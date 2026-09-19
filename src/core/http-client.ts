import {
  DEFAULT_JEV_MAX_RETRIES,
  DEFAULT_JEV_MODEL,
  DEFAULT_JEV_TIMEOUT_MS,
  buildNoulRequest,
  parseNoulResponse,
} from "./client.js";
import type {
  ChoiceRequest,
  ChoiceResult,
  JevClient,
  JevHttpRequest,
  JevRequestOptions,
  NoulRequest,
  NoulResult,
} from "./client.js";
import { resolveTimeoutSignal } from "./timeout.js";
import type { TimeoutSignalFactory } from "./timeout.js";
import {
  JevAbortError,
  JevConfigError,
  JevInputError,
  JevRequestError,
  JevTimeoutError,
  describeError,
} from "./jev-errors.js";

export interface HookFetchInit {
  readonly method?: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: string;
}

export interface HookFetchResponse {
  readonly status: number;
  readonly ok: boolean;
  readonly text: string;
}

export type HookFetch = (url: string, init?: HookFetchInit) => Promise<HookFetchResponse>;

export interface HttpJevClientConfig {
  readonly apiKey: string;
  readonly fetch: HookFetch;
  readonly baseUrl?: string;
  readonly model?: string;
  readonly timeoutMs?: number;
  readonly maxRetries?: number;
  readonly timeoutSignal?: TimeoutSignalFactory;
  readonly onRequest?: () => void;
}

const DEFAULT_JEV_BASE_URL = "https://api.typesafe.ai";

function rejectOnAbort(signal: AbortSignal): Promise<never> {
  return new Promise((_resolve, reject) => {
    if (signal.aborted) {
      reject(new JevAbortError());
      return;
    }
    signal.addEventListener(
      "abort",
      () => {
        reject(new JevAbortError());
      },
      { once: true },
    );
  });
}

function requirePositiveTimeout(timeoutMs: number, raw: number | undefined): number {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new JevConfigError(`timeoutMs must be a positive number, got ${String(raw)}`);
  }
  return timeoutMs;
}

export class HttpJevClient implements JevClient {
  readonly #apiKey: string;
  readonly #fetch: HookFetch;
  readonly #baseUrl: string;
  readonly #model: string;
  readonly #timeoutMs: number;
  readonly #maxRetries: number;
  readonly #timeoutSignal: TimeoutSignalFactory | undefined;
  readonly #onRequest: (() => void) | undefined;

  constructor(config: HttpJevClientConfig) {
    const apiKey = config.apiKey.trim();
    if (apiKey.length === 0) throw new JevConfigError("TypeSafe API key is empty");
    const maxRetries = config.maxRetries ?? DEFAULT_JEV_MAX_RETRIES;
    if (!Number.isInteger(maxRetries) || maxRetries < 0) {
      throw new JevConfigError(`maxRetries must be a non-negative integer, got ${String(config.maxRetries)}`);
    }
    const baseUrl = config.baseUrl?.trim() ?? "";
    this.#apiKey = apiKey;
    this.#fetch = config.fetch;
    this.#baseUrl = baseUrl.length > 0 ? baseUrl : DEFAULT_JEV_BASE_URL;
    this.#model = config.model ?? DEFAULT_JEV_MODEL;
    this.#timeoutMs = requirePositiveTimeout(config.timeoutMs ?? DEFAULT_JEV_TIMEOUT_MS, config.timeoutMs);
    this.#maxRetries = maxRetries;
    this.#timeoutSignal = config.timeoutSignal;
    this.#onRequest = config.onRequest;
  }

  async noul(request: NoulRequest, options: JevRequestOptions = {}): Promise<NoulResult> {
    const http = buildNoulRequest(
      { apiKey: this.#apiKey, baseUrl: this.#baseUrl, model: this.#model },
      request,
    );
    const ids = Object.keys(request.questions);
    const timeoutMs = requirePositiveTimeout(options.timeoutMs ?? this.#timeoutMs, options.timeoutMs);
    if (options.signal?.aborted === true) throw new JevAbortError();
    // The engine has no setTimeout, so a retryable failure is retried at once, without backoff.
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.#send(http, ids, options.signal, timeoutMs);
      } catch (error) {
        const shouldRetry = error instanceof JevRequestError && error.retryable && attempt < this.#maxRetries;
        if (!shouldRetry) throw error;
      }
    }
  }

  choice<L extends string>(_request: ChoiceRequest<L>, _options?: JevRequestOptions): Promise<ChoiceResult<L>> {
    return Promise.reject(new JevInputError("HttpJevClient does not support choice questions"));
  }

  async #send(
    http: JevHttpRequest,
    ids: readonly string[],
    callerSignal: AbortSignal | undefined,
    timeoutMs: number,
  ): Promise<NoulResult> {
    const timeoutSignal = resolveTimeoutSignal(this.#timeoutSignal, timeoutMs);
    this.#onRequest?.();
    let response: HookFetchResponse;
    try {
      const pending = this.#fetch(http.url, {
        method: http.method,
        headers: http.headers,
        body: http.body,
      });
      const races: Promise<HookFetchResponse>[] = [pending];
      if (timeoutSignal !== undefined) races.push(rejectOnAbort(timeoutSignal));
      if (callerSignal !== undefined) races.push(rejectOnAbort(callerSignal));
      response = await Promise.race(races);
    } catch (error) {
      if (callerSignal?.aborted === true) throw new JevAbortError("Jev request aborted", { cause: error });
      if (timeoutSignal?.aborted === true) {
        throw new JevTimeoutError(timeoutMs, `Jev request timed out after ${String(timeoutMs)} ms`, { cause: error });
      }
      throw new JevRequestError(`Jev request could not connect: ${describeError(error)}`, {
        retryable: true,
        cause: error,
      });
    }
    return parseNoulResponse(ids, response.status, response.ok, response.text);
  }
}
