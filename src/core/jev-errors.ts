export class JevCoreError extends Error {
  override readonly name: string = "JevCoreError";

  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
  }
}

export class JevConfigError extends JevCoreError {
  override readonly name = "JevConfigError";
}

export class JevInputError extends JevCoreError {
  override readonly name = "JevInputError";
}

export class JevBudgetError extends JevCoreError {
  override readonly name = "JevBudgetError";
}

export class JevRequestError extends JevCoreError {
  override readonly name = "JevRequestError";
  readonly status: number | undefined;
  readonly retryable: boolean;
  readonly requestId: string | undefined;

  constructor(
    message: string,
    details: { status?: number; retryable: boolean; requestId?: string; cause?: unknown },
  ) {
    super(message, { cause: details.cause });
    this.status = details.status;
    this.retryable = details.retryable;
    this.requestId = details.requestId;
  }
}

export class JevTimeoutError extends JevCoreError {
  override readonly name = "JevTimeoutError";
  readonly timeoutMs: number;

  constructor(timeoutMs: number, message?: string, options?: { cause?: unknown }) {
    super(message ?? `Jev request exceeded ${String(timeoutMs)} ms`, options);
    this.timeoutMs = timeoutMs;
  }
}

export class JevAbortError extends JevCoreError {
  override readonly name = "JevAbortError";

  constructor(message = "Jev request aborted", options?: { cause?: unknown }) {
    super(message, options);
  }
}

export class JevResponseError extends JevCoreError {
  override readonly name = "JevResponseError";
}

export function describeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  return String(error);
}
