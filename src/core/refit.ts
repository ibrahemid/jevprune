import { JevpruneError } from "./errors.js";
import { withFooter } from "./footer.js";
import { splitLines } from "./lines.js";
import type { Line } from "./lines.js";
import { mergeDecisions } from "./merge.js";
import type { Decision, DroppedRange } from "./types.js";

const THRESHOLD_LADDER: readonly number[] = [0.5, 0.7, 0.9, 1.01];

export interface RefitInput {
  readonly lines: readonly Line[];
  readonly decisions: Map<number, Decision>;
  readonly runId: string;
  readonly minCollapseLines: number;
  readonly footer: string;
  readonly maxChars: number;
  readonly startThreshold: number;
}

export interface RefitResult {
  readonly kept: string;
  readonly dropped: DroppedRange[];
  readonly linesOut: number;
  readonly threshold: number;
}

export function refitToBudget(input: RefitInput): RefitResult | null {
  if (!Number.isFinite(input.maxChars) || input.maxChars < 0) {
    throw new JevpruneError(`refit budget must be a number >= 0, got ${String(input.maxChars)}`);
  }
  if (!Number.isFinite(input.startThreshold)) {
    throw new JevpruneError(`refit start threshold must be a finite number, got ${String(input.startThreshold)}`);
  }

  for (const threshold of thresholdsFrom(input.startThreshold)) {
    const decisions = rescoreDecisions(input.decisions, threshold);
    const { kept, dropped } = mergeDecisions(input.lines, decisions, {
      minCollapseLines: input.minCollapseLines,
      runId: input.runId,
    });
    if (withFooter(kept, input.footer).length > input.maxChars) continue;
    return { kept, dropped, linesOut: splitLines(kept).length, threshold };
  }
  return null;
}

function thresholdsFrom(start: number): number[] {
  return [start, ...THRESHOLD_LADDER.filter((threshold) => threshold > start)];
}

function rescoreDecisions(decisions: ReadonlyMap<number, Decision>, threshold: number): Map<number, Decision> {
  const rescored = new Map<number, Decision>();
  for (const [n, decision] of decisions) {
    if (decision.reason === "jev") {
      const noul = decision.noul ?? 0;
      rescored.set(n, { keep: noul >= threshold, reason: "jev", noul });
    } else if (decision.reason === "collapse-min") {
      rescored.set(n, { keep: false, reason: "jev" });
    } else {
      rescored.set(n, { ...decision });
    }
  }
  return rescored;
}
