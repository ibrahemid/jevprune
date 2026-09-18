export type LineTerminator = "" | "\n" | "\r\n" | "\r";

export interface Line {
  readonly n: number;
  readonly text: string;
  readonly terminator: LineTerminator;
}

export function splitLines(text: string): Line[] {
  const lines: Line[] = [];
  const pattern = /\r\n|\n|\r/g;
  let start = 0;
  let match = pattern.exec(text);
  while (match !== null) {
    const raw = match[0];
    const terminator: LineTerminator = raw === "\r\n" ? "\r\n" : raw === "\r" ? "\r" : "\n";
    lines.push({ n: lines.length + 1, text: text.slice(start, match.index), terminator });
    start = match.index + raw.length;
    match = pattern.exec(text);
  }
  if (start < text.length) {
    lines.push({ n: lines.length + 1, text: text.slice(start), terminator: "" });
  }
  return lines;
}

export function joinLines(lines: Iterable<Line>): string {
  let out = "";
  for (const line of lines) out += line.text + line.terminator;
  return out;
}
