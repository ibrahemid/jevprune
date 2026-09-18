import { describe, expect, it } from "vitest";

import { CHARS_PER_TOKEN, estimateJsonTokens, estimateTokens } from "../../src/core/index.js";

describe("estimateTokens", () => {
  it("rounds up at the configured chars per token", () => {
    expect(estimateTokens("")).toBe(0);
    expect(estimateTokens("a")).toBe(1);
    expect(estimateTokens("a".repeat(CHARS_PER_TOKEN))).toBe(1);
    expect(estimateTokens("a".repeat(CHARS_PER_TOKEN + 1))).toBe(2);
  });

  it("estimates json by its serialized length", () => {
    const value = { n: 1, text: "hello" };
    expect(estimateJsonTokens(value)).toBe(estimateTokens(JSON.stringify(value)));
    expect(estimateJsonTokens(undefined)).toBe(0);
  });
});
