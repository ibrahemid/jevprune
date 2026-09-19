import { JevAbortError, JevBudgetError, JevTimeoutError } from "./jev-errors.js";
import type { JevRequestOptions } from "./client.js";
import { DEFAULT_WINDOW_TOKENS, estimateJsonTokens } from "./tokens.js";

export interface WindowItem {
  readonly id: string;
  readonly text: string;
}

export interface PlanWindowsOptions<T extends WindowItem> {
  readonly budgetTokens?: number;
  readonly overheadTokens?: number;
  readonly itemOverheadTokens?: number;
  readonly costTokens?: (item: T) => number;
}

export interface WindowPlan<T extends WindowItem> {
  readonly windows: readonly (readonly T[])[];
  readonly oversize: readonly T[];
}

export function planWindows<T extends WindowItem>(
  items: readonly T[],
  options: PlanWindowsOptions<T> = {},
): WindowPlan<T> {
  const budget = options.budgetTokens ?? DEFAULT_WINDOW_TOKENS;
  const overhead = options.overheadTokens ?? 0;
  const itemOverhead = options.itemOverheadTokens ?? 0;
  if (!Number.isInteger(budget) || budget <= 0) {
    throw new JevBudgetError(`budgetTokens must be a positive integer, got ${String(options.budgetTokens)}`);
  }
  if (!Number.isFinite(overhead) || overhead < 0) {
    throw new JevBudgetError(`overheadTokens must be a non-negative number, got ${String(options.overheadTokens)}`);
  }
  if (!Number.isFinite(itemOverhead) || itemOverhead < 0) {
    throw new JevBudgetError(
      `itemOverheadTokens must be a non-negative number, got ${String(options.itemOverheadTokens)}`,
    );
  }
  if (overhead >= budget) {
    throw new JevBudgetError(
      `overheadTokens (${String(overhead)}) leaves no room under budgetTokens (${String(budget)})`,
    );
  }
  const cost = options.costTokens ?? ((item: T): number => estimateJsonTokens({ id: item.id, text: item.text }));
  const windows: T[][] = [];
  const oversize: T[] = [];
  let current: T[] = [];
  let used = overhead;
  for (const item of items) {
    const itemCost = cost(item) + itemOverhead;
    if (overhead + itemCost > budget) {
      oversize.push(item);
      continue;
    }
    if (used + itemCost > budget && current.length > 0) {
      windows.push(current);
      current = [];
      used = overhead;
    }
    current.push(item);
    used += itemCost;
  }
  if (current.length > 0) windows.push(current);
  return { windows, oversize };
}

export const DEFAULT_WINDOW_CONCURRENCY = 4;
export const DEFAULT_WINDOW_TIMEOUT_MS = 10_000;

export interface RunWindowsOptions {
  readonly concurrency?: number;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
}

export type WindowJudge<T, R> = (window: readonly T[], index: number, options: JevRequestOptions) => Promise<R>;

export async function runWindows<T, R>(
  windows: readonly (readonly T[])[],
  judge: WindowJudge<T, R>,
  options: RunWindowsOptions = {},
): Promise<R[]> {
  const concurrency = options.concurrency ?? DEFAULT_WINDOW_CONCURRENCY;
  const timeoutMs = options.timeoutMs ?? DEFAULT_WINDOW_TIMEOUT_MS;
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new JevBudgetError(`concurrency must be a positive integer, got ${String(options.concurrency)}`);
  }
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new JevBudgetError(`timeoutMs must be a positive number, got ${String(options.timeoutMs)}`);
  }
  if (windows.length === 0) return [];
  if (options.signal?.aborted === true) throw new JevAbortError();

  const controller = new AbortController();
  const onOuterAbort = (): void => {
    controller.abort(options.signal?.reason);
  };
  options.signal?.addEventListener("abort", onOuterAbort, { once: true });

  const results: R[] = new Array<R>(windows.length);
  let failure: Error | undefined;
  let next = 0;

  const worker = async (): Promise<void> => {
    while (!controller.signal.aborted) {
      const index = next;
      next += 1;
      if (index >= windows.length) return;
      const window = windows[index];
      if (window === undefined) return;
      const timeout = AbortSignal.timeout(timeoutMs);
      const signal = AbortSignal.any([controller.signal, timeout]);
      try {
        results[index] = await judge(window, index, { signal, timeoutMs });
      } catch (error) {
        if (failure === undefined) failure = classifyWindowFailure(error, index, timeout, options.signal, timeoutMs);
        controller.abort();
        return;
      }
    }
  };

  try {
    await Promise.all(Array.from({ length: Math.min(concurrency, windows.length) }, worker));
  } finally {
    options.signal?.removeEventListener("abort", onOuterAbort);
  }
  if (failure !== undefined) throw failure;
  return results;
}

function classifyWindowFailure(
  error: unknown,
  index: number,
  timeout: AbortSignal,
  outer: AbortSignal | undefined,
  timeoutMs: number,
): Error {
  if (timeout.aborted) {
    return new JevTimeoutError(timeoutMs, `Jev window ${String(index + 1)} exceeded ${String(timeoutMs)} ms`, {
      cause: error,
    });
  }
  if (outer?.aborted === true) return new JevAbortError("Jev windows aborted by caller", { cause: error });
  if (error instanceof Error) return error;
  return new Error(String(error));
}
