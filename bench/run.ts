import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";

import { TYPESAFE_API_KEY_ENV } from "../src/core/client.js";
import type { JevClient } from "../src/core/client.js";
import { DEFAULT_CONFIG } from "../src/core/config.js";
import type { ResolvedConfig } from "../src/core/config.js";
import { JevpruneError, UsageError, errorMessage } from "../src/core/errors.js";
import { splitLines } from "../src/core/lines.js";
import { newRunId } from "../src/core/run-id.js";
import { selectLines } from "../src/core/select.js";
import { utf8Length } from "../src/core/text.js";
import { estimateTokens } from "../src/core/tokens.js";
import type { Decision } from "../src/core/types.js";
import { createJevClientFromEnv } from "../src/typesafe-client.js";

export class BenchError extends JevpruneError {
  override readonly name = "BenchError";
}

export interface BenchLabels {
  readonly task: string;
  readonly command: string;
  readonly needed: readonly number[];
  readonly why: Readonly<Record<string, string>>;
}

export interface BenchArm {
  readonly name: "raw" | "rules" | "jev";
}

export interface BenchRow {
  readonly fixture: string;
  readonly arm: BenchArm["name"];
  readonly linesIn: number;
  readonly linesOut: number;
  readonly bytesIn: number;
  readonly bytesOut: number;
  readonly estimatedTokensIn: number;
  readonly estimatedTokensOut: number;
  readonly requests: number;
  readonly wallMs: number;
  readonly recall: number;
}

export interface BenchReport {
  readonly ranAt: string;
  readonly rows: readonly BenchRow[];
}

export interface BenchOptions {
  readonly client: JevClient | null;
  readonly out?: string;
}

export const BENCH_FIXTURES = ["npm-test", "cargo-build", "docker-compose"] as const;

export const DEFAULT_REPORT_PATH = fileURLToPath(new URL("../bench/report.json", import.meta.url));

export const JEV_SKIPPED_NOTE = `jev arm skipped: ${TYPESAFE_API_KEY_ENV} is not set`;

const BENCH_CONFIG: ResolvedConfig = { ...DEFAULT_CONFIG, home: "" };

interface BenchFixture {
  readonly name: string;
  readonly text: string;
  readonly labels: BenchLabels;
}

export async function loadFixture(name: string): Promise<BenchFixture> {
  const logPath = new URL(`../bench/fixtures/${name}.log`, import.meta.url);
  const labelsPath = new URL(`../bench/labels/${name}.json`, import.meta.url);
  const text = await readText(logPath);
  const labels = parseLabels(await readText(labelsPath), fileURLToPath(labelsPath));
  const totalLines = splitLines(text).length;
  for (const n of labels.needed) {
    if (n > totalLines) {
      throw new BenchError(
        `label file ${fileURLToPath(labelsPath)} needs line ${String(n)}, but ${name}.log has ${String(totalLines)} lines`,
      );
    }
  }
  return { name, text, labels };
}

export async function runBench(options: BenchOptions): Promise<BenchReport> {
  const rows: BenchRow[] = [];

  for (const name of BENCH_FIXTURES) {
    const fixture = await loadFixture(name);
    rows.push(rawRow(fixture));
    rows.push(await armRow(fixture, "rules", null, BENCH_CONFIG));
    if (options.client !== null) {
      rows.push(await armRow(fixture, "jev", options.client, BENCH_CONFIG));
    }
  }

  const report: BenchReport = { ranAt: new Date().toISOString(), rows };
  if (options.out !== undefined) {
    await writeFile(options.out, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  }
  return report;
}

function rawRow(fixture: BenchFixture): BenchRow {
  const started = performance.now();
  const lines = splitLines(fixture.text).length;
  const bytes = utf8Length(fixture.text);
  const tokens = estimateTokens(fixture.text);
  const wallMs = performance.now() - started;
  return {
    fixture: fixture.name,
    arm: "raw",
    linesIn: lines,
    linesOut: lines,
    bytesIn: bytes,
    bytesOut: bytes,
    estimatedTokensIn: tokens,
    estimatedTokensOut: tokens,
    requests: 0,
    wallMs,
    recall: recallOf(fixture.labels.needed, new Map()),
  };
}

async function armRow(
  fixture: BenchFixture,
  arm: "rules" | "jev",
  client: JevClient | null,
  config: ResolvedConfig,
): Promise<BenchRow> {
  const started = performance.now();
  const result = await selectLines({
    text: fixture.text,
    task: fixture.labels.task,
    command: fixture.labels.command,
    client,
    config,
    runId: newRunId(),
  });
  const wallMs = performance.now() - started;
  return {
    fixture: fixture.name,
    arm,
    linesIn: result.linesIn,
    linesOut: result.linesOut,
    bytesIn: result.bytesIn,
    bytesOut: result.bytesOut,
    estimatedTokensIn: estimateTokens(fixture.text),
    estimatedTokensOut: estimateTokens(result.kept),
    requests: result.jevRequests,
    wallMs,
    recall: recallOf(fixture.labels.needed, result.decisions),
  };
}

export function recallOf(needed: readonly number[], decisions: ReadonlyMap<number, Decision>): number {
  if (needed.length === 0) throw new BenchError("a bench fixture needs at least one needed line");
  let kept = 0;
  for (const n of needed) {
    if (decisions.get(n)?.keep !== false) kept += 1;
  }
  return kept / needed.length;
}

export function formatTable(rows: readonly BenchRow[]): string {
  const header = [
    "fixture",
    "arm",
    "lines in",
    "lines out",
    "bytes in",
    "bytes out",
    "tokens in",
    "tokens out",
    "requests",
    "ms",
    "recall",
  ];
  const body = rows.map((row) => [
    row.fixture,
    row.arm,
    String(row.linesIn),
    String(row.linesOut),
    String(row.bytesIn),
    String(row.bytesOut),
    String(row.estimatedTokensIn),
    String(row.estimatedTokensOut),
    String(row.requests),
    row.wallMs.toFixed(0),
    row.recall.toFixed(2),
  ]);
  const widths = header.map((cell, column) =>
    Math.max(cell.length, ...body.map((cells) => cells[column]?.length ?? 0)),
  );
  const line = (cells: readonly string[]): string =>
    cells
      .map((cell, column) => (column < 2 ? cell.padEnd(widths[column] ?? 0) : cell.padStart(widths[column] ?? 0)))
      .join("  ")
      .trimEnd();
  return [line(header), ...body.map(line)].join("\n");
}

function parseLabels(raw: string, path: string): BenchLabels {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new BenchError(`label file ${path} is not valid JSON: ${errorMessage(error)}`, { cause: error });
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new BenchError(`label file ${path} must contain a JSON object`);
  }
  const record = parsed as Record<string, unknown>;
  const task = readLabelText(record, "task", path);
  const command = readLabelText(record, "command", path);
  const needed = readNeeded(record["needed"], path);
  const why = readWhy(record["why"], needed, path);
  return { task, command, needed, why };
}

function readLabelText(record: Record<string, unknown>, key: string, path: string): string {
  const value = record[key];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new BenchError(`label file ${path} must set "${key}" to a non-empty string`);
  }
  return value;
}

function readNeeded(value: unknown, path: string): readonly number[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new BenchError(`label file ${path} must set "needed" to a non-empty array of line numbers`);
  }
  const needed: number[] = [];
  for (const entry of value) {
    if (typeof entry !== "number" || !Number.isInteger(entry) || entry < 1) {
      throw new BenchError(`label file ${path} has a "needed" entry that is not a line number: ${String(entry)}`);
    }
    if (needed.includes(entry)) {
      throw new BenchError(`label file ${path} lists line ${String(entry)} twice in "needed"`);
    }
    needed.push(entry);
  }
  return needed;
}

function readWhy(value: unknown, needed: readonly number[], path: string): Readonly<Record<string, string>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new BenchError(`label file ${path} must set "why" to a JSON object keyed by line number`);
  }
  const record = value as Record<string, unknown>;
  const why: Record<string, string> = {};
  for (const n of needed) {
    const reason = record[String(n)];
    if (typeof reason !== "string" || reason.trim().length === 0) {
      throw new BenchError(`label file ${path} has no "why" entry for needed line ${String(n)}`);
    }
    why[String(n)] = reason;
  }
  for (const key of Object.keys(record)) {
    if (!needed.includes(Number(key))) {
      throw new BenchError(`label file ${path} has a "why" entry for line ${key}, which is not in "needed"`);
    }
  }
  return why;
}

async function readText(path: URL): Promise<string> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    throw new BenchError(`bench file ${fileURLToPath(path)} could not be read: ${errorMessage(error)}`, {
      cause: error,
    });
  }
}

function parseOutOption(args: readonly string[]): string | undefined {
  let out: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? "";
    if (arg === "--out") {
      const next = args[index + 1];
      if (next !== undefined && !next.startsWith("-")) {
        out = next;
        index += 1;
      } else {
        out = DEFAULT_REPORT_PATH;
      }
      continue;
    }
    if (arg.startsWith("--out=")) {
      const value = arg.slice("--out=".length);
      out = value.length > 0 ? value : DEFAULT_REPORT_PATH;
      continue;
    }
    throw new UsageError(`unknown bench argument ${arg}, expected --out [path]`);
  }
  return out;
}

async function main(): Promise<void> {
  const out = parseOutOption(process.argv.slice(2));
  const hasKey = (process.env[TYPESAFE_API_KEY_ENV]?.trim() ?? "").length > 0;
  const client = hasKey ? createJevClientFromEnv(process.env) : null;
  if (client === null) console.log(JEV_SKIPPED_NOTE);
  const report = await runBench({ client, ...(out !== undefined ? { out } : {}) });
  console.log(formatTable(report.rows));
  if (out !== undefined) console.log(`report written to ${out}`);
}

function isDirectRun(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  return import.meta.url === pathToFileURL(entry).href;
}

if (isDirectRun()) {
  void main().catch((error: unknown) => {
    process.exitCode = 1;
    console.error(errorMessage(error));
  });
}
