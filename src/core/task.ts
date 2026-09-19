export const MAX_MESSAGE_TASK_CHARS = 500;

const MAX_TASK_MESSAGES = 3;

export interface TaskMessage {
  readonly role: "user" | "assistant";
  readonly text: string;
  readonly toolResults?: readonly unknown[];
}

export function taskFromMessages(messages: readonly TaskMessage[], command: string): string {
  const prompts: string[] = [];
  for (const message of messages) {
    if (message.role !== "user") continue;
    if (message.toolResults !== undefined && message.toolResults.length > 0) continue;
    const text = message.text.trim();
    if (text.length === 0) continue;
    prompts.push(text.slice(0, MAX_MESSAGE_TASK_CHARS));
  }
  const recent = prompts.slice(-MAX_TASK_MESSAGES);
  if (recent.length === 0) return command;
  const joined = recent.join("\n");
  return command.length === 0 ? joined : `${joined}\n${command}`;
}
