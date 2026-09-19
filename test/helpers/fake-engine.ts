import type { JevState } from "../../src/core/client.js";
import { RunStoreError } from "../../src/core/errors.js";
import type { NoulScorer } from "../../src/core/fake-jev.js";
import type { FsEntry, HookDeps } from "../../src/core/hook.js";
import type { HookFetchInit, HookFetchResponse } from "../../src/core/http-client.js";
import type { TaskMessage } from "../../src/core/task.js";
import { utf8Length } from "../../src/core/text.js";

export interface FakeRequest {
  readonly url: string;
  readonly body: string;
}

export interface FakeToast {
  readonly text: string;
  readonly timeoutMs: number | undefined;
}

export interface FakeEngine {
  readonly deps: HookDeps;
  readonly files: Map<string, string>;
  readonly logs: string[];
  readonly toasts: string[];
  readonly toastCalls: FakeToast[];
  readonly requests: FakeRequest[];
  readonly processCalls: (readonly string[])[];
}

export interface FakeEngineOptions {
  readonly env?: Readonly<Record<string, string>>;
  readonly settings?: Readonly<Record<string, unknown>>;
  readonly messages?: readonly TaskMessage[];
  readonly files?: Readonly<Record<string, string>>;
  readonly cwd?: string;
  readonly noul?: NoulScorer;
  readonly httpStatus?: number;
  readonly failWrite?: (path: string) => Error | undefined;
}

const DEFAULT_CWD = "/work";
const KEEP_EVERYTHING: NoulScorer = () => 1;

export function createFakeEngine(options: FakeEngineOptions = {}): FakeEngine {
  const files = new Map<string, string>(Object.entries(options.files ?? {}));
  const logs: string[] = [];
  const toasts: string[] = [];
  const toastCalls: FakeToast[] = [];
  const requests: FakeRequest[] = [];
  const processCalls: (readonly string[])[] = [];
  const scorer = options.noul ?? KEEP_EVERYTHING;
  const status = options.httpStatus ?? 200;

  const deps: HookDeps = {
    fs: {
      read: (path) => {
        const text = files.get(path);
        if (text === undefined) {
          return Promise.reject(new RunStoreError(`${path} was not found`, { code: "ENOENT" }));
        }
        return Promise.resolve(text);
      },
      write: (path, text) => {
        const failure = options.failWrite?.(path);
        if (failure !== undefined) return Promise.reject(failure);
        files.set(path, text);
        return Promise.resolve();
      },
      exists: (path) => Promise.resolve(files.has(path)),
      list: (path) => Promise.resolve(listDirectory(files, path)),
    },
    http: { fetch: (url, init) => answerNoul(requests, scorer, status, url, init) },
    env: { get: (name) => Promise.resolve(options.env?.[name]) },
    settings: { read: () => Promise.resolve(options.settings ?? {}) },
    session: {
      messages: () => Promise.resolve(options.messages ?? []),
      cwd: () => Promise.resolve(options.cwd ?? DEFAULT_CWD),
    },
    ui: {
      log: (text) => {
        logs.push(text);
      },
      toast: (text, toastOptions) => {
        toasts.push(text);
        toastCalls.push({ text, timeoutMs: toastOptions?.timeoutMs });
      },
    },
    process: {
      run: (argv) => {
        processCalls.push(argv);
        if (argv[0] === "rm") for (const path of argv.slice(2)) files.delete(path);
        return Promise.resolve({ exitCode: 0, stdout: "", stderr: "" });
      },
    },
  };

  return { deps, files, logs, toasts, toastCalls, requests, processCalls };
}

function listDirectory(files: ReadonlyMap<string, string>, path: string): FsEntry[] {
  const prefix = path.endsWith("/") ? path : `${path}/`;
  const entries: FsEntry[] = [];
  for (const [key, text] of files) {
    if (!key.startsWith(prefix)) continue;
    const name = key.slice(prefix.length);
    if (name.includes("/")) continue;
    entries.push({ name, kind: "file", size: utf8Length(text) });
  }
  return entries;
}

function answerNoul(
  requests: FakeRequest[],
  scorer: NoulScorer,
  status: number,
  url: string,
  init?: HookFetchInit,
): Promise<HookFetchResponse> {
  const body = init?.body ?? "";
  requests.push({ url, body });
  if (status < 200 || status > 299) {
    return Promise.resolve({ status, ok: false, text: JSON.stringify({ error: "request refused" }) });
  }
  const parsed: unknown = JSON.parse(body);
  if (!isRecord(parsed)) throw new RunStoreError("the fake engine received a request that is not an object");
  const questions = parsed["questions"];
  if (!isRecord(questions)) throw new RunStoreError("the fake engine received a request without questions");
  const state = parsed["state"];
  const answers: Record<string, { type: "noul"; noul: number }> = {};
  for (const [id, question] of Object.entries(questions)) {
    const instructions = isRecord(question) ? question["instructions"] : undefined;
    answers[id] = {
      type: "noul",
      noul: clamp(scorer(id, typeof instructions === "string" ? instructions : "", asState(state))),
    };
  }
  return Promise.resolve({
    status,
    ok: true,
    text: JSON.stringify({
      model: typeof parsed["model"] === "string" ? parsed["model"] : "jev-fake",
      answers,
      usage: { input_tokens: Object.keys(answers).length * 10, output_tokens: Object.keys(answers).length },
    }),
  });
}

function asState(state: unknown): JevState {
  if (typeof state === "string") return state;
  return isJevState(state) ? state : null;
}

function isJevState(value: unknown): value is JevState {
  return typeof value === "object";
}

function clamp(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
