import { describe, expect, it } from "vitest";

import { SIGNATURE_CASE_INSENSITIVE, SIGNATURE_CASE_SENSITIVE, computeKeeps, isSignatureLine } from "../src/keeps.js";
import { splitLines } from "../src/lines.js";

const VITEST_OUTPUT = [
  "> app@0.1.0 test",
  "> vitest run",
  "",
  " ✓ src/util/format.test.ts (4 tests) 6ms",
  " ❯ src/auth/login.test.ts (3 tests | 1 failed) 21ms",
  "   × keeps the session on a valid password 12ms",
  "     → expected false to be true",
  "",
  " FAIL  src/auth/login.test.ts > keeps the session on a valid password",
  "AssertionError: expected false to be true",
  " ❯ src/auth/login.test.ts:24:5",
  "      22|   const session = await login(user, password);",
  "      23|",
  "      24|   expect(session.active).toBe(true);",
  "    at Object.<anonymous> (/home/dev/app/src/auth/login.test.ts:24:5)",
  "",
  " Test Files  1 failed | 4 passed (5)",
  "      Tests  1 failed | 18 passed (19)",
  "   Duration  1.42s",
];

describe("isSignatureLine", () => {
  it("matches the failure vocabulary of common tools", () => {
    for (const line of [
      " FAIL  src/auth/login.test.ts",
      "AssertionError: expected false to be true",
      "ValueError: bad input",
      "E       assert 1 == 2",
      "npm ERR! code ELIFECYCLE",
      " Test Files  1 failed | 4 passed (5)",
      "   × keeps the session",
      " ❯ src/auth/login.test.ts:24:5",
      "error[E0308]: mismatched types",
      "Traceback (most recent call last):",
      '  File "/home/dev/app/app.py", line 12, in login',
      "    at Object.<anonymous> (/home/dev/app/src/auth/login.test.ts:24:5)",
      "  --> src/main.rs:14:9",
      "thread 'main' panicked at src/main.rs:14:9:",
      "bash: nope: command not found",
      "process exited with 1",
      "docker: Error response from daemon: no such file or directory",
      'time="2026-01-01T00:00:00Z" level=error msg="connection refused"',
      "[error] failed to compile",
      "=================== 1 failed, 2 passed in 0.12s ===================",
    ]) {
      expect(isSignatureLine(line), line).toBe(true);
    }
  });

  it("leaves warnings and routine progress to Jev", () => {
    for (const line of [
      "warning: unused variable `x`",
      "npm WARN deprecated glob@7.2.3",
      " ✓ src/util/format.test.ts (4 tests) 6ms",
      "Downloading node-22.0.0.tar.gz [==>        ] 22%",
      "  vite v7.0.0 building for production...",
      "> app@0.1.0 test",
      "  transforming (1243) src/main.ts",
      "webpack compiled successfully in 4200 ms",
    ]) {
      expect(isSignatureLine(line), line).toBe(false);
    }
  });

  it("keeps both regexes stateless", () => {
    expect(SIGNATURE_CASE_SENSITIVE.global).toBe(false);
    expect(SIGNATURE_CASE_INSENSITIVE.global).toBe(false);
    const line = "npm ERR! code ELIFECYCLE";
    expect(isSignatureLine(line)).toBe(true);
    expect(isSignatureLine(line)).toBe(true);
  });
});

describe("computeKeeps", () => {
  const lines = splitLines(`${VITEST_OUTPUT.join("\n")}\n`);

  it("keeps the failing assertion, its frame and its context", () => {
    const keeps = computeKeeps(lines, { tailLines: 0, contextLines: 1 });
    const kept = (text: string): number => lines.find((line) => line.text === text)?.n ?? -1;
    expect(keeps.get(kept("AssertionError: expected false to be true"))).toBe("signature");
    expect(keeps.get(kept("    at Object.<anonymous> (/home/dev/app/src/auth/login.test.ts:24:5)"))).toBe("signature");
    expect(keeps.get(kept("      24|   expect(session.active).toBe(true);"))).toBe("context");
    expect(keeps.has(kept("> vitest run"))).toBe(false);
    expect(keeps.get(kept("   Duration  1.42s"))).toBe("context");
  });

  it("keeps the last tailLines lines and lets signatures win over tail", () => {
    const keeps = computeKeeps(lines, { tailLines: 3, contextLines: 0 });
    expect(keeps.get(lines.length)).toBe("tail");
    expect(keeps.get(lines.length - 1)).toBe("signature");
    expect(keeps.get(lines.length - 2)).toBe("signature");
    expect(keeps.has(lines.length - 3)).toBe(false);
  });

  it("keeps only the first of repeated signature lines", () => {
    const repeated = splitLines(
      [
        "AssertionError: expected false to be true",
        "step 1",
        "step 2",
        "AssertionError: expected false to be true",
        "step 3",
      ].join("\n"),
    );
    const keeps = computeKeeps(repeated, { tailLines: 0, contextLines: 0 });
    expect(keeps.get(1)).toBe("signature");
    expect(keeps.has(4)).toBe(false);
  });

  it("clamps the context window to the output", () => {
    const short = splitLines("npm ERR! boom\nnext\n");
    const keeps = computeKeeps(short, { tailLines: 0, contextLines: 5 });
    expect([...keeps.entries()]).toEqual([
      [1, "signature"],
      [2, "context"],
    ]);
  });

  it("keeps nothing for output without signatures or tail", () => {
    expect(computeKeeps(splitLines("a\nb\nc\n"), { tailLines: 0, contextLines: 2 }).size).toBe(0);
  });
});
