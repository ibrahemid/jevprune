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
import type { ChoiceQuestion, EntryType, Fetch, NoulQuestion, RequestOptions } from "@typesafe-ai/sdk";

import {
  JevAbortError,
  JevConfigError,
  JevInputError,
  JevRequestError,
  JevResponseError,
  JevTimeoutError,
  describeError,
} from "./errors.js";

export type JevState = EntryType;

export interface JevUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
}

export interface NoulRequest {
  readonly state: JevState;
  readonly questions: Readonly<Record<string, string>>;
}

export interface NoulResult {
  readonly model: string;
  readonly answers: Readonly<Record<string, number>>;
  readonly usage: JevUsage;
}

export interface ChoiceQuestionSpec<L extends string> {
  readonly instructions: string;
  readonly labels: readonly L[];
  readonly descriptions?: Readonly<Partial<Record<L, string>>>;
}

export interface ChoiceRequest<L extends string> {
  readonly state: JevState;
  readonly questions: Readonly<Record<string, ChoiceQuestionSpec<L>>>;
}

export interface ChoiceAnswer<L extends string> {
  readonly choice: L;
  readonly confidence: number;
  readonly probabilities: Readonly<Record<L, number>>;
}

export interface ChoiceResult<L extends string> {
  readonly model: string;
  readonly answers: Readonly<Record<string, ChoiceAnswer<L>>>;
  readonly usage: JevUsage;
}

export interface JevRequestOptions {
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
}

export interface JevClient {
  noul(request: NoulRequest, options?: JevRequestOptions): Promise<NoulResult>;
  choice<L extends string>(request: ChoiceRequest<L>, options?: JevRequestOptions): Promise<ChoiceResult<L>>;
}

export interface TypeSafeJevClientConfig {
  readonly apiKey: string;
  readonly baseUrl?: string;
  readonly model?: string;
  readonly timeoutMs?: number;
  readonly maxRetries?: number;
  readonly fetch?: Fetch;
}

export const DEFAULT_JEV_MODEL = "jev-latest";
export const DEFAULT_JEV_TIMEOUT_MS = 10_000;
export const DEFAULT_JEV_MAX_RETRIES = 1;
export const TYPESAFE_API_KEY_ENV = "TYPESAFE_API_KEY";
export const TYPESAFE_BASE_URL_ENV = "TYPESAFE_BASE_URL";

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

function requireIds(ids: readonly string[]): readonly string[] {
  if (ids.length === 0) throw new JevInputError("a Jev request needs at least one question");
  for (const id of ids) {
    if (id.length === 0) throw new JevInputError("question ids must be non-empty strings");
  }
  return ids;
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isUnitInterval(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}

function readModel(model: unknown): string {
  return typeof model === "string" ? model : "";
}

function readUsage(usage: unknown): JevUsage {
  const record = isRecord(usage) ? usage : {};
  const input = record["input_tokens"];
  const output = record["output_tokens"];
  return {
    inputTokens: typeof input === "number" && Number.isFinite(input) ? input : 0,
    outputTokens: typeof output === "number" && Number.isFinite(output) ? output : 0,
  };
}

function rejectUnexpectedIds(expected: readonly string[], answers: Record<string, unknown>): void {
  const known = new Set(expected);
  for (const key of Object.keys(answers)) {
    if (!known.has(key)) throw new JevResponseError(`Jev answered an id that was not asked: "${key}"`);
  }
}

export function validateNoulAnswers(ids: readonly string[], answers: unknown): Record<string, number> {
  if (!isRecord(answers)) throw new JevResponseError("Jev response has no answers object");
  rejectUnexpectedIds(ids, answers);
  const out: Record<string, number> = {};
  for (const id of ids) {
    const answer = answers[id];
    if (!isRecord(answer)) throw new JevResponseError(`Jev response is missing the answer for "${id}"`);
    if (answer["type"] !== "noul") throw new JevResponseError(`Jev answer "${id}" is not a noul answer`);
    const value = answer["noul"];
    if (!isUnitInterval(value)) throw new JevResponseError(`Jev answer "${id}" has no noul value in [0, 1]`);
    out[id] = value;
  }
  return out;
}

export function validateChoiceAnswers<L extends string>(
  questions: Readonly<Record<string, ChoiceQuestionSpec<L>>>,
  answers: unknown,
): Record<string, ChoiceAnswer<L>> {
  if (!isRecord(answers)) throw new JevResponseError("Jev response has no answers object");
  const ids = Object.keys(questions);
  rejectUnexpectedIds(ids, answers);
  const out: Record<string, ChoiceAnswer<L>> = {};
  for (const id of ids) {
    const spec = questions[id];
    if (spec === undefined) continue;
    const answer = answers[id];
    if (!isRecord(answer)) throw new JevResponseError(`Jev response is missing the answer for "${id}"`);
    if (answer["type"] !== "choice") throw new JevResponseError(`Jev answer "${id}" is not a choice answer`);
    const chosen = answer["choice"];
    if (typeof chosen !== "string" || !spec.labels.includes(chosen as L)) {
      throw new JevResponseError(`Jev answer "${id}" chose an undeclared label: ${String(chosen)}`);
    }
    const confidence = answer["confidence"];
    if (!isUnitInterval(confidence)) throw new JevResponseError(`Jev answer "${id}" has no confidence in [0, 1]`);
    const rawProbabilities = answer["probabilities"];
    if (!isRecord(rawProbabilities)) throw new JevResponseError(`Jev answer "${id}" has no probabilities`);
    const probabilities = {} as Record<L, number>;
    for (const label of spec.labels) probabilities[label] = 0;
    for (const [label, value] of Object.entries(rawProbabilities)) {
      if (!spec.labels.includes(label as L)) {
        throw new JevResponseError(`Jev answer "${id}" reports a probability for an undeclared label: ${label}`);
      }
      if (!isUnitInterval(value)) throw new JevResponseError(`Jev answer "${id}" has a probability outside [0, 1]`);
      probabilities[label as L] = value;
    }
    out[id] = { choice: chosen as L, confidence, probabilities };
  }
  return out;
}
