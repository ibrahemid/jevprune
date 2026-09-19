import { describe, expect, it } from "vitest";

import { RunStoreError } from "../src/core/errors.js";
import type { RunRecordPlan } from "../src/core/record.js";
import { persistRun } from "../src/core/store-writer.js";
import type { RunFiles } from "../src/core/store-writer.js";

const HOME = "/home/ibra/.jevprune";
const RUN_ID = "m1xk2p7a-3f9c";
const LOG_PATH = `${HOME}/runs/${RUN_ID}.log`;
const META_PATH = `${HOME}/runs/${RUN_ID}.json`;
const GAIN_PATH = `${HOME}/gain.jsonl`;

interface MemoryFilesOptions {
  readonly failWrite?: (path: string) => Error | undefined;
}

class MemoryFiles implements RunFiles {
  readonly contents = new Map<string, string>();
  readonly writes: string[] = [];
  readonly #options: MemoryFilesOptions;

  constructor(options: MemoryFilesOptions = {}) {
    this.#options = options;
  }

  read(path: string): Promise<string> {
    const text = this.contents.get(path);
    if (text === undefined) return Promise.reject(new RunStoreError(`${path} was not found`, { code: "ENOENT" }));
    return Promise.resolve(text);
  }

  write(path: string, text: string): Promise<void> {
    const failure = this.#options.failWrite?.(path);
    if (failure !== undefined) return Promise.reject(failure);
    this.writes.push(path);
    this.contents.set(path, text);
    return Promise.resolve();
  }

  exists(path: string): Promise<boolean> {
    return Promise.resolve(this.contents.has(path));
  }
}

function plan(overrides: { readonly persistLog?: boolean; readonly reason?: string } = {}): RunRecordPlan {
  const reason = overrides.reason;
  return {
    meta: {
      id: RUN_ID,
      command: "pnpm build",
      argv: [],
      startedAt: "2026-01-01T00:00:00.000Z",
      endedAt: "2026-01-01T00:00:02.000Z",
      exitCode: 0,
      signal: null,
      bytes: 4096,
      lines: 200,
      mode: overrides.persistLog === false ? "fast-path" : "jev",
      linesOut: 12,
      ...(reason === undefined ? {} : { fallbackReason: reason }),
      task: "find the failing asset copy",
    },
    gain: {
      ts: "2026-01-01T00:00:02.000Z",
      id: RUN_ID,
      mode: overrides.persistLog === false ? "fast-path" : "jev",
      linesIn: 200,
      linesOut: 12,
      bytesIn: 4096,
      bytesOut: 220,
      ...(reason === undefined ? {} : { reason }),
    },
    persistLog: overrides.persistLog ?? true,
  };
}

describe("persistRun", () => {
  it("writes the log, the meta and the gain entry at the run paths", async () => {
    const files = new MemoryFiles();
    const recordPlan = plan();

    const result = await persistRun({ files, home: HOME, plan: recordPlan, log: "line one\nline two\n" });

    expect(result).toEqual({ logPath: LOG_PATH });
    expect(files.writes).toEqual([LOG_PATH, META_PATH, GAIN_PATH]);
    expect(files.contents.get(LOG_PATH)).toBe("line one\nline two\n");
    expect(files.contents.get(META_PATH)).toBe(`${JSON.stringify(recordPlan.meta)}\n`);
    expect(files.contents.get(GAIN_PATH)).toBe(`${JSON.stringify(recordPlan.gain)}\n`);
  });

  it("appends the gain entry after the existing lines", async () => {
    const files = new MemoryFiles();
    const earlier = '{"id":"earlier"}\n';
    files.contents.set(GAIN_PATH, earlier);
    const recordPlan = plan();

    await persistRun({ files, home: HOME, plan: recordPlan, log: "output\n" });

    expect(files.contents.get(GAIN_PATH)).toBe(`${earlier}${JSON.stringify(recordPlan.gain)}\n`);
  });

  it("writes no log file when the plan does not persist one", async () => {
    const files = new MemoryFiles();

    const result = await persistRun({ files, home: HOME, plan: plan({ persistLog: false }), log: "output\n" });

    expect(result.logPath).toBeUndefined();
    expect(files.writes).toEqual([META_PATH, GAIN_PATH]);
    expect(files.contents.has(LOG_PATH)).toBe(false);
  });

  it("reports the path the caller already wrote and writes no second log", async () => {
    const files = new MemoryFiles();
    const alreadyAt = "/tmp/persisted-output.log";

    const result = await persistRun({ files, home: HOME, plan: plan(), logAlreadyAt: alreadyAt });

    expect(result).toEqual({ logPath: alreadyAt });
    expect(files.writes).toEqual([META_PATH, GAIN_PATH]);
  });

  it("rejects a call that passes both a log and a written log path", async () => {
    const files = new MemoryFiles();

    await expect(
      persistRun({ files, home: HOME, plan: plan(), log: "output\n", logAlreadyAt: "/tmp/output.log" }),
    ).rejects.toThrow(RunStoreError);
    expect(files.writes).toEqual([]);
  });

  it("reports the error code of a failing write and no log path", async () => {
    const files = new MemoryFiles({
      failWrite: (path) => (path === META_PATH ? new RunStoreError("meta failed", { code: "EACCES" }) : undefined),
    });

    const result = await persistRun({ files, home: HOME, plan: plan(), log: "output\n" });

    expect(result).toEqual({ failureCode: "EACCES" });
    expect(result.logPath).toBeUndefined();
    expect(files.contents.has(GAIN_PATH)).toBe(false);
  });

  it("reports a generic failure when the thrown value carries no code", async () => {
    const files = new MemoryFiles({
      failWrite: (path) => (path === GAIN_PATH ? new RunStoreError("gain failed") : undefined),
    });

    const result = await persistRun({ files, home: HOME, plan: plan(), logAlreadyAt: "/tmp/output.log" });

    expect(result).toEqual({ failureCode: "failed" });
  });
});
