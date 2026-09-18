import { loadConfig } from "../config.js";
import { UsageError } from "../errors.js";
import { formatFooter, withFooter } from "../footer.js";
import type { CliIo } from "../io.js";
import { runCommand } from "../runner.js";
import type { RunCapture } from "../runner.js";
import { saveRun } from "../save.js";
import { RunStore, newRunId } from "../store.js";
import type { RunMeta } from "../store.js";
import { resolveTask } from "../task.js";

export interface RunOptions {
  readonly argv: readonly string[];
  readonly task?: string | undefined;
  readonly hook?: boolean | undefined;
  readonly transcript?: string | undefined;
}

export async function runRun(options: RunOptions, io: CliIo): Promise<number> {
  if (options.argv.length === 0) throw new UsageError("run needs a command after --");
  const config = await loadConfig(io.env);
  const store = new RunStore({ home: config.home, retention: config.retention });
  const runId = newRunId();
  const command = options.argv.join(" ");
  const transcriptPath = options.hook === true ? options.transcript : undefined;
  const { task } = await resolveTask({
    ...(options.task !== undefined ? { flag: options.task } : {}),
    env: io.env,
    ...(transcriptPath !== undefined ? { transcriptPath } : {}),
    command,
  });
  const capture = await runCommand({
    argv: options.argv,
    runId,
    store,
    maxPruneBytes: config.maxPruneBytes,
    cwd: io.cwd,
    env: io.env,
  });

  try {
    const footer = await report(capture, { store, runId, command, argv: options.argv, task });
    await io.write(withFooter(capture.text, footer));
  } catch {
    await io.write(capture.text);
  }
  return capture.exitCode;
}

async function report(
  capture: RunCapture,
  context: { store: RunStore; runId: string; command: string; argv: readonly string[]; task: string },
): Promise<string> {
  const meta: RunMeta = {
    id: context.runId,
    command: context.command,
    argv: [...context.argv],
    startedAt: capture.startedAt,
    endedAt: capture.endedAt,
    exitCode: capture.exitCode,
    signal: capture.signal,
    bytes: capture.bytes,
    lines: capture.lines,
    mode: "passthrough",
    linesOut: capture.lines,
    task: context.task,
  };
  const saveFailureCode = await saveRun(context.store, meta, {
    ts: new Date().toISOString(),
    id: context.runId,
    mode: "passthrough",
    linesIn: capture.lines,
    linesOut: capture.lines,
    bytesIn: capture.bytes,
    bytesOut: Buffer.byteLength(capture.text),
  });
  const storeFailureCode = capture.storeFailure?.code ?? (capture.storeFailure !== undefined ? "failed" : undefined);
  const failureCode = storeFailureCode ?? saveFailureCode;
  return formatFooter({
    mode: "passthrough",
    linesIn: capture.lines,
    linesOut: capture.lines,
    exitCode: capture.exitCode,
    ...(failureCode !== undefined
      ? { storeFailureCode: failureCode }
      : { logPath: context.store.logPath(context.runId) }),
  });
}
