import type { SelectionMode } from "./types.js";

export const RUN_ID_PATTERN = /^[a-z0-9]+-[a-f0-9]{4}$/;
export const RUNS_DIR = "runs";
export const GAIN_FILE = "gain.jsonl";

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
