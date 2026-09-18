import { loadConfig } from "./config.js";
import type { Config, ResolvedConfig } from "./config.js";
import { JevConfigError, createJevClientFromEnv } from "./core/index.js";
import type { JevClient } from "./core/index.js";
import { RunStoreError } from "./errors.js";
import { formatFooter } from "./footer.js";
import { readStream } from "./io.js";
import { selectLines } from "./select.js";
import type { SelectionResult } from "./select.js";
import { RunStore, newRunId } from "./store.js";
import type { RunMeta } from "./store.js";
import type { DroppedRange, SelectionMode } from "./types.js";

export interface PruneInput {
  readonly text: string;
  readonly task: string;
  readonly command?: string;
  readonly exitCode?: number | null;
  readonly client?: JevClient | null;
  readonly config?: Partial<Config>;
  readonly save?: boolean;
  readonly env?: NodeJS.ProcessEnv;
}

export interface PruneStreamInput extends Omit<PruneInput, "text"> {
  readonly stream: NodeJS.ReadableStream;
}

export interface PruneResult {
  readonly kept: string;
  readonly dropped: DroppedRange[];
  readonly runId: string;
  readonly mode: SelectionMode;
  readonly linesIn: number;
  readonly linesOut: number;
  readonly fallbackReason?: string;
  readonly logPath?: string;
  readonly footer: string;
}

export type RunMetaBase = Omit<RunMeta, "mode" | "linesOut" | "fallbackReason">;

export interface RecordRunInput {
  readonly store: RunStore | null;
  readonly selection: SelectionResult;
  readonly meta: RunMetaBase;
  readonly logText?: string;
  readonly storeFailureCode?: string;
}

export interface RecordRunResult {
  readonly footer: string;
  readonly logPath?: string;
}

export async function pruneOutput(input: PruneInput): Promise<PruneResult> {
  const env = input.env ?? process.env;
  const config = mergeConfig(await loadConfig(env), input.config);
  const client = input.client !== undefined ? input.client : clientFromEnv(env);
  const runId = newRunId();
  const command = input.command ?? "";
  const store =
    input.save === false ? null : new RunStore({ home: config.home, retention: config.retention });
  const startedAt = new Date().toISOString();

  const selection = await selectLines({
    text: input.text,
    task: input.task,
    command,
    exitCode: input.exitCode ?? null,
    client,
    config,
    runId,
  });

  const recorded = await recordRun({
    store,
    selection,
    logText: input.text,
    meta: {
      id: runId,
      command,
      argv: [],
      startedAt,
      endedAt: new Date().toISOString(),
      exitCode: input.exitCode ?? null,
      signal: null,
      bytes: selection.bytesIn,
      lines: selection.linesIn,
      task: input.task,
    },
  });

  return {
    kept: selection.kept,
    dropped: selection.dropped,
    runId,
    mode: selection.mode,
    linesIn: selection.linesIn,
    linesOut: selection.linesOut,
    ...(selection.fallbackReason !== undefined ? { fallbackReason: selection.fallbackReason } : {}),
    ...(recorded.logPath !== undefined ? { logPath: recorded.logPath } : {}),
    footer: recorded.footer,
  };
}

export async function pruneStream(input: PruneStreamInput): Promise<PruneResult> {
  const { stream, ...rest } = input;
  return await pruneOutput({ ...rest, text: await readStream(stream) });
}

export async function recordRun(input: RecordRunInput): Promise<RecordRunResult> {
  const { store, selection, meta } = input;
  const fastPath = selection.mode === "fast-path";
  let failureCode = input.storeFailureCode;

  if (store !== null && failureCode === undefined) {
    try {
      if (fastPath) {
        if (input.logText === undefined) await store.discardRun(meta.id);
      } else {
        if (input.logText !== undefined) await writeLog(store, meta.id, input.logText);
        await store.finalizeRun(meta.id, {
          ...meta,
          mode: selection.mode,
          linesOut: selection.linesOut,
          ...(selection.fallbackReason !== undefined ? { fallbackReason: selection.fallbackReason } : {}),
        });
      }
      await store.appendGain({
        ts: new Date().toISOString(),
        id: meta.id,
        mode: selection.mode,
        linesIn: selection.linesIn,
        linesOut: selection.linesOut,
        bytesIn: selection.bytesIn,
        bytesOut: selection.bytesOut,
      });
      await store.enforceRetention();
    } catch (error) {
      if (!(error instanceof RunStoreError)) throw error;
      failureCode = error.code ?? "failed";
    }
  }

  const logPath = store !== null && !fastPath && failureCode === undefined ? store.logPath(meta.id) : undefined;
  const footer = formatFooter({
    mode: selection.mode,
    linesIn: selection.linesIn,
    linesOut: selection.linesOut,
    exitCode: meta.exitCode,
    ...(selection.fallbackReason !== undefined ? { fallbackReason: selection.fallbackReason } : {}),
    ...(failureCode !== undefined ? { storeFailureCode: failureCode } : {}),
    ...(logPath !== undefined ? { logPath } : {}),
  });
  return { footer, ...(logPath !== undefined ? { logPath } : {}) };
}

export function clientFromEnv(env: NodeJS.ProcessEnv): JevClient | null {
  try {
    return createJevClientFromEnv(env);
  } catch (error) {
    if (error instanceof JevConfigError) return null;
    throw error;
  }
}

export function mergeConfig(base: ResolvedConfig, overrides: Partial<Config> | undefined): ResolvedConfig {
  if (overrides === undefined) return base;
  const defined: Partial<Config> = {};
  for (const key of Object.keys(overrides) as (keyof Config)[]) {
    if (overrides[key] !== undefined) Object.assign(defined, { [key]: overrides[key] });
  }
  return { ...base, ...defined };
}

async function writeLog(store: RunStore, id: string, text: string): Promise<void> {
  const writer = await store.openRun({ id });
  writer.write(Buffer.from(text, "utf8"));
  await writer.close();
  if (writer.failure !== undefined) throw writer.failure;
}
