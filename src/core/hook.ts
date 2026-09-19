import { TYPESAFE_API_KEY_ENV } from "./client.js";
import { DEFAULT_CONFIG, HOME_ENV, parseConfig } from "./config.js";
import type { Config, ResolvedConfig, RetentionConfig } from "./config.js";
import { passthroughReason } from "./decide.js";
import type { PassthroughReason } from "./decide.js";
import { ConfigError, errorCode } from "./errors.js";
import { formatCount, formatFooter, withFooter } from "./footer.js";
import type { HookFetch } from "./http-client.js";
import { HttpJevClient } from "./http-client.js";
import { splitLines } from "./lines.js";
import { configFilePath, joinHomePath, runLogPath, runMetaPath } from "./paths.js";
import { pruneCore } from "./prune-core.js";
import type { RunRecordPlan } from "./record.js";
import { refitToBudget } from "./refit.js";
import { planRetention } from "./retention.js";
import type { RetentionEntry } from "./retention.js";
import { newRunId } from "./run-id.js";
import type { SelectionResult } from "./select.js";
import { RUNS_DIR, RUN_ID_PATTERN } from "./store-types.js";
import { persistRun } from "./store-writer.js";
import type { RunFiles } from "./store-writer.js";
import { taskFromMessages } from "./task.js";
import type { TaskMessage } from "./task.js";
import { utf8Length } from "./text.js";

const USER_HOME_ENV = "HOME";
const HOME_DIR_NAME = ".jevprune";
const TOAST_TIMEOUT_MS = 8_000;
const MAX_REMOVE_PATHS = 50;
const MISSING_KEY_LINE = "jevprune: TYPESAFE_API_KEY not set, results pass through";
const CONFIG_IGNORED_LINE = "jevprune: config file ignored";
const RUN_FILE_EXTENSIONS = [".log", ".json"] as const;

export interface HookOptions {
  readonly apiKey?: string;
  readonly threshold?: number;
  readonly diagnostics: boolean;
}

export type HookPluginOptions = Readonly<Record<string, unknown>>;

export interface HookUi {
  log(text: string): void;
  toast(text: string, options?: { timeoutMs?: number }): void;
}

export interface FsEntry {
  readonly name: string;
  readonly kind: "file" | "dir" | "other";
  readonly size: number;
}

export interface HookDeps {
  readonly fs: RunFiles & { list(path: string): Promise<readonly FsEntry[]> };
  readonly http: { fetch: HookFetch };
  readonly env: { get(name: string): Promise<string | undefined> };
  readonly settings: { read(): Promise<Readonly<Record<string, unknown>>> };
  readonly session: {
    messages(): Promise<readonly TaskMessage[]>;
    cwd(): Promise<string>;
  };
  readonly ui: HookUi;
  readonly process?: { run(argv: readonly string[]): Promise<unknown> };
}

export interface BashResultRecord {
  readonly stdout: string;
  readonly stderr: string;
  readonly interrupted: boolean;
  readonly persistedOutputPath?: string;
  readonly persistedOutputSize?: number;
  readonly [key: string]: unknown;
}

export interface BashAnswer {
  readonly deny?: string | undefined;
  readonly isError?: boolean | undefined;
  readonly text?: string | undefined;
  readonly result?: unknown;
}

export interface BashEvent {
  readonly command: string;
  readonly tool_use_id?: string | undefined;
}

export interface HookState {
  keyNoticeShown: boolean;
}

type LogReason = PassthroughReason | "budget" | "error";

interface LogArchive {
  start(): void;
  wasStarted(): boolean;
  settle(): Promise<string | undefined>;
}

interface FooterParts {
  readonly selection: SelectionResult;
  readonly linesOut: number;
  readonly userHome: string | undefined;
  readonly logPath: string | undefined;
  readonly failureCode: string | undefined;
}

export function createHookState(): HookState {
  return { keyNoticeShown: false };
}

export function resolveHookOptions(options: HookPluginOptions): HookOptions {
  const apiKey = readText(options["apiKey"]);
  const threshold = readThreshold(options["threshold"]);
  return {
    ...(apiKey === undefined ? {} : { apiKey }),
    ...(threshold === undefined ? {} : { threshold }),
    diagnostics: options["diagnostics"] === true,
  };
}

export async function resolveApiKey(deps: HookDeps, options: HookOptions): Promise<string | undefined> {
  const fromOptions = readText(options.apiKey);
  if (fromOptions !== undefined) return fromOptions;
  const fromEnv = readText(await deps.env.get(TYPESAFE_API_KEY_ENV));
  if (fromEnv !== undefined) return fromEnv;
  const settings = await deps.settings.read();
  const env = settings["env"];
  return isRecord(env) ? readText(env[TYPESAFE_API_KEY_ENV]) : undefined;
}

export async function resolveHookHome(deps: HookDeps): Promise<string> {
  const override = readText(await deps.env.get(HOME_ENV));
  if (override !== undefined) {
    if (isAbsolutePath(override)) return override;
    return joinHomePath(await deps.session.cwd(), override);
  }
  const userHome = readText(await deps.env.get(USER_HOME_ENV));
  if (userHome === undefined) {
    throw new ConfigError(`${USER_HOME_ENV} is not set, so the jevprune home cannot be resolved`);
  }
  return joinHomePath(userHome, HOME_DIR_NAME);
}

export async function loadHookConfig(
  deps: HookDeps,
  home: string,
  options: HookOptions,
): Promise<ResolvedConfig> {
  const path = configFilePath(home);
  let config: Config = DEFAULT_CONFIG;
  if (await deps.fs.exists(path)) {
    try {
      config = parseConfig(await deps.fs.read(path), path);
    } catch (error) {
      if (!(error instanceof ConfigError)) throw error;
      logDiagnostic(deps, options, CONFIG_IGNORED_LINE);
    }
  }
  const threshold = options.threshold;
  return { ...config, ...(threshold === undefined ? {} : { threshold }), home };
}

export async function handleBashResult(
  deps: HookDeps,
  state: HookState,
  options: HookOptions,
  event: BashEvent,
  answer: BashAnswer,
): Promise<BashAnswer> {
  if (answer.deny !== undefined) return passThrough(deps, options, answer, "denied");
  if (answer.isError === true) return passThrough(deps, options, answer, "tool-error");
  const record = answer.result;
  if (!isBashResultRecord(record)) return passThrough(deps, options, answer, "tool-error");
  try {
    return await pruneBashResult(deps, state, options, event, answer, record);
  } catch {
    return passThrough(deps, options, answer, "error");
  }
}

async function pruneBashResult(
  deps: HookDeps,
  state: HookState,
  options: HookOptions,
  event: BashEvent,
  answer: BashAnswer,
  record: BashResultRecord,
): Promise<BashAnswer> {
  const persisted = readText(record.persistedOutputPath);
  const combined =
    persisted === undefined ? withStderr(record.stdout, record.stderr) : await deps.fs.read(persisted);

  const home = await resolveHookHome(deps);
  const config = await loadHookConfig(deps, home, options);
  const apiKey = await resolveApiKey(deps, options);

  const reason = passthroughReason({
    denied: false,
    isError: false,
    interrupted: record.interrupted,
    command: event.command,
    output: combined,
    lines: splitLines(combined).length,
    fastPathLines: config.fastPathLines,
    hasKey: apiKey !== undefined,
    home,
  });
  if (reason !== null || apiKey === undefined) {
    const passthrough = reason ?? "no-key";
    if (passthrough === "no-key" && !state.keyNoticeShown) {
      state.keyNoticeShown = true;
      deps.ui.log(MISSING_KEY_LINE);
    }
    return passThrough(deps, options, answer, passthrough);
  }

  const runId = newRunId();
  const logPath = runLogPath(home, runId);
  const archive = createLogArchive(deps.fs, logPath, combined);
  const client = new HttpJevClient({
    apiKey,
    fetch: deps.http.fetch,
    timeoutMs: config.windowTimeoutMs,
    onRequest: () => {
      archive.start();
    },
  });

  const task = taskFromMessages(await deps.session.messages(), event.command);
  const { selection, plan } = await pruneCore({
    text: combined,
    task,
    command: event.command,
    exitCode: 0,
    client,
    config,
    runId,
    bytes: utf8Length(combined),
    now: () => new Date().toISOString(),
  });

  if (!archive.wasStarted() && plan.persistLog) archive.start();
  const logFailureCode = await archive.settle();
  const savedLogPath = archive.wasStarted() && logFailureCode === undefined ? logPath : undefined;
  const userHome = await deps.env.get(USER_HOME_ENV);

  let kept = selection.kept;
  let linesOut = selection.linesOut;
  let footer = buildFooter({
    selection,
    linesOut,
    userHome,
    logPath: savedLogPath,
    failureCode: logFailureCode,
  });

  const maxChars = persisted === undefined ? Number.POSITIVE_INFINITY : (answer.text?.length ?? Number.POSITIVE_INFINITY);
  if (withFooter(kept, footer).length > maxChars) {
    if (selection.mode !== "jev") return passThrough(deps, options, answer, "budget");
    const refit = refitToBudget({
      lines: splitLines(combined),
      decisions: selection.decisions,
      runId,
      minCollapseLines: config.minCollapseLines,
      footer,
      maxChars,
      startThreshold: config.threshold,
    });
    if (refit === null) return passThrough(deps, options, answer, "budget");
    kept = refit.kept;
    linesOut = refit.linesOut;
  }

  const persistedRun = await persistRun({
    files: deps.fs,
    home,
    plan: refitPlan(plan, linesOut, kept),
    ...(savedLogPath === undefined ? {} : { logAlreadyAt: savedLogPath }),
  });
  await enforceHookRetention(deps, home, config.retention).catch(() => undefined);

  const failureCode = logFailureCode ?? persistedRun.failureCode;
  footer = buildFooter({
    selection,
    linesOut,
    userHome,
    logPath: persistedRun.logPath,
    failureCode,
  });
  const stdout = withFooter(kept, footer);
  if (stdout.length > maxChars) return passThrough(deps, options, answer, "budget");

  deps.ui.toast(
    `jevprune: ${formatCount(selection.linesIn)} → ${formatCount(linesOut)} lines, run ${runId}`,
    { timeoutMs: TOAST_TIMEOUT_MS },
  );
  logDiagnostic(
    deps,
    options,
    `jevprune: ${formatCount(selection.linesIn)} → ${formatCount(linesOut)} lines, run ${runId}, ` +
      `${String(selection.jevRequests)} requests, ${String(durationMs(plan))} ms`,
  );

  const result: Record<string, unknown> = { ...record, stdout, stderr: "" };
  delete result["persistedOutputPath"];
  delete result["persistedOutputSize"];
  return { result };
}

async function enforceHookRetention(
  deps: HookDeps,
  home: string,
  retention: RetentionConfig,
): Promise<void> {
  const runner = deps.process;
  if (runner === undefined) return;
  const entries = await deps.fs.list(joinHomePath(home, RUNS_DIR));
  const candidates: RetentionEntry[] = [];
  for (const entry of entries) {
    if (entry.kind !== "file") continue;
    const id = runIdFromFileName(entry.name);
    if (id === undefined) continue;
    candidates.push({ id, bytes: entry.size });
  }
  const paths: string[] = [];
  for (const id of planRetention(candidates, retention)) {
    paths.push(runLogPath(home, id), runMetaPath(home, id));
  }
  for (let index = 0; index < paths.length; index += MAX_REMOVE_PATHS) {
    await runner.run(["rm", "-f", ...paths.slice(index, index + MAX_REMOVE_PATHS)]);
  }
}

function runIdFromFileName(name: string): string | undefined {
  for (const extension of RUN_FILE_EXTENSIONS) {
    if (!name.endsWith(extension)) continue;
    const id = name.slice(0, name.length - extension.length);
    return RUN_ID_PATTERN.test(id) ? id : undefined;
  }
  return undefined;
}

function createLogArchive(files: RunFiles, path: string, text: string): LogArchive {
  let pending: Promise<void> | undefined;
  let failureCode: string | undefined;
  return {
    start(): void {
      if (pending !== undefined) return;
      pending = files.write(path, text).catch((error: unknown) => {
        failureCode = errorCode(error) ?? "failed";
      });
    },
    wasStarted(): boolean {
      return pending !== undefined;
    },
    async settle(): Promise<string | undefined> {
      if (pending !== undefined) await pending;
      return failureCode;
    },
  };
}

function refitPlan(plan: RunRecordPlan, linesOut: number, kept: string): RunRecordPlan {
  if (linesOut === plan.meta.linesOut) return plan;
  return {
    ...plan,
    meta: { ...plan.meta, linesOut },
    gain: { ...plan.gain, linesOut, bytesOut: utf8Length(kept) },
  };
}

function buildFooter(parts: FooterParts): string {
  const { selection } = parts;
  return formatFooter({
    mode: selection.mode,
    linesIn: selection.linesIn,
    linesOut: parts.linesOut,
    exitCode: 0,
    ...(parts.userHome === undefined ? {} : { userHome: parts.userHome }),
    ...(parts.logPath === undefined ? {} : { logPath: parts.logPath }),
    ...(parts.failureCode === undefined ? {} : { storeFailureCode: parts.failureCode }),
    ...(selection.fallbackReason === undefined ? {} : { fallbackReason: selection.fallbackReason }),
  });
}

function durationMs(plan: RunRecordPlan): number {
  const started = Date.parse(plan.meta.startedAt);
  const ended = Date.parse(plan.meta.endedAt);
  return Number.isFinite(started) && Number.isFinite(ended) ? Math.max(0, ended - started) : 0;
}

function passThrough(deps: HookDeps, options: HookOptions, answer: BashAnswer, reason: LogReason): BashAnswer {
  logDiagnostic(deps, options, `jevprune: passed through (${reason})`);
  return answer;
}

function logDiagnostic(deps: HookDeps, options: HookOptions, text: string): void {
  if (options.diagnostics) deps.ui.log(text);
}

function withStderr(stdout: string, stderr: string): string {
  return stderr.length === 0 ? stdout : `${stdout}\n${stderr}`;
}

function isBashResultRecord(value: unknown): value is BashResultRecord {
  if (!isRecord(value)) return false;
  return (
    typeof value["stdout"] === "string" &&
    typeof value["stderr"] === "string" &&
    typeof value["interrupted"] === "boolean"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isAbsolutePath(path: string): boolean {
  return /^([a-zA-Z]:[\\/]|[\\/])/.test(path);
}

function readText(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}

function readThreshold(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) return undefined;
  return value;
}
