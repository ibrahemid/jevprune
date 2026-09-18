import type { Line } from "./lines.js";
import type { Decision, DroppedRange } from "./types.js";

export interface MergeOptions {
  readonly minCollapseLines: number;
  readonly runId: string;
  readonly totalLines?: number;
}

export interface MergeResult {
  readonly kept: string;
  readonly dropped: DroppedRange[];
}

interface DroppedRun {
  from: number;
  to: number;
  lines: Line[];
  missing: boolean;
}

export function collapseMarker(range: DroppedRange, runId: string): string {
  return `[jevprune: ${String(range.count)} lines dropped, run ${runId}, lines ${String(range.from)}-${String(range.to)}]\n`;
}

export function mergeDecisions(
  lines: readonly Line[],
  decisions: Map<number, Decision>,
  options: MergeOptions,
): MergeResult {
  const minCollapseLines = Math.max(1, Math.trunc(options.minCollapseLines));
  const dropped: DroppedRange[] = [];
  let kept = "";
  let run: DroppedRun | null = null;
  let expected = 1;

  const flush = (): void => {
    if (run === null) return;
    const count = run.to - run.from + 1;
    if (!run.missing && count < minCollapseLines) {
      for (const line of run.lines) {
        decisions.set(line.n, { keep: true, reason: "collapse-min" });
        kept += line.text + line.terminator;
      }
    } else {
      const range = { from: run.from, to: run.to, count };
      dropped.push(range);
      kept += collapseMarker(range, options.runId);
    }
    run = null;
  };

  const dropLine = (line: Line): void => {
    if (run === null) run = { from: line.n, to: line.n, lines: [line], missing: false };
    else {
      run.to = line.n;
      run.lines.push(line);
    }
  };

  const dropMissing = (from: number, to: number): void => {
    if (to < from) return;
    if (run === null) run = { from, to, lines: [], missing: true };
    else {
      run.to = to;
      run.missing = true;
    }
  };

  for (const line of lines) {
    dropMissing(expected, line.n - 1);
    expected = line.n + 1;
    if (decisions.get(line.n)?.keep === false) {
      dropLine(line);
      continue;
    }
    flush();
    kept += line.text + line.terminator;
  }
  if (options.totalLines !== undefined) dropMissing(expected, options.totalLines);
  flush();

  return { kept, dropped };
}
