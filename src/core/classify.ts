const SHELL_METACHARACTERS = /[\r\n|;&<>`$\\]/;
const LEADING_ASSIGNMENTS = /^(?:[A-Za-z_]\w*=(?:[^\s'"]+|'[^']*'|"[^"]*")\s+)*/;
const LEADING_DIRECTORIES = /^(?:\/?[\w.-]+\/)+/;

const READER_NAMES = "cat|bat|jq|yq|diff|git\\s+(?:diff|show)|base64|openssl";
const READER_COMMAND = new RegExp(`^(?:${READER_NAMES})(?:\\s|$)`);
const READER_IN_PIPELINE = new RegExp(`(?:^|[|;&]\\s*)(?:${READER_NAMES})\\b`);

const MIN_REFERENCE_LINES = 5;

const HEADING_LINE = /^ {0,3}#{1,6} \S/;
const LIST_LINE = /^ {0,3}(?:[-*+] |\d+\. )\S/;
const FENCE_LINE = /^ {0,3}(?:```|~~~)/;
const MARKDOWN_MIN_HEADINGS = 2;
const MARKDOWN_MIN_MARKS = 3;
const MARKDOWN_MARK_RATIO = 0.05;

const USAGE_LINE = /^ {0,2}(?:usage|synopsis)\b[: ]/i;
const OPTION_LINE = /^ {1,10}-{1,2}[A-Za-z0-9][\w-]*/;
const MAN_HEADER_LINE = /^[A-Z][A-Z ]{2,}$/;
const HELP_HEAD_LINES = 10;
const HELP_MIN_OPTIONS = 3;
const MAN_MIN_HEADERS = 3;

const DECLARATION_LINE =
  /^ {0,4}(?:(?:export|public|private|protected|static|async|pub|final|default)\s+)*(?:import|from|package|use|using|#include|include|require|def|class|function|const|let|var|fn|func|type|interface|struct|enum|impl|trait|module|namespace)\b/;
const CLOSER_LINE = /^\s*[}\])]+[;,)]*$/;
const INDENTED_LINE = /^(?: {2,}|\t+)\S/;
const SOURCE_MIN_DECLARATIONS = 5;
const SOURCE_DECLARATION_RATIO = 0.03;
const SOURCE_CODE_RATIO = 0.6;

const MARKUP_HEADS = ["<?xml", "<!DOCTYPE", "---\n"];
const MARKUP_OPEN_TAG = /^<[A-Za-z_][\w:.-]*(?:\s|\/?>)/;
const DIFF_LINE = /^(?:diff --git |--- |@@ )/m;

function isJson(text: string): boolean {
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
}

export function simpleCommand(command: string): string {
  if (SHELL_METACHARACTERS.test(command)) return "";
  return command.trim().replace(LEADING_ASSIGNMENTS, "").replace(LEADING_DIRECTORIES, "");
}

export function looksStructured(command: string, output: string): boolean {
  const head = output.trimStart();
  if ((head.startsWith("{") || head.startsWith("[")) && isJson(output)) return true;
  for (const prefix of MARKUP_HEADS) {
    if (head.startsWith(prefix)) return true;
  }
  if (MARKUP_OPEN_TAG.test(head)) return true;
  if (DIFF_LINE.test(output)) return true;
  if (READER_COMMAND.test(simpleCommand(command))) return true;
  return READER_IN_PIPELINE.test(command);
}

export function isDocumentOutput(command: string, output: string): boolean {
  if (looksStructured(command, output)) return true;
  return isReference(output);
}

function isReference(output: string): boolean {
  const lines = output.split("\n").filter((line) => line.trim().length > 0);
  if (lines.length < MIN_REFERENCE_LINES) return false;
  const counts = countReferenceMarks(lines);
  return isMarkdownDocument(counts) || isHelpPage(counts) || isSourceListing(counts);
}

interface ReferenceMarks {
  readonly lines: number;
  readonly headings: number;
  readonly markdownMarks: number;
  readonly options: number;
  readonly manHeaders: number;
  readonly usageHead: boolean;
  readonly declarations: number;
  readonly code: number;
}

function countReferenceMarks(lines: readonly string[]): ReferenceMarks {
  let headings = 0;
  let markdownMarks = 0;
  let options = 0;
  let manHeaders = 0;
  let usageHead = false;
  let declarations = 0;
  let code = 0;
  for (const [index, line] of lines.entries()) {
    const isHeading = HEADING_LINE.test(line);
    if (isHeading) headings += 1;
    if (isHeading || LIST_LINE.test(line) || FENCE_LINE.test(line)) markdownMarks += 1;
    if (OPTION_LINE.test(line)) options += 1;
    if (MAN_HEADER_LINE.test(line)) manHeaders += 1;
    if (index < HELP_HEAD_LINES && USAGE_LINE.test(line)) usageHead = true;
    const isDeclaration = DECLARATION_LINE.test(line);
    if (isDeclaration) declarations += 1;
    if (isDeclaration || CLOSER_LINE.test(line) || INDENTED_LINE.test(line)) code += 1;
  }
  return { lines: lines.length, headings, markdownMarks, options, manHeaders, usageHead, declarations, code };
}

function isMarkdownDocument(marks: ReferenceMarks): boolean {
  if (marks.headings < MARKDOWN_MIN_HEADINGS) return false;
  return marks.markdownMarks >= Math.max(MARKDOWN_MIN_MARKS, marks.lines * MARKDOWN_MARK_RATIO);
}

function isHelpPage(marks: ReferenceMarks): boolean {
  if (marks.options < HELP_MIN_OPTIONS) return false;
  return marks.usageHead || marks.manHeaders >= MAN_MIN_HEADERS;
}

function isSourceListing(marks: ReferenceMarks): boolean {
  if (marks.declarations < SOURCE_MIN_DECLARATIONS) return false;
  if (marks.declarations < marks.lines * SOURCE_DECLARATION_RATIO) return false;
  return marks.code >= marks.lines * SOURCE_CODE_RATIO;
}
