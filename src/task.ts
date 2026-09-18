import { readFile } from "node:fs/promises";

import { TASK_ENV } from "./config.js";
import { TranscriptError, errorMessage } from "./errors.js";

export const MAX_TASK_LENGTH = 400;

export type TaskSource = "flag" | "env" | "transcript" | "command";

export interface TaskInput {
  readonly flag?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly transcriptPath?: string;
  readonly command: string;
}

export interface ResolvedTask {
  readonly task: string;
  readonly source: TaskSource;
}

export async function resolveTask(input: TaskInput): Promise<ResolvedTask> {
  const flag = input.flag?.trim() ?? "";
  if (flag.length > 0) return { task: flag, source: "flag" };

  const fromEnv = input.env?.[TASK_ENV]?.trim() ?? "";
  if (fromEnv.length > 0) return { task: fromEnv, source: "env" };

  if (input.transcriptPath !== undefined && input.transcriptPath.length > 0) {
    const fromTranscript = await readTranscriptTask(input.transcriptPath).catch((error: unknown) => {
      if (error instanceof TranscriptError) return null;
      throw error;
    });
    if (fromTranscript !== null) return { task: fromTranscript, source: "transcript" };
  }

  return { task: input.command, source: "command" };
}

export async function readTranscriptTask(path: string): Promise<string | null> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    throw new TranscriptError(`transcript ${path} could not be read: ${errorMessage(error)}`, {
      path,
      cause: error,
    });
  }
  for (const line of raw.split("\n")) {
    if (line.trim().length === 0) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    const text = userText(parsed);
    if (text !== null) return text;
  }
  return null;
}

function userText(entry: unknown): string | null {
  if (!isRecord(entry) || entry["type"] !== "user") return null;
  const message = entry["message"];
  if (!isRecord(message)) return null;
  const content = message["content"];
  if (typeof content === "string") return usableText(content);
  if (!Array.isArray(content)) return null;
  for (const item of content) {
    if (!isRecord(item) || item["type"] !== "text") continue;
    const text = item["text"];
    if (typeof text !== "string") continue;
    const usable = usableText(text);
    if (usable !== null) return usable;
  }
  return null;
}

function usableText(text: string): string | null {
  const trimmed = text.trim();
  if (trimmed.length === 0 || trimmed.startsWith("<")) return null;
  return trimmed.slice(0, MAX_TASK_LENGTH);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
