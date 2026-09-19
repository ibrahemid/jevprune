import type { EngineInterface, On, PluginOptions, Register, ToolCallResult } from "claude-code";

import { createHookState, handleBashResult, resolveHookOptions } from "../src/core/hook.js";
import type { HookDeps } from "../src/core/hook.js";
import type { HookFetchInit, HookFetchResponse } from "../src/core/http-client.js";
import { JevAbortError } from "../src/core/jev-errors.js";

function readEnv($: EngineInterface, name: string): Promise<string | undefined> {
  if (name === "TYPESAFE_API_KEY") return $.env.get("TYPESAFE_API_KEY");
  if (name === "JEVPRUNE_HOME") return $.env.get("JEVPRUNE_HOME");
  if (name === "HOME") return $.env.get("HOME");
  return Promise.resolve(undefined);
}

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

async function fetchThroughHost(
  $: EngineInterface,
  url: string,
  init?: HookFetchInit,
): Promise<HookFetchResponse> {
  const pending = $.http.fetch(url, {
    ...(init?.method === undefined ? {} : { method: init.method }),
    ...(init?.headers === undefined ? {} : { headers: { ...init.headers } }),
    ...(init?.body === undefined ? {} : { body: init.body }),
  });
  const signal = init?.signal;
  const response = signal === undefined ? await pending : await Promise.race([pending, rejectOnAbort(signal)]);
  return { status: response.status, ok: response.ok, text: response.text };
}

function depsOf($: EngineInterface): HookDeps {
  return {
    fs: {
      read: (path) => $.fs.read(path),
      write: (path, text) => $.fs.write(path, text),
      exists: (path) => $.fs.exists(path),
      list: (path) => $.fs.list(path),
    },
    http: { fetch: (url, init) => fetchThroughHost($, url, init) },
    env: { get: (name) => readEnv($, name) },
    settings: { read: () => $.settings.read() },
    session: {
      messages: () => $.session.messages(),
      cwd: () => $.session.cwd(),
    },
    ui: {
      log: (text) => {
        $.ui.log(text);
      },
      toast: (text, options) => {
        $.ui.toast(text, options);
      },
    },
    process: { run: (argv) => $.process.run(argv) },
  };
}

export const register: Register = (on: On, options: PluginOptions) => {
  const hookOptions = resolveHookOptions(options);
  const state = createHookState();
  on("tool.call", { tool: "Bash" }, async ($, event, next) => {
    const answer = await next(event);
    const outcome = await handleBashResult(
      depsOf($),
      state,
      hookOptions,
      { command: event.command, tool_use_id: event.tool_use_id },
      answer,
    );
    if (outcome === answer) return answer;
    return outcome as ToolCallResult<"Bash">;
  });
};
