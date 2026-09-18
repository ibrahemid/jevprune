import { describe, expect, it } from "vitest";

import { joinLines, splitLines } from "../src/lines.js";
import { collapseMarker, mergeDecisions } from "../src/merge.js";
import type { Decision } from "../src/types.js";

const MARKER = /^\[jevprune: \d+ lines dropped, run [a-z0-9]+-[a-f0-9]{4}, lines \d+-\d+\]$/;

function seeded(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state * 1_103_515_245 + 12_345) % 2_147_483_648;
    return state / 2_147_483_648;
  };
}

function decisionsFor(count: number, keep: (n: number) => boolean): Map<number, Decision> {
  const decisions = new Map<number, Decision>();
  for (let n = 1; n <= count; n += 1) decisions.set(n, { keep: keep(n), reason: "jev" });
  return decisions;
}

describe("mergeDecisions", () => {
  it("replaces a dropped run with one marker line", () => {
    const lines = splitLines("a\nb\nc\nd\ne\n");
    const decisions = decisionsFor(5, (n) => n === 1 || n === 5);
    const { kept, dropped } = mergeDecisions(lines, decisions, { minCollapseLines: 3, runId: "abcd-0001" });
    expect(kept).toBe("a\n[jevprune: 3 lines dropped, run abcd-0001, lines 2-4]\ne\n");
    expect(dropped).toEqual([{ from: 2, to: 4, count: 3 }]);
  });

  it("keeps a dropped run shorter than minCollapseLines", () => {
    const lines = splitLines("a\nb\nc\nd\n");
    const decisions = decisionsFor(4, (n) => n === 1 || n === 4);
    const { kept, dropped } = mergeDecisions(lines, decisions, { minCollapseLines: 3, runId: "abcd-0002" });
    expect(kept).toBe("a\nb\nc\nd\n");
    expect(dropped).toEqual([]);
    expect(decisions.get(2)).toEqual({ keep: true, reason: "collapse-min" });
    expect(decisions.get(3)).toEqual({ keep: true, reason: "collapse-min" });
  });

  it("keeps the original terminators and the missing final one", () => {
    const lines = splitLines("a\r\nb\r\nc\r\nd\r\ne");
    const decisions = decisionsFor(5, (n) => n === 1 || n === 5);
    const { kept } = mergeDecisions(lines, decisions, { minCollapseLines: 2, runId: "abcd-0003" });
    expect(kept).toBe("a\r\n[jevprune: 3 lines dropped, run abcd-0003, lines 2-4]\ne");
  });

  it("collapses a trailing dropped run", () => {
    const lines = splitLines("a\nb\nc\nd");
    const decisions = decisionsFor(4, (n) => n === 1);
    const { kept, dropped } = mergeDecisions(lines, decisions, { minCollapseLines: 2, runId: "abcd-0004" });
    expect(kept).toBe("a\n[jevprune: 3 lines dropped, run abcd-0004, lines 2-4]\n");
    expect(dropped).toEqual([{ from: 2, to: 4, count: 3 }]);
  });

  it("formats the marker from the range", () => {
    expect(collapseMarker({ from: 12, to: 40, count: 29 }, "abcd-0005")).toBe(
      "[jevprune: 29 lines dropped, run abcd-0005, lines 12-40]\n",
    );
  });

  it("holds the retention invariants for random decisions", () => {
    const random = seeded(11);
    const lines = splitLines(
      Array.from({ length: 120 }, (_, index) => `line ${String(index + 1)} of the build`).join("\n") + "\n",
    );
    for (let round = 0; round < 200; round += 1) {
      const minCollapseLines = 1 + Math.floor(random() * 4);
      const decisions = decisionsFor(lines.length, () => random() > 0.5);
      const { kept, dropped } = mergeDecisions(lines, decisions, { minCollapseLines, runId: "abcd-0006" });

      const withoutMarkers = joinLines(splitLines(kept).filter((line) => !MARKER.test(line.text)));
      const keptLines = lines.filter((line) => decisions.get(line.n)?.keep === true);
      expect(withoutMarkers).toBe(joinLines(keptLines));

      const droppedNumbers = new Set<number>();
      for (const range of dropped) {
        expect(range.count).toBe(range.to - range.from + 1);
        expect(range.count).toBeGreaterThanOrEqual(minCollapseLines);
        for (let n = range.from; n <= range.to; n += 1) {
          expect(droppedNumbers.has(n)).toBe(false);
          droppedNumbers.add(n);
        }
      }
      for (const line of keptLines) expect(droppedNumbers.has(line.n)).toBe(false);
      expect(droppedNumbers.size + keptLines.length).toBe(lines.length);
    }
  });
});
