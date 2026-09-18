import { JevAbortError, JevInputError, JevTimeoutError } from "./errors.js";
import type {
  ChoiceAnswer,
  ChoiceQuestionSpec,
  ChoiceRequest,
  ChoiceResult,
  JevClient,
  JevRequestOptions,
  JevState,
  NoulRequest,
  NoulResult,
} from "./jev-client.js";
import { estimateJsonTokens } from "./tokens.js";

export type NoulScorer = (id: string, instructions: string, state: JevState) => number;
export type ChoiceScorer = (
  id: string,
  spec: ChoiceQuestionSpec<string>,
  state: JevState,
) => string | ChoiceAnswer<string>;

export interface FakeJevCall {
  readonly kind: "noul" | "choice";
  readonly state: JevState;
  readonly ids: readonly string[];
}

export interface FakeJevOptions {
  readonly noul?: NoulScorer;
  readonly choice?: ChoiceScorer;
  readonly delayMs?: number;
  readonly failWith?: (call: number) => Error | undefined;
  readonly model?: string;
}

export class FakeJevClient implements JevClient {
  readonly calls: FakeJevCall[] = [];
  readonly #options: FakeJevOptions;

  constructor(options: FakeJevOptions = {}) {
    this.#options = options;
  }

  async noul(request: NoulRequest, options: JevRequestOptions = {}): Promise<NoulResult> {
    const ids = Object.keys(request.questions);
    if (ids.length === 0) throw new JevInputError("a Jev request needs at least one question");
    this.calls.push({ kind: "noul", state: request.state, ids });
    await this.#settle(options.signal);
    const scorer = this.#options.noul ?? ((): number => 0.5);
    const answers: Record<string, number> = {};
    for (const id of ids) {
      answers[id] = clamp(scorer(id, request.questions[id] ?? "", request.state));
    }
    return { model: this.#options.model ?? "jev-fake", answers, usage: this.#usage(request, ids.length) };
  }

  async choice<L extends string>(
    request: ChoiceRequest<L>,
    options: JevRequestOptions = {},
  ): Promise<ChoiceResult<L>> {
    const ids = Object.keys(request.questions);
    if (ids.length === 0) throw new JevInputError("a Jev request needs at least one question");
    this.calls.push({ kind: "choice", state: request.state, ids });
    await this.#settle(options.signal);
    const answers: Record<string, ChoiceAnswer<L>> = {};
    for (const id of ids) {
      const spec = request.questions[id];
      if (spec === undefined) continue;
      answers[id] = resolveChoice(id, spec, request.state, this.#options.choice);
    }
    return { model: this.#options.model ?? "jev-fake", answers, usage: this.#usage(request, ids.length) };
  }

  async #settle(signal: AbortSignal | undefined): Promise<void> {
    const failure = this.#options.failWith?.(this.calls.length);
    await wait(this.#options.delayMs ?? 0, signal);
    if (failure !== undefined) throw failure;
  }

  #usage(request: NoulRequest | ChoiceRequest<string>, questionCount: number): NoulResult["usage"] {
    return { inputTokens: estimateJsonTokens(request), outputTokens: questionCount * 20 };
  }
}

function resolveChoice<L extends string>(
  id: string,
  spec: ChoiceQuestionSpec<L>,
  state: JevState,
  scorer: ChoiceScorer | undefined,
): ChoiceAnswer<L> {
  const first = spec.labels[0];
  if (first === undefined) throw new JevInputError(`choice question "${id}" has no labels`);
  const picked = scorer?.(id, spec, state) ?? first;
  if (typeof picked === "string") {
    if (!spec.labels.includes(picked as L)) {
      throw new JevInputError(`fake scorer chose "${picked}" which is not a label of "${id}"`);
    }
    const probabilities = {} as Record<L, number>;
    for (const label of spec.labels) probabilities[label] = label === picked ? 1 : 0;
    return { choice: picked as L, confidence: 1, probabilities };
  }
  if (!spec.labels.includes(picked.choice as L)) {
    throw new JevInputError(`fake scorer chose "${picked.choice}" which is not a label of "${id}"`);
  }
  return picked as ChoiceAnswer<L>;
}

function clamp(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

function abortError(signal: AbortSignal): Error {
  const reason: unknown = signal.reason;
  if (reason instanceof Error && reason.name === "TimeoutError") {
    return new JevTimeoutError(0, "fake Jev request timed out", { cause: reason });
  }
  return new JevAbortError("fake Jev request aborted", { cause: reason });
}

function wait(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted === true) {
      reject(abortError(signal));
      return;
    }
    const onAbort = (): void => {
      clearTimeout(timer);
      if (signal !== undefined) reject(abortError(signal));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
