import { readFile, stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it, vi } from "vitest";

import { BENCH_FIXTURES, DEFAULT_REPORT_PATH, loadFixture, runBench } from "../bench/run.js";
import type { BenchRow } from "../bench/run.js";
import { DEFAULT_CONFIG } from "../src/core/config.js";
import { FakeJevClient } from "../src/core/index.js";
import type { NoulScorer } from "../src/core/index.js";
import { splitLines } from "../src/core/lines.js";

const FIXTURE_COUNT = BENCH_FIXTURES.length;
const TAIL_LINES = DEFAULT_CONFIG.tailLines;

interface WindowState {
  readonly lines: readonly { readonly n: number; readonly text: string }[];
}

function scorerFor(keyword: string): NoulScorer {
  return (id, _instructions, state) => {
    const n = Number(id.slice(1));
    const text = (state as unknown as WindowState).lines.find((line) => line.n === n)?.text ?? "";
    return text.includes(keyword) ? 1 : 0;
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

async function mtimeOf(path: string): Promise<number | null> {
  try {
    return (await stat(path)).mtimeMs;
  } catch {
    return null;
  }
}

function rowsFor(rows: readonly BenchRow[], fixture: string): readonly BenchRow[] {
  return rows.filter((row) => row.fixture === fixture);
}

describe("bench labels", () => {
  for (const name of BENCH_FIXTURES) {
    it(`labels only lines that exist in ${name}.log`, async () => {
      const fixture = await loadFixture(name);
      const lines = splitLines(fixture.text);
      const { needed, why } = fixture.labels;

      expect(needed.length).toBeGreaterThan(0);
      for (const n of needed) {
        expect(n).toBeGreaterThanOrEqual(1);
        expect(n).toBeLessThanOrEqual(lines.length);
        expect(lines[n - 1]?.n).toBe(n);
      }
      expect(Object.keys(why).sort()).toEqual(needed.map(String).sort());
    });
  }

  it("labels at least one line outside the tail window", async () => {
    const outside: string[] = [];
    for (const name of BENCH_FIXTURES) {
      const fixture = await loadFixture(name);
      const lastLine = splitLines(fixture.text).length;
      if (fixture.labels.needed.some((n) => n <= lastLine - TAIL_LINES)) outside.push(name);
    }
    expect(outside.length).toBeGreaterThan(0);
  });

  for (const name of BENCH_FIXTURES) {

    it(`copies ${name}.log byte for byte from the test fixture`, async () => {
      const bench = await readFile(fileURLToPath(new URL(`../bench/fixtures/${name}.log`, import.meta.url)), "utf8");
      const source = await readFile(fileURLToPath(new URL(`../test/fixtures/${name}.log`, import.meta.url)), "utf8");
      expect(bench).toBe(source);
    });
  }
});

describe("runBench", () => {
  it("reports three arms per fixture without touching the network or writing a report", async () => {
    const fetchSpy = vi.fn(() => {
      throw new Error("the bench must not make a network request");
    });
    vi.stubGlobal("fetch", fetchSpy);
    const before = await mtimeOf(DEFAULT_REPORT_PATH);
    const client = new FakeJevClient({ noul: () => 0 });

    const report = await runBench({ client });

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(await mtimeOf(DEFAULT_REPORT_PATH)).toBe(before);
    expect(Date.parse(report.ranAt)).toBeGreaterThan(0);
    expect(report.rows).toHaveLength(FIXTURE_COUNT * 3);
    expect(client.calls.length).toBeGreaterThan(0);

    for (const name of BENCH_FIXTURES) {
      const rows = rowsFor(report.rows, name);
      expect(rows.map((row) => row.arm)).toEqual(["raw", "rules", "jev"]);

      const [raw, rules, jev] = rows as [BenchRow, BenchRow, BenchRow];
      expect(raw.recall).toBe(1);
      expect(raw.linesOut).toBe(raw.linesIn);
      expect(raw.bytesOut).toBe(raw.bytesIn);
      expect(raw.requests).toBe(0);

      expect(rules.linesIn).toBe(raw.linesIn);
      expect(rules.linesOut).toBeLessThan(rules.linesIn);
      expect(rules.requests).toBe(0);

      expect(jev.linesIn).toBe(raw.linesIn);
      expect(jev.linesOut).toBeLessThan(jev.linesIn);
      expect(jev.requests).toBeGreaterThan(0);

      for (const row of rows) {
        for (const value of [
          row.linesIn,
          row.linesOut,
          row.bytesIn,
          row.bytesOut,
          row.estimatedTokensIn,
          row.estimatedTokensOut,
          row.requests,
          row.wallMs,
          row.recall,
        ]) {
          expect(Number.isFinite(value)).toBe(true);
          expect(value).toBeGreaterThanOrEqual(0);
        }
        expect(row.recall).toBeLessThanOrEqual(1);
      }
    }
  });

  it("separates the arms on recall when the rules arm misses the needed lines", async () => {
    const client = new FakeJevClient({ noul: scorerFor("Plugin successfully installed") });

    const report = await runBench({ client });
    const rows = rowsFor(report.rows, "docker-compose");
    const rules = rows.find((row) => row.arm === "rules");
    const jev = rows.find((row) => row.arm === "jev");

    expect(rules?.recall).toBeLessThan(1);
    expect(jev?.recall).toBe(1);
  });

  it("skips the jev arm when no client is given", async () => {
    const report = await runBench({ client: null });

    expect(report.rows).toHaveLength(FIXTURE_COUNT * 2);
    expect(report.rows.every((row) => row.arm !== "jev")).toBe(true);
  });
});
