import type { FallbackReason } from "./types.js";

export const UNAUTHORIZED_REASON = "unauthorized (401)";

export const NOT_UTF8_REASON = "not valid UTF-8";

export const NOT_UTF8_NOTE = "output is not valid UTF-8";

export const DOCUMENT_NOTE = "output looks like a document";

export const NOT_SAVED_NOTE = "full output was not saved";

export const SECRET_NOTE = `output looks like a credential, ${NOT_SAVED_NOTE}`;

export function logNotRemovedNote(code: string, path: string): string {
  return `saved log could not be removed (${code}): ${path}`;
}

export const OVERSIZE_SECRET_NOTE = `output looked like a credential, ${NOT_SAVED_NOTE}`;

function sizeLimitText(reason: Extract<FallbackReason, { kind: "size-limit" }>): string {
  const limit = `output over ${String(reason.maxBytes)} bytes`;
  return reason.isSecret === true ? `${limit}, ${OVERSIZE_SECRET_NOTE}` : limit;
}

export function fallbackReasonText(reason: FallbackReason): string {
  switch (reason.kind) {
    case "size-limit":
      return sizeLimitText(reason);
    case "not-utf8":
      return NOT_UTF8_REASON;
    case "document":
      return DOCUMENT_NOTE;
    case "secret":
      return SECRET_NOTE;
    case "unavailable":
      return reason.detail;
  }
}

export function fallbackNote(reason: FallbackReason | undefined): string {
  if (reason === undefined) return "Jev unavailable: unknown";
  switch (reason.kind) {
    case "size-limit":
      return sizeLimitText(reason);
    case "not-utf8":
      return NOT_UTF8_NOTE;
    case "document":
      return DOCUMENT_NOTE;
    case "secret":
      return SECRET_NOTE;
    case "unavailable":
      return `Jev unavailable: ${reason.detail}`;
  }
}

export function passthroughNoteFor(reason: FallbackReason | undefined): string | undefined {
  if (reason === undefined) return undefined;
  if (reason.kind === "not-utf8") return NOT_UTF8_NOTE;
  return fallbackReasonText(reason);
}
