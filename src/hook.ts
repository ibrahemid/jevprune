import type { ResolvedConfig } from "./config.js";

export interface PreToolUseToolInput {
  readonly command?: string;
  readonly run_in_background?: boolean;
}

export interface PreToolUseInput {
  readonly tool_name?: string;
  readonly transcript_path?: string;
  readonly tool_input?: PreToolUseToolInput;
}

export interface RewritePlan {
  readonly command: string;
}

export const STATE_CHANGING_TOKENS: readonly string[] = [
  "cd",
  "export",
  "source",
  ".",
  "unset",
  "alias",
  "set",
  "eval",
  "exec",
  "pushd",
  "popd",
];

export const ALWAYS_INTERACTIVE_COMMANDS: readonly string[] = [
  "vim",
  "vi",
  "nvim",
  "nano",
  "emacs",
  "less",
  "more",
  "man",
  "top",
  "htop",
  "ssh",
  "telnet",
  "tmux",
  "screen",
  "sudo",
  "su",
  "passwd",
  "claude",
  "watch",
];

export const INTERACTIVE_WHEN_BARE_COMMANDS: readonly string[] = [
  "python",
  "python3",
  "node",
  "irb",
  "psql",
  "mysql",
  "sqlite3",
  "bash",
  "sh",
  "zsh",
  "fish",
  "gh",
];

const SHELL_COMMANDS: readonly string[] = ["bash", "sh", "zsh", "fish"];
const DOCKER_TTY_FLAG = /^-(?:i|t|it|ti)$|^--interactive$|^--tty$/;

const STATE_CHANGE_PATTERN = new RegExp(
  `(?:^|;|\\||\\(|&&)\\s*(?:${STATE_CHANGING_TOKENS.map(escapeRegExp).join("|")})(?=\\s|$|[;|)&])`,
);

const ENV_ASSIGNMENT_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*=/;

export function quoteForShell(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

export function hasStateChange(command: string): boolean {
  return STATE_CHANGE_PATTERN.test(command);
}

export function isInteractiveCommand(command: string): boolean {
  const words = command.split(/\s+/).filter((word) => word.length > 0);
  let index = 0;
  while (index < words.length && ENV_ASSIGNMENT_PATTERN.test(words[index] ?? "")) index += 1;
  const word = words[index];
  if (word === undefined) return true;
  const rest = words.slice(index + 1);
  if (ALWAYS_INTERACTIVE_COMMANDS.includes(word)) return true;
  if (INTERACTIVE_WHEN_BARE_COMMANDS.includes(word)) {
    if (rest.length === 0) return true;
    if (SHELL_COMMANDS.includes(word) && rest.includes("-i")) return true;
    return word === "gh" && rest[0] === "auth";
  }
  if (word === "tail") return rest[0] === "-f";
  if (word === "docker" && (rest[0] === "exec" || rest[0] === "run")) {
    return rest.some((flag) => DOCKER_TTY_FLAG.test(flag));
  }
  return false;
}

export function isAllowlisted(command: string, allowlist: readonly string[]): boolean {
  for (const prefix of allowlist) {
    if (prefix.length === 0) continue;
    if (command === prefix) return true;
    const next = command.startsWith(prefix) ? command[prefix.length] : undefined;
    if (next !== undefined && /\s/.test(next)) return true;
  }
  return false;
}

export function planRewrite(input: PreToolUseInput, config: ResolvedConfig): RewritePlan | null {
  if (input.tool_name !== "Bash") return null;
  if (!config.autoWrap) return null;

  const toolInput = input.tool_input;
  if (toolInput === undefined) return null;
  if (toolInput.run_in_background === true) return null;

  const command = typeof toolInput.command === "string" ? toolInput.command.trim() : "";
  if (command.length === 0) return null;
  if (/\bjevprune\b/.test(command)) return null;
  if (hasStateChange(command)) return null;
  if (isInteractiveCommand(command)) return null;
  if (command.endsWith("&") && !command.endsWith("&&")) return null;
  if (isAllowlisted(command, config.allowlist)) return null;

  const transcript =
    typeof input.transcript_path === "string" && input.transcript_path.length > 0
      ? ` --transcript ${quoteForShell(input.transcript_path)}`
      : "";
  return { command: `jevprune run --hook${transcript} -- bash -c ${quoteForShell(command)}` };
}

export function parsePreToolUse(raw: string): PreToolUseInput | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isRecord(parsed)) return null;

  const toolName = parsed["tool_name"];
  const transcriptPath = parsed["transcript_path"];
  const toolInput = parsed["tool_input"];
  return {
    ...(typeof toolName === "string" ? { tool_name: toolName } : {}),
    ...(typeof transcriptPath === "string" ? { transcript_path: transcriptPath } : {}),
    ...(isRecord(toolInput) ? { tool_input: readToolInput(toolInput) } : {}),
  };
}

export function formatHookOutput(plan: RewritePlan): string {
  return JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      updatedInput: { command: plan.command },
    },
  });
}

function readToolInput(source: Record<string, unknown>): PreToolUseToolInput {
  const command = source["command"];
  const background = source["run_in_background"];
  return {
    ...(typeof command === "string" ? { command } : {}),
    ...(typeof background === "boolean" ? { run_in_background: background } : {}),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
