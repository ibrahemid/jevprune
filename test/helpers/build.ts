import { execFile } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const root = fileURLToPath(new URL("../..", import.meta.url));

let pending: Promise<string> | undefined;

export async function buildCli(): Promise<string> {
  pending ??= build();
  return await pending;
}

async function build(): Promise<string> {
  const out = await mkdtemp(join(tmpdir(), "jevprune-build-"));
  await execFileAsync("pnpm", ["exec", "tsup", "--out-dir", out], { cwd: root });
  return join(out, "cli.js");
}
