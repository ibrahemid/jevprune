import { loadConfig } from "../config.js";
import { errorMessage } from "../errors.js";
import { formatHookOutput, parsePreToolUse, planRewrite } from "../hook.js";
import type { CliIo } from "../io.js";
import { readStream } from "../io.js";

export async function runHook(io: CliIo): Promise<number> {
  try {
    const input = parsePreToolUse(await readStream(io.stdin));
    if (input === null) return 0;
    const plan = planRewrite(input, await loadConfig(io.env));
    if (plan === null) return 0;
    await io.write(`${formatHookOutput(plan)}\n`);
  } catch (error) {
    await io.writeError(`jevprune: hook skipped: ${errorMessage(error)}\n`).catch(() => undefined);
  }
  return 0;
}
