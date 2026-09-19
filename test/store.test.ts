import { readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { LineRangeError, RunNotFoundError, RunStoreError } from "../src/core/errors.js";
import { RUN_ID_PATTERN, RunStore, newRunId } from "../src/store.js";
import type { RunMeta } from "../src/store.js";
import { makeHome, removeHome } from "./helpers/env.js";

let home = "";
let store: RunStore;

beforeEach(async () => {
  home = await makeHome();
  store = new RunStore({ home, retention: { maxRuns: 200, maxBytes: 268_435_456 } });
});

afterEach(async () => {
  await removeHome(home);
});

function meta(id: string, extra: Partial<RunMeta> = {}): RunMeta {
  return {
    id,
    command: "pnpm test",
    argv: ["pnpm", "test"],
    startedAt: "2026-01-01T00:00:00.000Z",
    endedAt: "2026-01-01T00:00:01.000Z",
    exitCode: 0,
    signal: null,
    bytes: 4,
    lines: 1,
    mode: "passthrough",
    linesOut: 1,
    task: "run the tests",
    ...extra,
  };
}

async function writeRun(id: string, text: string): Promise<void> {
  const writer = await store.openRun({ id });
  writer.write(Buffer.from(text, "utf8"));
  await writer.close();
  await store.finalizeRun(id, meta(id));
}

describe("newRunId", () => {
  it("is time sortable and matches the run id pattern", () => {
    const first = newRunId();
    const second = newRunId();
    const stamp = (id: string): string => id.slice(0, id.indexOf("-"));
    expect(first).toMatch(RUN_ID_PATTERN);
    expect(second).toMatch(RUN_ID_PATTERN);
    expect(stamp(second) >= stamp(first)).toBe(true);
    expect(Number.parseInt(stamp(first), 36)).toBeGreaterThan(Date.now() - 60_000);
  });
});

describe("openRun", () => {
  it("creates the run directory 0700 and the log 0600", async () => {
    const id = newRunId();
    const writer = await store.openRun({ id });
    writer.write(Buffer.from("hello\n", "utf8"));
    await writer.close();
    expect(writer.failure).toBeUndefined();
    expect((await stat(store.runsDir)).mode & 0o777).toBe(0o700);
    expect((await stat(store.logPath(id))).mode & 0o777).toBe(0o600);
    expect(await readFile(store.logPath(id), "utf8")).toBe("hello\n");
  });

  it("refuses to reuse an existing run id", async () => {
    const id = newRunId();
    await (await store.openRun({ id })).close();
    await expect(store.openRun({ id })).rejects.toBeInstanceOf(RunStoreError);
  });

  it("rejects an id that is not a run id before touching the filesystem", async () => {
    await expect(store.openRun({ id: "../escape" })).rejects.toThrow(/is not a run id/);
  });
});

describe("finalizeRun", () => {
  it("writes the meta file 0600 and reads it back", async () => {
    const id = newRunId();
    await writeRun(id, "one\ntwo\n");
    expect((await stat(store.metaPath(id))).mode & 0o777).toBe(0o600);
    const record = await store.readRun(id);
    expect(record.text).toBe("one\ntwo\n");
    expect(record.meta?.task).toBe("run the tests");
  });

  it("reports a missing run", async () => {
    await expect(store.readRun("zzzz-abcd")).rejects.toBeInstanceOf(RunNotFoundError);
  });
});

describe("readRunLines", () => {
  it("returns the exact bytes of the requested range", async () => {
    const id = newRunId();
    await writeRun(id, "a\nb\r\nc\nd");
    expect(await store.readRunLines(id, 2, 3)).toBe("b\r\nc\n");
    expect(await store.readRunLines(id, 4, 4)).toBe("d");
    expect(await store.readRunLines(id)).toBe("a\nb\r\nc\nd");
  });

  it("rejects a range outside the run", async () => {
    const id = newRunId();
    await writeRun(id, "a\nb\n");
    await expect(store.readRunLines(id, 1, 9)).rejects.toBeInstanceOf(LineRangeError);
    await expect(store.readRunLines(id, 0, 1)).rejects.toBeInstanceOf(LineRangeError);
    await expect(store.readRunLines(id, 3, 2)).rejects.toBeInstanceOf(LineRangeError);
  });
});

describe("gain ledger", () => {
  it("sums the entries and ignores malformed lines", async () => {
    await store.appendGain({
      ts: "2026-01-01T00:00:00.000Z",
      id: "a-0001",
      mode: "jev",
      linesIn: 100,
      linesOut: 10,
      bytesIn: 1000,
      bytesOut: 100,
    });
    await store.appendGain({
      ts: "2026-01-01T00:00:02.000Z",
      id: "a-0002",
      mode: "passthrough",
      linesIn: 5,
      linesOut: 5,
      bytesIn: 50,
      bytesOut: 50,
    });
    await writeFile(join(home, "gain.jsonl"), "not json\n", { flag: "a" });
    expect(await store.readGain()).toEqual({ runs: 2, linesIn: 105, linesOut: 15, bytesIn: 1050, bytesOut: 150 });
  });

  it("reports zeroes when no ledger exists", async () => {
    expect(await store.readGain()).toEqual({ runs: 0, linesIn: 0, linesOut: 0, bytesIn: 0, bytesOut: 0 });
  });
});

describe("enforceRetention", () => {
  it("deletes the oldest runs beyond maxRuns", async () => {
    const ids = ["aaaa-0001", "aaab-0002", "aaac-0003"];
    for (const id of ids) await writeRun(id, "x\n");
    const limited = new RunStore({ home, retention: { maxRuns: 2, maxBytes: 268_435_456 } });
    await limited.enforceRetention();
    await expect(limited.readRun("aaaa-0001")).rejects.toBeInstanceOf(RunNotFoundError);
    expect((await limited.readRun("aaac-0003")).text).toBe("x\n");
    await expect(stat(store.metaPath("aaaa-0001"))).rejects.toThrow();
  });

  it("deletes the oldest runs beyond maxBytes", async () => {
    const ids = ["baaa-0001", "baab-0002"];
    for (const id of ids) await writeRun(id, "y".repeat(4_000));
    const limited = new RunStore({ home, retention: { maxRuns: 200, maxBytes: 5_000 } });
    await limited.enforceRetention();
    await expect(limited.readRun("baaa-0001")).rejects.toBeInstanceOf(RunNotFoundError);
    expect((await limited.readRun("baab-0002")).text.length).toBe(4_000);
  });

  it("does nothing when there is no run directory", async () => {
    await expect(store.enforceRetention()).resolves.toBeUndefined();
  });
});
