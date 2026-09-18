import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";

import type { CliIo } from "../../src/io.js";

export async function makeHome(): Promise<string> {
  return await mkdtemp(join(tmpdir(), "jevprune-test-"));
}

export async function removeHome(home: string): Promise<void> {
  await rm(home, { recursive: true, force: true });
}

export interface TestIo extends CliIo {
  out(): string;
  err(): string;
}

export function testIo(env: NodeJS.ProcessEnv, stdin = ""): TestIo {
  let out = "";
  let err = "";
  return {
    env,
    cwd: process.cwd(),
    stdin: Readable.from([Buffer.from(stdin, "utf8")]),
    write: (text) => {
      out += text;
      return Promise.resolve();
    },
    writeError: (text) => {
      err += text;
      return Promise.resolve();
    },
    out: () => out,
    err: () => err,
  };
}

export function homeEnv(home: string): NodeJS.ProcessEnv {
  return { JEVPRUNE_HOME: home };
}

export async function writeConfig(home: string, config: Record<string, unknown>): Promise<void> {
  await writeFile(join(home, "config.json"), JSON.stringify(config), "utf8");
}
