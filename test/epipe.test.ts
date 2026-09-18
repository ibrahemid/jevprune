import { spawn } from "node:child_process";
import { rm } from "node:fs/promises";
import { dirname } from "node:path";

import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";

import { buildCli } from "./helpers/build.js";
import { makeHome, removeHome } from "./helpers/env.js";

let home = "";
let bin = "";

beforeEach(async () => {
  home = await makeHome();
});

afterEach(async () => {
  await removeHome(home);
});

afterAll(async () => {
  if (bin !== "") await rm(dirname(bin), { recursive: true, force: true });
});

describe("stdout closed early", () => {
  it(
    "keeps the child's exit code and prints nothing on stderr",
    async () => {
      bin = await buildCli();
      const child = spawn(process.execPath, [bin, "run", "--task", "count", "--", "sh", "-c", "seq 1 500; exit 7"], {
        env: { PATH: process.env["PATH"] ?? "", JEVPRUNE_HOME: home },
        stdio: ["ignore", "pipe", "pipe"],
      });
      child.stdout.destroy();
      let stderr = "";
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk: string) => {
        stderr += chunk;
      });

      const code = await new Promise<number | null>((resolve) => {
        child.on("close", (exitCode) => {
          resolve(exitCode);
        });
      });
      expect(stderr).toBe("");
      expect(code).toBe(7);
    },
    180_000,
  );
});
