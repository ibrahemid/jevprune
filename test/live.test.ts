import { readFileSync } from "node:fs";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createJevClientFromEnv } from "../src/core/index.js";
import { pruneOutput } from "../src/prune.js";
import { homeEnv, makeHome, removeHome } from "./helpers/env.js";

const LIVE = process.env["JEVPRUNE_LIVE"] === "1";
const TIMEOUT_MS = 300_000;

describe.skipIf(!LIVE)("live jev", () => {
  let home = "";

  beforeEach(async () => {
    home = await makeHome();
  });

  afterEach(async () => {
    await removeHome(home);
  });

  it(
    "keeps the failure block for both demo tasks and more lines for the slow one",
    async () => {
      const text = readFileSync(new URL("./fixtures/npm-test.log", import.meta.url), "utf8");
      const client = createJevClientFromEnv({ TYPESAFE_API_KEY: process.env["TYPESAFE_API_KEY"] });
      const base = {
        text,
        command: "pnpm test",
        exitCode: 0,
        client,
        env: homeEnv(home),
        config: { windowTimeoutMs: 120_000 },
      };
      const auth = await pruneOutput({ ...base, task: "fix the failing auth test" });
      const slow = await pruneOutput({ ...base, task: "why is the build slow" });

      for (const result of [auth, slow]) {
        expect(result.mode, result.fallbackReason).toBe("jev");
        expect(result.kept).toContain("FAIL  src/auth/login.test.ts");
        expect(result.kept).toContain("AssertionError: expected 200 to be 401");
        expect(result.kept).toContain("❯ src/auth/login.test.ts:88:29");
        expect(result.linesOut).toBeLessThan(result.linesIn);
      }
      expect(slow.linesOut).toBeGreaterThan(auth.linesOut);
    },
    TIMEOUT_MS,
  );
});
