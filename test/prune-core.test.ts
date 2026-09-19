import { readFile, readdir } from "node:fs/promises";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DEFAULT_CONFIG } from "../src/core/config.js";
import type { ResolvedConfig } from "../src/core/config.js";
import { FakeJevClient } from "../src/core/index.js";
import { splitLines } from "../src/core/lines.js";
import { pruneCore } from "../src/core/prune-core.js";
import type { SelectionResult } from "../src/core/select.js";
import { utf8Length } from "../src/core/text.js";
import { recordRun } from "../src/prune.js";
import { RunStore } from "../src/store.js";
import { makeHome, removeHome } from "./helpers/env.js";

const STARTED_AT = "2026-01-01T00:00:00.000Z";
const ENDED_AT = "2026-01-01T00:00:02.000Z";
const RUN_ID = "m1xk2p7a-3f9c";

function config(overrides: Partial<ResolvedConfig> = {}): ResolvedConfig {
  return { ...DEFAULT_CONFIG, home: "/nonexistent", tailLines: 0, contextLines: 0, ...overrides };
}

function fixedClock(): () => string {
  let call = 0;
  return () => {
    call += 1;
    return call === 1 ? STARTED_AT : ENDED_AT;
  };
}

function buildLog(count: number): string {
  const lines: string[] = [];
  for (let index = 1; index <= count; index += 1) lines.push(`[${String(index)}/${String(count)}] copying asset`);
  return `${lines.join("\n")}\n`;
}

function everyTenth(): (id: string) => number {
  return (id) => (Number.parseInt(id.slice(1), 10) % 10 === 0 ? 0.9 : 0.1);
}

describe("pruneCore", () => {
  it("returns a deterministic meta and gain for a Jev selection", async () => {
    const text = buildLog(200);
    const bytes = utf8Length(text);
    const run = async (): Promise<Awaited<ReturnType<typeof pruneCore>>> =>
      await pruneCore({
        text,
        task: "find the failing asset copy",
        command: "pnpm build",
        exitCode: 0,
        client: new FakeJevClient({ noul: everyTenth() }),
        config: config(),
        runId: RUN_ID,
        bytes,
        now: fixedClock(),
      });

    const first = await run();
    const second = await run();

    expect(first.selection.mode).toBe("jev");
    expect(first.plan.persistLog).toBe(true);
    expect(first.plan.meta).toEqual({
      id: RUN_ID,
      command: "pnpm build",
      argv: [],
      startedAt: STARTED_AT,
      endedAt: ENDED_AT,
      exitCode: 0,
      signal: null,
      bytes,
      lines: 200,
      mode: "jev",
      linesOut: first.selection.linesOut,
      task: "find the failing asset copy",
    });
    expect(first.plan.gain).toEqual({
      ts: ENDED_AT,
      id: RUN_ID,
      mode: "jev",
      linesIn: 200,
      linesOut: first.selection.linesOut,
      bytesIn: bytes,
      bytesOut: utf8Length(first.selection.kept),
      });
    expect(first.selection.linesOut).toBeLessThan(200);
    expect(JSON.stringify(second.plan)).toBe(JSON.stringify(first.plan));
  });

  it("carries argv and the signal name into the meta", async () => {
    const text = buildLog(10);
    const result = await pruneCore({
      text,
      task: "check the build",
      command: "pnpm build",
      exitCode: null,
      client: null,
      config: config(),
      runId: RUN_ID,
      bytes: utf8Length(text),
      argv: ["pnpm", "build"],
      signalName: "SIGTERM",
      now: fixedClock(),
    });

    expect(result.plan.meta.argv).toEqual(["pnpm", "build"]);
    expect(result.plan.meta.signal).toBe("SIGTERM");
    expect(result.plan.meta.exitCode).toBeNull();
  });

  it("marks a fast-path run as not persisted", async () => {
    const text = buildLog(10);
    const result = await pruneCore({
      text,
      task: "check the build",
      command: "pnpm build",
      exitCode: 0,
      client: new FakeJevClient({ noul: everyTenth() }),
      config: config(),
      runId: RUN_ID,
      bytes: utf8Length(text),
      now: fixedClock(),
    });

    expect(result.selection.mode).toBe("fast-path");
    expect(result.selection.kept).toBe(text);
    expect(result.plan.persistLog).toBe(false);
    expect(result.plan.meta.mode).toBe("fast-path");
    expect(result.plan.meta.linesOut).toBe(10);
    expect(result.plan.meta.fallbackReason).toBeUndefined();
    expect(result.plan.gain.reason).toBeUndefined();
  });

  it("fills the fallback reason when no client is configured", async () => {
    const text = buildLog(200);
    const result = await pruneCore({
      text,
      task: "find the failing asset copy",
      command: "pnpm build",
      exitCode: 0,
      client: null,
      config: config(),
      runId: RUN_ID,
      bytes: utf8Length(text),
      now: fixedClock(),
    });

    expect(result.selection.mode).toBe("fallback");
    expect(result.plan.persistLog).toBe(true);
    expect(result.plan.meta.fallbackReason).toBe("API key not set");
    expect(result.plan.gain.reason).toBe("API key not set");
  });

  it("keeps the full line count of an oversize capture", async () => {
    const text = buildLog(80);
    const captured = splitLines(text).length;
    const result = await pruneCore({
      text,
      task: "find the failing asset copy",
      command: "pnpm build",
      exitCode: 0,
      client: new FakeJevClient({ noul: everyTenth() }),
      config: config({ maxPruneBytes: 4096 }),
      runId: RUN_ID,
      bytes: utf8Length(text),
      oversize: { lines: 5000, headSegmentLines: 20 },
      now: fixedClock(),
    });

    expect(result.selection.mode).toBe("fallback");
    expect(result.plan.meta.lines).toBe(5000);
    expect(result.plan.meta.lines).toBeGreaterThan(captured);
    expect(result.plan.meta.fallbackReason).toBe("output over 4096 bytes");
    expect(result.plan.gain.reason).toBe("output over 4096 bytes");
  });

  it("passes the interrupted flag through to the selection", async () => {
    const text = buildLog(200);
    const result = await pruneCore({
      text,
      task: "find the failing asset copy",
      command: "pnpm build",
      exitCode: 0,
      interrupted: true,
      client: new FakeJevClient({ noul: everyTenth() }),
      config: config(),
      runId: RUN_ID,
      bytes: utf8Length(text),
      now: fixedClock(),
    });

    expect(result.selection.mode).toBe("passthrough");
    expect(result.plan.meta.mode).toBe("passthrough");
  });
});

describe("recordRun with archive", () => {
  let home = "";

  beforeEach(async () => {
    home = await makeHome();
  });

  afterEach(async () => {
    await removeHome(home);
  });

  async function fallbackSelection(): Promise<SelectionResult> {
    const text = buildLog(200);
    const { selection } = await pruneCore({
      text,
      task: "find the failing asset copy",
      command: "aws configure list",
      exitCode: 0,
      client: null,
      config: config(),
      runId: RUN_ID,
      bytes: utf8Length(text),
      now: fixedClock(),
    });
    return selection;
  }

  function metaFor(): Parameters<typeof recordRun>[0]["meta"] {
    return {
      id: RUN_ID,
      command: "aws configure list",
      argv: [],
      startedAt: STARTED_AT,
      endedAt: ENDED_AT,
      exitCode: 0,
      signal: null,
      bytes: 4096,
      lines: 200,
      task: "find the failing asset copy",
    };
  }

  it("keeps the run log and the meta by default", async () => {
    const store = new RunStore({ home });
    const selection = await fallbackSelection();

    const recorded = await recordRun({ store, selection, meta: metaFor(), logText: "output\n" });

    expect(recorded.logPath).toBe(store.logPath(RUN_ID));
    expect((await readdir(store.runsDir)).sort()).toEqual([`${RUN_ID}.json`, `${RUN_ID}.log`]);
    expect(recorded.footer).toContain("full output");
  });

  it("discards the run when archive is false and still records the gain", async () => {
    const store = new RunStore({ home });
    const selection = await fallbackSelection();

    const recorded = await recordRun({ store, selection, meta: metaFor(), logText: "output\n", archive: false });

    expect(recorded.logPath).toBeUndefined();
    await expect(readdir(store.runsDir)).rejects.toThrow();
    expect(recorded.footer).not.toContain("full output");
    const gain = await readFile(store.gainPath, "utf8");
    expect(JSON.parse(gain.trim())).toMatchObject({ id: RUN_ID, mode: "fallback", linesIn: 200 });
  });
});
