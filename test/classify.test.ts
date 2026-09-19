import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { isDocumentOutput, looksStructured, simpleCommand } from "../src/core/classify.js";

const FIXTURE_RUNS: readonly { readonly file: string; readonly command: string }[] = [
  { file: "npm-test.log", command: "pnpm test" },
  { file: "cargo-build.log", command: "cargo build" },
  { file: "docker-compose.log", command: "docker compose up" },
  { file: "pytest.log", command: "pytest" },
];

const JQ_OUTPUT = '{\n  "name": "app",\n  "version": "0.2.0"\n}\n';

const GIT_DIFF_OUTPUT = [
  "diff --git a/src/core/select.ts b/src/core/select.ts",
  "index 1f0a9c2..8b3d41e 100644",
  "--- a/src/core/select.ts",
  "+++ b/src/core/select.ts",
  "@@ -18,7 +18,7 @@ export function selectLines(input: SelectInput): SelectionResult {",
  "-  const bytes = Buffer.byteLength(text);",
  "+  const bytes = utf8Length(text);",
].join("\n");

const YAML_FRONT_MATTER = "---\ntitle: jevprune\nversion: 0.2.0\n---\n\nA log pruner.\n";

const MARKDOWN_DOCUMENT = [
  "# jevprune",
  "",
  "Prunes long command output line by line.",
  "",
  "## Install",
  "",
  "- `npm i -g jevprune`",
  "- set `TYPESAFE_API_KEY`",
  "",
  "## Commands",
  "",
  "1. `jevprune run -- pnpm test`",
  "2. `jevprune show <id> --lines 120-531`",
  "",
  "```sh",
  "jevprune gain",
  "```",
  "",
  "## Limits",
  "",
  "- failed commands are never pruned",
  "- output over the size limit falls back to rules",
].join("\n");

const HELP_OUTPUT = [
  "Usage: jevprune [options] <command>",
  "",
  "Options:",
  "  -t, --task <text>      the task the output is read for",
  "  --threshold <number>   keep a line at or above this score",
  "  --lines <from>-<to>    the range to read back",
  "  -h, --help             print this help",
  "  -V, --version          print the version",
].join("\n");

const SOURCE_LISTING = [
  'import { readFile } from "node:fs/promises";',
  "",
  'import { loadConfig } from "./config.js";',
  'import type { ResolvedConfig } from "./config.js";',
  "",
  "export interface ReaderInput {",
  "  readonly path: string;",
  "  readonly config: ResolvedConfig;",
  "}",
  "",
  "export async function readSource(input: ReaderInput): Promise<string> {",
  "  const config = await loadConfig(input.config);",
  "  const text = await readFile(input.path, \"utf8\");",
  "  if (text.length > config.maxPruneBytes) {",
  "    return text.slice(0, config.maxPruneBytes);",
  "  }",
  "  return text;",
  "}",
].join("\n");

const SEQ_OUTPUT = `${Array.from({ length: 300 }, (_, index) => String(index + 1)).join("\n")}\n`;

function readFixture(name: string): string {
  return readFileSync(fileURLToPath(new URL(`fixtures/${name}`, import.meta.url)), "utf8");
}

describe("simpleCommand", () => {
  it("returns an empty string for a command with shell metacharacters", () => {
    for (const command of ["cat a.json | jq .", "pytest; echo done", "echo `date`", "cat $FILE", "a && b"]) {
      expect(simpleCommand(command)).toBe("");
    }
  });

  it("strips leading environment assignments", () => {
    expect(simpleCommand("RUST_LOG=debug CI='1' cargo build")).toBe("cargo build");
  });

  it("strips the leading directories of the program path", () => {
    expect(simpleCommand("/usr/local/bin/jq .name data.json")).toBe("jq .name data.json");
    expect(simpleCommand("  node_modules/.bin/vitest run  ")).toBe("vitest run");
  });
});

describe("looksStructured", () => {
  it("accepts a JSON blob and rejects output that only starts like one", () => {
    expect(looksStructured("jq .", JQ_OUTPUT)).toBe(true);
    expect(looksStructured("pnpm test", "[vite] building\n[vite] done\n")).toBe(false);
  });

  it("accepts XML, HTML and YAML front matter heads", () => {
    expect(looksStructured("run", '<?xml version="1.0"?>\n<build />\n')).toBe(true);
    expect(looksStructured("run", "<!DOCTYPE html>\n<html></html>\n")).toBe(true);
    expect(looksStructured("run", "<html lang=\"en\">\n</html>\n")).toBe(true);
    expect(looksStructured("run", YAML_FRONT_MATTER)).toBe(true);
  });

  it("accepts a diff anywhere in the output", () => {
    expect(looksStructured("git diff", GIT_DIFF_OUTPUT)).toBe(true);
    expect(looksStructured("run", `building\n${GIT_DIFF_OUTPUT}`)).toBe(true);
  });

  it("accepts a reader command regardless of its output", () => {
    for (const command of ["cat src/index.ts", "bat README.md", "git show HEAD", "base64 key.bin", "openssl x509 -text"]) {
      expect(looksStructured(command, "plain text\n")).toBe(true);
    }
  });

  it("accepts a reader command after a pipe or separator", () => {
    expect(looksStructured("curl -s https://example.com/api | jq .items", "plain text\n")).toBe(true);
    expect(looksStructured("pnpm build; cat dist/index.js", "plain text\n")).toBe(true);
  });

  it("rejects a build command with plain output", () => {
    expect(looksStructured("pnpm test", "ok\n")).toBe(false);
    expect(looksStructured("cargo build", "Compiling app v0.1.0\n")).toBe(false);
  });
});

describe("isDocumentOutput", () => {
  it("classifies a jq output as a document", () => {
    expect(isDocumentOutput("jq . package.json", JQ_OUTPUT)).toBe(true);
  });

  it("classifies a Markdown document by its headings and lists", () => {
    expect(isDocumentOutput("sh ./render.sh", MARKDOWN_DOCUMENT)).toBe(true);
  });

  it("classifies a usage block with its options as a document", () => {
    expect(isDocumentOutput("jevprune --help", HELP_OUTPUT)).toBe(true);
  });

  it("classifies a source listing as a document", () => {
    expect(isDocumentOutput("sh ./print-source.sh", SOURCE_LISTING)).toBe(true);
  });

  it("does not classify the build and test fixtures as documents", () => {
    for (const { file, command } of FIXTURE_RUNS) {
      expect(isDocumentOutput(command, readFixture(file))).toBe(false);
    }
  });

  it("does not classify a run of numbers as a document", () => {
    expect(isDocumentOutput("seq 300", SEQ_OUTPUT)).toBe(false);
  });

  it("does not classify short output as a document", () => {
    expect(isDocumentOutput("pnpm build", "# build\n# done\n")).toBe(false);
  });
});
