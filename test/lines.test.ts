import { describe, expect, it } from "vitest";

import { joinLines, splitLines } from "../src/core/lines.js";

function seeded(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state * 1_103_515_245 + 12_345) % 2_147_483_648;
    return state / 2_147_483_648;
  };
}

function randomText(random: () => number): string {
  const pieces = ["a", "bb", "", " ", "\t", "é", "\n", "\r\n", "\r", "npm ERR!", "line"];
  const length = Math.floor(random() * 12);
  let out = "";
  for (let index = 0; index < length; index += 1) {
    out += pieces[Math.floor(random() * pieces.length)] ?? "";
  }
  return out;
}

describe("splitLines", () => {
  it("numbers lines from 1 and keeps each terminator", () => {
    expect(splitLines("a\nb\r\nc\rd")).toEqual([
      { n: 1, text: "a", terminator: "\n" },
      { n: 2, text: "b", terminator: "\r\n" },
      { n: 3, text: "c", terminator: "\r" },
      { n: 4, text: "d", terminator: "" },
    ]);
  });

  it("does not produce a trailing empty line for text ending in a terminator", () => {
    expect(splitLines("a\n").map((line) => line.text)).toEqual(["a"]);
    expect(splitLines("a\r\n").map((line) => line.text)).toEqual(["a"]);
    expect(splitLines("")).toEqual([]);
  });

  it("keeps empty lines between terminators", () => {
    expect(splitLines("\n\n").map((line) => line.text)).toEqual(["", ""]);
  });

  it("round-trips every generated input", () => {
    const random = seeded(7);
    for (let index = 0; index < 500; index += 1) {
      const text = randomText(random);
      expect(joinLines(splitLines(text))).toBe(text);
    }
  });

  it("round-trips the fixed corpus", () => {
    for (const text of ["", "\n", "\r", "\r\n", "a", "a\r\n\r\nb", "\r\rx", "tail\r"]) {
      expect(joinLines(splitLines(text))).toBe(text);
    }
  });
});
