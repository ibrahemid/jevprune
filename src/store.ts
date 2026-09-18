import { randomBytes } from "node:crypto";
import { createReadStream } from "node:fs";
import { appendFile, mkdir, open, readFile, readdir, stat, unlink, writeFile } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { join } from "node:path";
import { finished } from "node:stream/promises";
import type { Writable } from "node:stream";

import { byteLineStarts } from "./bytes.js";
import { DEFAULT_CONFIG } from "./config.js";
import type { RetentionConfig } from "./config.js";
import { LineRangeError, RunNotFoundError, RunStoreError, errorCode, errorMessage } from "./errors.js";
import type { SelectionMode } from "./types.js";

export const RUN_ID_PATTERN = /^[a-z0-9]+-[a-f0-9]{4}$/;
export const RUNS_DIR = "runs";
export const GAIN_FILE = "gain.jsonl";

const DIR_MODE = 0o700;
const FILE_MODE = 0o600;

export interface RunMeta {
  readonly id: string;
  readonly command: string;
  readonly argv: readonly string[];
  readonly startedAt: string;
  readonly endedAt: string;
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly bytes: number;
  readonly lines: number;
  readonly mode: SelectionMode;
  readonly linesOut: number;
  readonly fallbackReason?: string;
  readonly task: string;
}

export interface GainEntry {
  readonly ts: string;
  readonly id: string;
  readonly mode: SelectionMode;
  readonly linesIn: number;
  readonly linesOut: number;
  readonly bytesIn: number;
  readonly bytesOut: number;
  readonly reason?: string;
}

export interface GainTotals {
  readonly runs: number;
  readonly linesIn: number;
  readonly linesOut: number;
  readonly bytesIn: number;
  readonly bytesOut: number;
}

export interface RunRecord {
  readonly id: string;
  readonly path: string;
  readonly text: string;
  readonly meta: RunMeta | null;
}

export interface RunWriter {
  readonly path: string;
  readonly failure: RunStoreError | undefined;
  write(chunk: Buffer): boolean;
  onDrain(listener: () => void): void;
  close(): Promise<void>;
}

export function newRunId(): string {
  return `${Date.now().toString(36)}-${randomBytes(2).toString("hex")}`;
}

class FileRunWriter implements RunWriter {
  readonly path: string;
  readonly #handle: FileHandle;
  readonly #stream: Writable;
  #waiting: (() => void)[] = [];
  #failure: RunStoreError | undefined;
  #closed = false;

  constructor(path: string, handle: FileHandle, stream: Writable) {
    this.path = path;
    this.#handle = handle;
    this.#stream = stream;
    this.#stream.on("error", (error: unknown) => {
      this.#fail(error);
      this.#release();
    });
    this.#stream.on("drain", () => {
      this.#release();
    });
  }

  get failure(): RunStoreError | undefined {
    return this.#failure;
  }

  write(chunk: Buffer): boolean {
    if (this.#closed || this.#failure !== undefined) return true;
    try {
      return this.#stream.write(chunk);
    } catch (error) {
      this.#fail(error);
      return true;
    }
  }

  onDrain(listener: () => void): void {
    if (this.#closed || this.#failure !== undefined) {
      queueMicrotask(listener);
      return;
    }
    this.#waiting.push(listener);
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    try {
      this.#stream.end();
      await finished(this.#stream);
    } catch (error) {
      this.#fail(error);
      await this.#handle.close().catch(() => undefined);
    }
    this.#release();
  }

  #fail(error: unknown): void {
    this.#failure ??= storeError(`run log ${this.path} could not be written`, error);
  }

  #release(): void {
    const waiting = this.#waiting;
    this.#waiting = [];
    for (const listener of waiting) listener();
  }
}

export class RunStore {
  readonly home: string;
  readonly #retention: RetentionConfig;

  constructor(options: { home: string; retention?: RetentionConfig }) {
    this.home = options.home;
    this.#retention = options.retention ?? DEFAULT_CONFIG.retention;
  }

  get runsDir(): string {
    return join(this.home, RUNS_DIR);
  }

  get gainPath(): string {
    return join(this.home, GAIN_FILE);
  }

  logPath(id: string): string {
    return join(this.runsDir, `${requireRunId(id)}.log`);
  }

  metaPath(id: string): string {
    return join(this.runsDir, `${requireRunId(id)}.json`);
  }

  async openRun(run: { id: string }): Promise<RunWriter> {
    const path = this.logPath(run.id);
    await this.#ensureDir(this.runsDir);
    let handle: FileHandle;
    try {
      handle = await open(path, "wx", FILE_MODE);
    } catch (error) {
      throw storeError(`run log ${path} could not be created`, error);
    }
    return new FileRunWriter(path, handle, handle.createWriteStream());
  }

  async finalizeRun(id: string, meta: RunMeta): Promise<void> {
    const path = this.metaPath(id);
    await this.#ensureDir(this.runsDir);
    try {
      await writeFile(path, `${JSON.stringify(meta)}\n`, { mode: FILE_MODE });
    } catch (error) {
      throw storeError(`run meta ${path} could not be written`, error);
    }
  }

  async readRunBytes(id: string): Promise<Buffer> {
    const path = this.logPath(id);
    try {
      return await readFile(path);
    } catch (error) {
      if (errorCode(error) === "ENOENT") throw new RunNotFoundError(id, { cause: error });
      throw storeError(`run log ${path} could not be read`, error);
    }
  }

  async *readRunChunks(id: string): AsyncGenerator<Buffer> {
    const path = this.logPath(id);
    try {
      for await (const chunk of createReadStream(path) as AsyncIterable<Buffer | string>) {
        yield typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk;
      }
    } catch (error) {
      if (errorCode(error) === "ENOENT") throw new RunNotFoundError(id, { cause: error });
      throw storeError(`run log ${path} could not be read`, error);
    }
  }

  async readRun(id: string): Promise<RunRecord> {
    const bytes = await this.readRunBytes(id);
    return { id, path: this.logPath(id), text: bytes.toString("utf8"), meta: await this.#readMeta(id) };
  }

  async readRunLineBytes(id: string, from = 1, to?: number): Promise<Buffer> {
    const bytes = await this.readRunBytes(id);
    const starts = byteLineStarts(bytes);
    const lines = starts.length - 1;
    const last = to ?? lines;
    if (!Number.isInteger(from) || !Number.isInteger(last) || from < 1 || last < from) {
      throw new LineRangeError(`line range ${String(from)}-${String(last)} is not a range`);
    }
    if (last > lines) {
      throw new LineRangeError(
        `line range ${String(from)}-${String(last)} is outside run ${id} (${String(lines)} lines)`,
      );
    }
    return bytes.subarray(starts[from - 1] ?? 0, starts[last] ?? bytes.length);
  }

  async readRunLines(id: string, from = 1, to?: number): Promise<string> {
    return (await this.readRunLineBytes(id, from, to)).toString("utf8");
  }

  async appendGain(entry: GainEntry): Promise<void> {
    await this.#ensureDir(this.home);
    try {
      await appendFile(this.gainPath, `${JSON.stringify(entry)}\n`, { mode: FILE_MODE });
    } catch (error) {
      throw storeError(`gain ledger ${this.gainPath} could not be written`, error);
    }
  }

  async readGain(): Promise<GainTotals> {
    let raw: string;
    try {
      raw = await readFile(this.gainPath, "utf8");
    } catch (error) {
      if (errorCode(error) === "ENOENT") return { runs: 0, linesIn: 0, linesOut: 0, bytesIn: 0, bytesOut: 0 };
      throw storeError(`gain ledger ${this.gainPath} could not be read`, error);
    }
    let runs = 0;
    let linesIn = 0;
    let linesOut = 0;
    let bytesIn = 0;
    let bytesOut = 0;
    for (const line of raw.split("\n")) {
      if (line.trim().length === 0) continue;
      const entry = parseGainEntry(line);
      if (entry === null) continue;
      runs += 1;
      linesIn += entry.linesIn;
      linesOut += entry.linesOut;
      bytesIn += entry.bytesIn;
      bytesOut += entry.bytesOut;
    }
    return { runs, linesIn, linesOut, bytesIn, bytesOut };
  }

  async enforceRetention(): Promise<void> {
    let names: string[];
    try {
      names = await readdir(this.runsDir);
    } catch (error) {
      if (errorCode(error) === "ENOENT") return;
      throw storeError(`run directory ${this.runsDir} could not be read`, error);
    }
    const ids = [...new Set(names.filter((name) => name.endsWith(".log")).map((name) => name.slice(0, -4)))]
      .filter((id) => RUN_ID_PATTERN.test(id))
      .sort();
    const sizes = new Map<string, number>();
    let total = 0;
    for (const id of ids) {
      const bytes = (await this.#sizeOf(this.logPath(id))) + (await this.#sizeOf(this.metaPath(id)));
      sizes.set(id, bytes);
      total += bytes;
    }
    let count = ids.length;
    for (const id of ids) {
      if (count <= this.#retention.maxRuns && total <= this.#retention.maxBytes) break;
      await this.discardRun(id);
      total -= sizes.get(id) ?? 0;
      count -= 1;
    }
  }

  async discardRun(id: string): Promise<void> {
    for (const path of [this.logPath(id), this.metaPath(id)]) {
      try {
        await unlink(path);
      } catch (error) {
        if (errorCode(error) === "ENOENT") continue;
        throw storeError(`run file ${path} could not be deleted`, error);
      }
    }
  }

  async #sizeOf(path: string): Promise<number> {
    try {
      return (await stat(path)).size;
    } catch (error) {
      if (errorCode(error) === "ENOENT") return 0;
      throw storeError(`run file ${path} could not be inspected`, error);
    }
  }

  async #readMeta(id: string): Promise<RunMeta | null> {
    const path = this.metaPath(id);
    let raw: string;
    try {
      raw = await readFile(path, "utf8");
    } catch (error) {
      if (errorCode(error) === "ENOENT") return null;
      throw storeError(`run meta ${path} could not be read`, error);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      throw storeError(`run meta ${path} is not valid JSON`, error);
    }
    return isRecord(parsed) ? (parsed as unknown as RunMeta) : null;
  }

  async #ensureDir(path: string): Promise<void> {
    try {
      await mkdir(path, { recursive: true, mode: DIR_MODE });
    } catch (error) {
      throw storeError(`directory ${path} could not be created`, error);
    }
  }
}

function requireRunId(id: string): string {
  if (!RUN_ID_PATTERN.test(id)) throw new RunStoreError(`"${id}" is not a run id`);
  return id;
}

function parseGainEntry(line: string): GainEntry | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  if (!isRecord(parsed)) return null;
  const linesIn = parsed["linesIn"];
  const linesOut = parsed["linesOut"];
  const bytesIn = parsed["bytesIn"];
  const bytesOut = parsed["bytesOut"];
  if (
    typeof linesIn !== "number" ||
    typeof linesOut !== "number" ||
    typeof bytesIn !== "number" ||
    typeof bytesOut !== "number"
  ) {
    return null;
  }
  return parsed as unknown as GainEntry;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function storeError(message: string, error: unknown): RunStoreError {
  const code = errorCode(error);
  return new RunStoreError(`${message}: ${errorMessage(error)}`, {
    ...(code !== undefined ? { code } : {}),
    cause: error,
  });
}
