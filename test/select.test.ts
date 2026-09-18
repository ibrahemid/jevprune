import { describe, expect, it } from "vitest";

import { DEFAULT_CONFIG } from "../src/config.js";
import type { ResolvedConfig } from "../src/config.js";
import {
  FakeJevClient,
  JevRequestError,
  JevResponseError,
  JevTimeoutError,
  estimateJsonTokens,
} from "../src/core/index.js";
import type { NoulScorer } from "../src/core/index.js";
import { splitLines } from "../src/lines.js";
import { selectLines } from "../src/select.js";

interface WindowState {
  readonly command: string;
  readonly task: string;
  readonly rubric: string;
  readonly lines: readonly { readonly n: number; readonly text: string }[];
}

function config(overrides: Partial<ResolvedConfig> = {}): ResolvedConfig {
  return { ...DEFAULT_CONFIG, home: "/nonexistent", tailLines: 0, contextLines: 0, ...overrides };
}

function buildLog(): string {
  const lines: string[] = [];
  for (let index = 1; index <= 90; index += 1) {
    lines.push(`[${String(index)}/90] fetching package-${String(index)} ... done`);
  }
  lines.push("");
  lines.push("auth: verifying session token for user 42");
  lines.push("auth: refreshing the login cookie");
  lines.push("compiling src/server.ts took 812 ms");
  lines.push("compiling src/client.ts took 1204 ms");
  lines.push("AssertionError: expected 401 to be 200");
  lines.push("");
  for (let index = 1; index <= 10; index += 1) lines.push(`cleanup step ${String(index)} complete`);
  return `${lines.join("\n")}\n`;
}

function textOf(state: unknown, id: string): string {
  const window = state as WindowState;
  const n = Number(id.slice(1));
  return window.lines.find((line) => line.n === n)?.text ?? "";
}

function taskOf(state: unknown): string {
  return (state as WindowState).task;
}

function keywordScorer(): NoulScorer {
  return (id, _instructions, state) => {
    const text = textOf(state, id).toLowerCase();
    const keywords = taskOf(state).includes("auth") ? ["auth", "login"] : [" ms", "took"];
    return keywords.some((keyword) => text.includes(keyword)) ? 0.9 : 0.05;
  };
}

function askedLines(client: FakeJevClient): number[] {
  return client.calls.flatMap((call) => call.ids.map((id) => Number(id.slice(1)))).sort((a, b) => a - b);
}

describe("selectLines", () => {
  it("passes short output through the fast path without asking Jev", async () => {
    const client = new FakeJevClient();
    const text = "a\nb\nc\n";
    const result = await selectLines({
      text,
      task: "anything",
      command: "pnpm test",
      exitCode: 0,
      client,
      config: config(),
      runId: "abcd-0001",
    });
    expect(result.mode).toBe("fast-path");
    expect(result.kept).toBe(text);
    expect(result.linesOut).toBe(3);
    expect(client.calls).toEqual([]);
  });

  it("passes everything through when the command failed or was interrupted", async () => {
    const client = new FakeJevClient();
    const text = buildLog();
    const failed = await selectLines({
      text,
      task: "fix it",
      command: "pnpm test",
      exitCode: 1,
      client,
      config: config(),
      runId: "abcd-0002",
    });
    expect(failed.mode).toBe("passthrough");
    expect(failed.kept).toBe(text);

    const interrupted = await selectLines({
      text,
      task: "fix it",
      command: "pnpm test",
      exitCode: 0,
      interrupted: true,
      client,
      config: config(),
      runId: "abcd-0003",
    });
    expect(interrupted.mode).toBe("passthrough");
    expect(client.calls).toEqual([]);
  });

  it("never sends deterministic keeps or blank lines to Jev", async () => {
    const client = new FakeJevClient({ noul: () => 0.9 });
    const text = buildLog();
    const lines = splitLines(text);
    const result = await selectLines({
      text,
      task: "fix the failing auth test",
      command: "pnpm test",
      exitCode: 0,
      client,
      config: config({ tailLines: 4, contextLines: 1 }),
      runId: "abcd-0004",
    });
    expect(result.mode).toBe("jev");
    const asked = new Set(askedLines(client));
    const signature = lines.find((line) => line.text === "AssertionError: expected 401 to be 200")?.n ?? -1;
    expect(asked.has(signature)).toBe(false);
    expect(result.decisions.get(signature)).toEqual({ keep: true, reason: "signature" });
    for (const line of lines) {
      if (line.text.trim().length === 0) expect(asked.has(line.n)).toBe(false);
      if (line.n > lines.length - 4) expect(asked.has(line.n)).toBe(false);
    }
    expect(result.decisions.get(lines.length)).toEqual({ keep: true, reason: "tail" });
  });

  it("keeps the lines Jev scores at or above the threshold", async () => {
    const client = new FakeJevClient({ noul: (id, _instructions, state) => (textOf(state, id).startsWith("auth") ? 0.4 : 0.1) });
    const text = buildLog();
    const result = await selectLines({
      text,
      task: "fix the failing auth test",
      command: "pnpm test",
      exitCode: 0,
      client,
      config: config({ threshold: 0.25 }),
      runId: "abcd-0005",
    });
    expect(result.kept).toContain("auth: verifying session token for user 42");
    expect(result.kept).not.toContain("fetching package-3 ");
    expect(result.linesIn).toBe(splitLines(text).length);
    expect(result.linesOut).toBeLessThan(result.linesIn);
    expect(result.jevRequests).toBe(result.windows);
    expect(result.jevInputTokens).toBeGreaterThan(0);
    expect(result.decisions.get(92)).toMatchObject({ keep: true, reason: "jev", noul: 0.4 });
  });

  it("splits the lines into windows that stay under the token budget", async () => {
    const client = new FakeJevClient({ noul: () => 0.5 });
    const result = await selectLines({
      text: buildLog(),
      task: "fix the failing auth test",
      command: "pnpm test",
      exitCode: 0,
      client,
      config: config({ windowTokens: 400 }),
      runId: "abcd-0006",
    });
    expect(result.windows).toBeGreaterThan(1);
    expect(client.calls).toHaveLength(result.windows);
    for (const call of client.calls) {
      expect(estimateJsonTokens(call.state)).toBeLessThanOrEqual(400);
    }
    const asked = askedLines(client);
    expect(new Set(asked).size).toBe(asked.length);
  });

  it("diverges on the task with the same output", async () => {
    const text = buildLog();
    const base = {
      text,
      command: "pnpm test",
      exitCode: 0,
      config: config(),
      runId: "abcd-0007",
    };
    const authClient = new FakeJevClient({ noul: keywordScorer() });
    const auth = await selectLines({ ...base, task: "fix the failing auth test", client: authClient });
    const slowClient = new FakeJevClient({ noul: keywordScorer() });
    const slow = await selectLines({ ...base, task: "why is the build slow", client: slowClient });

    expect(auth.kept).toContain("auth: refreshing the login cookie");
    expect(auth.kept).not.toContain("compiling src/server.ts took 812 ms");
    expect(slow.kept).toContain("compiling src/server.ts took 812 ms");
    expect(slow.kept).not.toContain("auth: refreshing the login cookie");
    for (const kept of [auth.kept, slow.kept]) {
      expect(kept).toContain("AssertionError: expected 401 to be 200");
    }
  });

  it("keeps everything with a reason when Jev is unavailable", async () => {
    const text = buildLog();
    const base = {
      text,
      task: "fix the failing auth test",
      command: "pnpm test",
      exitCode: 0,
      config: config(),
      runId: "abcd-0008",
    };
    const noKey = await selectLines({ ...base, client: null });
    expect(noKey.mode).toBe("passthrough");
    expect(noKey.kept).toBe(text);
    expect(noKey.fallbackReason).toBe("no api key");

    const cases: [Error, string][] = [
      [new JevTimeoutError(10, "too slow"), "timeout"],
      [new JevRequestError("rate limited", { status: 429, retryable: true }), "rate limited (429)"],
      [new JevRequestError("overloaded", { status: 529, retryable: true }), "overloaded (529)"],
      [new JevRequestError("unauthorized", { status: 401, retryable: false }), "unauthorized (401)"],
      [new JevRequestError("bad request", { status: 400, retryable: false }), "bad request (400)"],
      [new JevRequestError("no route", { retryable: true }), "network"],
      [new JevResponseError("garbled"), "invalid response"],
    ];
    for (const [error, reason] of cases) {
      const client = new FakeJevClient({ failWith: () => error });
      const result = await selectLines({ ...base, client });
      expect(result.mode, reason).toBe("passthrough");
      expect(result.kept).toBe(text);
      expect(result.fallbackReason).toBe(reason);
    }
  });
});
