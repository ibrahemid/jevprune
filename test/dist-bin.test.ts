import { execFile } from "node:child_process";
import { mkdtemp, rm, stat, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

import { VERSION } from "../src/version.js";

const execFileAsync = promisify(execFile);
const root = fileURLToPath(new URL("..", import.meta.url));
const bin = join(root, "dist", "cli.js");

async function mtimeOf(path: string): Promise<number | undefined> {
  try {
    return (await stat(path)).mtimeMs;
  } catch {
    return undefined;
  }
}

async function buildIfStale(): Promise<boolean> {
  const built = await mtimeOf(bin);
  const source = await mtimeOf(join(root, "src", "cli.ts"));
  if (built !== undefined && source !== undefined && built >= source) return true;
  try {
    await execFileAsync("pnpm", ["exec", "tsup"], { cwd: root });
    return true;
  } catch {
    return false;
  }
}

describe("dist bin", () => {
  it(
    "runs when invoked through a symlink, as a global install does",
    async (ctx) => {
      if (!(await buildIfStale())) ctx.skip();
      const dir = await mkdtemp(join(tmpdir(), "jevprune-bin-"));
      try {
        const link = join(dir, "jevprune");
        await symlink(bin, link);
        const { stdout, stderr } = await execFileAsync(process.execPath, [link, "--version"], {
          cwd: dir,
          env: { PATH: process.env["PATH"] ?? "", JEVPRUNE_HOME: join(dir, "home") },
        });
        expect(stderr).toBe("");
        expect(stdout).toBe(`${VERSION}\n`);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
    180_000,
  );
});
