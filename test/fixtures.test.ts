import { readFileSync } from "node:fs";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DEFAULT_CONFIG } from "../src/config.js";
import type { ResolvedConfig } from "../src/config.js";
import { FakeJevClient, estimateJsonTokens } from "../src/core/index.js";
import type { NoulScorer } from "../src/core/index.js";
import { computeKeeps } from "../src/core/keeps.js";
import { joinLines, splitLines } from "../src/core/lines.js";
import type { Line } from "../src/core/lines.js";
import { pruneOutput } from "../src/prune.js";
import { selectLines } from "../src/core/select.js";
import { homeEnv, makeHome, removeHome } from "./helpers/env.js";

const MARKER = /^\[jevprune: \d+ lines dropped, run [^,]+, lines \d+-\d+\]$/;

function fixture(name: string): string {
  return readFileSync(new URL(`./fixtures/${name}.log`, import.meta.url), "utf8");
}

const NPM = fixture("npm-test");
const PYTEST = fixture("pytest");
const CARGO = fixture("cargo-build");
const DOCKER = fixture("docker-compose");

const FIXTURES: [string, string][] = [
  ["npm-test", NPM],
  ["pytest", PYTEST],
  ["cargo-build", CARGO],
  ["docker-compose", DOCKER],
];

function config(overrides: Partial<ResolvedConfig> = {}): ResolvedConfig {
  return { ...DEFAULT_CONFIG, home: "/nonexistent", ...overrides };
}

function numberOf(lines: readonly Line[], needle: string): number {
  const found = lines.find((line) => line.text.includes(needle));
  expect(found, needle).toBeDefined();
  return found?.n ?? 0;
}

interface WindowState {
  readonly task: string;
  readonly lines: readonly { readonly n: number; readonly text: string }[];
}

function textOf(state: unknown, id: string): string {
  const n = Number(id.slice(1));
  return (state as WindowState).lines.find((line) => line.n === n)?.text ?? "";
}

function taskOf(state: unknown): string {
  return (state as WindowState).task;
}

function millisecondsOf(text: string): number {
  const match = /(\d+)ms$/.exec(text);
  return match === null ? 0 : Number(match[1]);
}

function keywordScorer(): NoulScorer {
  return (id, _instructions, state) => {
    const text = textOf(state, id);
    if (taskOf(state).includes("auth")) return text.toLowerCase().includes("auth") ? 0.9 : 0.05;
    return millisecondsOf(text) > 400 ? 0.9 : 0.05;
  };
}

describe("deterministic keeps on captured output", () => {
  it("keeps the vitest failure block, its assertion and its frame with context", () => {
    const lines = splitLines(NPM);
    const keeps = computeKeeps(lines, { tailLines: 0, contextLines: 3 });
    const fail = numberOf(lines, "FAIL  src/auth/login.test.ts");
    const assertion = numberOf(lines, "AssertionError: expected 200 to be 401");
    const frame = numberOf(lines, "❯ src/auth/login.test.ts:88:29");

    expect(keeps.get(fail)).toBe("signature");
    expect(keeps.get(assertion)).toBe("signature");
    expect(keeps.get(frame)).toBe("signature");
    expect(keeps.get(numberOf(lines, "Test Files  1 failed"))).toBe("signature");
    expect(keeps.get(frame + 3)).toBe("context");
    expect(keeps.get(fail - 1)).toBe("context");
  });

  it("keeps the pytest traceback, its assertion detail and the failed summary", () => {
    const lines = splitLines(PYTEST);
    const keeps = computeKeeps(lines, { tailLines: 0, contextLines: 3 });
    const detail = numberOf(lines, "E       AssertionError: assert 14 == 12");
    const summary = numberOf(lines, "FAILED test/app/config/test_app_config.py");

    expect(keeps.get(detail)).toBe("signature");
    expect(keeps.get(detail + 1)).toBe("signature");
    expect(keeps.get(summary)).toBe("signature");
    expect(keeps.get(numberOf(lines, "test/app/config/test_app_config.py:57: AssertionError"))).toBe("signature");
    expect(keeps.get(detail - 1)).toBe("context");
  });

  it("keeps the rustc error and the source location it points at", () => {
    const lines = splitLines(CARGO);
    const keeps = computeKeeps(lines, { tailLines: 0, contextLines: 3 });
    const error = numberOf(lines, "error[E0308]: mismatched types");
    const location = numberOf(lines, "--> crates/app-sdk/src/client.rs:127:22");

    expect(keeps.get(error)).toBe("signature");
    expect(keeps.get(location)).toBe("signature");
    expect(keeps.get(numberOf(lines, "error: could not compile `app-sdk`"))).toBe("signature");
    expect(keeps.get(location + 2)).toBe("context");
  });

  it("keeps the container that exited with a failure and its context", () => {
    const lines = splitLines(DOCKER);
    const keeps = computeKeeps(lines, { tailLines: 0, contextLines: 3 });
    const exited = numberOf(lines, "app-dns-exporter exited with code 1");

    expect(keeps.get(exited)).toBe("signature");
    expect(keeps.get(exited - 1)).toBe("context");
    expect(keeps.get(exited + 1)).toBe("context");
  });
});

describe("selection on captured output", () => {
  it("plans every window of the compose output under the token budget", async () => {
    const client = new FakeJevClient({ noul: () => 0.5 });
    const result = await selectLines({
      text: DOCKER,
      task: "why did the dns exporter restart",
      command: "docker compose up",
      exitCode: 0,
      client,
      config: config(),
      runId: "fixt-0001",
    });
    expect(result.windows).toBeGreaterThan(1);
    expect(client.calls).toHaveLength(result.windows);
    for (const call of client.calls) {
      expect(estimateJsonTokens(call.state)).toBeLessThanOrEqual(DEFAULT_CONFIG.windowTokens);
    }
    const asked = client.calls.flatMap((call) => call.ids);
    expect(new Set(asked).size).toBe(asked.length);
  });

  it.each(FIXTURES)("partitions %s into kept lines and dropped ranges", async (_name, text) => {
    const client = new FakeJevClient({ noul: (id, _instructions, state) => (textOf(state, id).length % 3) / 3 });
    const result = await selectLines({
      text,
      task: "find out why the run failed",
      command: "make check",
      exitCode: 0,
      client,
      config: config(),
      runId: "fixt-0002",
    });
    const lines = splitLines(text);
    const kept = lines.filter((line) => result.decisions.get(line.n)?.keep === true);

    expect(result.mode).toBe("jev");
    expect(result.dropped.length).toBeGreaterThan(0);
    expect(joinLines(splitLines(result.kept).filter((line) => !MARKER.test(line.text)))).toBe(joinLines(kept));

    const covered = new Set(kept.map((line) => line.n));
    expect(covered.size).toBe(kept.length);
    for (const range of result.dropped) {
      expect(range.to - range.from + 1).toBe(range.count);
      for (let n = range.from; n <= range.to; n += 1) {
        expect(covered.has(n)).toBe(false);
        covered.add(n);
      }
    }
    expect(covered.size).toBe(lines.length);
  });

  it("keeps different lines of the same test run for two tasks", async () => {
    const lines = splitLines(NPM);
    const base = {
      text: NPM,
      command: "pnpm test",
      exitCode: 0,
      config: config(),
      runId: "fixt-0003",
    };
    const auth = await selectLines({
      ...base,
      task: "fix the failing auth test",
      client: new FakeJevClient({ noul: keywordScorer() }),
    });
    const slow = await selectLines({
      ...base,
      task: "why is the build slow",
      client: new FakeJevClient({ noul: keywordScorer() }),
    });

    const authTest = numberOf(lines, "src/auth/oauth.test.ts > oauth > paginates an unknown id 9ms");
    const slowTest = numberOf(lines, "src/billing/refunds.test.ts > refunds > computes an empty input 2435ms");
    expect(auth.decisions.get(authTest)).toMatchObject({ keep: true, reason: "jev" });
    expect(auth.decisions.get(slowTest)).toMatchObject({ keep: false, reason: "jev" });
    expect(slow.decisions.get(authTest)).toMatchObject({ keep: false, reason: "jev" });
    expect(slow.decisions.get(slowTest)).toMatchObject({ keep: true, reason: "jev" });

    for (const result of [auth, slow]) {
      expect(result.kept).toContain("FAIL  src/auth/login.test.ts");
      expect(result.kept).toContain("AssertionError: expected 200 to be 401");
      expect(result.kept).toContain("❯ src/auth/login.test.ts:88:29");
      expect(result.kept).toContain("Test Files  1 failed | 94 passed (95)");
      expect(result.linesOut).toBeLessThan(result.linesIn / 3);
    }
  });
});

describe("pruneOutput on captured output", () => {
  let home = "";

  beforeEach(async () => {
    home = await makeHome();
  });

  afterEach(async () => {
    await removeHome(home);
  });

  it("passes a failed run through untouched", async () => {
    const client = new FakeJevClient({ noul: () => 0.9 });
    const result = await pruneOutput({
      text: PYTEST,
      task: "fix the failing test",
      command: "pytest",
      exitCode: 1,
      client,
      env: homeEnv(home),
    });
    expect(result.mode).toBe("passthrough");
    expect(result.kept).toBe(PYTEST);
    expect(result.linesOut).toBe(result.linesIn);
    expect(client.calls).toEqual([]);
    expect(result.footer).toContain("exit 1");
  });

  it("takes the fast path on a short capture", async () => {
    const client = new FakeJevClient({ noul: () => 0.9 });
    const text = joinLines(splitLines(CARGO).slice(0, DEFAULT_CONFIG.fastPathLines));
    const result = await pruneOutput({
      text,
      task: "fix the build",
      command: "cargo build",
      exitCode: 0,
      client,
      env: homeEnv(home),
    });
    expect(result.mode).toBe("fast-path");
    expect(result.kept).toBe(text);
    expect(result.footer).toBe("");
    expect(result.logPath).toBeUndefined();
    expect(client.calls).toEqual([]);
  });
});
