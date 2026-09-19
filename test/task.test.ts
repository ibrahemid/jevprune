import { describe, expect, it } from "vitest";

import {
  HttpJevClient,
  MAX_MESSAGE_TASK_CHARS,
  buildRunRecord,
  isDocumentOutput,
  looksBinary,
  looksSecret,
  passthroughReason,
  persistRun,
  pruneCore,
  refitToBudget,
  taskFromMessages,
} from "../src/index.js";
import type { TaskMessage } from "../src/index.js";
import { resolveTask } from "../src/task.js";

describe("resolveTask", () => {
  it("prefers the flag over the environment and the command", () => {
    expect(resolveTask({ flag: "from flag", env: { JEVPRUNE_TASK: "from env" }, command: "pnpm test" })).toEqual({
      task: "from flag",
      source: "flag",
    });
  });

  it("prefers the environment over the command", () => {
    expect(resolveTask({ env: { JEVPRUNE_TASK: "from env" }, command: "pnpm test" })).toEqual({
      task: "from env",
      source: "env",
    });
  });

  it("falls back to the command", () => {
    expect(resolveTask({ env: {}, command: "pnpm test" })).toEqual({
      task: "pnpm test",
      source: "command",
    });
  });

  it("ignores blank flag and environment values", () => {
    expect(resolveTask({ flag: "   ", env: { JEVPRUNE_TASK: "" }, command: "pnpm test" })).toEqual({
      task: "pnpm test",
      source: "command",
    });
  });
});

describe("package entry point", () => {
  it("exposes taskFromMessages", () => {
    const messages: readonly TaskMessage[] = [{ role: "user", text: "fix the auth test" }];
    expect(taskFromMessages(messages, "pnpm test")).toBe("fix the auth test\npnpm test");
    expect(MAX_MESSAGE_TASK_CHARS).toBe(500);
  });

  it("exposes the protection, client, core and store entry points", () => {
    for (const exported of [
      isDocumentOutput,
      looksSecret,
      looksBinary,
      passthroughReason,
      HttpJevClient,
      pruneCore,
      persistRun,
      buildRunRecord,
      refitToBudget,
    ]) {
      expect(typeof exported).toBe("function");
    }
  });
});
