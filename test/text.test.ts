import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { utf8Length } from "../src/core/text.js";

const FIXTURES = ["cargo-build.log", "docker-compose.log", "npm-test.log", "pytest.log"];

function readFixture(name: string): string {
  return readFileSync(fileURLToPath(new URL(`fixtures/${name}`, import.meta.url)), "utf8");
}

function nextSeed(seed: number): number {
  return (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
}

function randomCodeUnits(count: number, seed: number): string {
  const units: number[] = [];
  let state = seed;
  for (let index = 0; index < count; index += 1) {
    state = nextSeed(state);
    units.push(state % 0x11_000);
  }
  return String.fromCharCode(...units.map((unit) => unit % 0x10_000));
}

describe("utf8Length", () => {
  it("matches Buffer.byteLength on the fixture logs", () => {
    for (const name of FIXTURES) {
      const text = readFixture(name);
      expect(utf8Length(text)).toBe(Buffer.byteLength(text, "utf8"));
    }
  });

  it("matches Buffer.byteLength across the code-unit ranges", () => {
    const samples = [
      "",
      "a",
      "\n\r\t",
      "ascii only",
      "café",
      "日本語のログ",
      "\u007f\u0080߿ࠀ￿",
      "😀",
      "a😀b😀c",
      "😀😀",
    ];
    for (const sample of samples) {
      expect(utf8Length(sample)).toBe(Buffer.byteLength(sample, "utf8"));
    }
  });

  it("matches Buffer.byteLength on lone surrogates", () => {
    const samples = [
      "\ud800",
      "\udc00",
      "a\ud800b",
      "a\udc00b",
      "\ud800\ud800",
      "\udc00😀",
      "😀\ud800",
      "\ud83d",
      "\ud83da",
    ];
    for (const sample of samples) {
      expect(utf8Length(sample)).toBe(Buffer.byteLength(sample, "utf8"));
    }
  });

  it("matches Buffer.byteLength on random code-unit strings", () => {
    for (let seed = 1; seed <= 200; seed += 1) {
      const sample = randomCodeUnits(64, seed);
      expect(utf8Length(sample)).toBe(Buffer.byteLength(sample, "utf8"));
    }
  });
});
