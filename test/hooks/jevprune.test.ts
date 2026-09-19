import { describe, expect, it } from "vitest";

import { JevpruneError, RunStoreError } from "../../src/core/errors.js";
import { createHookState, handleBashResult, resolveApiKey, resolveHookOptions } from "../../src/core/hook.js";
import type { BashAnswer, HookDeps, HookOptions } from "../../src/core/hook.js";
import { createFakeEngine } from "../helpers/fake-engine.js";
import type { FakeEngine } from "../helpers/fake-engine.js";

const USER_HOME = "/home/ibra";
const HOME = `${USER_HOME}/.jevprune`;
const COMMAND = "pnpm build";
const API_KEY = "sk-test";
const OPTIONS: HookOptions = { diagnostics: false };
const ENV = { HOME: USER_HOME, TYPESAFE_API_KEY: API_KEY };

function buildLines(count: number, text: (n: number) => string): string {
  let out = "";
  for (let n = 1; n <= count; n += 1) out += `${text(n)}\n`;
  return out;
}

function inlineAnswer(stdout: string, extra: Readonly<Record<string, unknown>> = {}): BashAnswer {
  return { result: { stdout, stderr: "", interrupted: false, ...extra }, text: stdout };
}

function runIdOf(engine: FakeEngine): string {
  for (const path of engine.files.keys()) {
    const match = /\/runs\/(.+)\.log$/.exec(path);
    const id = match?.[1];
    if (id !== undefined) return id;
  }
  throw new JevpruneError("the hook wrote no run log");
}

function stdoutOf(answer: BashAnswer): string {
  const result = answer.result;
  if (typeof result !== "object" || result === null) throw new JevpruneError("the hook returned no result");
  const stdout = (result as { stdout?: unknown }).stdout;
  if (typeof stdout !== "string") throw new JevpruneError("the hook returned no stdout");
  return stdout;
}

function footerOf(answer: BashAnswer): string {
  const lines = stdoutOf(answer).trimEnd().split("\n");
  return lines[lines.length - 1] ?? "";
}

async function handle(
  deps: HookDeps,
  answer: BashAnswer,
  overrides: { readonly command?: string; readonly options?: HookOptions } = {},
): Promise<BashAnswer> {
  return await handleBashResult(
    deps,
    createHookState(),
    overrides.options ?? OPTIONS,
    { command: overrides.command ?? COMMAND },
    answer,
  );
}

describe("handleBashResult", () => {
  it("prunes an inline result and archives the run", async () => {
    const text = buildLines(200, (n) => `step ${String(n)}`);
    const engine = createFakeEngine({ env: ENV, noul: (id) => (id === "l100" ? 1 : 0) });
    const answer = inlineAnswer(text);

    const outcome = await handle(engine.deps, answer);

    const id = runIdOf(engine);
    const tail = buildLines(40, (n) => `step ${String(n + 160)}`);
    const kept =
      `[jevprune: 99 lines dropped, run ${id}, lines 1-99]\n` +
      `step 100\n` +
      `[jevprune: 60 lines dropped, run ${id}, lines 101-160]\n` +
      tail;
    const footer = `jevprune: 200 → 43 lines, exit 0, full output ~/.jevprune/runs/${id}.log`;

    expect(outcome.result).toEqual({ stdout: `${kept}${footer}\n`, stderr: "", interrupted: false });
    expect(engine.toastCalls).toEqual([{ text: `200 → 43 lines, run ${id}`, timeoutMs: 8000 }]);
    expect(engine.files.get(`${HOME}/runs/${id}.log`)).toBe(text);

    const meta: unknown = JSON.parse(engine.files.get(`${HOME}/runs/${id}.json`) ?? "null");
    expect(meta).toMatchObject({
      id,
      command: COMMAND,
      argv: [],
      exitCode: 0,
      signal: null,
      mode: "jev",
      lines: 200,
      linesOut: 43,
    });

    const gain = (engine.files.get(`${HOME}/gain.jsonl`) ?? "").trimEnd().split("\n");
    expect(gain).toHaveLength(1);
    expect(JSON.parse(gain[0] ?? "null")).toMatchObject({ id, mode: "jev", linesIn: 200, linesOut: 43 });
  });

  it("prunes both streams into stdout and blanks stderr", async () => {
    const stdout = buildLines(300, (n) => `out ${String(n)}`);
    const stderr = buildLines(300, (n) => `err ${String(n)}`);
    const engine = createFakeEngine({
      env: ENV,
      noul: (id) => (id === "l1" || id === "l302" ? 1 : 0),
    });
    const answer: BashAnswer = { result: { stdout, stderr, interrupted: false }, text: stdout };

    const outcome = await handle(engine.deps, answer);

    const pruned = stdoutOf(outcome);
    expect(outcome.result).toMatchObject({ stderr: "", interrupted: false });
    expect(pruned).toContain("out 1\n");
    expect(pruned).toContain("err 1\n");
    expect(engine.files.get(`${HOME}/runs/${runIdOf(engine)}.log`)).toBe(`${stdout}\n${stderr}`);
  });

  it("logs the line counts and the request count when diagnostics are on", async () => {
    const engine = createFakeEngine({ env: ENV, noul: () => 1 });
    await handle(engine.deps, inlineAnswer(buildLines(200, (n) => `step ${String(n)}`)), {
      options: { diagnostics: true },
    });

    const id = runIdOf(engine);
    expect(engine.logs).toHaveLength(1);
    expect(engine.logs[0]).toMatch(
      new RegExp(`^jevprune: 200 → 200 lines, run ${id}, \\d+ requests, \\d+ ms$`),
    );
  });
});

describe("pass-through", () => {
  const cases: readonly {
    readonly name: string;
    readonly answer: BashAnswer;
    readonly command?: string;
    readonly env?: Readonly<Record<string, string>>;
  }[] = [
    { name: "denied", answer: { deny: "the user said no" } },
    { name: "isError", answer: { isError: true, result: "command failed", text: "command failed" } },
    {
      name: "interrupted",
      answer: inlineAnswer(buildLines(200, (n) => `step ${String(n)}`), { interrupted: true }),
    },
    {
      name: "recovery-read through jevprune show",
      answer: inlineAnswer(buildLines(200, (n) => `step ${String(n)}`)),
      command: "jevprune show m1xk2p7a-3f9c --lines 120-531",
    },
    {
      name: "recovery-read through the run path",
      answer: inlineAnswer(buildLines(200, (n) => `step ${String(n)}`)),
      command: "cat ~/.jevprune/runs/m1xk2p7a-3f9c.log",
    },
    { name: "fast-path", answer: inlineAnswer(buildLines(10, (n) => `step ${String(n)}`)) },
    {
      name: "binary",
      answer: inlineAnswer(buildLines(200, (n) => `step ${String(n)}\u0000\u0001\u0002`)),
    },
    {
      name: "document",
      answer: inlineAnswer(buildLines(200, (n) => `step ${String(n)}`)),
      command: "git diff",
    },
    {
      name: "secret",
      answer: inlineAnswer(buildLines(200, (n) => `step ${String(n)}`)),
      command: "printenv",
    },
    {
      name: "no-key",
      answer: inlineAnswer(buildLines(200, (n) => `step ${String(n)}`)),
      env: { HOME: USER_HOME },
    },
  ];

  for (const testCase of cases) {
    it(`returns the same answer for ${testCase.name}`, async () => {
      const engine = createFakeEngine({ env: testCase.env ?? ENV });
      const outcome = await handle(engine.deps, testCase.answer, {
        ...(testCase.command === undefined ? {} : { command: testCase.command }),
      });

      expect(outcome).toBe(testCase.answer);
      expect(engine.files.size).toBe(0);
      expect(engine.requests).toHaveLength(0);
      expect(engine.toasts).toHaveLength(0);
    });
  }

  it("names the reason when diagnostics are on", async () => {
    const engine = createFakeEngine({ env: ENV });
    await handle(engine.deps, inlineAnswer(buildLines(200, (n) => `step ${String(n)}`)), {
      command: "git diff",
      options: { diagnostics: true },
    });

    expect(engine.logs).toEqual(["jevprune: passed through (document)"]);
  });

  it("logs the missing key once per state", async () => {
    const engine = createFakeEngine({ env: { HOME: USER_HOME } });
    const state = createHookState();
    const answer = inlineAnswer(buildLines(200, (n) => `step ${String(n)}`));

    await handleBashResult(engine.deps, state, OPTIONS, { command: COMMAND }, answer);
    await handleBashResult(engine.deps, state, OPTIONS, { command: COMMAND }, answer);

    expect(engine.logs).toEqual(["jevprune: TYPESAFE_API_KEY not set, results pass through"]);
  });
});

describe("resolveHookOptions", () => {
  it("reads the plugin configuration", () => {
    expect(resolveHookOptions({ apiKey: API_KEY, threshold: 0.5, diagnostics: true })).toEqual({
      apiKey: API_KEY,
      threshold: 0.5,
      diagnostics: true,
    });
  });

  it("ignores a threshold outside [0, 1] and a threshold that is not a number", () => {
    expect(resolveHookOptions({ threshold: 1.5 })).toEqual({ diagnostics: false });
    expect(resolveHookOptions({ threshold: -0.1 })).toEqual({ diagnostics: false });
    expect(resolveHookOptions({ threshold: "0.5" })).toEqual({ diagnostics: false });
    expect(resolveHookOptions({ threshold: 0 })).toEqual({ diagnostics: false, threshold: 0 });
  });

  it("ignores a blank key and defaults diagnostics to false", () => {
    expect(resolveHookOptions({ apiKey: "   " })).toEqual({ diagnostics: false });
    expect(resolveHookOptions({ apiKey: ` ${API_KEY} ` })).toEqual({ apiKey: API_KEY, diagnostics: false });
    expect(resolveHookOptions({})).toEqual({ diagnostics: false });
    expect(resolveHookOptions({ diagnostics: "yes" })).toEqual({ diagnostics: false });
  });
});

describe("resolveApiKey", () => {
  const settings = { env: { TYPESAFE_API_KEY: "from-settings" } };

  it("prefers the option, then the environment, then the settings", async () => {
    const engine = createFakeEngine({ env: { TYPESAFE_API_KEY: "from-env" }, settings });
    expect(await resolveApiKey(engine.deps, { diagnostics: false, apiKey: "from-option" })).toBe("from-option");
    expect(await resolveApiKey(engine.deps, OPTIONS)).toBe("from-env");
  });

  it("reads each source on its own", async () => {
    const optionOnly = createFakeEngine();
    expect(await resolveApiKey(optionOnly.deps, { diagnostics: false, apiKey: "from-option" })).toBe("from-option");

    const envOnly = createFakeEngine({ env: { TYPESAFE_API_KEY: "from-env" } });
    expect(await resolveApiKey(envOnly.deps, OPTIONS)).toBe("from-env");

    const settingsOnly = createFakeEngine({ settings });
    expect(await resolveApiKey(settingsOnly.deps, OPTIONS)).toBe("from-settings");

    const none = createFakeEngine();
    expect(await resolveApiKey(none.deps, OPTIONS)).toBeUndefined();
  });
});

describe("configuration", () => {
  it("sends the session task with the Jev request", async () => {
    const engine = createFakeEngine({
      env: ENV,
      messages: [
        { role: "user", text: "fix the failing build" },
        { role: "assistant", text: "on it" },
      ],
    });

    await handle(engine.deps, inlineAnswer(buildLines(200, (n) => `step ${String(n)}`)));

    const body: unknown = JSON.parse(engine.requests[0]?.body ?? "null");
    expect(body).toMatchObject({ state: { task: `fix the failing build\n${COMMAND}`, command: COMMAND } });
  });

  it("lets the threshold option override the config file", async () => {
    const text = buildLines(200, (n) => `step ${String(n)}`);
    const files = { [`${HOME}/config.json`]: JSON.stringify({ threshold: 0.9 }) };

    const strict = createFakeEngine({ env: ENV, files, noul: () => 0.5 });
    const fromFile = await handle(strict.deps, inlineAnswer(text));

    const relaxed = createFakeEngine({ env: ENV, files, noul: () => 0.5 });
    const fromOption = await handle(relaxed.deps, inlineAnswer(text), {
      options: { diagnostics: false, threshold: 0.3 },
    });

    expect(footerOf(fromFile)).toContain("200 → 41 lines");
    expect(footerOf(fromOption)).toContain("200 → 200 lines");
  });

  it("passes a result over maxPruneBytes through untouched", async () => {
    const engine = createFakeEngine({
      env: ENV,
      files: { [`${HOME}/config.json`]: JSON.stringify({ maxPruneBytes: 512 }) },
    });
    const answer = inlineAnswer(buildLines(300, (n) => `step ${String(n)}`));

    const outcome = await handle(engine.deps, answer, { options: { diagnostics: true } });

    expect(outcome).toBe(answer);
    expect(engine.requests).toHaveLength(0);
    expect(engine.files.size).toBe(1);
    expect(engine.toasts).toHaveLength(0);
    expect(engine.logs).toEqual(["jevprune: passed through (oversize)"]);
  });

  it("reads the config file under JEVPRUNE_HOME", async () => {
    const engine = createFakeEngine({
      env: { HOME: USER_HOME, JEVPRUNE_HOME: "/custom/home", TYPESAFE_API_KEY: API_KEY },
      files: { "/custom/home/config.json": JSON.stringify({ fastPathLines: 500 }) },
    });
    const answer = inlineAnswer(buildLines(200, (n) => `step ${String(n)}`));

    const outcome = await handle(engine.deps, answer);

    expect(outcome).toBe(answer);
    expect(engine.files.size).toBe(1);
  });
});

describe("persisted output", () => {
  const PERSISTED_PATH = "/tmp/claude/tool-result.txt";

  function persistedAnswer(text: string, modelText: string): BashAnswer {
    return {
      result: {
        stdout: "the first lines only",
        stderr: "a warning",
        interrupted: false,
        persistedOutputPath: PERSISTED_PATH,
        persistedOutputSize: text.length,
      },
      text: modelText,
    };
  }

  it("prunes the persisted file and drops the persisted fields", async () => {
    const text = buildLines(200, (n) => `step ${String(n)}`);
    const engine = createFakeEngine({
      env: ENV,
      files: { [PERSISTED_PATH]: text },
      noul: (id) => (id === "l100" ? 1 : 0),
    });

    const outcome = await handle(engine.deps, persistedAnswer(text, text));

    const id = runIdOf(engine);
    expect(outcome.result).toEqual({
      stdout: stdoutOf(outcome),
      stderr: "",
      interrupted: false,
    });
    expect(footerOf(outcome)).toBe(
      `jevprune: 200 → 43 lines, exit 0, full output ~/.jevprune/runs/${id}.log`,
    );
    expect(engine.files.get(`${HOME}/runs/${id}.log`)).toBe(text);
  });

  it("prunes past the engine preview the model was given", async () => {
    const text = buildLines(300, (n) => `step ${String(n)} ${"y".repeat(40)}`);
    const engine = createFakeEngine({
      env: ENV,
      files: { [PERSISTED_PATH]: text },
      noul: (id) => (Number(id.slice(1)) <= 120 ? 1 : 0),
    });
    const answer = persistedAnswer(text, text.slice(0, 2_000));

    const outcome = await handle(engine.deps, answer);

    const pruned = stdoutOf(outcome);
    expect(outcome).not.toBe(answer);
    expect(pruned.length).toBeGreaterThan(2_000);
    expect(footerOf(outcome)).toBe(
      `jevprune: 300 → 161 lines, exit 0, full output ~/.jevprune/runs/${runIdOf(engine)}.log`,
    );
  });

  it("passes through and leaves no run files when the kept text cannot fit the budget", async () => {
    const text = buildLines(200, (n) => `step ${String(n)} ${"y".repeat(300)}`);
    const engine = createFakeEngine({
      env: ENV,
      files: { [PERSISTED_PATH]: text },
      httpStatus: 401,
    });
    const answer = persistedAnswer(text, text.slice(0, 2_000));

    const outcome = await handle(engine.deps, answer, { options: { diagnostics: true } });

    expect(outcome).toBe(answer);
    expect(engine.logs).toEqual(["jevprune: passed through (budget)"]);
    expect([...engine.files.keys()].some((path) => path.includes("/runs/"))).toBe(false);
    expect(engine.files.has(`${HOME}/gain.jsonl`)).toBe(false);
    expect(engine.processCalls).toContainEqual([
      "rm",
      "-f",
      expect.stringContaining(`${HOME}/runs/`),
      expect.stringContaining(`${HOME}/runs/`),
    ]);
  });
});

describe("archiving", () => {
  it("writes the log when no Jev request was needed", async () => {
    const text = buildLines(160, () => "") + buildLines(40, (n) => `step ${String(n + 160)}`);
    const engine = createFakeEngine({ env: ENV });

    const outcome = await handle(engine.deps, inlineAnswer(text));

    const id = runIdOf(engine);
    expect(engine.requests).toHaveLength(0);
    expect(engine.files.get(`${HOME}/runs/${id}.log`)).toBe(text);
    expect(footerOf(outcome)).toBe(
      `jevprune: 200 → 41 lines, exit 0, full output ~/.jevprune/runs/${id}.log`,
    );
  });

  it("falls back and still archives when Jev refuses the key", async () => {
    const text = buildLines(200, (n) => `step ${String(n)}`);
    const engine = createFakeEngine({ env: ENV, httpStatus: 401 });

    const outcome = await handle(engine.deps, inlineAnswer(text));

    const id = runIdOf(engine);
    expect(footerOf(outcome)).toBe(
      `jevprune: fallback (Jev unavailable: unauthorized (401)), 200 → 81 lines, exit 0, ` +
        `full output ~/.jevprune/runs/${id}.log`,
    );
    expect(engine.files.get(`${HOME}/runs/${id}.log`)).toBe(text);
  });

  it("reports the failure code when the log cannot be written", async () => {
    const text = buildLines(200, (n) => `step ${String(n)}`);
    const engine = createFakeEngine({
      env: ENV,
      noul: (id) => (id === "l100" ? 1 : 0),
      failWrite: (path) =>
        path.endsWith(".log") ? new RunStoreError(`${path} is not writable`, { code: "EACCES" }) : undefined,
    });

    const outcome = await handle(engine.deps, inlineAnswer(text));

    expect(footerOf(outcome)).toBe("jevprune: 200 → 43 lines, exit 0, full output was not saved (EACCES)");
    expect(stdoutOf(outcome)).toContain("lines dropped, run ");
  });

  it("removes the oldest runs through the retention plan", async () => {
    const text = buildLines(200, (n) => `step ${String(n)}`);
    const engine = createFakeEngine({
      env: ENV,
      files: {
        [`${HOME}/config.json`]: JSON.stringify({ retention: { maxRuns: 1, maxBytes: 1_000_000 } }),
        [`${HOME}/runs/m1aaaaaa-1111.log`]: "old output\n",
        [`${HOME}/runs/m1aaaaaa-1111.json`]: "{}\n",
      },
      noul: () => 1,
    });

    await handle(engine.deps, inlineAnswer(text));

    const id = runIdOf(engine);
    expect(engine.processCalls).toEqual([
      ["chmod", "600", `${HOME}/runs/${id}.log`],
      ["chmod", "600", `${HOME}/runs/${id}.json`],
      ["rm", "-f", `${HOME}/runs/m1aaaaaa-1111.log`, `${HOME}/runs/m1aaaaaa-1111.json`],
    ]);
    expect(engine.files.has(`${HOME}/runs/m1aaaaaa-1111.log`)).toBe(false);
  });

  it("takes every request timeout from the engine clock", async () => {
    const text = buildLines(200, (n) => `step ${String(n)}`);
    const engine = createFakeEngine({
      env: ENV,
      files: { [`${HOME}/config.json`]: JSON.stringify({ windowTimeoutMs: 1_234 }) },
      noul: () => 1,
    });

    await handle(engine.deps, inlineAnswer(text));

    expect(engine.timers.length).toBeGreaterThan(0);
    expect(engine.timers.every((timer) => timer.ms === 1_234)).toBe(true);
  });

  it("falls back when the engine clock fires the window timeout", async () => {
    const text = buildLines(200, (n) => `step ${String(n)}`);
    const engine = createFakeEngine({ env: ENV, fireTimers: true, noul: () => 1 });

    const outcome = await handle(engine.deps, inlineAnswer(text));

    expect(footerOf(outcome)).toContain("fallback (Jev unavailable: timeout)");
  });

  it("locks the run files to the owner", async () => {
    const text = buildLines(200, (n) => `step ${String(n)}`);
    const engine = createFakeEngine({ env: ENV, noul: (id) => (id === "l100" ? 1 : 0) });

    await handle(engine.deps, inlineAnswer(text));

    const id = runIdOf(engine);
    expect(engine.processCalls).toEqual([
      ["chmod", "600", `${HOME}/runs/${id}.log`],
      ["chmod", "600", `${HOME}/runs/${id}.json`],
    ]);
  });
});

describe("failures", () => {
  it("returns the answer untouched when the prune throws", async () => {
    const engine = createFakeEngine({ env: ENV });
    const deps: HookDeps = {
      ...engine.deps,
      session: {
        messages: () => Promise.reject(new JevpruneError("the transcript is unavailable")),
        cwd: () => Promise.resolve("/work"),
      },
    };
    const answer = inlineAnswer(buildLines(200, (n) => `step ${String(n)}`));

    const outcome = await handle(deps, answer, { options: { diagnostics: true } });

    expect(outcome).toBe(answer);
    expect(engine.logs).toEqual(["jevprune: passed through (error)"]);
  });

  it("removes the run files when the prune throws after the log was written", async () => {
    const engine = createFakeEngine({ env: ENV, noul: (id) => (id === "l100" ? 1 : 0) });
    let homeReads = 0;
    const deps: HookDeps = {
      ...engine.deps,
      env: {
        get: (name) => {
          if (name !== "HOME") return engine.deps.env.get(name);
          homeReads += 1;
          if (homeReads > 1) return Promise.reject(new JevpruneError("the home directory is unreadable"));
          return engine.deps.env.get(name);
        },
      },
    };
    const answer = inlineAnswer(buildLines(200, (n) => `step ${String(n)}`));

    const outcome = await handle(deps, answer);

    expect(outcome).toBe(answer);
    expect([...engine.files.keys()].some((path) => path.includes("/runs/"))).toBe(false);
    expect(engine.processCalls.some((argv) => argv[0] === "rm")).toBe(true);
  });
});
