import { isDocumentOutput } from "./classify.js";
import { joinHomePath } from "./paths.js";
import { looksSecret } from "./secrets.js";
import { RUNS_DIR } from "./store-types.js";
import { looksBinary } from "./text.js";

export type PassthroughReason =
  | "denied"
  | "tool-error"
  | "interrupted"
  | "recovery-read"
  | "fast-path"
  | "binary"
  | "document"
  | "secret"
  | "no-key";

export interface PassthroughDecisionInput {
  readonly denied: boolean;
  readonly isError: boolean;
  readonly interrupted: boolean;
  readonly command: string;
  readonly output: string;
  readonly lines: number;
  readonly fastPathLines: number;
  readonly hasKey: boolean;
  readonly home: string;
}

const SHOW_COMMAND = /(?:^|[|;&]\s*)jevprune\s+show\b/;
const DEFAULT_RUNS_PATH = `~/.jevprune/${RUNS_DIR}`;

function isRecoveryRead(command: string, home: string): boolean {
  if (SHOW_COMMAND.test(command)) return true;
  if (command.includes(DEFAULT_RUNS_PATH)) return true;
  if (home.length === 0) return false;
  return command.includes(joinHomePath(home, RUNS_DIR));
}

export function passthroughReason(input: PassthroughDecisionInput): PassthroughReason | null {
  if (input.denied) return "denied";
  if (input.isError) return "tool-error";
  if (input.interrupted) return "interrupted";
  if (isRecoveryRead(input.command, input.home)) return "recovery-read";
  if (input.lines <= input.fastPathLines) return "fast-path";
  if (looksBinary(input.output)) return "binary";
  if (isDocumentOutput(input.command, input.output)) return "document";
  if (looksSecret(input.command, input.output)) return "secret";
  if (!input.hasKey) return "no-key";
  return null;
}
