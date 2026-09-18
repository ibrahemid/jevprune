import { spawn } from "node:child_process";
import type { ChildProcessByStdio } from "node:child_process";
import { constants } from "node:os";
import type { Readable } from "node:stream";

import { isValidUtf8 } from "./bytes.js";
import { RunStoreError, SpawnError, UsageError, errorCode, errorMessage } from "./errors.js";
import type { RunStore, RunWriter } from "./store.js";

type CapturedChild = ChildProcessByStdio<null, Readable, Readable>;

export const FORWARDED_SIGNALS: readonly NodeJS.Signals[] = ["SIGINT", "SIGTERM", "SIGHUP"];
export const TAIL_RING_BYTES = 256 * 1024;

const LF = 0x0a;
const CR = 0x0d;

export interface RunCapture {
  readonly captured: Buffer;
  readonly validUtf8: boolean;
  readonly bytes: number;
  readonly lines: number;
  readonly headSegmentLines: number;
  readonly exitCode: number;
  readonly signal: NodeJS.Signals | null;
  readonly interrupted: boolean;
  readonly oversize: boolean;
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

class LineCounter {
  #terminators = 0;
  #pendingCr = false;
  #lastByte: number | undefined;

  push(chunk: Buffer): void {
    for (const byte of chunk) {
      if (this.#pendingCr) {
        this.#pendingCr = false;
        this.#terminators += 1;
        if (byte === LF) {
          this.#lastByte = byte;
          continue;
        }
      }
      if (byte === CR) {
        this.#pendingCr = true;
        this.#lastByte = byte;
        continue;
      }
      if (byte === LF) this.#terminators += 1;
      this.#lastByte = byte;
    }
  }

  get terminators(): number {
    return this.#terminators + (this.#pendingCr ? 1 : 0);
  }

  get lines(): number {
    if (this.#lastByte === undefined) return 0;
    const endsWithTerminator = this.#lastByte === LF || this.#lastByte === CR;
    return this.terminators + (endsWithTerminator ? 0 : 1);
  }
}

class CaptureBuffer {
  readonly #maxBytes: number;
  readonly #head: Buffer[] = [];
  readonly #ring: Buffer[] = [];
  readonly #headCounter = new LineCounter();
  #headBytes = 0;
  #ringBytes = 0;
  #oversize = false;

  constructor(maxBytes: number) {
    this.#maxBytes = maxBytes;
  }

  get oversize(): boolean {
    return this.#oversize;
  }

  get headSegmentLines(): number {
    return this.#oversize ? this.#headCounter.terminators : this.#headCounter.lines;
  }

  push(chunk: Buffer): void {
    let rest = chunk;
    if (!this.#oversize) {
      const room = this.#maxBytes - this.#headBytes;
      if (rest.length <= room) {
        this.#head.push(rest);
        this.#headCounter.push(rest);
        this.#headBytes += rest.length;
        return;
      }
      if (room > 0) {
        const head = rest.subarray(0, room);
        this.#head.push(head);
        this.#headCounter.push(head);
        this.#headBytes += room;
        rest = rest.subarray(room);
      }
      this.#oversize = true;
    }
    this.#ring.push(rest);
    this.#ringBytes += rest.length;
    this.#trimRing();
  }

  bytes(): Buffer {
    if (!this.#oversize) return Buffer.concat(this.#head);
    const head = trimToLastTerminator(Buffer.concat(this.#head));
    const tail = trimToFirstLine(Buffer.concat(this.#ring));
    return Buffer.concat([head, tail]);
  }

  #trimRing(): void {
    while (this.#ringBytes > TAIL_RING_BYTES) {
      const first = this.#ring[0];
      if (first === undefined) return;
      const excess = this.#ringBytes - TAIL_RING_BYTES;
      if (first.length <= excess) {
        this.#ring.shift();
        this.#ringBytes -= first.length;
      } else {
        this.#ring[0] = first.subarray(excess);
        this.#ringBytes -= excess;
      }
    }
  }
}

export async function runCommand(input: RunCommandInput): Promise<RunCapture> {
  const executable = input.argv[0];
  if (executable === undefined || executable.length === 0) {
    throw new UsageError("run needs a command to execute");
  }
  const writer = await openWriter(input);
  const buffer = new CaptureBuffer(input.maxPruneBytes);
  const counter = new LineCounter();
  let bytes = 0;
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
    bytes += chunk.length;
    counter.push(chunk);
    buffer.push(chunk);
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

  const captured = buffer.bytes();
  return {
    captured,
    validUtf8: isValidUtf8(captured),
    bytes,
    lines: counter.lines,
    headSegmentLines: buffer.headSegmentLines,
    exitCode: exitCodeOf(exit),
    signal: exit.signal,
    interrupted: receivedSignal || exit.signal !== null,
    oversize: buffer.oversize,
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

function trimToLastTerminator(buffer: Buffer): Buffer {
  for (let index = buffer.length - 1; index >= 0; index -= 1) {
    const byte = buffer[index];
    if (byte === LF || byte === CR) return buffer.subarray(0, index + 1);
  }
  return buffer.subarray(0, 0);
}

function trimToFirstLine(buffer: Buffer): Buffer {
  for (let index = 0; index < buffer.length; index += 1) {
    const byte = buffer[index];
    if (byte === LF) return buffer.subarray(index + 1);
    if (byte === CR) {
      const next = buffer[index + 1];
      return buffer.subarray(next === LF ? index + 2 : index + 1);
    }
  }
  return Buffer.alloc(0);
}
