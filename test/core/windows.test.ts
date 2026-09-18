import { describe, expect, it } from "vitest";

import {
  JevAbortError,
  JevBudgetError,
  JevTimeoutError,
  estimateJsonTokens,
  planWindows,
  runWindows,
} from "../../src/core/index.js";
import type { WindowItem } from "../../src/core/index.js";

function items(count: number, width = 30): WindowItem[] {
  return Array.from({ length: count }, (_, i) => ({ id: `l${String(i + 1)}`, text: "x".repeat(width) }));
}

describe("planWindows", () => {
  it("keeps order, never exceeds the budget and fills windows greedily", () => {
    const list = items(50);
    const cost = (item: WindowItem): number => estimateJsonTokens({ id: item.id, text: item.text });
    const budget = cost(list[0] as WindowItem) * 7 + 5;
    const plan = planWindows(list, { budgetTokens: budget, overheadTokens: 5 });
    expect(plan.oversize).toEqual([]);
    expect(plan.windows.flat()).toEqual(list);
    plan.windows.forEach((window, index) => {
      const used = 5 + window.reduce((sum, item) => sum + cost(item), 0);
      expect(used).toBeLessThanOrEqual(budget);
      const following = plan.windows[index + 1]?.[0];
      if (following !== undefined) expect(used + cost(following)).toBeGreaterThan(budget);
    });
  });

  it("uses the caller's cost function and item overhead", () => {
    const list = items(10);
    const plan = planWindows(list, { budgetTokens: 100, overheadTokens: 10, itemOverheadTokens: 5, costTokens: () => 25 });
    expect(plan.windows.map((w) => w.length)).toEqual([3, 3, 3, 1]);
  });

  it("sets aside items that cannot fit alone", () => {
    const list = [...items(2), { id: "big", text: "y".repeat(10_000) }, ...items(1)];
    const plan = planWindows(list, { budgetTokens: 200 });
    expect(plan.oversize.map((i) => i.id)).toEqual(["big"]);
    expect(plan.windows.flat().map((i) => i.id)).toEqual(["l1", "l2", "l1"]);
  });

  it("returns no windows for no items", () => {
    expect(planWindows([])).toEqual({ windows: [], oversize: [] });
  });

  it("rejects budgets that leave no room", () => {
    expect(() => planWindows(items(1), { budgetTokens: 0 })).toThrow(JevBudgetError);
    expect(() => planWindows(items(1), { budgetTokens: 10, overheadTokens: 10 })).toThrow(JevBudgetError);
    expect(() => planWindows(items(1), { itemOverheadTokens: -1 })).toThrow(JevBudgetError);
  });
});

describe("runWindows", () => {
  it("returns results in window order under a concurrency cap", async () => {
    const windows = Array.from({ length: 9 }, (_, i) => [{ id: String(i), text: "" }]);
    let active = 0;
    let peak = 0;
    const results = await runWindows(
      windows,
      async (window, index) => {
        active += 1;
        peak = Math.max(peak, active);
        await new Promise((resolve) => setTimeout(resolve, 5 + (9 - index)));
        active -= 1;
        return `${window[0]?.id ?? ""}:${String(index)}`;
      },
      { concurrency: 3 },
    );
    expect(results).toEqual(windows.map((w, i) => `${w[0]?.id ?? ""}:${String(i)}`));
    expect(peak).toBe(3);
  });

  it("times out a slow window", async () => {
    const windows = [[{ id: "a", text: "" }]];
    await expect(
      runWindows(
        windows,
        (_window, _index, options) =>
          new Promise((_resolve, reject) => {
            options.signal?.addEventListener("abort", () => {
              reject(new Error("aborted by signal"));
            });
          }),
        { timeoutMs: 30 },
      ),
    ).rejects.toBeInstanceOf(JevTimeoutError);
  });

  it("aborts the remaining windows after the first failure", async () => {
    const windows = Array.from({ length: 6 }, (_, i) => [{ id: String(i), text: "" }]);
    const started: number[] = [];
    await expect(
      runWindows(
        windows,
        async (_window, index) => {
          started.push(index);
          await new Promise((resolve) => setTimeout(resolve, 5));
          if (index === 1) throw new Error("boom");
          return index;
        },
        { concurrency: 2 },
      ),
    ).rejects.toThrow("boom");
    expect(started.length).toBeLessThan(6);
  });

  it("rejects immediately on an aborted caller signal", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      runWindows([[{ id: "a", text: "" }]], () => Promise.resolve(1), { signal: controller.signal }),
    ).rejects.toBeInstanceOf(JevAbortError);
  });

  it("validates its options", async () => {
    await expect(runWindows([[]], () => Promise.resolve(1), { concurrency: 0 })).rejects.toBeInstanceOf(JevBudgetError);
    await expect(runWindows([[]], () => Promise.resolve(1), { timeoutMs: 0 })).rejects.toBeInstanceOf(JevBudgetError);
    await expect(runWindows([], () => Promise.resolve(1))).resolves.toEqual([]);
  });
});
