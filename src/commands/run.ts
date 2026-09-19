import { loadConfig } from "../config.js";
import { RunStoreError, UsageError, errorName } from "../core/errors.js";
import { footerAfter, withFooter } from "../footer.js";
import type { CliIo } from "../io.js";
import { clientFromEnv, recordRun, shouldArchiveSelection } from "../prune.js";
import type { RunMetaBase } from "../prune.js";
import { runCommand } from "../runner.js";
import type { RunCapture } from "../runner.js";
import { NOT_UTF8_NOTE, fallbackReasonText } from "../core/reasons.js";
import { passthroughSelection, selectLines } from "../core/select.js";
import { looksSecret } from "../core/secrets.js";
import { RunStore, newRunId } from "../store.js";
import { resolveTask } from "../task.js";
import type { FallbackReason } from "../core/types.js";

export interface RunOptions {
  readonly argv: readonly string[];
  readonly task?: string | undefined;
  readonly threshold?: number | undefined;
}

interface PassThroughInput {
  readonly capture: RunCapture;
  readonly store: RunStore;
  readonly meta: RunMetaBase;
  readonly maxPruneBytes: number;
}

export async function runRun(options: RunOptions, io: CliIo): Promise<number> {
  if (options.argv.length === 0) throw new UsageError("run needs a command after --");
  const loaded = await loadConfig(io.env);
  const config = options.threshold !== undefined ? { ...loaded, threshold: options.threshold } : loaded;
  const store = new RunStore({ home: config.home, retention: config.retention });
  const runId = newRunId();
  const command = options.argv.join(" ");
  const { task } = resolveTask({
    ...(options.task !== undefined ? { flag: options.task } : {}),
    env: io.env,
    command,
  });

  const client = clientFromEnv(io.env);

  const capture = await runCommand({
    argv: options.argv,
    runId,
    store,
    maxPruneBytes: config.maxPruneBytes,
    cwd: io.cwd,
    env: io.env,
  });

  const meta: RunMetaBase = {
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
  };

  const failed = capture.exitCode !== 0 || capture.interrupted;
  if (!capture.validUtf8 || (capture.oversize && failed)) {
    return await passThrough({ capture, store, meta, maxPruneBytes: config.maxPruneBytes }, io);
  }

  try {
    const selection = await selectLines({
      text: capture.captured.toString("utf8"),
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
    const { footer } = await recordRun({
      store,
      selection,
      meta,
      archive: shouldArchiveSelection(selection),
      ...(capture.storeFailure !== undefined
        ? { storeFailureCode: capture.storeFailure.code ?? "failed" }
        : {}),
    });
    await io.write(withFooter(selection.kept, footer));
  } catch (error) {
    await io.writeBytes(capture.captured).catch(() => undefined);
    await io
      .writeError(`jevprune: pruning failed (${errorName(error)}), output passed through\n`)
      .catch(() => undefined);
  }
  return capture.exitCode;
}

async function passThrough(input: PassThroughInput, io: CliIo): Promise<number> {
  const { capture } = input;
  let storeFailureCode = capture.storeFailure === undefined ? undefined : (capture.storeFailure.code ?? "failed");
  let written = 0;
  let lastByte: number | undefined;
  let complete = false;

  if (capture.oversize && storeFailureCode === undefined) {
    try {
      for await (const chunk of input.store.readRunChunks(input.meta.id)) {
        await io.writeBytes(chunk).catch(() => undefined);
        if (chunk.length === 0) continue;
        written += chunk.length;
        lastByte = chunk[chunk.length - 1];
      }
      complete = true;
    } catch (error) {
      storeFailureCode = error instanceof RunStoreError ? (error.code ?? "failed") : "failed";
    }
  }

  if (!complete && written === 0) {
    await io.writeBytes(capture.captured).catch(() => undefined);
    lastByte = capture.captured.at(-1);
    complete = !capture.oversize;
  }

  const isSecret = capture.validUtf8 && looksSecret(input.meta.command, capture.captured.toString("utf8"));
  const oversizeReason: FallbackReason = {
    kind: "size-limit",
    maxBytes: input.maxPruneBytes,
    ...(isSecret ? { isSecret: true } : {}),
  };
  const reason: FallbackReason | undefined = capture.validUtf8
    ? complete && !isSecret
      ? undefined
      : oversizeReason
    : { kind: "not-utf8" };
  const note = capture.validUtf8 ? (reason === undefined ? undefined : fallbackReasonText(reason)) : NOT_UTF8_NOTE;

  try {
    const selection = passthroughSelection({
      bytes: capture.bytes,
      lines: capture.lines,
      ...(reason !== undefined ? { reason } : {}),
    });
    const { footer } = await recordRun({
      store: input.store,
      selection,
      archive: shouldArchiveSelection(selection),
      ...(note !== undefined ? { passthroughNote: note } : {}),
      meta: input.meta,
      ...(storeFailureCode !== undefined ? { storeFailureCode } : {}),
    });
    await io.write(footerAfter(lastByte, footer)).catch(() => undefined);
  } catch (error) {
    await io
      .writeError(`jevprune: pruning failed (${errorName(error)}), output passed through\n`)
      .catch(() => undefined);
  }
  return capture.exitCode;
}
