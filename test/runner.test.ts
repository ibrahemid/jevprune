import { readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { SpawnError, UsageError } from "../src/errors.js";
import { splitLines } from "../src/lines.js";
import { runCommand } from "../src/runner.js";
import { RunStore, newRunId } from "../src/store.js";
import { makeHome, removeHome } from "./helpers/env.js";

let home = "";
let store: RunStore;

beforeEach(async () => {
  home = await makeHome();
  store = new RunStore({ home });
});

afterEach(async () => {
  await removeHome(home);
});

function node(script: string): string[] {
  return [process.execPath, "-e", script];
}

async function run(script: string, maxPruneBytes = 1_048_576): Promise<Awaited<ReturnType<typeof runCommand>>> {
  return await runCommand({ argv: node(script), runId: newRunId(), store, maxPruneBytes });
}

describe("runCommand", () => {
  it("passes the child's exit code through and captures stdout", async () => {
    const capture = await run("process.stdout.write('one\\ntwo\\n'); process.exit(3);");
    expect(capture.exitCode).toBe(3);
    expect(capture.text).toBe("one\ntwo\n");
    expect(capture.lines).toBe(2);
    expect(capture.bytes).toBe(8);
    expect(capture.interrupted).toBe(false);
    expect(capture.oversize).toBe(false);
  });

  it("captures stdout and stderr into one log", async () => {
    const capture = await run(
      "process.stdout.write('out\\n'); process.stderr.write('err\\n'); setTimeout(() => process.stdout.write('late\\n'), 30);",
    );
    expect(capture.text).toContain("out\n");
    expect(capture.text).toContain("err\n");
    expect(capture.text).toContain("late\n");
    expect(capture.lines).toBe(3);
  });

  it("writes the run log with mode 0600 and the same bytes it kept in memory", async () => {
    const id = newRunId();
    const capture = await runCommand({
      argv: node("process.stdout.write('x'.repeat(100) + '\\n');"),
      runId: id,
      store,
      maxPruneBytes: 1_048_576,
    });
    expect((await stat(store.logPath(id))).mode & 0o777).toBe(0o600);
    expect(await readFile(store.logPath(id), "utf8")).toBe(capture.text);
    expect(capture.storeFailure).toBeUndefined();
  });

  it("reports a child killed by a signal as 128 + signal", async () => {
    const capture = await run("process.kill(process.pid, 'SIGTERM');");
    expect(capture.signal).toBe("SIGTERM");
    expect(capture.exitCode).toBe(143);
    expect(capture.interrupted).toBe(true);
  });

  it("removes its signal handlers when the child exits", async () => {
    const before = process.listenerCount("SIGTERM");
    await run("process.stdout.write('done\\n');");
    expect(process.listenerCount("SIGTERM")).toBe(before);
  });

  it("reports a missing executable as a spawn error", async () => {
    await expect(
      runCommand({
        argv: [join(home, "not-an-executable")],
        runId: newRunId(),
        store,
        maxPruneBytes: 1_048_576,
      }),
    ).rejects.toBeInstanceOf(SpawnError);
  });

  it("rejects an empty argv", async () => {
    await expect(
      runCommand({ argv: [], runId: newRunId(), store, maxPruneBytes: 1_048_576 }),
    ).rejects.toBeInstanceOf(UsageError);
  });

  it("counts lines exactly when a terminator is split across chunks", async () => {
    const capture = await run("process.stdout.write('a\\r'); setTimeout(() => process.stdout.write('\\nb'), 40);");
    expect(capture.text).toBe("a\r\nb");
    expect(capture.lines).toBe(2);
    expect(capture.lines).toBe(splitLines(capture.text).length);
  });

  it("counts lone carriage returns and unterminated last lines", async () => {
    for (const [script, text] of [
      ["process.stdout.write('a\\rb\\rc');", "a\rb\rc"],
      ["process.stdout.write('a\\n');", "a\n"],
      ["process.stdout.write('');", ""],
    ] as const) {
      const capture = await run(script);
      expect(capture.text).toBe(text);
      expect(capture.lines).toBe(splitLines(text).length);
    }
  });

  it("keeps memory bounded on a 40 MiB output and still counts every line", async () => {
    const capture = await run(
      "const line = 'x'.repeat(1023) + '\\n'; for (let i = 0; i < 40960; i += 1) process.stdout.write(line);",
      262_144,
    );
    expect(capture.bytes).toBe(41_943_040);
    expect(capture.lines).toBe(40_960);
    expect(capture.oversize).toBe(true);
    expect(Buffer.byteLength(capture.text)).toBeLessThanOrEqual(262_144 + 256 * 1024);
    for (const line of splitLines(capture.text)) {
      expect(line.text === "" || line.text === "x".repeat(1023)).toBe(true);
    }
  });

  it("keeps capturing when the run store cannot be opened", async () => {
    const blocker = join(home, "blocker");
    await writeFile(blocker, "", "utf8");
    const broken = new RunStore({ home: join(blocker, "inside") });
    const capture = await runCommand({
      argv: node("process.stdout.write('still here\\n');"),
      runId: newRunId(),
      store: broken,
      maxPruneBytes: 1_048_576,
    });
    expect(capture.text).toBe("still here\n");
    expect(capture.exitCode).toBe(0);
    expect(capture.storeFailure?.code).toBe("ENOTDIR");
  });

  it("captures without a store", async () => {
    const capture = await runCommand({
      argv: node("process.stdout.write('no store\\n');"),
      runId: newRunId(),
      store: null,
      maxPruneBytes: 1_048_576,
    });
    expect(capture.text).toBe("no store\n");
  });
});
