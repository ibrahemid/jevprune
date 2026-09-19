import { TASK_ENV } from "./config.js";

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

export function resolveTask(input: TaskInput): ResolvedTask {
  const flag = input.flag?.trim() ?? "";
  if (flag.length > 0) return { task: flag, source: "flag" };

  const fromEnv = input.env?.[TASK_ENV]?.trim() ?? "";
  if (fromEnv.length > 0) return { task: fromEnv, source: "env" };

  return { task: input.command, source: "command" };
}
