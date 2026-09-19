const SHELL_METACHARACTERS = /[\r\n|;&<>`$\\]/;
const LEADING_ASSIGNMENTS = /^(?:[A-Za-z_]\w*=(?:[^\s'"]+|'[^']*'|"[^"]*")\s+)*/;
const LEADING_DIRECTORIES = /^(?:\/?[\w.-]+\/)+/;

const READER_NAMES = "cat|bat|jq|yq|diff|git\\s+(?:diff|show)|base64|openssl";
const READER_COMMAND = new RegExp(`^(?:${READER_NAMES})(?:\\s|$)`);
const READER_IN_PIPELINE = new RegExp(`(?:^|[|;&]\\s*)(?:${READER_NAMES})\\b`);

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
  return looksStructured(command, output);
}
