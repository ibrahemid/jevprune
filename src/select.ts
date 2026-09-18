import type { ResolvedConfig } from "./config.js";
import {
  JevRequestError,
  JevResponseError,
  JevTimeoutError,
  estimateJsonTokens,
  estimateTokens,
  planWindows,
  runWindows,
} from "./core/index.js";
import type { JevClient, JevState, NoulResult, WindowItem } from "./core/index.js";
import { computeKeeps } from "./keeps.js";
import type { KeepReason } from "./keeps.js";
import { splitLines } from "./lines.js";
import { mergeDecisions } from "./merge.js";
import type { Line } from "./lines.js";
import type { Decision, DroppedRange, SelectionMode } from "./types.js";

export const UNAUTHORIZED_REASON = "unauthorized (401)";

export const RUBRIC =
  "A line is needed when a developer acting on the task would want to read it: errors, failures, assertions, stack frames, diagnostics, timings or statuses that bear on the task, and the lines that give them meaning. Progress bars, download counters, repeated banners, unchanged status lines and routine success noise are not needed.";

export const ITEM_OVERHEAD_TOKENS = 12;

export interface SelectInput {
  readonly text: string;
  readonly task: string;
  readonly command: string;
  readonly exitCode?: number | null;
  readonly interrupted?: boolean;
  readonly oversize?: { readonly lines: number };
  readonly client: JevClient | null;
  readonly config: ResolvedConfig;
  readonly runId: string;
  readonly signal?: AbortSignal;
}

export interface SelectionResult {
  readonly mode: SelectionMode;
  readonly kept: string;
  readonly dropped: DroppedRange[];
  readonly linesIn: number;
  readonly linesOut: number;
  readonly bytesIn: number;
  readonly bytesOut: number;
  readonly windows: number;
  readonly jevRequests: number;
  readonly jevInputTokens: number;
  readonly fallbackReason?: string;
  readonly decisions: Map<number, Decision>;
}

interface LineItem extends WindowItem {
  readonly n: number;
}

interface FallbackInput {
  readonly lines: readonly Line[];
  readonly keeps: Map<number, KeepReason>;
  readonly input: SelectInput;
  readonly reason: string;
  readonly bytesIn: number;
  readonly linesIn: number;
}

interface JevVerdicts {
  readonly windows: number;
  readonly jevRequests: number;
  readonly jevInputTokens: number;
  readonly answers: Map<number, number>;
  readonly oversize: readonly number[];
}

export function questionFor(n: number): string {
  return `Is line ${String(n)} needed for the task?`;
}

export async function selectLines(input: SelectInput): Promise<SelectionResult> {
  const lines = splitLines(input.text);
  const bytesIn = Buffer.byteLength(input.text);

  if (input.oversize !== undefined) {
    return fallbackSelection({
      lines,
      keeps: keepsOf(lines, input.config),
      input,
      reason: `output over ${String(input.config.maxPruneBytes)} bytes`,
      bytesIn,
      linesIn: input.oversize.lines,
    });
  }
  if ((input.exitCode !== undefined && input.exitCode !== null && input.exitCode !== 0) || input.interrupted === true) {
    return everyLine(lines, "passthrough", input.text, bytesIn);
  }
  if (lines.length <= input.config.fastPathLines) {
    return everyLine(lines, "fast-path", input.text, bytesIn);
  }

  const keeps = keepsOf(lines, input.config);
  const decisions = new Map<number, Decision>();
  const candidates: LineItem[] = [];
  for (const line of lines) {
    const keep = keeps.get(line.n);
    if (keep !== undefined) {
      decisions.set(line.n, { keep: true, reason: keep });
      continue;
    }
    if (line.text.trim().length === 0) {
      decisions.set(line.n, { keep: false, reason: "blank" });
      continue;
    }
    candidates.push({ id: `l${String(line.n)}`, n: line.n, text: line.text });
  }

  if (input.client === null) {
    return fallbackSelection({ lines, keeps, input, reason: "no api key", bytesIn, linesIn: lines.length });
  }

  let verdicts: JevVerdicts;
  try {
    verdicts = await askJev(candidates, input, input.client);
  } catch (error) {
    return fallbackSelection({
      lines,
      keeps,
      input,
      reason: fallbackReason(error),
      bytesIn,
      linesIn: lines.length,
    });
  }

  for (const n of verdicts.oversize) decisions.set(n, { keep: true, reason: "oversize" });
  for (const item of candidates) {
    if (decisions.has(item.n)) continue;
    const noul = verdicts.answers.get(item.n) ?? 0;
    decisions.set(item.n, { keep: noul >= input.config.threshold, reason: "jev", noul });
  }

  const { kept, dropped } = mergeDecisions(lines, decisions, {
    minCollapseLines: input.config.minCollapseLines,
    runId: input.runId,
  });
  return {
    mode: "jev",
    kept,
    dropped,
    linesIn: lines.length,
    linesOut: splitLines(kept).length,
    bytesIn,
    bytesOut: Buffer.byteLength(kept),
    windows: verdicts.windows,
    jevRequests: verdicts.jevRequests,
    jevInputTokens: verdicts.jevInputTokens,
    decisions,
  };
}

async function askJev(candidates: readonly LineItem[], input: SelectInput, client: JevClient): Promise<JevVerdicts> {
  const answers = new Map<number, number>();
  if (candidates.length === 0) {
    return { windows: 0, jevRequests: 0, jevInputTokens: 0, answers, oversize: [] };
  }
  const lastLine = candidates[candidates.length - 1]?.n ?? 0;
  const plan = planWindows(candidates, {
    budgetTokens: input.config.windowTokens,
    overheadTokens: estimateJsonTokens(stateOf(input, [])),
    itemOverheadTokens: estimateTokens(questionFor(lastLine)) + ITEM_OVERHEAD_TOKENS,
    costTokens: (item) => estimateJsonTokens({ n: item.n, text: item.text }),
  });

  const results = await runWindows<LineItem, NoulResult>(
    plan.windows,
    async (window, _index, options) => {
      const questions: Record<string, string> = {};
      for (const item of window) questions[item.id] = questionFor(item.n);
      return await client.noul({ state: stateOf(input, window), questions }, options);
    },
    {
      concurrency: input.config.concurrency,
      timeoutMs: input.config.windowTimeoutMs,
      ...(input.signal !== undefined ? { signal: input.signal } : {}),
    },
  );

  let jevInputTokens = 0;
  for (const [index, result] of results.entries()) {
    jevInputTokens += result.usage.inputTokens;
    for (const item of plan.windows[index] ?? []) {
      const noul = result.answers[item.id];
      if (noul !== undefined) answers.set(item.n, noul);
    }
  }
  return {
    windows: plan.windows.length,
    jevRequests: results.length,
    jevInputTokens,
    answers,
    oversize: plan.oversize.map((item) => item.n),
  };
}

function stateOf(input: SelectInput, window: readonly LineItem[]): JevState {
  return {
    command: input.command,
    task: input.task,
    rubric: RUBRIC,
    lines: window.map((item) => ({ n: item.n, text: item.text })),
  };
}

function keepsOf(lines: readonly Line[], config: ResolvedConfig): Map<number, KeepReason> {
  return computeKeeps(lines, { tailLines: config.tailLines, contextLines: config.contextLines });
}

function fallbackSelection(fallback: FallbackInput): SelectionResult {
  const { lines, keeps, input } = fallback;
  const headLines = Math.max(0, Math.trunc(input.config.headLines));
  const decisions = new Map<number, Decision>();
  for (const line of lines) {
    const keep = keeps.get(line.n);
    if (keep !== undefined) decisions.set(line.n, { keep: true, reason: keep });
    else if (line.n <= headLines) decisions.set(line.n, { keep: true, reason: "head" });
    else decisions.set(line.n, { keep: false, reason: "fallback" });
  }

  const { kept, dropped } = mergeDecisions(lines, decisions, {
    minCollapseLines: input.config.minCollapseLines,
    runId: input.runId,
  });
  return {
    mode: "fallback",
    kept,
    dropped,
    linesIn: fallback.linesIn,
    linesOut: splitLines(kept).length,
    bytesIn: fallback.bytesIn,
    bytesOut: Buffer.byteLength(kept),
    windows: 0,
    jevRequests: 0,
    jevInputTokens: 0,
    fallbackReason: fallback.reason,
    decisions,
  };
}

export function fallbackReason(error: unknown): string {
  if (error instanceof JevTimeoutError) return "timeout";
  if (error instanceof JevResponseError) return "invalid response";
  if (error instanceof JevRequestError) {
    switch (error.status) {
      case 429:
        return "rate limited (429)";
      case 529:
        return "overloaded (529)";
      case 401:
        return UNAUTHORIZED_REASON;
      case 400:
        return "bad request (400)";
      case undefined:
        return "network";
      default:
        return error.name;
    }
  }
  if (error instanceof Error) return error.name;
  return "unknown";
}

function everyLine(
  lines: readonly Line[],
  mode: "fast-path" | "passthrough",
  text: string,
  bytesIn: number,
): SelectionResult {
  const decisions = new Map<number, Decision>();
  for (const line of lines) decisions.set(line.n, { keep: true, reason: mode });
  return {
    mode,
    kept: text,
    dropped: [],
    linesIn: lines.length,
    linesOut: lines.length,
    bytesIn,
    bytesOut: bytesIn,
    windows: 0,
    jevRequests: 0,
    jevInputTokens: 0,
    decisions,
  };
}
