export class JevpruneError extends Error {
  override readonly name: string = "JevpruneError";

  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
  }
}

export class ConfigError extends JevpruneError {
  override readonly name = "ConfigError";
}

export class UsageError extends JevpruneError {
  override readonly name = "UsageError";
}

export class RunStoreError extends JevpruneError {
  override readonly name = "RunStoreError";
  readonly code: string | undefined;

  constructor(message: string, details: { code?: string; cause?: unknown } = {}) {
    super(message, { cause: details.cause });
    this.code = details.code;
  }
}

export class SpawnError extends JevpruneError {
  override readonly name = "SpawnError";
  readonly executable: string;
  readonly code: string | undefined;

  constructor(message: string, details: { executable: string; code?: string; cause?: unknown }) {
    super(message, { cause: details.cause });
    this.executable = details.executable;
    this.code = details.code;
  }
}

export class RunNotFoundError extends JevpruneError {
  override readonly name = "RunNotFoundError";
  readonly id: string;

  constructor(id: string, options?: { cause?: unknown }) {
    super(`run ${id} was not found`, options);
    this.id = id;
  }
}

export class LineRangeError extends JevpruneError {
  override readonly name = "LineRangeError";
}

export function errorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const code: unknown = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}

export function errorName(error: unknown): string {
  return error instanceof Error ? error.name : "Error";
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  return String(error);
}
