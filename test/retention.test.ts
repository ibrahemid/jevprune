import { describe, expect, it } from "vitest";

import { JevpruneError } from "../src/core/errors.js";
import { planRetention } from "../src/core/retention.js";
import type { RetentionEntry } from "../src/core/retention.js";
import { RUN_ID_PATTERN } from "../src/core/store-types.js";

const ROOMY = { maxRuns: 200, maxBytes: 268_435_456 };

function entriesOf(...ids: readonly string[]): RetentionEntry[] {
  return ids.map((id) => ({ id, bytes: 100 }));
}

describe("planRetention", () => {
  it("returns nothing for empty input", () => {
    expect(planRetention([], ROOMY)).toEqual([]);
  });

  it("returns nothing while both limits hold", () => {
    expect(planRetention(entriesOf("aaaa-0001", "aaab-0002"), ROOMY)).toEqual([]);
  });

  it("deletes the oldest runs beyond maxRuns, oldest first", () => {
    const entries = entriesOf("aaac-0003", "aaaa-0001", "aaab-0002", "aaad-0004");
    expect(planRetention(entries, { ...ROOMY, maxRuns: 2 })).toEqual(["aaaa-0001", "aaab-0002"]);
  });

  it("deletes the oldest runs beyond maxBytes", () => {
    const entries: RetentionEntry[] = [
      { id: "baaa-0001", bytes: 4_000 },
      { id: "baab-0002", bytes: 4_000 },
    ];
    expect(planRetention(entries, { maxRuns: 200, maxBytes: 5_000 })).toEqual(["baaa-0001"]);
  });

  it("stops as soon as both limits hold", () => {
    const entries: RetentionEntry[] = [
      { id: "caaa-0001", bytes: 6_000 },
      { id: "caab-0002", bytes: 1_000 },
      { id: "caac-0003", bytes: 1_000 },
    ];
    expect(planRetention(entries, { maxRuns: 200, maxBytes: 5_000 })).toEqual(["caaa-0001"]);
  });

  it("applies whichever limit bites deeper", () => {
    const entries: RetentionEntry[] = [
      { id: "daaa-0001", bytes: 10 },
      { id: "daab-0002", bytes: 10 },
      { id: "daac-0003", bytes: 9_000 },
    ];
    expect(planRetention(entries, { maxRuns: 2, maxBytes: 5_000 })).toEqual([
      "daaa-0001",
      "daab-0002",
      "daac-0003",
    ]);
  });

  it("sums the bytes of every file belonging to one run", () => {
    const entries: RetentionEntry[] = [
      { id: "eaaa-0001", bytes: 3_000 },
      { id: "eaaa-0001", bytes: 3_000 },
      { id: "eaab-0002", bytes: 100 },
    ];
    expect(planRetention(entries, { maxRuns: 200, maxBytes: 5_000 })).toEqual(["eaaa-0001"]);
  });

  it("ignores names that are not run ids", () => {
    const entries: RetentionEntry[] = [
      { id: "../../etc/passwd", bytes: 9_000 },
      { id: "gain.jsonl", bytes: 9_000 },
      { id: "faaa-0001", bytes: 100 },
      { id: "faab-0002", bytes: 100 },
    ];
    const doomed = planRetention(entries, { maxRuns: 1, maxBytes: 268_435_456 });
    expect(doomed).toEqual(["faaa-0001"]);
    for (const id of doomed) expect(RUN_ID_PATTERN.test(id)).toBe(true);
  });

  it("rejects an entry without a byte count >= 0", () => {
    expect(() => planRetention([{ id: "gaaa-0001", bytes: -1 }], ROOMY)).toThrow(JevpruneError);
    expect(() => planRetention([{ id: "gaaa-0001", bytes: Number.NaN }], ROOMY)).toThrow(/byte count/);
  });
});
