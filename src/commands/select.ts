import { readFile } from "node:fs/promises";

import { countByteLines, isValidUtf8 } from "../bytes.js";
import { loadConfig } from "../config.js";
import { errorMessage } from "../errors.js";
import { footerAfter, withFooter } from "../footer.js";
import type { CliIo } from "../io.js";
import { readStreamBytes } from "../io.js";
import { pruneOutput, recordRun } from "../prune.js";
import { NOT_UTF8_NOTE, passthroughSelection } from "../select.js";
import { RunStore, newRunId } from "../store.js";
import { resolveTask } from "../task.js";

export interface SelectOptions {
  readonly task?: string | undefined;
  readonly threshold?: number | undefined;
  readonly file?: string | undefined;
  readonly command?: string | undefined;
}

interface PassThroughInput {
  readonly bytes: Buffer;
  readonly task: string;
  readonly command: string;
  readonly env: NodeJS.ProcessEnv;
}

export async function runSelect(options: SelectOptions, io: CliIo): Promise<number> {
  let input: Buffer;
  try {
    input = options.file !== undefined ? await readFile(options.file) : await readStreamBytes(io.stdin);
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

  if (!isValidUtf8(input)) {
    return await passThrough({ bytes: input, task, command, env: io.env }, io);
  }

  const result = await pruneOutput({
    text: input.toString("utf8"),
    task,
    command,
    exitCode: null,
    env: io.env,
    ...(options.threshold !== undefined ? { config: { threshold: options.threshold } } : {}),
  });
  await io.write(withFooter(result.kept, result.footer));
  return 0;
}

async function passThrough(input: PassThroughInput, io: CliIo): Promise<number> {
  const config = await loadConfig(input.env);
  const store = new RunStore({ home: config.home, retention: config.retention });
  const lines = countByteLines(input.bytes);
  const startedAt = new Date().toISOString();
  const { footer } = await recordRun({
    store,
    selection: passthroughSelection({ bytes: input.bytes.length, lines, reason: { kind: "not-utf8" } }),
    logBytes: input.bytes,
    passthroughNote: NOT_UTF8_NOTE,
    meta: {
      id: newRunId(),
      command: input.command,
      argv: [],
      startedAt,
      endedAt: new Date().toISOString(),
      exitCode: null,
      signal: null,
      bytes: input.bytes.length,
      lines,
      task: input.task,
    },
  });
  await io.writeBytes(input.bytes);
  await io.write(footerAfter(input.bytes.at(-1), footer));
  return 0;
}
