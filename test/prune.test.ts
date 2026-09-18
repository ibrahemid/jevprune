import { access, readdir } from "node:fs/promises";
import { join } from "node:path";
import { Readable } from "node:stream";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { FakeJevClient } from "../src/core/index.js";
import type { NoulScorer } from "../src/core/index.js";
import { splitLines } from "../src/lines.js";
import { pruneOutput, pruneStream } from "../src/prune.js";
import { RunStore } from "../src/store.js";
import { homeEnv, makeHome, removeHome } from "./helpers/env.js";

interface WindowState {
  readonly lines: readonly { readonly n: number; readonly text: string }[];
}

class SourceError extends Error {
  override readonly name = "SourceError";
}

let home = "";

beforeEach(async () => {
  home = await makeHome();
});

afterEach(async () => {
  await removeHome(home);
});

function buildLog(): string {
  const lines: string[] = [];
  for (let index = 1; index <= 100; index += 1) lines.push(`[${String(index)}/100] copying asset-${String(index)}`);
  lines.push("keep: the session store is empty");
  for (let index = 1; index <= 20; index += 1) lines.push(`[cleanup] removing temp-${String(index)}`);
  return `${lines.join("\n")}\n`;
}

function buildLongLog(count: number): string {
  const pad = "y".repeat(80);
  const lines: string[] = [];
  for (let index = 1; index <= count; index += 1) lines.push(`line ${String(index)} ${pad}`);
  return `${lines.join("\n")}\n`;
}

function chunked(text: string, size: number): Buffer[] {
  const bytes = Buffer.from(text, "utf8");
  const chunks: Buffer[] = [];
  for (let start = 0; start < bytes.length; start += size) chunks.push(bytes.subarray(start, start + size));
  return chunks;
}

function expectMarkerNumbering(kept: string, text: string): void {
  const printed = splitLines(kept);
  const source = splitLines(text);
  let markers = 0;
  for (const [index, line] of printed.entries()) {
    const match = /\[jevprune: \d+ lines dropped, run [a-z0-9]+-[a-f0-9]{4}, lines (\d+)-(\d+)\]/.exec(line.text);
    if (match === null) continue;
    markers += 1;
    expect(printed[index - 1]?.text).toBe(source[Number(match[1]) - 2]?.text);
    expect(printed[index + 1]?.text).toBe(source[Number(match[2])]?.text);
  }
  expect(markers).toBeGreaterThan(0);
}

function keepMarked(): NoulScorer {
  return (id, _instructions, state) => {
    const window = state as unknown as WindowState;
    const n = Number(id.slice(1));
    return window.lines.find((line) => line.n === n)?.text.startsWith("keep:") === true ? 0.9 : 0.05;
  };
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

describe("pruneOutput", () => {
  it("prunes, saves the full output and builds the footer", async () => {
    const text = buildLog();
    const result = await pruneOutput({
      text,
      task: "find the session problem",
      command: "pnpm build",
      exitCode: 0,
      client: new FakeJevClient({ noul: keepMarked() }),
      env: homeEnv(home),
      config: { tailLines: 2, contextLines: 0 },
    });

    expect(result.mode).toBe("jev");
    expect(result.kept).toContain("keep: the session store is empty");
    expect(result.kept).toContain("lines dropped, run ");
    expect(result.linesIn).toBe(splitLines(text).length);
    expect(result.linesOut).toBeLessThan(result.linesIn);
    expect(result.dropped.length).toBeGreaterThan(0);
    expect(result.footer).toBe(
      `jevprune: ${String(result.linesIn)} → ${String(result.linesOut)} lines, exit 0, full output ${join(home, "runs", `${result.runId}.log`)}`,
    );

    const store = new RunStore({ home });
    const record = await store.readRun(result.runId);
    expect(record.text).toBe(text);
    expect(record.meta?.mode).toBe("jev");
    expect(record.meta?.linesOut).toBe(result.linesOut);
    expect(await store.readGain()).toMatchObject({ runs: 1, linesIn: result.linesIn, linesOut: result.linesOut });
  });

  it("recovers every dropped line from the run log", async () => {
    const text = buildLog();
    const result = await pruneOutput({
      text,
      task: "find the session problem",
      client: new FakeJevClient({ noul: keepMarked() }),
      env: homeEnv(home),
    });
    const store = new RunStore({ home });
    const range = result.dropped[0];
    expect(range).toBeDefined();
    const recovered = await store.readRunLines(result.runId, range?.from, range?.to);
    expect(recovered).toBe(
      splitLines(text)
        .slice((range?.from ?? 1) - 1, range?.to)
        .map((line) => line.text + line.terminator)
        .join(""),
    );
  });

  it("falls back to the keeps, the head and the tail when there is no api key", async () => {
    const text = buildLog();
    const result = await pruneOutput({
      text,
      task: "anything",
      exitCode: 0,
      env: homeEnv(home),
      config: { headLines: 5, tailLines: 4, contextLines: 0 },
    });
    expect(result.mode).toBe("fallback");
    expect(result.fallbackReason).toEqual({ kind: "unavailable", detail: "API key not set" });
    expect(result.linesIn).toBe(splitLines(text).length);
    expect(result.linesOut).toBe(10);
    expect(result.kept).toContain("[1/100] copying asset-1");
    expect(result.kept).toContain("[cleanup] removing temp-20");
    expect(result.kept).toContain(`lines dropped, run ${result.runId}, lines 6-117`);
    expect(result.footer).toContain("fallback (Jev unavailable: API key not set)");
    expect((await new RunStore({ home }).readRun(result.runId)).text).toBe(text);
  });

  it("saves nothing but a ledger entry on the fast path", async () => {
    const result = await pruneOutput({
      text: "one\ntwo\n",
      task: "anything",
      exitCode: 0,
      client: new FakeJevClient(),
      env: homeEnv(home),
    });
    expect(result.mode).toBe("fast-path");
    expect(result.footer).toBe("");
    expect(result.logPath).toBeUndefined();
    expect(await exists(join(home, "runs", `${result.runId}.log`))).toBe(false);
    expect(await new RunStore({ home }).readGain()).toMatchObject({ runs: 1, linesIn: 2, linesOut: 2 });
  });

  it("writes nothing when save is false", async () => {
    const result = await pruneOutput({
      text: buildLog(),
      task: "find the session problem",
      client: new FakeJevClient({ noul: keepMarked() }),
      env: homeEnv(home),
      save: false,
    });
    expect(result.logPath).toBeUndefined();
    expect(result.footer).not.toContain("full output");
    await expect(readdir(join(home, "runs"))).rejects.toThrow();
  });

  it("falls back on the head and the tail without a request over maxPruneBytes", async () => {
    const text = buildLog();
    const client = new FakeJevClient({ noul: keepMarked() });
    const result = await pruneOutput({
      text,
      task: "find the session problem",
      command: "pnpm build",
      exitCode: 0,
      client,
      env: homeEnv(home),
      config: { maxPruneBytes: 1024, headLines: 5, tailLines: 4, contextLines: 0 },
    });

    expect(client.calls).toEqual([]);
    expect(result.mode).toBe("fallback");
    expect(result.fallbackReason).toEqual({ kind: "size-limit", maxBytes: 1024 });
    expect(result.linesIn).toBe(splitLines(text).length);
    expect(result.linesOut).toBeLessThan(result.linesIn);
    expect(result.footer).toContain("fallback (output over 1024 bytes)");
    expect((await new RunStore({ home }).readRun(result.runId)).text).toBe(text);
  });

  it("applies the size limit before the failed command passthrough", async () => {
    const client = new FakeJevClient({ noul: keepMarked() });
    const result = await pruneOutput({
      text: buildLog(),
      task: "find the session problem",
      exitCode: 1,
      client,
      env: homeEnv(home),
      config: { maxPruneBytes: 1024, headLines: 5, tailLines: 4, contextLines: 0 },
    });

    expect(client.calls).toEqual([]);
    expect(result.mode).toBe("fallback");
    expect(result.fallbackReason).toEqual({ kind: "size-limit", maxBytes: 1024 });
  });

  it("applies the config overrides over the loaded config", async () => {
    const client = new FakeJevClient({ noul: () => 0.3 });
    const kept = await pruneOutput({
      text: buildLog(),
      task: "anything",
      client,
      env: homeEnv(home),
      config: { threshold: 0.2, tailLines: 0, contextLines: 0 },
    });
    const dropped = await pruneOutput({
      text: buildLog(),
      task: "anything",
      client,
      env: homeEnv(home),
      config: { threshold: 0.4, tailLines: 0, contextLines: 0 },
    });
    expect(kept.linesOut).toBeGreaterThan(dropped.linesOut);
  });
});

describe("pruneStream", () => {
  it("reads the stream and prunes it like text", async () => {
    const text = buildLog();
    const result = await pruneStream({
      stream: Readable.from([Buffer.from(text, "utf8")]),
      task: "find the session problem",
      exitCode: 0,
      client: new FakeJevClient({ noul: keepMarked() }),
      env: homeEnv(home),
    });
    expect(result.mode).toBe("jev");
    expect(result.linesIn).toBe(splitLines(text).length);
    expect(result.kept).toContain("keep: the session store is empty");
  });

  it("bounds the read at maxPruneBytes, makes no request and still saves the whole stream", async () => {
    const text = buildLongLog(20_000);
    const client = new FakeJevClient({ noul: () => 0.9 });
    const result = await pruneStream({
      stream: Readable.from(chunked(text, 64 * 1024)),
      task: "read the last lines",
      exitCode: 0,
      client,
      env: homeEnv(home),
      config: { maxPruneBytes: 65_536, headLines: 20, tailLines: 10, contextLines: 0 },
    });

    expect(client.calls).toEqual([]);
    expect(result.mode).toBe("fallback");
    expect(result.fallbackReason).toEqual({ kind: "size-limit", maxBytes: 65_536 });
    expect(result.linesIn).toBe(20_000);
    expect(result.linesOut).toBeLessThan(result.linesIn);

    const store = new RunStore({ home });
    expect((await store.readRun(result.runId)).text).toBe(text);
    expectMarkerNumbering(result.kept, text);
    expect(splitLines(result.kept).at(-1)?.text).toBe("line 20000 " + "y".repeat(80));
  });

  it("discards the partial run and rethrows when the source stream fails", async () => {
    const failure = new SourceError("source stopped at chunk 2");
    function* failing(): Generator<Buffer> {
      yield Buffer.from("line 1\n", "utf8");
      throw failure;
    }

    await expect(
      pruneStream({
        stream: Readable.from(failing()),
        task: "anything",
        exitCode: 0,
        client: new FakeJevClient(),
        env: homeEnv(home),
      }),
    ).rejects.toBe(failure);

    expect(await readdir(join(home, "runs"))).toEqual([]);
  });

  it("saves nothing but a ledger entry on the fast path", async () => {
    const result = await pruneStream({
      stream: Readable.from([Buffer.from("one\ntwo\n", "utf8")]),
      task: "anything",
      exitCode: 0,
      client: new FakeJevClient(),
      env: homeEnv(home),
    });
    expect(result.mode).toBe("fast-path");
    expect(result.logPath).toBeUndefined();
    expect(await exists(join(home, "runs", `${result.runId}.log`))).toBe(false);
  });
});
