import { describe, expect, it } from "vitest";

import { JevpruneError } from "../src/core/errors.js";
import { withFooter } from "../src/core/footer.js";
import { splitLines } from "../src/core/lines.js";
import type { Line } from "../src/core/lines.js";
import { refitToBudget } from "../src/core/refit.js";
import type { RefitInput } from "../src/core/refit.js";
import type { Decision } from "../src/core/types.js";

const RUN_ID = "abcd-0001";
const FOOTER = "jevprune: 40 → 30 lines, exit 0";
const LINE = "0123456789";

function linesOf(count: number): Line[] {
  return splitLines(`${Array.from({ length: count }, () => LINE).join("\n")}\n`);
}

function block(from: number, to: number): string {
  return `${LINE}\n`.repeat(to - from + 1);
}

function marker(from: number, to: number): string {
  return `[jevprune: ${String(to - from + 1)} lines dropped, run ${RUN_ID}, lines ${String(from)}-${String(to)}]\n`;
}

function nouls(count: number, noulOf: (n: number) => number, threshold: number): Map<number, Decision> {
  const decisions = new Map<number, Decision>();
  for (let n = 1; n <= count; n += 1) {
    const noul = noulOf(n);
    decisions.set(n, { keep: noul >= threshold, reason: "jev", noul });
  }
  return decisions;
}

function laddered(): Map<number, Decision> {
  return nouls(40, (n) => (n <= 10 ? 0.95 : n <= 20 ? 0.75 : n <= 30 ? 0.55 : 0.2), 0.1);
}

function inputFor(overrides: Partial<RefitInput> = {}): RefitInput {
  return {
    lines: linesOf(40),
    decisions: laddered(),
    runId: RUN_ID,
    minCollapseLines: 3,
    footer: FOOTER,
    maxChars: 1_000_000,
    startThreshold: 0.1,
    ...overrides,
  };
}

function budgetFor(kept: string): number {
  return withFooter(kept, FOOTER).length;
}

describe("refitToBudget", () => {
  it("keeps the start threshold when the output already fits", () => {
    const result = refitToBudget(inputFor());
    expect(result?.threshold).toBe(0.1);
    expect(result?.kept).toBe(block(1, 40));
    expect(result?.dropped).toEqual([]);
    expect(result?.linesOut).toBe(40);
  });

  it("steps up one ladder threshold at a time until the output fits", () => {
    const steps: readonly { threshold: number; kept: string }[] = [
      { threshold: 0.5, kept: block(1, 30) + marker(31, 40) },
      { threshold: 0.7, kept: block(1, 20) + marker(21, 40) },
      { threshold: 0.9, kept: block(1, 10) + marker(11, 40) },
      { threshold: 1.01, kept: marker(1, 40) },
    ];
    for (const step of steps) {
      const result = refitToBudget(inputFor({ maxChars: budgetFor(step.kept) }));
      expect(result?.threshold).toBe(step.threshold);
      expect(result?.kept).toBe(step.kept);
      expect(result?.linesOut).toBe(splitLines(step.kept).length);
    }
  });

  it("counts the footer in the budget", () => {
    const fitsAtHalf = block(1, 30) + marker(31, 40);
    const result = refitToBudget(inputFor({ maxChars: fitsAtHalf.length }));
    expect(result?.threshold).toBe(0.7);
  });

  it("reports the dropped ranges of the threshold it settled on", () => {
    const kept = block(1, 20) + marker(21, 40);
    const result = refitToBudget(inputFor({ maxChars: budgetFor(kept) }));
    expect(result?.dropped).toEqual([{ from: 21, to: 40, count: 20 }]);
  });

  it("never drops a forced keep", () => {
    const decisions = laddered();
    for (const n of [31, 32, 33]) decisions.set(n, { keep: true, reason: "tail" });
    decisions.set(15, { keep: true, reason: "signature" });
    decisions.set(25, { keep: true, reason: "context" });
    const kept =
      marker(1, 14) +
      block(15, 15) +
      marker(16, 24) +
      block(25, 25) +
      marker(26, 30) +
      block(31, 33) +
      marker(34, 40);
    const result = refitToBudget(inputFor({ decisions, maxChars: budgetFor(kept) }));
    expect(result?.threshold).toBe(1.01);
    expect(result?.kept).toBe(kept);
  });

  it("returns null when the forced keeps alone exceed the budget", () => {
    const decisions = laddered();
    for (let n = 31; n <= 40; n += 1) decisions.set(n, { keep: true, reason: "tail" });
    const result = refitToBudget(inputFor({ decisions, maxChars: 40 }));
    expect(result).toBeNull();
  });

  it("returns null when even the emptied output is over the budget", () => {
    expect(refitToBudget(inputFor({ maxChars: 0 }))).toBeNull();
  });

  it("re-drops lines that the first merge kept only to satisfy minCollapseLines", () => {
    const decisions = nouls(12, (n) => (n === 6 || n === 7 ? 0.2 : 0.95), 0.9);
    for (const n of [6, 7]) decisions.set(n, { keep: true, reason: "collapse-min" });
    const kept = block(1, 5) + marker(6, 7) + block(8, 12);
    const result = refitToBudget(
      inputFor({ lines: linesOf(12), decisions, minCollapseLines: 1, maxChars: budgetFor(kept) }),
    );
    expect(result?.kept).toBe(kept);
  });

  it("leaves the caller's decisions untouched", () => {
    const decisions = laddered();
    refitToBudget(inputFor({ decisions, maxChars: budgetFor(marker(1, 40)) }));
    expect(decisions.get(31)).toEqual({ keep: true, reason: "jev", noul: 0.2 });
    expect(decisions.get(1)).toEqual({ keep: true, reason: "jev", noul: 0.95 });
  });

  it("rejects a budget that is not a number >= 0", () => {
    expect(() => refitToBudget(inputFor({ maxChars: -1 }))).toThrow(JevpruneError);
    expect(() => refitToBudget(inputFor({ maxChars: Number.NaN }))).toThrow(/budget/);
  });

  it("rejects a start threshold that is not finite", () => {
    expect(() => refitToBudget(inputFor({ startThreshold: Number.NaN }))).toThrow(JevpruneError);
  });
});
