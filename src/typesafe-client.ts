import {
  APIConnectionError,
  APIError,
  APITimeoutError,
  APIUserAbortError,
  AuthenticationError,
  RateLimitError,
  TypeSafeClient,
  TypeSafeError,
  choice,
  noul,
} from "@typesafe-ai/sdk";
import type { ChoiceQuestion, Fetch, NoulQuestion, RequestOptions } from "@typesafe-ai/sdk";

import {
  DEFAULT_JEV_MAX_RETRIES,
  DEFAULT_JEV_MODEL,
  DEFAULT_JEV_TIMEOUT_MS,
  TYPESAFE_API_KEY_ENV,
  TYPESAFE_BASE_URL_ENV,
  readModel,
  readUsage,
  requireIds,
  validateChoiceAnswers,
  validateNoulAnswers,
} from "./core/client.js";
import type {
  ChoiceQuestionSpec,
  ChoiceRequest,
  ChoiceResult,
  JevClient,
  JevRequestOptions,
  NoulRequest,
  NoulResult,
} from "./core/client.js";
import {
  JevAbortError,
  JevConfigError,
  JevInputError,
  JevRequestError,
  JevTimeoutError,
  describeError,
} from "./core/jev-errors.js";

export interface TypeSafeJevClientConfig {
  readonly apiKey: string;
  readonly baseUrl?: string;
  readonly model?: string;
  readonly timeoutMs?: number;
  readonly maxRetries?: number;
  readonly fetch?: Fetch;
}

export class TypeSafeJevClient implements JevClient {
  readonly #client: TypeSafeClient;
  readonly #timeoutMs: number;

  constructor(config: TypeSafeJevClientConfig) {
    const apiKey = config.apiKey.trim();
    if (apiKey.length === 0) throw new JevConfigError("TypeSafe API key is empty");
    const timeoutMs = config.timeoutMs ?? DEFAULT_JEV_TIMEOUT_MS;
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      throw new JevConfigError(`timeoutMs must be a positive number, got ${String(config.timeoutMs)}`);
    }
    const maxRetries = config.maxRetries ?? DEFAULT_JEV_MAX_RETRIES;
    if (!Number.isInteger(maxRetries) || maxRetries < 0) {
      throw new JevConfigError(`maxRetries must be a non-negative integer, got ${String(config.maxRetries)}`);
    }
    this.#timeoutMs = timeoutMs;
    try {
      this.#client = new TypeSafeClient({
        apiKey,
        ...(config.baseUrl !== undefined ? { baseURL: config.baseUrl } : {}),
        defaultModel: config.model ?? DEFAULT_JEV_MODEL,
        logLevel: "off",
        timeout: timeoutMs,
        retry: { maxRetries, backoffInitialMs: 250, backoffMaxMs: 1_500, maxRetryAfterMs: 2_000 },
        ...(config.fetch !== undefined ? { fetch: config.fetch } : {}),
      });
    } catch (error) {
      throw new JevConfigError(`TypeSafe client rejected its configuration: ${describeError(error)}`, {
        cause: error,
      });
    }
  }

  async noul(request: NoulRequest, options: JevRequestOptions = {}): Promise<NoulResult> {
    const ids = requireIds(Object.keys(request.questions));
    const questions: Record<string, NoulQuestion> = {};
    for (const id of ids) {
      const instructions = request.questions[id];
      if (typeof instructions !== "string" || instructions.length === 0) {
        throw new JevInputError(`question "${id}" has no instructions`);
      }
      questions[id] = noul(instructions);
    }
    const result = await this.#call(() =>
      this.#client.systemOne({ state: request.state, questions }, this.#requestOptions(options)),
    );
    return {
      model: readModel(result.model),
      answers: validateNoulAnswers(ids, result.answers),
      usage: readUsage(result.usage),
    };
  }

  async choice<L extends string>(
    request: ChoiceRequest<L>,
    options: JevRequestOptions = {},
  ): Promise<ChoiceResult<L>> {
    const ids = requireIds(Object.keys(request.questions));
    const questions: Record<string, ChoiceQuestion> = {};
    for (const id of ids) {
      const spec = request.questions[id];
      if (spec === undefined) throw new JevInputError(`question "${id}" is undefined`);
      validateChoiceSpec(id, spec);
      const criteria: Record<string, string | null> = {};
      for (const label of spec.labels) criteria[label] = spec.descriptions?.[label] ?? null;
      questions[id] = choice(spec.instructions, criteria);
    }
    const result = await this.#call(() =>
      this.#client.systemOne({ state: request.state, questions }, this.#requestOptions(options)),
    );
    return {
      model: readModel(result.model),
      answers: validateChoiceAnswers(request.questions, result.answers),
      usage: readUsage(result.usage),
    };
  }

  #requestOptions(options: JevRequestOptions): RequestOptions {
    const timeout = options.timeoutMs ?? this.#timeoutMs;
    return options.signal !== undefined ? { signal: options.signal, timeout } : { timeout };
  }

  async #call<T>(send: () => Promise<T>): Promise<T> {
    try {
      return await send();
    } catch (error) {
      throw toJevError(error);
    }
  }
}

export function createJevClientFromEnv(
  env: Readonly<Record<string, string | undefined>> = process.env,
  overrides: Partial<Omit<TypeSafeJevClientConfig, "apiKey">> = {},
): TypeSafeJevClient {
  const apiKey = env[TYPESAFE_API_KEY_ENV]?.trim() ?? "";
  if (apiKey.length === 0) throw new JevConfigError(`${TYPESAFE_API_KEY_ENV} is not set`);
  const baseUrl = env[TYPESAFE_BASE_URL_ENV]?.trim();
  return new TypeSafeJevClient({
    apiKey,
    ...(baseUrl !== undefined && baseUrl.length > 0 ? { baseUrl } : {}),
    ...overrides,
  });
}

export function toJevError(error: unknown): Error {
  if (error instanceof JevRequestError || error instanceof JevTimeoutError || error instanceof JevAbortError) {
    return error;
  }
  if (error instanceof APIUserAbortError) return new JevAbortError(error.message, { cause: error });
  if (error instanceof APITimeoutError) {
    return new JevTimeoutError(error.timeoutMs, `Jev request timed out after ${String(error.timeoutMs)} ms`, {
      cause: error,
    });
  }
  if (error instanceof APIError) {
    const retryable = error instanceof RateLimitError || error.status >= 500 || error.status === 408;
    const detail = error instanceof AuthenticationError ? "TypeSafe rejected the API key" : error.message;
    return new JevRequestError(`Jev request failed with status ${String(error.status)}: ${detail}`, {
      status: error.status,
      retryable,
      ...(error.requestId !== undefined ? { requestId: error.requestId } : {}),
      cause: error,
    });
  }
  if (error instanceof APIConnectionError) {
    return new JevRequestError(`Jev request could not connect: ${error.message}`, { retryable: true, cause: error });
  }
  if (error instanceof TypeSafeError) {
    return new JevConfigError(`TypeSafe SDK rejected the request: ${error.message}`, { cause: error });
  }
  if (error instanceof Error) return error;
  return new JevRequestError(`Jev request failed: ${describeError(error)}`, { retryable: false, cause: error });
}

function validateChoiceSpec<L extends string>(id: string, spec: ChoiceQuestionSpec<L>): void {
  if (typeof spec.instructions !== "string" || spec.instructions.length === 0) {
    throw new JevInputError(`choice question "${id}" has no instructions`);
  }
  if (spec.labels.length < 2) throw new JevInputError(`choice question "${id}" needs at least two labels`);
  if (new Set(spec.labels).size !== spec.labels.length) {
    throw new JevInputError(`choice question "${id}" has duplicate labels`);
  }
  for (const label of spec.labels) {
    if (label.length === 0) throw new JevInputError(`choice question "${id}" has an empty label`);
  }
}

