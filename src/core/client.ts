import { JevInputError, JevRequestError, JevResponseError } from "./jev-errors.js";

export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

export type JevState = string | { [key: string]: JsonValue } | JsonValue[] | null;

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

export const DEFAULT_JEV_MODEL = "jev-latest";
export const DEFAULT_JEV_TIMEOUT_MS = 10_000;
export const DEFAULT_JEV_MAX_RETRIES = 1;
export const TYPESAFE_API_KEY_ENV = "TYPESAFE_API_KEY";
export const TYPESAFE_BASE_URL_ENV = "TYPESAFE_BASE_URL";

export function requireIds(ids: readonly string[]): readonly string[] {
  if (ids.length === 0) throw new JevInputError("a Jev request needs at least one question");
  for (const id of ids) {
    if (id.length === 0) throw new JevInputError("question ids must be non-empty strings");
  }
  return ids;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isUnitInterval(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}

export function readModel(model: unknown): string {
  return typeof model === "string" ? model : "";
}

export function readUsage(usage: unknown): JevUsage {
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

export interface JevHttpRequest {
  readonly url: string;
  readonly method: "POST";
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
}

const SYSTEM_ONE_PATH = "/v1/systemone";
const MAX_ERROR_BODY_CHARS = 200;

function stripTrailingSlashes(url: string): string {
  return url.replace(/\/+$/, "");
}

export function buildNoulRequest(
  config: { readonly apiKey: string; readonly baseUrl: string; readonly model: string },
  request: NoulRequest,
): JevHttpRequest {
  const ids = requireIds(Object.keys(request.questions));
  const questions: Record<string, { type: "noul"; instructions: string }> = {};
  for (const id of ids) {
    const instructions = request.questions[id];
    if (typeof instructions !== "string" || instructions.length === 0) {
      throw new JevInputError(`question "${id}" has no instructions`);
    }
    questions[id] = { type: "noul", instructions };
  }
  return {
    url: `${stripTrailingSlashes(config.baseUrl)}${SYSTEM_ONE_PATH}`,
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.apiKey}`,
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ state: request.state, questions, model: config.model }),
  };
}

function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

function describeFailureBody(status: number, text: string): string {
  if (status === 401) return "TypeSafe rejected the API key";
  const trimmed = text.trim();
  if (trimmed.length === 0) return "no body";
  return trimmed.length > MAX_ERROR_BODY_CHARS ? `${trimmed.slice(0, MAX_ERROR_BODY_CHARS)}…` : trimmed;
}

export function parseNoulResponse(
  ids: readonly string[],
  status: number,
  ok: boolean,
  text: string,
): NoulResult {
  if (!ok) {
    throw new JevRequestError(`Jev request failed with status ${String(status)}: ${describeFailureBody(status, text)}`, {
      status,
      retryable: isRetryableStatus(status),
    });
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new JevResponseError("Jev response is not valid JSON", { cause: error });
  }
  if (!isRecord(parsed)) throw new JevResponseError("Jev response is not a JSON object");
  return {
    model: readModel(parsed["model"]),
    answers: validateNoulAnswers(ids, parsed["answers"]),
    usage: readUsage(parsed["usage"]),
  };
}
