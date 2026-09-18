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

  it("keeps everything with a reason when there is no api key", async () => {
    const text = buildLog();
    const result = await pruneOutput({ text, task: "anything", exitCode: 0, env: homeEnv(home) });
    expect(result.mode).toBe("passthrough");
    expect(result.fallbackReason).toBe("no api key");
    expect(result.kept).toBe(text);
    expect(result.footer).toContain("lines passed through");
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
});
