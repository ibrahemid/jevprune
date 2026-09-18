import { readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { runCli } from "../src/cli.js";
import { RunStore } from "../src/store.js";
import { VERSION } from "../src/version.js";
import { homeEnv, makeHome, removeHome, testIo, writeConfig } from "./helpers/env.js";

let home = "";

beforeEach(async () => {
  home = await makeHome();
});

afterEach(async () => {
  await removeHome(home);
});

function node(script: string): string[] {
  return [process.execPath, "-e", script];
}

async function runIds(): Promise<string[]> {
  const names = await readdir(join(home, "runs"));
  return names.filter((name) => name.endsWith(".log")).map((name) => name.slice(0, -4));
}

describe("cli", () => {
  it("prints the version", async () => {
    const io = testIo(homeEnv(home));
    expect(await runCli(["--version"], io)).toBe(0);
    expect(io.out()).toBe(`${VERSION}\n`);
  });

  it("prints the help on request and on a bare invocation", async () => {
    const asked = testIo(homeEnv(home));
    expect(await runCli(["--help"], asked)).toBe(0);
    expect(asked.out()).toContain("usage: jevprune");

    const bare = testIo(homeEnv(home));
    expect(await runCli([], bare)).toBe(2);
    expect(bare.err()).toContain("usage: jevprune");
  });

  it("rejects an unknown command and an unknown flag with exit 2", async () => {
    const unknownCommand = testIo(homeEnv(home));
    expect(await runCli(["nope"], unknownCommand)).toBe(2);
    expect(unknownCommand.err()).toBe('jevprune: unknown command "nope"\n');

    const unknownFlag = testIo(homeEnv(home));
    expect(await runCli(["select", "--nope"], unknownFlag)).toBe(2);
    expect(unknownFlag.err()).toMatch(/^jevprune: /);
  });

  it("rejects run without a command after --", async () => {
    const io = testIo(homeEnv(home));
    expect(await runCli(["run", "--task", "x"], io)).toBe(2);
    expect(io.err()).toBe("jevprune: run needs a command after --\n");
  });
});

describe("cli run", () => {
  it("prints short output unchanged and keeps no run log", async () => {
    const io = testIo(homeEnv(home));
    const script = "for (let i = 1; i <= 3; i += 1) process.stdout.write('line ' + i + '\\n');";
    expect(await runCli(["run", "--task", "check the output", "--", ...node(script)], io)).toBe(0);
    expect(io.out()).toBe("line 1\nline 2\nline 3\n");
    expect(io.err()).toBe("");
    expect(await runIds()).toEqual([]);
    expect(await new RunStore({ home }).readGain()).toMatchObject({ runs: 1, linesIn: 3, linesOut: 3 });
  });

  it("prints every captured line with a footer and saves the run", async () => {
    await writeConfig(home, { fastPathLines: 0 });
    const io = testIo(homeEnv(home));
    const script = "for (let i = 1; i <= 3; i += 1) process.stdout.write('line ' + i + '\\n');";
    expect(await runCli(["run", "--task", "check the output", "--", ...node(script)], io)).toBe(0);

    const [id] = await runIds();
    expect(id).toBeDefined();
    expect(io.out()).toBe(
      `line 1\nline 2\nline 3\njevprune: exit 0, 3 lines passed through, full output ${join(home, "runs", `${String(id)}.log`)}\n`,
    );
    expect(io.err()).toBe("");

    const store = new RunStore({ home });
    const record = await store.readRun(String(id));
    expect(record.text).toBe("line 1\nline 2\nline 3\n");
    expect(record.meta?.mode).toBe("passthrough");
    expect(record.meta?.fallbackReason).toBe("no api key");
    expect(record.meta?.task).toBe("check the output");
    expect(record.meta?.exitCode).toBe(0);
    expect(await store.readGain()).toMatchObject({ runs: 1, linesIn: 3, linesOut: 3 });
  });

  it("prints the full captured output when pruning fails after the command ran", async () => {
    await writeConfig(home, { fastPathLines: 0 });
    const base = testIo(homeEnv(home));
    let failed = false;
    const io = {
      ...base,
      write: (text: string): Promise<void> => {
        if (failed) return base.write(text);
        failed = true;
        return Promise.reject(new Error("stdout is gone"));
      },
    };
    const script = "process.stdout.write('kept 1\\nkept 2\\n'); process.exit(5);";
    expect(await runCli(["run", "--", ...node(script)], io)).toBe(5);
    expect(base.out()).toBe("kept 1\nkept 2\n");
  });

  it("rejects a threshold outside [0, 1]", async () => {
    const io = testIo(homeEnv(home));
    expect(await runCli(["run", "--threshold", "2", "--", ...node("process.stdout.write('x\\n');")], io)).toBe(2);
    expect(io.err()).toBe('jevprune: --threshold must be a number in [0, 1], got "2"\n');
  });

  it("exits with the command's code", async () => {
    const io = testIo(homeEnv(home));
    expect(await runCli(["run", "--", ...node("process.stderr.write('boom\\n'); process.exit(7);")], io)).toBe(7);
    expect(io.out()).toContain("boom\n");
  });

  it("reports a missing executable with exit 127", async () => {
    const io = testIo(homeEnv(home));
    expect(await runCli(["run", "--", join(home, "missing-binary")], io)).toBe(127);
    expect(io.err()).toBe(`jevprune: command not found: ${join(home, "missing-binary")}\n`);
  });

  it("takes the task from the transcript only with --hook", async () => {
    await writeConfig(home, { fastPathLines: 0 });
    const transcript = join(home, "transcript.jsonl");
    await writeFile(transcript, JSON.stringify({ type: "user", message: { content: "fix the auth test" } }), "utf8");
    const io = testIo(homeEnv(home));
    const argv = ["run", "--hook", "--transcript", transcript, "--", ...node("process.stdout.write('ok\\n');")];
    expect(await runCli(argv, io)).toBe(0);
    const [id] = await runIds();
    const record = await new RunStore({ home }).readRun(String(id));
    expect(record.meta?.task).toBe("fix the auth test");
  });

  it("falls back to the command as the task", async () => {
    await writeConfig(home, { fastPathLines: 0 });
    const io = testIo(homeEnv(home));
    expect(await runCli(["run", "--", ...node("process.stdout.write('ok\\n');")], io)).toBe(0);
    const [id] = await runIds();
    const record = await new RunStore({ home }).readRun(String(id));
    expect(record.meta?.task).toBe(`${process.execPath} -e process.stdout.write('ok\\n');`);
  });
});

describe("cli select", () => {
  it("reads a file, prints it and saves the run", async () => {
    await writeConfig(home, { fastPathLines: 0 });
    const path = join(home, "input.log");
    await writeFile(path, "alpha\nbeta\n", "utf8");
    const io = testIo(homeEnv(home));
    expect(await runCli(["select", "--task", "read it", "--file", path], io)).toBe(0);

    const [id] = await runIds();
    expect(io.out()).toBe(
      `alpha\nbeta\njevprune: 2 lines passed through, full output ${join(home, "runs", `${String(id)}.log`)}\n`,
    );
    expect(await readFile(join(home, "runs", `${String(id)}.log`), "utf8")).toBe("alpha\nbeta\n");
  });

  it("reads stdin when no file is given", async () => {
    const io = testIo(homeEnv(home), "from stdin\n");
    expect(await runCli(["select"], io)).toBe(0);
    expect(io.out()).toContain("from stdin\n");
  });

  it("exits 1 when the input cannot be read", async () => {
    const io = testIo(homeEnv(home));
    expect(await runCli(["select", "--file", join(home, "missing.log")], io)).toBe(1);
    expect(io.err()).toMatch(/^jevprune: input could not be read: /);
    expect(io.out()).toBe("");
  });
});
