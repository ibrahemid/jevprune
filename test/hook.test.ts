import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { runCli } from "../src/cli.js";
import { DEFAULT_ALLOWLIST, DEFAULT_CONFIG } from "../src/config.js";
import type { ResolvedConfig } from "../src/config.js";
import {
  ALWAYS_INTERACTIVE_COMMANDS,
  INTERACTIVE_WHEN_BARE_COMMANDS,
  STATE_CHANGING_TOKENS,
  hasStateChange,
  parsePreToolUse,
  planRewrite,
  quoteForShell,
} from "../src/hook.js";
import type { PreToolUseInput } from "../src/hook.js";
import { homeEnv, makeHome, removeHome, testIo, writeConfig } from "./helpers/env.js";

const TRANSCRIPT = "/tmp/claude/transcript.jsonl";

function config(overrides: Partial<ResolvedConfig> = {}): ResolvedConfig {
  return { ...DEFAULT_CONFIG, home: "/nonexistent", ...overrides };
}

function event(command: string, extra: Partial<PreToolUseInput> = {}): PreToolUseInput {
  return { tool_name: "Bash", transcript_path: TRANSCRIPT, tool_input: { command }, ...extra };
}

function rewriteOf(command: string, overrides: Partial<ResolvedConfig> = {}): string | null {
  return planRewrite(event(command), config(overrides))?.command ?? null;
}

describe("planRewrite", () => {
  it("wraps a plain command", () => {
    expect(planRewrite(event("pnpm test"), config())).toEqual({
      command: `jevprune run --hook --transcript '${TRANSCRIPT}' -- bash -c 'pnpm test'`,
    });
  });

  it("quotes quotes, dollars, backticks and newlines for POSIX sh", () => {
    const command = "pnpm run 'build:all' $HOME `date`\nsecond";
    expect(rewriteOf(command)).toBe(
      `jevprune run --hook --transcript '${TRANSCRIPT}' -- bash -c 'pnpm run '\\''build:all'\\'' $HOME \`date\`\nsecond'`,
    );
    expect(quoteForShell("it's")).toBe("'it'\\''s'");
  });

  it("omits --transcript when the event carries no transcript path", () => {
    expect(planRewrite({ tool_name: "Bash", tool_input: { command: "pnpm test" } }, config())).toEqual({
      command: "jevprune run --hook -- bash -c 'pnpm test'",
    });
  });

  it("skips another tool", () => {
    expect(planRewrite({ ...event("pnpm test"), tool_name: "Read" }, config())).toBeNull();
    expect(planRewrite({ tool_input: { command: "pnpm test" } }, config())).toBeNull();
  });

  it("skips when autoWrap is off", () => {
    expect(rewriteOf("pnpm test", { autoWrap: false })).toBeNull();
  });

  it("skips a background command", () => {
    expect(
      planRewrite({ tool_name: "Bash", tool_input: { command: "pnpm test", run_in_background: true } }, config()),
    ).toBeNull();
  });

  it("skips an empty command and a missing tool input", () => {
    expect(rewriteOf("   ")).toBeNull();
    expect(planRewrite({ tool_name: "Bash" }, config())).toBeNull();
  });

  it("skips a command that already runs jevprune", () => {
    expect(rewriteOf("jevprune run -- pnpm test")).toBeNull();
    expect(rewriteOf("pnpm test 2>&1 | jevprune select --task 'x'")).toBeNull();
  });

  it("skips every state-changing token at the start and after a separator", () => {
    for (const token of STATE_CHANGING_TOKENS) {
      const statement = token === "." ? ". ./env.sh" : `${token} JEVPRUNE_TEST=1`;
      const commands = [
        statement,
        `pnpm build && ${statement}`,
        `pnpm build ; ${statement}`,
        `pnpm build | ${statement}`,
        `(${statement})`,
      ];
      for (const command of commands) {
        expect(hasStateChange(command), command).toBe(true);
        expect(rewriteOf(command), command).toBeNull();
      }
    }
  });

  it("skips a state-changing token at the start of a later line", () => {
    for (const separator of ["\n", "\r\n"]) {
      const command = `npm ci${separator}cd packages/app${separator}npm test`;
      expect(hasStateChange(command), JSON.stringify(command)).toBe(true);
      expect(rewriteOf(command), JSON.stringify(command)).toBeNull();
    }
  });

  it("wraps a multi-line command with no state-changing token", () => {
    const command = "npm ci\nnpm test";
    expect(hasStateChange(command)).toBe(false);
    expect(rewriteOf(command)).not.toBeNull();
  });

  it("wraps commands that only start with a state-changing token", () => {
    for (const command of ["setup.sh --check", "exports/build.sh", "./env.sh", "cdk deploy"]) {
      expect(hasStateChange(command), command).toBe(false);
      expect(rewriteOf(command), command).not.toBeNull();
    }
  });

  it("skips every always-interactive first word, after sudo and after env assignments", () => {
    for (const word of ALWAYS_INTERACTIVE_COMMANDS) {
      expect(rewriteOf(`${word} --version`), word).toBeNull();
      expect(rewriteOf(`sudo ${word} --version`), word).toBeNull();
      expect(rewriteOf(`FOO=bar ${word} --version`), word).toBeNull();
    }
  });

  it("skips bare REPLs and shells but wraps them when they take arguments", () => {
    for (const word of INTERACTIVE_WHEN_BARE_COMMANDS) {
      expect(rewriteOf(word), word).toBeNull();
      expect(rewriteOf(`FOO=bar ${word}`), word).toBeNull();
      if (word !== "gh") expect(rewriteOf(`${word} --version`), word).not.toBeNull();
    }
    expect(rewriteOf("python -m pytest -q")).not.toBeNull();
    expect(rewriteOf("python3 scripts/build.py")).not.toBeNull();
    expect(rewriteOf("node scripts/check.js")).not.toBeNull();
    expect(rewriteOf("bash scripts/gate.sh")).not.toBeNull();
    expect(rewriteOf("sh -c 'npm test 2>&1'")).not.toBeNull();
    expect(rewriteOf("psql -c 'select 1'")).not.toBeNull();
    expect(rewriteOf("gh pr list")).not.toBeNull();
    expect(rewriteOf("bash -i")).toBeNull();
    expect(rewriteOf("zsh -i -c ls")).toBeNull();
    expect(rewriteOf("gh auth login")).toBeNull();
  });

  it("skips docker exec and run with a terminal flag", () => {
    for (const command of ["docker exec -it web sh", "docker exec -i web sh", "docker run --rm -it node:22 bash", "docker run --interactive --tty img"]) {
      expect(rewriteOf(command), command).toBeNull();
    }
    for (const command of ["docker exec web ls -la", "docker run --rm node:22 node -v", "docker compose up -d"]) {
      expect(rewriteOf(command), command).not.toBeNull();
    }
  });

  it("skips tail -f and wraps other tails", () => {
    expect(rewriteOf("tail -f server.log")).toBeNull();
    expect(rewriteOf("FOO=bar tail -f server.log")).toBeNull();
    expect(rewriteOf("tail -n 40 server.log")).not.toBeNull();
    expect(rewriteOf("FOO=bar pnpm test")).not.toBeNull();
  });

  it("skips a command that ends in the background", () => {
    expect(rewriteOf("pnpm build &")).toBeNull();
    expect(rewriteOf("pnpm build && pnpm test")).not.toBeNull();
  });

  it("skips every allowlisted prefix and wraps commands that only look allowlisted", () => {
    for (const prefix of DEFAULT_ALLOWLIST) {
      expect(rewriteOf(prefix), prefix).toBeNull();
      expect(rewriteOf(`${prefix} something`), prefix).toBeNull();
    }
    expect(rewriteOf("lsof -i :3000")).not.toBeNull();
    expect(rewriteOf("testing/run.sh")).not.toBeNull();
    expect(rewriteOf("git diff --stat", { allowlist: ["git diff --stat"] })).toBeNull();
    expect(rewriteOf("git diff", { allowlist: ["git diff --stat"] })).not.toBeNull();
  });
});

describe("parsePreToolUse", () => {
  it("reads the fields it needs and ignores the rest", () => {
    const input = parsePreToolUse(
      JSON.stringify({
        session_id: "abc",
        tool_name: "Bash",
        transcript_path: TRANSCRIPT,
        tool_input: { command: "pnpm test", run_in_background: false, description: "run tests" },
      }),
    );
    expect(input).toEqual({
      tool_name: "Bash",
      transcript_path: TRANSCRIPT,
      tool_input: { command: "pnpm test", run_in_background: false },
    });
  });

  it("returns null for anything that is not a JSON object", () => {
    for (const raw of ["", "{", "null", "[]", '"text"']) {
      expect(parsePreToolUse(raw), raw).toBeNull();
    }
  });
});

describe("cli hook", () => {
  let home = "";

  beforeEach(async () => {
    home = await makeHome();
  });

  afterEach(async () => {
    await removeHome(home);
  });

  it("rewrites the command read from stdin", async () => {
    const stdin = JSON.stringify({
      tool_name: "Bash",
      transcript_path: TRANSCRIPT,
      tool_input: { command: "pnpm test" },
    });
    const io = testIo(homeEnv(home), stdin);
    expect(await runCli(["hook"], io)).toBe(0);
    expect(JSON.parse(io.out())).toEqual({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        updatedInput: { command: `jevprune run --hook --transcript '${TRANSCRIPT}' -- bash -c 'pnpm test'` },
      },
    });
    expect(io.err()).toBe("");
  });

  it("prints nothing for malformed stdin", async () => {
    const io = testIo(homeEnv(home), "{ not json");
    expect(await runCli(["hook"], io)).toBe(0);
    expect(io.out()).toBe("");
    expect(io.err()).toBe("");
  });

  it("prints nothing when the config turns autoWrap off", async () => {
    await writeConfig(home, { autoWrap: false });
    const stdin = JSON.stringify({ tool_name: "Bash", tool_input: { command: "pnpm test" } });
    const io = testIo(homeEnv(home), stdin);
    expect(await runCli(["hook"], io)).toBe(0);
    expect(io.out()).toBe("");
  });

  it("prints nothing when the config cannot be read", async () => {
    await writeConfig(home, { autoWrap: "yes" });
    const stdin = JSON.stringify({ tool_name: "Bash", tool_input: { command: "pnpm test" } });
    const io = testIo(homeEnv(home), stdin);
    expect(await runCli(["hook"], io)).toBe(0);
    expect(io.out()).toBe("");
    expect(io.err()).toMatch(/^jevprune: hook skipped: /);
  });
});
