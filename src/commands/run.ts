import { loadConfig } from "../config.js";
import { TYPESAFE_API_KEY_ENV } from "../core/index.js";
import { UsageError, errorName } from "../errors.js";
import { withFooter } from "../footer.js";
import type { CliIo } from "../io.js";
import { shouldAnnounceMissingKey } from "../notices.js";
import { clientFromEnv, recordRun } from "../prune.js";
import { runCommand } from "../runner.js";
import { UNAUTHORIZED_REASON, selectLines } from "../select.js";
import { RunStore, newRunId } from "../store.js";
import { resolveTask } from "../task.js";

export interface RunOptions {
  readonly argv: readonly string[];
  readonly task?: string | undefined;
  readonly threshold?: number | undefined;
  readonly hook?: boolean | undefined;
  readonly transcript?: string | undefined;
}

export async function runRun(options: RunOptions, io: CliIo): Promise<number> {
  if (options.argv.length === 0) throw new UsageError("run needs a command after --");
  const loaded = await loadConfig(io.env);
  const config = options.threshold !== undefined ? { ...loaded, threshold: options.threshold } : loaded;
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

  const client = clientFromEnv(io.env);
  if (options.hook === true && client === null && (await shouldAnnounceMissingKey(config.home))) {
    await io.writeError(`jevprune: ${TYPESAFE_API_KEY_ENV} not set, using fallback\n`).catch(() => undefined);
  }

  const capture = await runCommand({
    argv: options.argv,
    runId,
    store,
    maxPruneBytes: config.maxPruneBytes,
    cwd: io.cwd,
    env: io.env,
  });

  try {
    const selection = await selectLines({
      text: capture.text,
      task,
      command,
      exitCode: capture.exitCode,
      interrupted: capture.interrupted,
      ...(capture.oversize
        ? { oversize: { lines: capture.lines, headSegmentLines: capture.headSegmentLines } }
        : {}),
      client,
      config,
      runId,
    });
    if (options.hook === true && selection.fallbackReason === UNAUTHORIZED_REASON) {
      await io.writeError(`jevprune: ${TYPESAFE_API_KEY_ENV} rejected (401), using fallback\n`).catch(() => undefined);
    }
    const { footer } = await recordRun({
      store,
      selection,
      meta: {
        id: runId,
        command,
        argv: [...options.argv],
        startedAt: capture.startedAt,
        endedAt: capture.endedAt,
        exitCode: capture.exitCode,
        signal: capture.signal,
        bytes: capture.bytes,
        lines: capture.lines,
        task,
      },
      ...(capture.storeFailure !== undefined
        ? { storeFailureCode: capture.storeFailure.code ?? "failed" }
        : {}),
    });
    await io.write(withFooter(selection.kept, footer));
  } catch (error) {
    await io.write(capture.text).catch(() => undefined);
    await io
      .writeError(`jevprune: pruning failed (${errorName(error)}), output passed through\n`)
      .catch(() => undefined);
  }
  return capture.exitCode;
}
