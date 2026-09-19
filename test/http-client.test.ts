import { describe, expect, it } from "vitest";

import { FakeJevClient, HttpJevClient } from "../src/core/index.js";
import type { HookFetch, HookFetchInit, HookFetchResponse, NoulRequest } from "../src/core/index.js";
import {
  JevAbortError,
  JevConfigError,
  JevInputError,
  JevRequestError,
  JevResponseError,
  JevTimeoutError,
} from "../src/core/index.js";

interface Captured {
  readonly url: string;
  readonly init: HookFetchInit | undefined;
}

interface Transport {
  readonly fetch: HookFetch;
  readonly calls: Captured[];
}

function transportOf(respond: (call: number) => { status: number; body: unknown }): Transport {
  const calls: Captured[] = [];
  const fetch: HookFetch = (url, init) => {
    calls.push({ url, init });
    const { status, body } = respond(calls.length);
    const text = typeof body === "string" ? body : JSON.stringify(body);
    return Promise.resolve<HookFetchResponse>({ status, ok: status >= 200 && status < 300, text });
  };
  return { fetch, calls };
}

const hangingFetch: HookFetch = () => new Promise<HookFetchResponse>(() => undefined);

const REQUEST: NoulRequest = {
  state: { command: "pnpm test", lines: [{ n: 1, text: "ok" }] },
  questions: { l1: "Is line 1 needed?", l2: "Is line 2 needed?" },
};

const OK_BODY = {
  model: "jev-1.13.0",
  answers: { l1: { type: "noul", noul: 0.12 }, l2: { type: "noul", noul: 0.88 } },
  usage: { input_tokens: 40, output_tokens: 8 },
};

function clientOf(fetch: HookFetch, overrides: { maxRetries?: number; onRequest?: () => void } = {}): HttpJevClient {
  return new HttpJevClient({ apiKey: "apikey_test", fetch, timeoutMs: 2_000, maxRetries: 0, ...overrides });
}

function bodyOf(call: Captured | undefined): Record<string, unknown> {
  return JSON.parse(call?.init?.body ?? "{}") as Record<string, unknown>;
}

describe("HttpJevClient configuration", () => {
  it("rejects a blank API key", () => {
    expect(() => new HttpJevClient({ apiKey: "   ", fetch: hangingFetch })).toThrow(JevConfigError);
  });

  it("rejects a non-positive timeout", () => {
    expect(() => new HttpJevClient({ apiKey: "apikey_test", fetch: hangingFetch, timeoutMs: 0 })).toThrow(
      JevConfigError,
    );
  });

  it("rejects a negative retry count", () => {
    expect(() => new HttpJevClient({ apiKey: "apikey_test", fetch: hangingFetch, maxRetries: -1 })).toThrow(
      JevConfigError,
    );
  });
});

describe("HttpJevClient.noul request", () => {
  it("posts one noul question per id to the systemone endpoint", async () => {
    const transport = transportOf(() => ({ status: 200, body: OK_BODY }));
    await clientOf(transport.fetch).noul(REQUEST);
    const call = transport.calls[0];
    expect(call?.url).toBe("https://api.typesafe.ai/v1/systemone");
    expect(call?.init?.method).toBe("POST");
    expect(call?.init?.headers).toEqual({
      Authorization: "Bearer apikey_test",
      Accept: "application/json",
      "Content-Type": "application/json",
    });
    const body = bodyOf(call);
    expect(body["state"]).toEqual(REQUEST.state);
    expect(body["model"]).toBe("jev-latest");
    expect(body["questions"]).toEqual({
      l1: { type: "noul", instructions: "Is line 1 needed?" },
      l2: { type: "noul", instructions: "Is line 2 needed?" },
    });
  });

  it("sends the engine's init members only, with no signal", async () => {
    const transport = transportOf(() => ({ status: 200, body: OK_BODY }));
    const controller = new AbortController();
    await clientOf(transport.fetch).noul(REQUEST, { signal: controller.signal });
    const init = transport.calls[0]?.init as Readonly<Record<string, unknown>> | undefined;
    expect(Object.keys(init ?? {}).sort()).toEqual(["body", "headers", "method"]);
  });

  it("strips trailing slashes from a custom base url and sends the configured model", async () => {
    const transport = transportOf(() => ({ status: 200, body: OK_BODY }));
    const client = new HttpJevClient({
      apiKey: "apikey_test",
      fetch: transport.fetch,
      baseUrl: "https://jev.example.com//",
      model: "jev-1.13.0",
      maxRetries: 0,
    });
    await client.noul(REQUEST);
    expect(transport.calls[0]?.url).toBe("https://jev.example.com/v1/systemone");
    expect(bodyOf(transport.calls[0])["model"]).toBe("jev-1.13.0");
  });

  it("rejects a request with no questions", async () => {
    const transport = transportOf(() => ({ status: 200, body: OK_BODY }));
    await expect(clientOf(transport.fetch).noul({ state: "x", questions: {} })).rejects.toBeInstanceOf(JevInputError);
    expect(transport.calls).toHaveLength(0);
  });

  it("rejects a question with empty instructions", async () => {
    const transport = transportOf(() => ({ status: 200, body: OK_BODY }));
    await expect(clientOf(transport.fetch).noul({ state: "x", questions: { l1: "" } })).rejects.toBeInstanceOf(
      JevInputError,
    );
    expect(transport.calls).toHaveLength(0);
  });
});

describe("HttpJevClient.noul response", () => {
  it("returns validated answers and mapped usage", async () => {
    const transport = transportOf(() => ({ status: 200, body: OK_BODY }));
    await expect(clientOf(transport.fetch).noul(REQUEST)).resolves.toEqual({
      model: "jev-1.13.0",
      answers: { l1: 0.12, l2: 0.88 },
      usage: { inputTokens: 40, outputTokens: 8 },
    });
  });

  it("reports a malformed body as a response error", async () => {
    const transport = transportOf(() => ({ status: 200, body: "{not json" }));
    await expect(clientOf(transport.fetch).noul(REQUEST)).rejects.toBeInstanceOf(JevResponseError);
  });

  it("rejects an answer for an id that was not asked", async () => {
    const transport = transportOf(() => ({
      status: 200,
      body: {
        ...OK_BODY,
        answers: { ...OK_BODY.answers, l9: { type: "noul", noul: 0.5 } },
      },
    }));
    await expect(clientOf(transport.fetch).noul(REQUEST)).rejects.toBeInstanceOf(JevResponseError);
  });

  it("rejects a noul value outside the unit interval", async () => {
    const transport = transportOf(() => ({
      status: 200,
      body: { ...OK_BODY, answers: { l1: { type: "noul", noul: 1.4 }, l2: { type: "noul", noul: 0.2 } } },
    }));
    await expect(clientOf(transport.fetch).noul(REQUEST)).rejects.toBeInstanceOf(JevResponseError);
  });
});

describe("HttpJevClient.noul failures", () => {
  it("does not retry an authentication failure", async () => {
    const transport = transportOf(() => ({ status: 401, body: { error: "bad key" } }));
    const error = await clientOf(transport.fetch, { maxRetries: 1 })
      .noul(REQUEST)
      .catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(JevRequestError);
    expect((error as JevRequestError).status).toBe(401);
    expect((error as JevRequestError).retryable).toBe(false);
    expect((error as JevRequestError).message).toContain("TypeSafe rejected the API key");
    expect(transport.calls).toHaveLength(1);
  });

  it("retries a rate limit once and then throws", async () => {
    const transport = transportOf(() => ({ status: 429, body: { error: "slow down" } }));
    let requests = 0;
    const error = await clientOf(transport.fetch, {
      maxRetries: 1,
      onRequest: () => {
        requests += 1;
      },
    })
      .noul(REQUEST)
      .catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(JevRequestError);
    expect((error as JevRequestError).retryable).toBe(true);
    expect(transport.calls).toHaveLength(2);
    expect(requests).toBe(2);
  });

  it("retries a server failure once and then throws", async () => {
    const transport = transportOf(() => ({ status: 503, body: "unavailable" }));
    await expect(clientOf(transport.fetch, { maxRetries: 1 }).noul(REQUEST)).rejects.toBeInstanceOf(JevRequestError);
    expect(transport.calls).toHaveLength(2);
  });

  it("succeeds on the retry after a retryable failure", async () => {
    const transport = transportOf((call) => (call === 1 ? { status: 500, body: "boom" } : { status: 200, body: OK_BODY }));
    await expect(clientOf(transport.fetch, { maxRetries: 1 }).noul(REQUEST)).resolves.toMatchObject({
      answers: { l1: 0.12, l2: 0.88 },
    });
    expect(transport.calls).toHaveLength(2);
  });

  it("reports a transport failure as a retryable request error", async () => {
    const calls: string[] = [];
    const failing: HookFetch = (url) => {
      calls.push(url);
      return Promise.reject(new Error("socket closed"));
    };
    const error = await clientOf(failing)
      .noul(REQUEST)
      .catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(JevRequestError);
    expect((error as JevRequestError).retryable).toBe(true);
    expect(calls).toHaveLength(1);
  });

  it("maps a caller abort to JevAbortError", async () => {
    const controller = new AbortController();
    const pending = clientOf(hangingFetch).noul(REQUEST, { signal: controller.signal });
    controller.abort();
    await expect(pending).rejects.toBeInstanceOf(JevAbortError);
  });

  it("refuses a request whose signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    let requests = 0;
    const client = clientOf(hangingFetch, {
      onRequest: () => {
        requests += 1;
      },
    });
    await expect(client.noul(REQUEST, { signal: controller.signal })).rejects.toBeInstanceOf(JevAbortError);
    expect(requests).toBe(0);
  });

  it("times a request out through the injected signal factory", async () => {
    const asked: number[] = [];
    const client = new HttpJevClient({
      apiKey: "apikey_test",
      fetch: hangingFetch,
      timeoutMs: 25,
      maxRetries: 0,
      timeoutSignal: (ms) => {
        asked.push(ms);
        const controller = new AbortController();
        controller.abort();
        return controller.signal;
      },
    });
    const error = await client.noul(REQUEST).catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(JevTimeoutError);
    expect(asked).toEqual([25]);
  });

  it("maps a timeout to JevTimeoutError", async () => {
    const client = new HttpJevClient({
      apiKey: "apikey_test",
      fetch: hangingFetch,
      timeoutMs: 10,
      maxRetries: 0,
    });
    const error = await client.noul(REQUEST).catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(JevTimeoutError);
    expect((error as JevTimeoutError).timeoutMs).toBe(10);
  });
});

describe("HttpJevClient.choice", () => {
  it("rejects choice questions", async () => {
    const transport = transportOf(() => ({ status: 200, body: OK_BODY }));
    await expect(
      clientOf(transport.fetch).choice({
        state: "x",
        questions: { l1: { instructions: "keep or drop?", labels: ["keep", "drop"] } },
      }),
    ).rejects.toBeInstanceOf(JevInputError);
    expect(transport.calls).toHaveLength(0);
  });
});

describe("HttpJevClient and FakeJevClient", () => {
  it("agree on the shape of answers and usage", async () => {
    const transport = transportOf(() => ({ status: 200, body: OK_BODY }));
    const live = await clientOf(transport.fetch).noul(REQUEST);
    const fake = await new FakeJevClient().noul(REQUEST);
    expect(Object.keys(live.answers)).toEqual(Object.keys(fake.answers));
    for (const answers of [live.answers, fake.answers]) {
      for (const value of Object.values(answers)) {
        expect(typeof value).toBe("number");
        expect(value).toBeGreaterThanOrEqual(0);
        expect(value).toBeLessThanOrEqual(1);
      }
    }
    for (const result of [live, fake]) {
      expect(typeof result.model).toBe("string");
      expect(typeof result.usage.inputTokens).toBe("number");
      expect(typeof result.usage.outputTokens).toBe("number");
    }
  });
});
