import { describe, expect, it } from "vitest";

import {
  JevConfigError,
  JevInputError,
  JevRequestError,
  JevResponseError,
  JevTimeoutError,
  validateChoiceAnswers,
  validateNoulAnswers,
} from "../../src/core/index.js";
import { TypeSafeJevClient, createJevClientFromEnv } from "../../src/typesafe-client.js";

interface Captured {
  url: string;
  body: Record<string, unknown>;
  headers: Record<string, string>;
}

function fakeFetch(
  respond: (captured: Captured) => { status: number; body: unknown } | Promise<{ status: number; body: unknown }>,
): { fetch: (input: string, init?: RequestInit) => Promise<Response>; calls: Captured[] } {
  const calls: Captured[] = [];
  const fetch = async (input: string, init?: RequestInit): Promise<Response> => {
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((value, key) => {
      headers[key] = value;
    });
    const raw = typeof init?.body === "string" ? init.body : "{}";
    const captured: Captured = { url: input, body: JSON.parse(raw) as Record<string, unknown>, headers };
    calls.push(captured);
    const { status, body } = await respond(captured);
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  };
  return { fetch, calls };
}

function client(fetch: (input: string, init?: RequestInit) => Promise<Response>, timeoutMs = 2_000): TypeSafeJevClient {
  return new TypeSafeJevClient({ apiKey: "apikey_test", fetch, timeoutMs, maxRetries: 0 });
}

describe("TypeSafeJevClient.noul", () => {
  it("sends one noul question per id and returns validated answers", async () => {
    const transport = fakeFetch(() => ({
      status: 200,
      body: {
        model: "jev-1.13.0",
        answers: { l1: { type: "noul", noul: 0.12 }, l2: { type: "noul", noul: 0.88 } },
        usage: { input_tokens: 40, output_tokens: 8 },
      },
    }));
    const result = await client(transport.fetch).noul({
      state: { command: "npm test", lines: [{ n: 1, text: "a" }] },
      questions: { l1: "Is line 1 needed?", l2: "Is line 2 needed?" },
    });
    expect(result).toEqual({ model: "jev-1.13.0", answers: { l1: 0.12, l2: 0.88 }, usage: { inputTokens: 40, outputTokens: 8 } });
    const sent = transport.calls[0];
    expect(sent?.url).toBe("https://api.typesafe.ai/v1/systemone");
    expect(sent?.headers["authorization"]).toBe("Bearer apikey_test");
    expect(sent?.body["model"]).toBe("jev-latest");
    expect(sent?.body["questions"]).toEqual({
      l1: { type: "noul", instructions: "Is line 1 needed?" },
      l2: { type: "noul", instructions: "Is line 2 needed?" },
    });
  });

  it("rejects answers for ids that were not asked", async () => {
    const transport = fakeFetch(() => ({
      status: 200,
      body: { model: "m", answers: { l1: { type: "noul", noul: 0.5 }, l9: { type: "noul", noul: 0.5 } }, usage: {} },
    }));
    await expect(client(transport.fetch).noul({ state: null, questions: { l1: "q" } })).rejects.toBeInstanceOf(
      JevResponseError,
    );
  });

  it("rejects missing, mistyped and out-of-range answers", () => {
    expect(() => validateNoulAnswers(["a", "b"], { a: { type: "noul", noul: 0.1 } })).toThrow(JevResponseError);
    expect(() => validateNoulAnswers(["a"], { a: { type: "choice", noul: 0.1 } })).toThrow(JevResponseError);
    expect(() => validateNoulAnswers(["a"], { a: { type: "noul", noul: 1.5 } })).toThrow(JevResponseError);
    expect(() => validateNoulAnswers(["a"], { a: { type: "noul", noul: "0.5" } })).toThrow(JevResponseError);
    expect(() => validateNoulAnswers(["a"], null)).toThrow(JevResponseError);
    expect(validateNoulAnswers(["a"], { a: { type: "noul", noul: 0 } })).toEqual({ a: 0 });
  });

  it("maps api errors to typed errors", async () => {
    const statuses = [401, 429, 529, 400];
    const seen: JevRequestError[] = [];
    for (const status of statuses) {
      const transport = fakeFetch(() => ({ status, body: { detail: { error_type: "x" } } }));
      try {
        await client(transport.fetch).noul({ state: null, questions: { a: "q" } });
      } catch (error) {
        expect(error).toBeInstanceOf(JevRequestError);
        seen.push(error as JevRequestError);
      }
    }
    expect(seen.map((e) => e.status)).toEqual(statuses);
    expect(seen.map((e) => e.retryable)).toEqual([false, true, true, false]);
    expect(seen[0]?.message).toContain("API key");
  });

  it("times out a slow request", async () => {
    const transport = fakeFetch(
      () => new Promise((resolve) => setTimeout(() => resolve({ status: 200, body: {} }), 500)),
    );
    await expect(client(transport.fetch, 40).noul({ state: null, questions: { a: "q" } })).rejects.toBeInstanceOf(
      JevTimeoutError,
    );
  });

  it("honors a per-call timeout and signal", async () => {
    const transport = fakeFetch(
      () => new Promise((resolve) => setTimeout(() => resolve({ status: 200, body: {} }), 500)),
    );
    await expect(
      client(transport.fetch).noul({ state: null, questions: { a: "q" } }, { timeoutMs: 40 }),
    ).rejects.toBeInstanceOf(JevTimeoutError);
  });

  it("rejects empty questions before sending", async () => {
    const transport = fakeFetch(() => ({ status: 200, body: {} }));
    await expect(client(transport.fetch).noul({ state: null, questions: {} })).rejects.toBeInstanceOf(JevInputError);
    expect(transport.calls).toEqual([]);
  });
});

describe("TypeSafeJevClient.choice", () => {
  it("sends declared labels as criteria and validates the answer", async () => {
    const transport = fakeFetch(() => ({
      status: 200,
      body: {
        model: "m",
        answers: { h1: { type: "choice", choice: "yes", confidence: 0.9, probabilities: { yes: 0.9, no: 0.1 } } },
        usage: { input_tokens: 1, output_tokens: 1 },
      },
    }));
    const result = await client(transport.fetch).choice({
      state: "diff",
      questions: { h1: { instructions: "Does it belong?", labels: ["yes", "no"], descriptions: { yes: "belongs" } } },
    });
    expect(result.answers["h1"]).toEqual({ choice: "yes", confidence: 0.9, probabilities: { yes: 0.9, no: 0.1 } });
    expect(transport.calls[0]?.body["questions"]).toEqual({
      h1: { type: "choice", instructions: "Does it belong?", criteria: { yes: "belongs", no: null } },
    });
  });

  it("rejects undeclared labels and malformed probabilities", () => {
    const questions = { h: { instructions: "q", labels: ["yes", "no"] as const } };
    expect(() =>
      validateChoiceAnswers(questions, { h: { type: "choice", choice: "maybe", confidence: 1, probabilities: {} } }),
    ).toThrow(JevResponseError);
    expect(() =>
      validateChoiceAnswers(questions, {
        h: { type: "choice", choice: "yes", confidence: 1, probabilities: { maybe: 1 } },
      }),
    ).toThrow(JevResponseError);
    expect(() =>
      validateChoiceAnswers(questions, { h: { type: "choice", choice: "yes", confidence: 2, probabilities: {} } }),
    ).toThrow(JevResponseError);
    expect(
      validateChoiceAnswers(questions, { h: { type: "choice", choice: "no", confidence: 0.5, probabilities: { no: 0.5 } } }),
    ).toEqual({ h: { choice: "no", confidence: 0.5, probabilities: { yes: 0, no: 0.5 } } });
  });

  it("rejects specs with fewer than two or duplicate labels", async () => {
    const transport = fakeFetch(() => ({ status: 200, body: {} }));
    await expect(
      client(transport.fetch).choice({ state: null, questions: { h: { instructions: "q", labels: ["yes"] } } }),
    ).rejects.toBeInstanceOf(JevInputError);
    await expect(
      client(transport.fetch).choice({ state: null, questions: { h: { instructions: "q", labels: ["a", "a"] } } }),
    ).rejects.toBeInstanceOf(JevInputError);
  });
});

describe("createJevClientFromEnv", () => {
  it("requires TYPESAFE_API_KEY", () => {
    expect(() => createJevClientFromEnv({})).toThrow(JevConfigError);
    expect(() => createJevClientFromEnv({ TYPESAFE_API_KEY: "  " })).toThrow(JevConfigError);
    expect(createJevClientFromEnv({ TYPESAFE_API_KEY: "apikey_x" })).toBeInstanceOf(TypeSafeJevClient);
  });

  it("rejects invalid timeouts and retries", () => {
    expect(() => new TypeSafeJevClient({ apiKey: "k", timeoutMs: 0 })).toThrow(JevConfigError);
    expect(() => new TypeSafeJevClient({ apiKey: "k", maxRetries: -1 })).toThrow(JevConfigError);
    expect(() => new TypeSafeJevClient({ apiKey: "" })).toThrow(JevConfigError);
  });
});
