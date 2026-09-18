import { readFile } from "node:fs/promises";

import { loadConfig } from "../config.js";
import { RunStoreError, errorMessage } from "../errors.js";
import { formatFooter, withFooter } from "../footer.js";
import type { CliIo } from "../io.js";
import { readStream } from "../io.js";
import { splitLines } from "../lines.js";
import { saveRun } from "../save.js";
import { RunStore, newRunId } from "../store.js";
import { resolveTask } from "../task.js";

export interface SelectOptions {
  readonly task?: string | undefined;
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

  const config = await loadConfig(io.env);
  const store = new RunStore({ home: config.home, retention: config.retention });
  const runId = newRunId();
  const command = options.command ?? "";
  const { task } = await resolveTask({
    ...(options.task !== undefined ? { flag: options.task } : {}),
    env: io.env,
    command,
  });
  const lines = splitLines(text).length;
  const bytes = Buffer.byteLength(text);
  const startedAt = new Date().toISOString();

  let storeFailureCode = await writeLog(store, runId, text);
  if (storeFailureCode === undefined) {
    storeFailureCode = await saveRun(
      store,
      {
        id: runId,
        command,
        argv: [],
        startedAt,
        endedAt: new Date().toISOString(),
        exitCode: null,
        signal: null,
        bytes,
        lines,
        mode: "passthrough",
        linesOut: lines,
        task,
      },
      {
        ts: new Date().toISOString(),
        id: runId,
        mode: "passthrough",
        linesIn: lines,
        linesOut: lines,
        bytesIn: bytes,
        bytesOut: bytes,
      },
    );
  }

  const footer = formatFooter({
    mode: "passthrough",
    linesIn: lines,
    linesOut: lines,
    exitCode: null,
    ...(storeFailureCode !== undefined ? { storeFailureCode } : { logPath: store.logPath(runId) }),
  });
  await io.write(withFooter(text, footer));
  return 0;
}

async function writeLog(store: RunStore, runId: string, text: string): Promise<string | undefined> {
  try {
    const writer = await store.openRun({ id: runId });
    writer.write(Buffer.from(text, "utf8"));
    await writer.close();
    if (writer.failure !== undefined) return writer.failure.code ?? "failed";
  } catch (error) {
    if (!(error instanceof RunStoreError)) throw error;
    return error.code ?? "failed";
  }
  return undefined;
}
