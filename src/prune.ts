import { OutputCapture, captureBytes } from "./capture.js";
import type { CapturedOutput } from "./capture.js";
import { loadConfig } from "./config.js";
import type { Config, ResolvedConfig } from "./config.js";
import { JevConfigError, createJevClientFromEnv } from "./core/index.js";
import type { JevClient } from "./core/index.js";
import { RunStoreError } from "./errors.js";
import { formatFooter } from "./footer.js";
import { fallbackReasonText, selectLines } from "./select.js";
import type { SelectionResult } from "./select.js";
import { RunStore, newRunId } from "./store.js";
import type { RunMeta, RunWriter } from "./store.js";
import type { DroppedRange, FallbackReason, SelectionMode } from "./types.js";

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
  readonly fallbackReason?: FallbackReason;
  readonly logPath?: string;
  readonly footer: string;
}

export type RunMetaBase = Omit<RunMeta, "mode" | "linesOut" | "fallbackReason">;

interface PruneContext {
  readonly config: ResolvedConfig;
  readonly client: JevClient | null;
  readonly store: RunStore | null;
  readonly runId: string;
  readonly command: string;
}

interface SelectAndRecordInput {
  readonly prepared: PruneContext;
  readonly capture: CapturedOutput;
  readonly text: string;
  readonly task: string;
  readonly exitCode: number | null;
  readonly startedAt: string;
  readonly logBytes?: Buffer;
  readonly storeFailureCode?: string;
}

interface LogSink {
  write(chunk: Buffer): Promise<void>;
  close(): Promise<void>;
  failureCode(): string | undefined;
}

export interface RecordRunInput {
  readonly store: RunStore | null;
  readonly selection: SelectionResult;
  readonly meta: RunMetaBase;
  readonly logText?: string;
  readonly logBytes?: Buffer;
  readonly passthroughNote?: string;
  readonly storeFailureCode?: string;
}

export interface RecordRunResult {
  readonly footer: string;
  readonly logPath?: string;
}

export async function pruneOutput(input: PruneInput): Promise<PruneResult> {
  const prepared = await prepare(input);
  const startedAt = new Date().toISOString();
  const bytes = Buffer.from(input.text, "utf8");
  const capture = captureBytes(bytes, prepared.config.maxPruneBytes);

  return await selectAndRecord({
    prepared,
    capture,
    text: capture.oversize ? capture.captured.toString("utf8") : input.text,
    task: input.task,
    exitCode: input.exitCode ?? null,
    startedAt,
    logBytes: bytes,
  });
}

export async function pruneStream(input: PruneStreamInput): Promise<PruneResult> {
  const { stream, ...rest } = input;
  const prepared = await prepare(rest);
  const startedAt = new Date().toISOString();
  const sink = await openLogSink(prepared.store, prepared.runId);
  const capture = new OutputCapture(prepared.config.maxPruneBytes);

  try {
    for await (const chunk of stream as AsyncIterable<Buffer | string>) {
      const bytes = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk;
      capture.push(bytes);
      await sink.write(bytes);
    }
  } catch (error) {
    await sink.close();
    await discardPartialRun(prepared.store, prepared.runId);
    throw error;
  }
  await sink.close();

  const output = capture.result();
  const failureCode = sink.failureCode();
  return await selectAndRecord({
    prepared,
    capture: output,
    text: output.captured.toString("utf8"),
    task: input.task,
    exitCode: input.exitCode ?? null,
    startedAt,
    ...(failureCode !== undefined ? { storeFailureCode: failureCode } : {}),
  });
}

export async function recordRun(input: RecordRunInput): Promise<RecordRunResult> {
  const { store, selection, meta } = input;
  const fastPath = selection.mode === "fast-path";
  const log = input.logBytes ?? (input.logText !== undefined ? Buffer.from(input.logText, "utf8") : undefined);
  let failureCode = input.storeFailureCode;

  if (store !== null && failureCode === undefined) {
    try {
      if (fastPath) {
        if (log === undefined) await store.discardRun(meta.id);
      } else {
        if (log !== undefined) await writeLog(store, meta.id, log);
        await store.finalizeRun(meta.id, {
          ...meta,
          mode: selection.mode,
          linesOut: selection.linesOut,
          ...(selection.fallbackReason !== undefined
            ? { fallbackReason: fallbackReasonText(selection.fallbackReason) }
            : {}),
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
        ...(selection.fallbackReason !== undefined
          ? { reason: fallbackReasonText(selection.fallbackReason) }
          : {}),
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
    ...(input.passthroughNote !== undefined ? { passthroughNote: input.passthroughNote } : {}),
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

async function prepare(input: Omit<PruneInput, "text">): Promise<PruneContext> {
  const env = input.env ?? process.env;
  const config = mergeConfig(await loadConfig(env), input.config);
  return {
    config,
    client: input.client !== undefined ? input.client : clientFromEnv(env),
    store: input.save === false ? null : new RunStore({ home: config.home, retention: config.retention }),
    runId: newRunId(),
    command: input.command ?? "",
  };
}

async function selectAndRecord(input: SelectAndRecordInput): Promise<PruneResult> {
  const { prepared, capture } = input;
  const selection = await selectLines({
    text: input.text,
    task: input.task,
    command: prepared.command,
    exitCode: input.exitCode,
    ...(capture.oversize
      ? { oversize: { lines: capture.lines, headSegmentLines: capture.headSegmentLines } }
      : {}),
    client: prepared.client,
    config: prepared.config,
    runId: prepared.runId,
  });

  const recorded = await recordRun({
    store: prepared.store,
    selection,
    ...(input.logBytes !== undefined ? { logBytes: input.logBytes } : {}),
    ...(input.storeFailureCode !== undefined ? { storeFailureCode: input.storeFailureCode } : {}),
    meta: {
      id: prepared.runId,
      command: prepared.command,
      argv: [],
      startedAt: input.startedAt,
      endedAt: new Date().toISOString(),
      exitCode: input.exitCode,
      signal: null,
      bytes: capture.bytes,
      lines: selection.linesIn,
      task: input.task,
    },
  });

  return {
    kept: selection.kept,
    dropped: selection.dropped,
    runId: prepared.runId,
    mode: selection.mode,
    linesIn: selection.linesIn,
    linesOut: selection.linesOut,
    ...(selection.fallbackReason !== undefined ? { fallbackReason: selection.fallbackReason } : {}),
    ...(recorded.logPath !== undefined ? { logPath: recorded.logPath } : {}),
    footer: recorded.footer,
  };
}

async function openLogSink(store: RunStore | null, id: string): Promise<LogSink> {
  if (store === null) return discardingSink();
  let writer: RunWriter;
  try {
    writer = await store.openRun({ id });
  } catch (error) {
    if (!(error instanceof RunStoreError)) throw error;
    const code = error.code ?? "failed";
    return { ...discardingSink(), failureCode: () => code };
  }
  return {
    write: async (chunk) => {
      if (writer.write(chunk)) return;
      await new Promise<void>((resolve) => {
        writer.onDrain(resolve);
      });
    },
    close: async () => {
      await writer.close();
    },
    failureCode: () => (writer.failure === undefined ? undefined : (writer.failure.code ?? "failed")),
  };
}

async function discardPartialRun(store: RunStore | null, id: string): Promise<void> {
  if (store === null) return;
  try {
    await store.discardRun(id);
  } catch (error) {
    if (!(error instanceof RunStoreError)) throw error;
  }
}

function discardingSink(): LogSink {
  return {
    write: () => Promise.resolve(),
    close: () => Promise.resolve(),
    failureCode: () => undefined,
  };
}

async function writeLog(store: RunStore, id: string, bytes: Buffer): Promise<void> {
  const writer = await store.openRun({ id });
  writer.write(bytes);
  await writer.close();
  if (writer.failure !== undefined) throw writer.failure;
}
