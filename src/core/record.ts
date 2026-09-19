import { fallbackReasonText } from "./reasons.js";
import type { SelectionResult } from "./select.js";
import type { GainEntry, RunMeta } from "./store-types.js";

export interface BuildRunRecordInput {
  readonly runId: string;
  readonly command: string;
  readonly argv: readonly string[];
  readonly task: string;
  readonly startedAt: string;
  readonly endedAt: string;
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly bytes: number;
  readonly selection: SelectionResult;
}

export interface RunRecordPlan {
  readonly meta: RunMeta;
  readonly gain: GainEntry;
  readonly persistLog: boolean;
}

export function buildRunRecord(input: BuildRunRecordInput): RunRecordPlan {
  const { selection } = input;
  const reason = selection.fallbackReason === undefined ? undefined : fallbackReasonText(selection.fallbackReason);
  const meta: RunMeta = {
    id: input.runId,
    command: input.command,
    argv: input.argv,
    startedAt: input.startedAt,
    endedAt: input.endedAt,
    exitCode: input.exitCode,
    signal: input.signal,
    bytes: input.bytes,
    lines: selection.linesIn,
    mode: selection.mode,
    linesOut: selection.linesOut,
    ...(reason === undefined ? {} : { fallbackReason: reason }),
    task: input.task,
  };
  const gain: GainEntry = {
    ts: input.endedAt,
    id: input.runId,
    mode: selection.mode,
    linesIn: selection.linesIn,
    linesOut: selection.linesOut,
    bytesIn: selection.bytesIn,
    bytesOut: selection.bytesOut,
    ...(reason === undefined ? {} : { reason }),
  };
  return { meta, gain, persistLog: selection.mode !== "fast-path" };
}
