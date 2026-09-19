import { displayPath } from "./paths.js";
import { NOT_SAVED_NOTE, fallbackNote, logNotRemovedNote, passthroughNoteFor } from "./reasons.js";
import type { FallbackReason, SelectionMode } from "./types.js";

export { displayPath } from "./paths.js";

const LF = 0x0a;

export interface FooterInput {
  readonly mode: SelectionMode;
  readonly linesIn: number;
  readonly linesOut: number;
  readonly exitCode?: number | null;
  readonly logPath?: string;
  readonly fallbackReason?: FallbackReason;
  readonly passthroughNote?: string;
  readonly storeFailureCode?: string;
  readonly userHome?: string;
}

export function formatFooter(input: FooterInput): string {
  if (input.mode === "fast-path") return "";
  const parts: string[] = [];
  const note = noteFor(input);
  const saysNotSaved = note !== undefined && note.includes(NOT_SAVED_NOTE);
  const text = saysNotSaved ? resolveNotSaved(note, input) : note;
  if (input.mode === "passthrough") {
    if (input.exitCode !== undefined && input.exitCode !== null) parts.push(`exit ${String(input.exitCode)}`);
    parts.push(`${formatCount(input.linesIn)} lines passed through${text === undefined ? "" : ` (${text})`}`);
  } else {
    if (text !== undefined) parts.push(`fallback (${text})`);
    parts.push(`${formatCount(input.linesIn)} → ${formatCount(input.linesOut)} lines`);
    if (input.exitCode !== undefined && input.exitCode !== null) parts.push(`exit ${String(input.exitCode)}`);
  }
  if (saysNotSaved) return `jevprune: ${parts.join(", ")}`;
  if (input.storeFailureCode !== undefined) {
    parts.push(`${NOT_SAVED_NOTE} (${input.storeFailureCode})`);
  } else if (input.logPath !== undefined) {
    parts.push(`full output ${displayPath(input.logPath, input.userHome)}`);
  }
  return `jevprune: ${parts.join(", ")}`;
}

function noteFor(input: FooterInput): string | undefined {
  if (input.mode === "passthrough") return input.passthroughNote ?? passthroughNoteFor(input.fallbackReason);
  if (input.mode === "fallback") return fallbackNote(input.fallbackReason);
  return undefined;
}

function resolveNotSaved(note: string, input: FooterInput): string {
  if (input.storeFailureCode === undefined || input.logPath === undefined) return note;
  const path = displayPath(input.logPath, input.userHome);
  return note.replace(NOT_SAVED_NOTE, logNotRemovedNote(input.storeFailureCode, path));
}

export function footerAfter(lastByte: number | undefined, footer: string): string {
  if (footer.length === 0) return "";
  const separator = lastByte === undefined || lastByte === LF ? "" : "\n";
  return `${separator}${footer}\n`;
}

export function withFooter(kept: string, footer: string): string {
  if (footer.length === 0) return kept;
  const separator = kept.length === 0 || kept.endsWith("\n") ? "" : "\n";
  return `${kept}${separator}${footer}\n`;
}

export function formatCount(value: number): string {
  const digits = Math.trunc(Math.abs(value)).toString();
  const grouped = digits.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return value < 0 ? `-${grouped}` : grouped;
}
