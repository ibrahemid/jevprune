import { homedir } from "node:os";
import { sep } from "node:path";

import type { SelectionMode } from "./types.js";

export interface FooterInput {
  readonly mode: SelectionMode;
  readonly linesIn: number;
  readonly linesOut: number;
  readonly exitCode?: number | null;
  readonly logPath?: string;
  readonly fallbackReason?: string;
  readonly storeFailureCode?: string;
  readonly home?: string;
}

export function formatFooter(input: FooterInput): string {
  if (input.mode === "fast-path") return "";
  const parts: string[] = [];
  if (input.mode === "passthrough") {
    if (input.exitCode !== undefined && input.exitCode !== null) parts.push(`exit ${String(input.exitCode)}`);
    parts.push(`${formatCount(input.linesIn)} lines passed through`);
  } else {
    if (input.mode === "fallback") parts.push(`fallback (no Jev: ${input.fallbackReason ?? "unknown"})`);
    parts.push(`${formatCount(input.linesIn)} → ${formatCount(input.linesOut)} lines`);
    if (input.exitCode !== undefined && input.exitCode !== null) parts.push(`exit ${String(input.exitCode)}`);
  }
  if (input.storeFailureCode !== undefined) {
    parts.push(`run store unavailable (${input.storeFailureCode})`);
  } else if (input.logPath !== undefined) {
    parts.push(`full output ${displayPath(input.logPath, input.home)}`);
  }
  return `jevprune: ${parts.join(", ")}`;
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

export function displayPath(path: string, home: string = homedir()): string {
  if (path === home) return "~";
  if (home.length > 0 && path.startsWith(home + sep)) return `~${path.slice(home.length)}`;
  return path;
}
