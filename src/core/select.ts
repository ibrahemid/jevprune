import { isDocumentOutput } from "./classify.js";
import type { ResolvedConfig } from "./config.js";
import type { JevClient, JevState, NoulResult } from "./client.js";
import { JevRequestError, JevResponseError, JevTimeoutError } from "./jev-errors.js";
import { computeKeeps } from "./keeps.js";
import type { KeepReason } from "./keeps.js";
import { splitLines } from "./lines.js";
import { mergeDecisions } from "./merge.js";
import type { Line } from "./lines.js";
import { UNAUTHORIZED_REASON } from "./reasons.js";
import { looksSecret } from "./secrets.js";
import { looksBinary, utf8Length } from "./text.js";
import { estimateJsonTokens, estimateTokens } from "./tokens.js";
import type { Decision, DroppedRange, FallbackReason, SelectionMode } from "./types.js";
import type { TimeoutSignalFactory } from "./timeout.js";
import { planWindows, runWindows } from "./windows.js";
import type { WindowItem } from "./windows.js";

export interface OversizeCapture {
  readonly lines: number;
  readonly headSegmentLines: number;
}

export const RUBRIC =
  "A line is needed when a developer acting on the task would want to read it: errors, failures, assertions, stack frames, diagnostics, timings or statuses that bear on the task, and the lines that give them meaning. Progress bars, download counters, repeated banners, unchanged status lines and routine success noise are not needed.";

export const ITEM_OVERHEAD_TOKENS = 12;

export interface SelectInput {
  readonly text: string;
  readonly task: string;
  readonly command: string;
  readonly exitCode?: number | null;
  readonly interrupted?: boolean;
  readonly oversize?: OversizeCapture;
  readonly client: JevClient | null;
  readonly config: ResolvedConfig;
  readonly runId: string;
  readonly signal?: AbortSignal;
  readonly timeoutSignal?: TimeoutSignalFactory;
  readonly protect?: boolean;
}

export interface PassthroughInput {
  readonly bytes: number;
  readonly lines: number;
  readonly text?: string;
  readonly reason?: FallbackReason;
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
  readonly fallbackReason?: FallbackReason;
  readonly decisions: Map<number, Decision>;
}

interface LineItem extends WindowItem {
  readonly n: number;
}

interface FallbackInput {
  readonly lines: readonly Line[];
  readonly keeps: Map<number, KeepReason>;
  readonly input: SelectInput;
  readonly reason: FallbackReason;
  readonly bytesIn: number;
  readonly linesIn: number;
}

interface FallbackMerge {
  readonly lines: readonly Line[];
  readonly decisions: Map<number, Decision>;
  readonly input: SelectInput;
  readonly reason: FallbackReason;
  readonly bytesIn: number;
  readonly linesIn: number;
  readonly totalLines?: number;
}

interface JevVerdicts {
  readonly windows: number;
  readonly jevRequests: number;
  readonly jevInputTokens: number;
  readonly answers: Map<number, number>;
  readonly oversize: readonly number[];
}

export function passthroughSelection(input: PassthroughInput): SelectionResult {
  return {
    mode: "passthrough",
    kept: input.text ?? "",
    dropped: [],
    linesIn: input.lines,
    linesOut: input.lines,
    bytesIn: input.bytes,
    bytesOut: input.bytes,
    windows: 0,
    jevRequests: 0,
    jevInputTokens: 0,
    ...(input.reason !== undefined ? { fallbackReason: input.reason } : {}),
    decisions: new Map(),
  };
}

function holdsSecret(input: SelectInput): boolean {
  return input.protect !== false && looksSecret(input.command, input.text);
}

function protectedReason(input: SelectInput): FallbackReason | undefined {
  if (holdsSecret(input)) return { kind: "secret" };
  if (input.protect === false) return undefined;
  if (looksBinary(input.text)) return { kind: "not-utf8" };
  if (isDocumentOutput(input.command, input.text)) return { kind: "document" };
  return undefined;
}

export function questionFor(n: number): string {
  return `Is line ${String(n)} needed for the task?`;
}

export async function selectLines(input: SelectInput): Promise<SelectionResult> {
  const lines = splitLines(input.text);
  const bytesIn = utf8Length(input.text);

  if (input.oversize !== undefined) {
    const isSecret = protectedReason(input)?.kind === "secret";
    return oversizeSelection(input, input.oversize, lines, bytesIn, isSecret);
  }
  if ((input.exitCode !== undefined && input.exitCode !== null && input.exitCode !== 0) || input.interrupted === true) {
    const secret: FallbackReason | undefined = holdsSecret(input) ? { kind: "secret" } : undefined;
    return everyLine(lines, "passthrough", input.text, bytesIn, secret);
  }
  const protection = protectedReason(input);
  if (protection !== undefined) {
    return passthroughSelection({ bytes: bytesIn, lines: lines.length, text: input.text, reason: protection });
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
    return fallbackSelection({
      lines,
      keeps,
      input,
      reason: { kind: "unavailable", detail: "API key not set" },
      bytesIn,
      linesIn: lines.length,
    });
  }

  let verdicts: JevVerdicts;
  try {
    verdicts = await askJev(candidates, input, input.client);
  } catch (error) {
    return fallbackSelection({
      lines,
      keeps,
      input,
      reason: unavailableReason(error),
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
    bytesOut: utf8Length(kept),
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
      ...(input.timeoutSignal !== undefined ? { timeoutSignal: input.timeoutSignal } : {}),
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
  return fallbackResult({
    lines,
    decisions: fallbackDecisions(lines, keeps, input.config.headLines),
    input,
    reason: fallback.reason,
    bytesIn: fallback.bytesIn,
    linesIn: fallback.linesIn,
  });
}

function oversizeSelection(
  input: SelectInput,
  oversize: OversizeCapture,
  captured: readonly Line[],
  bytesIn: number,
  isSecret: boolean,
): SelectionResult {
  const headCount = Math.min(Math.max(0, Math.trunc(oversize.headSegmentLines)), captured.length);
  const totalLines = Math.max(Math.trunc(oversize.lines), captured.length);
  const tailFirst = totalLines - captured.length + headCount + 1;
  const head = captured.slice(0, headCount);
  const tail = renumber(captured.slice(headCount), tailFirst);

  const contextLines = input.config.contextLines;
  const keeps = computeKeeps(head, { tailLines: 0, contextLines });
  const tailKeeps = computeKeeps(renumber(tail, 1), { tailLines: input.config.tailLines, contextLines });
  for (const [n, reason] of tailKeeps) keeps.set(n + tailFirst - 1, reason);

  const lines = [...head, ...tail];
  return fallbackResult({
    lines,
    decisions: fallbackDecisions(lines, keeps, input.config.headLines),
    input,
    reason: { kind: "size-limit", maxBytes: input.config.maxPruneBytes, ...(isSecret ? { isSecret } : {}) },
    bytesIn,
    linesIn: totalLines,
    totalLines,
  });
}

function fallbackDecisions(
  lines: readonly Line[],
  keeps: Map<number, KeepReason>,
  headLines: number,
): Map<number, Decision> {
  const head = Math.max(0, Math.trunc(headLines));
  const decisions = new Map<number, Decision>();
  for (const line of lines) {
    const keep = keeps.get(line.n);
    if (keep !== undefined) decisions.set(line.n, { keep: true, reason: keep });
    else if (line.n <= head) decisions.set(line.n, { keep: true, reason: "head" });
    else decisions.set(line.n, { keep: false, reason: "fallback" });
  }
  return decisions;
}

function renumber(lines: readonly Line[], from: number): Line[] {
  return lines.map((line, index) => ({ ...line, n: from + index }));
}

function fallbackResult(fallback: FallbackMerge): SelectionResult {
  const { kept, dropped } = mergeDecisions(fallback.lines, fallback.decisions, {
    minCollapseLines: fallback.input.config.minCollapseLines,
    runId: fallback.input.runId,
    ...(fallback.totalLines !== undefined ? { totalLines: fallback.totalLines } : {}),
  });
  return {
    mode: "fallback",
    kept,
    dropped,
    linesIn: fallback.linesIn,
    linesOut: splitLines(kept).length,
    bytesIn: fallback.bytesIn,
    bytesOut: utf8Length(kept),
    windows: 0,
    jevRequests: 0,
    jevInputTokens: 0,
    fallbackReason: fallback.reason,
    decisions: fallback.decisions,
  };
}

export function unavailableReason(error: unknown): FallbackReason {
  return { kind: "unavailable", detail: unavailableDetail(error) };
}

function unavailableDetail(error: unknown): string {
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
  reason?: FallbackReason,
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
    ...(reason === undefined ? {} : { fallbackReason: reason }),
    decisions,
  };
}
