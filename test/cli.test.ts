import { readFile, readdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { runCli } from "../src/cli.js";
import { splitLines } from "../src/lines.js";
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
      `line 1\nline 2\nline 3\njevprune: fallback (no Jev: no api key), 3 → 3 lines, exit 0, full output ${join(home, "runs", `${String(id)}.log`)}\n`,
    );
    expect(io.err()).toBe("");

    const store = new RunStore({ home });
    const record = await store.readRun(String(id));
    expect(record.text).toBe("line 1\nline 2\nline 3\n");
    expect(record.meta?.mode).toBe("fallback");
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
    expect(base.err()).toBe("jevprune: pruning failed (Error), output passed through\n");
  });

  it("falls back with the exact line count when the capture is truncated", async () => {
    await writeConfig(home, { fastPathLines: 0, maxPruneBytes: 1024, headLines: 2, tailLines: 2 });
    const io = testIo(homeEnv(home));
    const script =
      "for (let i = 1; i <= 200; i += 1) process.stdout.write('line ' + i + ' ' + 'y'.repeat(30) + '\\n');";
    expect(await runCli(["run", "--task", "check the output", "--", ...node(script)], io)).toBe(0);

    const [id] = await runIds();
    expect(io.out()).toContain("jevprune: fallback (no Jev: output over 1024 bytes), 200 → ");
    expect(io.out()).toContain(`full output ${join(home, "runs", `${String(id)}.log`)}`);

    const record = await new RunStore({ home }).readRun(String(id));
    expect(splitLines(record.text)).toHaveLength(200);
    expect(record.meta?.mode).toBe("fallback");
    expect(record.meta?.lines).toBe(200);
    expect(record.meta?.fallbackReason).toBe("output over 1024 bytes");
  });

  it("reports the run store as unavailable in the footer", async () => {
    await writeConfig(home, { fastPathLines: 0 });
    await writeFile(join(home, "runs"), "", "utf8");
    const io = testIo(homeEnv(home));
    const script = "process.stdout.write('one\\ntwo\\n');";
    expect(await runCli(["run", "--task", "check the output", "--", ...node(script)], io)).toBe(0);
    expect(io.out()).toBe(
      "one\ntwo\njevprune: fallback (no Jev: no api key), 2 → 2 lines, exit 0, run store unavailable (EEXIST)\n",
    );
  });

  it("names a missing key once per home, and only in hook mode", async () => {
    await writeConfig(home, { fastPathLines: 0 });
    const script = "process.stdout.write('ok\\n');";

    const plain = testIo(homeEnv(home));
    expect(await runCli(["run", "--", ...node(script)], plain)).toBe(0);
    expect(plain.err()).toBe("");

    const first = testIo(homeEnv(home));
    expect(await runCli(["run", "--hook", "--", ...node(script)], first)).toBe(0);
    expect(first.err()).toBe("jevprune: TYPESAFE_API_KEY not set, using fallback\n");

    const second = testIo(homeEnv(home));
    expect(await runCli(["run", "--hook", "--", ...node(script)], second)).toBe(0);
    expect(second.err()).toBe("");
  });

  it("names a rejected key every time in hook mode", async () => {
    await writeConfig(home, { fastPathLines: 0, tailLines: 0, contextLines: 0, headLines: 1 });
    const server = createServer((_request, response) => {
      response.writeHead(401, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { message: "invalid api key" } }));
    });
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });
    const port = (server.address() as AddressInfo).port;
    const env = {
      ...homeEnv(home),
      TYPESAFE_API_KEY: "test-key",
      TYPESAFE_BASE_URL: `http://127.0.0.1:${String(port)}`,
    };
    try {
      const script = "for (let i = 1; i <= 5; i += 1) process.stdout.write('line ' + i + '\\n');";
      for (const attempt of [1, 2]) {
        const io = testIo(env);
        expect(await runCli(["run", "--hook", "--", ...node(script)], io)).toBe(0);
        expect(io.err(), `attempt ${String(attempt)}`).toBe(
          "jevprune: TYPESAFE_API_KEY rejected (401), using fallback\n",
        );
        expect(io.out()).toContain("jevprune: fallback (no Jev: unauthorized (401)), 5 → ");
      }
    } finally {
      await new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
      });
    }
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

describe("cli show", () => {
  async function savedRun(): Promise<string> {
    await writeConfig(home, { fastPathLines: 0 });
    const io = testIo(homeEnv(home));
    const script = "for (let i = 1; i <= 4; i += 1) process.stdout.write('line ' + i + '\\n');";
    expect(await runCli(["run", "--task", "check the output", "--", ...node(script)], io)).toBe(0);
    const [id] = await runIds();
    expect(id).toBeDefined();
    return String(id);
  }

  it("prints the whole run log", async () => {
    const id = await savedRun();
    const io = testIo(homeEnv(home));
    expect(await runCli(["show", id], io)).toBe(0);
    expect(io.out()).toBe("line 1\nline 2\nline 3\nline 4\n");
  });

  it("prints a line range written with a dash or a colon", async () => {
    const id = await savedRun();
    for (const range of ["2-3", "2:3"]) {
      const io = testIo(homeEnv(home));
      expect(await runCli(["show", id, "--lines", range], io)).toBe(0);
      expect(io.out()).toBe("line 2\nline 3\n");
    }
  });

  it("exits 1 for an unknown id, a range outside the run and a malformed range", async () => {
    const id = await savedRun();

    const unknown = testIo(homeEnv(home));
    expect(await runCli(["show", "zzzz-0000"], unknown)).toBe(1);
    expect(unknown.err()).toBe("jevprune: run zzzz-0000 was not found\n");

    const outside = testIo(homeEnv(home));
    expect(await runCli(["show", id, "--lines", "3-9"], outside)).toBe(1);
    expect(outside.err()).toBe(`jevprune: line range 3-9 is outside run ${id} (4 lines)\n`);

    const malformed = testIo(homeEnv(home));
    expect(await runCli(["show", id, "--lines", "two"], malformed)).toBe(1);
    expect(malformed.err()).toBe('jevprune: --lines must be A-B or A:B, got "two"\n');

    const inverted = testIo(homeEnv(home));
    expect(await runCli(["show", id, "--lines", "3-2"], inverted)).toBe(1);
    expect(inverted.err()).toBe('jevprune: --lines must be a range with 1 <= A <= B, got "3-2"\n');
  });

  it("rejects a missing id and a second id with exit 2", async () => {
    const missing = testIo(homeEnv(home));
    expect(await runCli(["show"], missing)).toBe(2);
    expect(missing.err()).toBe("jevprune: show needs a run id\n");

    const extra = testIo(homeEnv(home));
    expect(await runCli(["show", "a-0001", "b-0002"], extra)).toBe(2);
    expect(extra.err()).toBe("jevprune: show takes one run id, got 2\n");
  });
});

describe("cli gain", () => {
  it("sums the ledger", async () => {
    await writeConfig(home, { fastPathLines: 0 });
    const store = new RunStore({ home });
    await store.appendGain({
      ts: new Date().toISOString(),
      id: "aaaa-0001",
      mode: "jev",
      linesIn: 1200,
      linesOut: 90,
      bytesIn: 60_000,
      bytesOut: 3_000,
    });
    await store.appendGain({
      ts: new Date().toISOString(),
      id: "aaaa-0002",
      mode: "jev",
      linesIn: 800,
      linesOut: 10,
      bytesIn: 40_000,
      bytesOut: 1_000,
    });

    const io = testIo(homeEnv(home));
    expect(await runCli(["gain"], io)).toBe(0);
    expect(io.out()).toBe(
      "jevprune: 2 runs, 2,000 → 100 lines, ~32,000 tokens saved (estimated at 3 chars per token)\n",
    );
  });

  it("reports zeros when nothing has run", async () => {
    const io = testIo(homeEnv(home));
    expect(await runCli(["gain"], io)).toBe(0);
    expect(io.out()).toBe("jevprune: 0 runs, 0 → 0 lines, ~0 tokens saved (estimated at 3 chars per token)\n");
  });

  it("rejects a flag with exit 2", async () => {
    const io = testIo(homeEnv(home));
    expect(await runCli(["gain", "--nope"], io)).toBe(2);
    expect(io.err()).toMatch(/^jevprune: /);
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
      `alpha\nbeta\njevprune: fallback (no Jev: no api key), 2 → 2 lines, full output ${join(home, "runs", `${String(id)}.log`)}\n`,
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
