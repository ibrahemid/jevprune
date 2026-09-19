import { RunStoreError, errorCode } from "./errors.js";
import { gainFilePath, runLogPath, runMetaPath } from "./paths.js";
import type { RunRecordPlan } from "./record.js";

export interface RunFiles {
  read(path: string): Promise<string>;
  write(path: string, text: string): Promise<void>;
  exists(path: string): Promise<boolean>;
}

export interface PersistRunInput {
  readonly files: RunFiles;
  readonly home: string;
  readonly plan: RunRecordPlan;
  readonly log?: string;
  readonly logAlreadyAt?: string;
}

export interface PersistRunResult {
  readonly logPath?: string;
  readonly failureCode?: string;
}

export async function persistRun(input: PersistRunInput): Promise<PersistRunResult> {
  if (input.log !== undefined && input.logAlreadyAt !== undefined) {
    throw new RunStoreError("persistRun takes either log or logAlreadyAt, not both");
  }
  const { files, home, plan } = input;
  const id = plan.meta.id;
  let writtenLogPath: string | undefined;

  try {
    if (plan.persistLog && input.log !== undefined) {
      const path = runLogPath(home, id);
      await files.write(path, input.log);
      writtenLogPath = path;
    }
    await files.write(runMetaPath(home, id), `${JSON.stringify(plan.meta)}\n`);
    const gainPath = gainFilePath(home);
    const previous = (await files.exists(gainPath)) ? await files.read(gainPath) : "";
    await files.write(gainPath, `${previous}${JSON.stringify(plan.gain)}\n`);
  } catch (error) {
    return { failureCode: errorCode(error) ?? "failed" };
  }

  const logPath = input.logAlreadyAt ?? writtenLogPath;
  return logPath === undefined ? {} : { logPath };
}
