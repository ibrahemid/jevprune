import { spawn } from "node:child_process";
import type { ChildProcessByStdio } from "node:child_process";
import { constants } from "node:os";
import type { Readable } from "node:stream";

import { isValidUtf8 } from "./bytes.js";
import { OutputCapture } from "./capture.js";
import type { CapturedOutput } from "./capture.js";
import { RunStoreError, SpawnError, UsageError, errorCode, errorMessage } from "./errors.js";
import type { RunStore, RunWriter } from "./store.js";

type CapturedChild = ChildProcessByStdio<null, Readable, Readable>;

export const FORWARDED_SIGNALS: readonly NodeJS.Signals[] = ["SIGINT", "SIGTERM", "SIGHUP"];

export interface RunCapture extends CapturedOutput {
  readonly validUtf8: boolean;
  readonly exitCode: number;
  readonly signal: NodeJS.Signals | null;
  readonly interrupted: boolean;
  readonly startedAt: string;
  readonly endedAt: string;
  readonly storeFailure?: RunStoreError;
}

export interface RunCommandInput {
  readonly argv: readonly string[];
  readonly runId: string;
  readonly store: RunStore | null;
  readonly maxPruneBytes: number;
  readonly cwd?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly onSignalForward?: (signal: NodeJS.Signals) => void;
}

export async function runCommand(input: RunCommandInput): Promise<RunCapture> {
  const executable = input.argv[0];
  if (executable === undefined || executable.length === 0) {
    throw new UsageError("run needs a command to execute");
  }
  const writer = await openWriter(input);
  const capture = new OutputCapture(input.maxPruneBytes);
  let storeFailure = writer.failure;
  const startedAt = new Date().toISOString();

  const child = spawn(executable, input.argv.slice(1), {
    stdio: ["inherit", "pipe", "pipe"],
    shell: false,
    ...(input.cwd !== undefined ? { cwd: input.cwd } : {}),
    ...(input.env !== undefined ? { env: input.env } : {}),
  });

  let paused = false;
  const onChunk = (chunk: Buffer): void => {
    capture.push(chunk);
    const ready = writer.write(chunk);
    if (ready || paused) return;
    paused = true;
    child.stdout.pause();
    child.stderr.pause();
    writer.onDrain(() => {
      paused = false;
      child.stdout.resume();
      child.stderr.resume();
    });
  };
  child.stdout.on("data", onChunk);
  child.stderr.on("data", onChunk);

  let receivedSignal = false;
  const handlers = installSignalHandlers(child, (signal) => {
    receivedSignal = true;
    input.onSignalForward?.(signal);
  });

  let exit: { code: number | null; signal: NodeJS.Signals | null };
  try {
    exit = await waitForExit(child, executable);
  } finally {
    removeSignalHandlers(handlers);
    await writer.close();
  }
  storeFailure = writer.failure ?? storeFailure;

  const output = capture.result();
  return {
    ...output,
    validUtf8: isValidUtf8(output.captured),
    exitCode: exitCodeOf(exit),
    signal: exit.signal,
    interrupted: receivedSignal || exit.signal !== null,
    startedAt,
    endedAt: new Date().toISOString(),
    ...(storeFailure !== undefined ? { storeFailure } : {}),
  };
}

const NO_WRITER: RunWriter = {
  path: "",
  failure: undefined,
  write: () => true,
  onDrain: (listener) => {
    queueMicrotask(listener);
  },
  close: () => Promise.resolve(),
};

async function openWriter(input: RunCommandInput): Promise<RunWriter> {
  if (input.store === null) return NO_WRITER;
  try {
    return await input.store.openRun({ id: input.runId });
  } catch (error) {
    const failure =
      error instanceof RunStoreError
        ? error
        : new RunStoreError(`run log could not be opened: ${errorMessage(error)}`, { cause: error });
    return { ...NO_WRITER, failure };
  }
}

function waitForExit(
  child: CapturedChild,
  executable: string,
): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  return new Promise((resolve, reject) => {
    child.on("error", (error: unknown) => {
      reject(spawnError(error, executable));
    });
    child.on("close", (code, signal) => {
      resolve({ code, signal });
    });
  });
}

function spawnError(error: unknown, executable: string): SpawnError {
  const code = errorCode(error);
  const message =
    code === "ENOENT"
      ? `command not found: ${executable}`
      : code === "EACCES"
        ? `command not executable: ${executable}`
        : `command could not start: ${executable}: ${errorMessage(error)}`;
  return new SpawnError(message, {
    executable,
    ...(code !== undefined ? { code } : {}),
    cause: error,
  });
}

function installSignalHandlers(
  child: CapturedChild,
  onForward: (signal: NodeJS.Signals) => void,
): Map<NodeJS.Signals, () => void> {
  const handlers = new Map<NodeJS.Signals, () => void>();
  for (const signal of FORWARDED_SIGNALS) {
    const handler = (): void => {
      onForward(signal);
      child.kill(signal);
    };
    process.on(signal, handler);
    handlers.set(signal, handler);
  }
  return handlers;
}

function removeSignalHandlers(handlers: Map<NodeJS.Signals, () => void>): void {
  for (const [signal, handler] of handlers) process.off(signal, handler);
}

function exitCodeOf(exit: { code: number | null; signal: NodeJS.Signals | null }): number {
  if (exit.code !== null) return exit.code;
  if (exit.signal !== null) return 128 + (constants.signals[exit.signal] ?? 0);
  return 0;
}

