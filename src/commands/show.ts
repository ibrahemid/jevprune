import { loadConfig } from "../config.js";
import { LineRangeError } from "../errors.js";
import type { CliIo } from "../io.js";
import { RunStore } from "../store.js";

export interface ShowOptions {
  readonly id: string;
  readonly lines?: string | undefined;
}

export interface LineRange {
  readonly from: number;
  readonly to: number;
}

export function parseLineRange(value: string): LineRange {
  const match = /^(\d+)[-:](\d+)$/.exec(value.trim());
  if (match === null) {
    throw new LineRangeError(`--lines must be A-B or A:B, got ${JSON.stringify(value)}`);
  }
  const from = Number(match[1] ?? "");
  const to = Number(match[2] ?? "");
  if (from < 1 || to < from) {
    throw new LineRangeError(`--lines must be a range with 1 <= A <= B, got ${JSON.stringify(value)}`);
  }
  return { from, to };
}

export async function runShow(options: ShowOptions, io: CliIo): Promise<number> {
  const config = await loadConfig(io.env);
  const store = new RunStore({ home: config.home, retention: config.retention });
  if (options.lines === undefined) {
    const record = await store.readRun(options.id);
    await io.write(record.text);
    return 0;
  }
  const range = parseLineRange(options.lines);
  await io.write(await store.readRunLines(options.id, range.from, range.to));
  return 0;
}
