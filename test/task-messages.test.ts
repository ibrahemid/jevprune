import { describe, expect, it } from "vitest";

import type { TaskMessage } from "../src/core/task.js";
import { MAX_MESSAGE_TASK_CHARS, taskFromMessages } from "../src/core/task.js";

const COMMAND = "pnpm test";

function userMessage(text: string, toolResults?: readonly unknown[]): TaskMessage {
  return toolResults === undefined ? { role: "user", text } : { role: "user", text, toolResults };
}

describe("taskFromMessages", () => {
  it("appends the command to a single prompt", () => {
    expect(taskFromMessages([userMessage("fix the failing login test")], COMMAND)).toBe(
      `fix the failing login test\n${COMMAND}`,
    );
  });

  it("keeps the last three prompts in order", () => {
    const messages = [
      userMessage("one"),
      userMessage("two"),
      userMessage("three"),
      userMessage("four"),
      userMessage("five"),
    ];
    expect(taskFromMessages(messages, COMMAND)).toBe(`three\nfour\nfive\n${COMMAND}`);
  });

  it("drops assistant messages", () => {
    const messages: TaskMessage[] = [
      { role: "assistant", text: "running the suite now" },
      userMessage("fix the failing login test"),
    ];
    expect(taskFromMessages(messages, COMMAND)).toBe(`fix the failing login test\n${COMMAND}`);
  });

  it("drops messages that carry tool results", () => {
    const messages = [userMessage("tool output", [{ id: "1" }]), userMessage("fix the login test")];
    expect(taskFromMessages(messages, COMMAND)).toBe(`fix the login test\n${COMMAND}`);
  });

  it("keeps a message with an empty tool result list", () => {
    expect(taskFromMessages([userMessage("fix the login test", [])], COMMAND)).toBe(
      `fix the login test\n${COMMAND}`,
    );
  });

  it("drops empty and whitespace-only messages", () => {
    const messages = [userMessage(""), userMessage("   \n\t "), userMessage("fix the login test")];
    expect(taskFromMessages(messages, COMMAND)).toBe(`fix the login test\n${COMMAND}`);
  });

  it("truncates each prompt to the character limit", () => {
    const long = "x".repeat(600);
    const task = taskFromMessages([userMessage(long)], COMMAND);
    expect(task).toBe(`${"x".repeat(MAX_MESSAGE_TASK_CHARS)}\n${COMMAND}`);
  });

  it("returns the command when no message qualifies", () => {
    expect(taskFromMessages([{ role: "assistant", text: "done" }], COMMAND)).toBe(COMMAND);
    expect(taskFromMessages([], COMMAND)).toBe(COMMAND);
  });

  it("returns the prompts alone for an empty command", () => {
    expect(taskFromMessages([userMessage("fix the login test")], "")).toBe("fix the login test");
  });

  it("returns an empty string with no prompts and no command", () => {
    expect(taskFromMessages([], "")).toBe("");
  });
});
