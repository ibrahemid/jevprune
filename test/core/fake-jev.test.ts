import { describe, expect, it } from "vitest";

import { FakeJevClient, JevInputError, JevTimeoutError } from "../../src/core/index.js";

describe("FakeJevClient", () => {
  it("scores noul questions with the supplied scorer and records calls", async () => {
    const client = new FakeJevClient({ noul: (id) => (id === "l2" ? 0.9 : 0.1) });
    const result = await client.noul({ state: { a: 1 }, questions: { l1: "q", l2: "q" } });
    expect(result.answers).toEqual({ l1: 0.1, l2: 0.9 });
    expect(result.usage.inputTokens).toBeGreaterThan(0);
    expect(client.calls).toEqual([{ kind: "noul", state: { a: 1 }, ids: ["l1", "l2"] }]);
  });

  it("clamps scorer output into [0, 1]", async () => {
    const client = new FakeJevClient({ noul: () => 7 });
    const result = await client.noul({ state: null, questions: { x: "q" } });
    expect(result.answers).toEqual({ x: 1 });
  });

  it("answers choice questions with a label or a full answer", async () => {
    const client = new FakeJevClient({
      choice: (id) =>
        id === "h1" ? "yes" : { choice: "mixed", confidence: 0.4, probabilities: { yes: 0.3, no: 0.3, mixed: 0.4 } },
    });
    const result = await client.choice({
      state: "diff",
      questions: {
        h1: { instructions: "q", labels: ["yes", "no", "mixed"] },
        h2: { instructions: "q", labels: ["yes", "no", "mixed"] },
      },
    });
    expect(result.answers["h1"]).toEqual({ choice: "yes", confidence: 1, probabilities: { yes: 1, no: 0, mixed: 0 } });
    expect(result.answers["h2"]?.choice).toBe("mixed");
  });

  it("rejects a scorer label outside the declared labels", async () => {
    const client = new FakeJevClient({ choice: () => "maybe" });
    await expect(
      client.choice({ state: null, questions: { h: { instructions: "q", labels: ["yes", "no"] } } }),
    ).rejects.toBeInstanceOf(JevInputError);
  });

  it("fails on the configured call and honors timeouts", async () => {
    const failing = new FakeJevClient({ failWith: (call) => (call === 2 ? new Error("second") : undefined) });
    await failing.noul({ state: null, questions: { a: "q" } });
    await expect(failing.noul({ state: null, questions: { a: "q" } })).rejects.toThrow("second");

    const slow = new FakeJevClient({ delayMs: 200 });
    await expect(
      slow.noul({ state: null, questions: { a: "q" } }, { signal: AbortSignal.timeout(10) }),
    ).rejects.toBeInstanceOf(JevTimeoutError);
  });

  it("requires at least one question", async () => {
    await expect(new FakeJevClient().noul({ state: null, questions: {} })).rejects.toBeInstanceOf(JevInputError);
  });
});
