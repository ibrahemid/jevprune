import type { Line } from "./lines.js";
import type { Decision, DroppedRange } from "./types.js";

export interface MergeOptions {
  readonly minCollapseLines: number;
  readonly runId: string;
}

export interface MergeResult {
  readonly kept: string;
  readonly dropped: DroppedRange[];
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
  let run: Line[] = [];

  const flush = (): void => {
    const first = run[0];
    const last = run[run.length - 1];
    if (first === undefined || last === undefined) return;
    if (run.length < minCollapseLines) {
      for (const line of run) {
        decisions.set(line.n, { keep: true, reason: "collapse-min" });
        kept += line.text + line.terminator;
      }
    } else {
      const range = { from: first.n, to: last.n, count: run.length };
      dropped.push(range);
      kept += collapseMarker(range, options.runId);
    }
    run = [];
  };

  for (const line of lines) {
    if (decisions.get(line.n)?.keep === false) {
      run.push(line);
      continue;
    }
    flush();
    kept += line.text + line.terminator;
  }
  flush();

  return { kept, dropped };
}
