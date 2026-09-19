import type { FallbackReason } from "./types.js";

export const UNAUTHORIZED_REASON = "unauthorized (401)";

export const NOT_UTF8_REASON = "not valid UTF-8";

export const NOT_UTF8_NOTE = "output is not valid UTF-8";

export function fallbackReasonText(reason: FallbackReason): string {
  switch (reason.kind) {
    case "size-limit":
      return `output over ${String(reason.maxBytes)} bytes`;
    case "not-utf8":
      return NOT_UTF8_REASON;
    case "unavailable":
      return reason.detail;
  }
}

export function fallbackNote(reason: FallbackReason | undefined): string {
  if (reason === undefined) return "Jev unavailable: unknown";
  switch (reason.kind) {
    case "size-limit":
      return `output over ${String(reason.maxBytes)} bytes`;
    case "not-utf8":
      return NOT_UTF8_NOTE;
    case "unavailable":
      return `Jev unavailable: ${reason.detail}`;
  }
}
