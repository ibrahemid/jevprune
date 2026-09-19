import type { Line } from "./lines.js";

export type KeepReason = "tail" | "signature" | "context";

export const SIGNATURE_CASE_SENSITIVE =
  /(^|\s)(FAIL|FAILED|ERROR|PANIC|FATAL)(\s|:|$)|\b[A-Z][A-Za-z]*(Error|Exception|Panic)\b|^\s*E\s{2,}\S|^npm ERR!|^\s*(Test Files|Tests|Test Suites)\s/;

export const SIGNATURE_CASE_INSENSITIVE =
  /^\s*(✗|✘|×|⨯|❌|❯)|^\s*(error|fatal)(\[E\d+\])?:|^traceback \(most recent call last\)|^\s*File ".*", line \d+|^\s+at .*:\d+:\d+\)?$|^\s*-->\s.*:\d+:\d+|^thread '.*' panicked|\b(exit code|exit status|exited with|command not found|no such file or directory|ENOENT|EACCES|ECONNREFUSED|segmentation fault|core dumped|killed)\b|\blevel[=:"\s]+"?(error|fatal|panic)\b|\[(error|fatal|panic)\]|^=+ .*(passed|failed|error).* =+$/i;

export function isSignatureLine(text: string): boolean {
  return SIGNATURE_CASE_SENSITIVE.test(text) || SIGNATURE_CASE_INSENSITIVE.test(text);
}

export function computeKeeps(
  lines: readonly Line[],
  options: { tailLines: number; contextLines: number },
): Map<number, KeepReason> {
  const keeps = new Map<number, KeepReason>();
  const tailLines = Math.max(0, Math.trunc(options.tailLines));
  const contextLines = Math.max(0, Math.trunc(options.contextLines));

  const tailStart = lines.length - tailLines + 1;
  for (const line of lines) {
    if (line.n >= tailStart) keeps.set(line.n, "tail");
  }

  const seen = new Set<string>();
  const signatures: number[] = [];
  for (const line of lines) {
    if (!isSignatureLine(line.text)) continue;
    const key = line.text.trim();
    if (seen.has(key)) continue;
    seen.add(key);
    signatures.push(line.n);
  }

  for (const n of signatures) keeps.set(n, "signature");
  for (const n of signatures) {
    for (let offset = 1; offset <= contextLines; offset += 1) {
      for (const candidate of [n - offset, n + offset]) {
        if (candidate < 1 || candidate > lines.length) continue;
        if (!keeps.has(candidate)) keeps.set(candidate, "context");
      }
    }
  }
  return keeps;
}
