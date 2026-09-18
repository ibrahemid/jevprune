import { readFile } from "node:fs/promises";

import { errorMessage } from "../errors.js";
import { withFooter } from "../footer.js";
import type { CliIo } from "../io.js";
import { readStream } from "../io.js";
import { pruneOutput } from "../prune.js";
import { resolveTask } from "../task.js";

export interface SelectOptions {
  readonly task?: string | undefined;
  readonly threshold?: number | undefined;
  readonly file?: string | undefined;
  readonly command?: string | undefined;
}

export async function runSelect(options: SelectOptions, io: CliIo): Promise<number> {
  let text: string;
  try {
    text = options.file !== undefined ? await readFile(options.file, "utf8") : await readStream(io.stdin);
  } catch (error) {
    await io.writeError(`jevprune: input could not be read: ${errorMessage(error)}\n`);
    return 1;
  }

  const command = options.command ?? "";
  const { task } = await resolveTask({
    ...(options.task !== undefined ? { flag: options.task } : {}),
    env: io.env,
    command,
  });
  const result = await pruneOutput({
    text,
    task,
    command,
    exitCode: null,
    env: io.env,
    ...(options.threshold !== undefined ? { config: { threshold: options.threshold } } : {}),
  });
  await io.write(withFooter(result.kept, result.footer));
  return 0;
}
