import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { MAX_TASK_LENGTH, resolveTask } from "../src/task.js";
import { makeHome, removeHome } from "./helpers/env.js";

let home = "";

beforeEach(async () => {
  home = await makeHome();
});

afterEach(async () => {
  await removeHome(home);
});

async function writeTranscript(lines: readonly unknown[]): Promise<string> {
  const path = join(home, "transcript.jsonl");
  await writeFile(path, lines.map((line) => JSON.stringify(line)).join("\n"), "utf8");
  return path;
}

function userEntry(text: string): unknown {
  return { type: "user", message: { role: "user", content: text } };
}

describe("resolveTask", () => {
  it("prefers the flag, then the environment, then the transcript, then the command", async () => {
    const transcriptPath = await writeTranscript([userEntry("from transcript")]);
    const env = { JEVPRUNE_TASK: "from env" };
    expect(await resolveTask({ flag: "from flag", env, transcriptPath, command: "pnpm test" })).toEqual({
      task: "from flag",
      source: "flag",
    });
    expect(await resolveTask({ env, transcriptPath, command: "pnpm test" })).toEqual({
      task: "from env",
      source: "env",
    });
    expect(await resolveTask({ env: {}, transcriptPath, command: "pnpm test" })).toEqual({
      task: "from transcript",
      source: "transcript",
    });
    expect(await resolveTask({ env: {}, command: "pnpm test" })).toEqual({
      task: "pnpm test",
      source: "command",
    });
  });

  it("ignores blank flag and environment values", async () => {
    expect(await resolveTask({ flag: "   ", env: { JEVPRUNE_TASK: "" }, command: "pnpm test" })).toEqual({
      task: "pnpm test",
      source: "command",
    });
  });

  it("reads the first usable text item of an array message", async () => {
    const transcriptPath = await writeTranscript([
      { type: "system", message: { content: "ignored" } },
      { type: "user", message: { content: [{ type: "image" }, { type: "text", text: "  fix the auth test  " }] } },
    ]);
    expect(await resolveTask({ env: {}, transcriptPath, command: "pnpm test" })).toEqual({
      task: "fix the auth test",
      source: "transcript",
    });
  });

  it("skips injected and empty texts", async () => {
    const transcriptPath = await writeTranscript([
      userEntry("<command-name>/clear</command-name>"),
      userEntry("   "),
      { type: "user", message: { content: [{ type: "text", text: "<system>" }] } },
      userEntry("why is the build slow"),
    ]);
    expect((await resolveTask({ env: {}, transcriptPath, command: "pnpm test" })).task).toBe("why is the build slow");
  });

  it("caps the transcript task at 400 characters", async () => {
    const transcriptPath = await writeTranscript([userEntry("x".repeat(600))]);
    const resolved = await resolveTask({ env: {}, transcriptPath, command: "pnpm test" });
    expect(resolved.task).toHaveLength(MAX_TASK_LENGTH);
  });

  it("skips unparseable transcript lines", async () => {
    const path = join(home, "broken.jsonl");
    await writeFile(path, `{not json\n${JSON.stringify(userEntry("keep going"))}\n`, "utf8");
    expect((await resolveTask({ env: {}, transcriptPath: path, command: "pnpm test" })).task).toBe("keep going");
  });

  it("falls back to the command when the transcript cannot be read", async () => {
    expect(
      await resolveTask({ env: {}, transcriptPath: join(home, "missing.jsonl"), command: "pnpm test" }),
    ).toEqual({ task: "pnpm test", source: "command" });
  });

  it("falls back to the command when the transcript has no user text", async () => {
    const transcriptPath = await writeTranscript([{ type: "assistant", message: { content: "hello" } }]);
    expect((await resolveTask({ env: {}, transcriptPath, command: "pnpm test" })).source).toBe("command");
  });
});
