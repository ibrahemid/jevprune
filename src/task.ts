import { TASK_ENV } from "./config.js";

export const MAX_TASK_LENGTH = 400;

export type TaskSource = "flag" | "env" | "command";

export interface TaskInput {
  readonly flag?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly command: string;
}

export interface ResolvedTask {
  readonly task: string;
  readonly source: TaskSource;
}

export function resolveTask(input: TaskInput): Promise<ResolvedTask> {
  const flag = input.flag?.trim() ?? "";
  if (flag.length > 0) return Promise.resolve({ task: flag, source: "flag" });

  const fromEnv = input.env?.[TASK_ENV]?.trim() ?? "";
  if (fromEnv.length > 0) return Promise.resolve({ task: fromEnv, source: "env" });

  return Promise.resolve({ task: input.command, source: "command" });
}
