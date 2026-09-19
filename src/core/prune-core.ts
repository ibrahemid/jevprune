import type { JevClient } from "./client.js";
import type { ResolvedConfig } from "./config.js";
import { buildRunRecord } from "./record.js";
import type { RunRecordPlan } from "./record.js";
import { selectLines } from "./select.js";
import type { OversizeCapture, SelectionResult } from "./select.js";

export interface PruneCoreInput {
  readonly text: string;
  readonly task: string;
  readonly command: string;
  readonly exitCode: number | null;
  readonly interrupted?: boolean;
  readonly client: JevClient | null;
  readonly config: ResolvedConfig;
  readonly runId: string;
  readonly bytes: number;
  readonly protect?: boolean;
  readonly oversize?: OversizeCapture;
  readonly signal?: AbortSignal;
  readonly now: () => string;
  readonly argv?: readonly string[];
  readonly signalName?: string | null;
}

export interface PruneCoreResult {
  readonly selection: SelectionResult;
  readonly plan: RunRecordPlan;
}

export async function pruneCore(input: PruneCoreInput): Promise<PruneCoreResult> {
  const startedAt = input.now();
  const selection = await selectLines({
    text: input.text,
    task: input.task,
    command: input.command,
    exitCode: input.exitCode,
    ...(input.interrupted === undefined ? {} : { interrupted: input.interrupted }),
    ...(input.oversize === undefined ? {} : { oversize: input.oversize }),
    client: input.client,
    config: input.config,
    runId: input.runId,
    ...(input.protect === undefined ? {} : { protect: input.protect }),
    ...(input.signal === undefined ? {} : { signal: input.signal }),
  });
  const plan = buildRunRecord({
    runId: input.runId,
    command: input.command,
    argv: input.argv ?? [],
    task: input.task,
    startedAt,
    endedAt: input.now(),
    exitCode: input.exitCode,
    signal: input.signalName ?? null,
    bytes: input.bytes,
    selection,
  });
  return { selection, plan };
}
