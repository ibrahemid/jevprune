import { readFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const ENTRY = "hooks/jevprune.ts";

const EXPECTED_GRAPH = [
  "hooks/jevprune.ts",
  "src/core/classify.ts",
  "src/core/client.ts",
  "src/core/config.ts",
  "src/core/decide.ts",
  "src/core/errors.ts",
  "src/core/footer.ts",
  "src/core/hook.ts",
  "src/core/http-client.ts",
  "src/core/jev-errors.ts",
  "src/core/keeps.ts",
  "src/core/lines.ts",
  "src/core/merge.ts",
  "src/core/paths.ts",
  "src/core/prune-core.ts",
  "src/core/reasons.ts",
  "src/core/record.ts",
  "src/core/refit.ts",
  "src/core/retention.ts",
  "src/core/run-id.ts",
  "src/core/secrets.ts",
  "src/core/select.ts",
  "src/core/store-types.ts",
  "src/core/store-writer.ts",
  "src/core/task.ts",
  "src/core/text.ts",
  "src/core/tokens.ts",
  "src/core/types.ts",
  "src/core/windows.ts",
];

const BANNED = [
  { name: "a node: import", pattern: /from\s*["']node:/ },
  { name: "require()", pattern: /(?<![.\w$])require\s*\(/ },
  { name: "Buffer", pattern: /(?<![.\w$])Buffer\b/ },
  { name: "process", pattern: /(?<![.\w$])process\s*\./ },
  { name: "setTimeout", pattern: /(?<![.\w$])setTimeout\s*\(/ },
  { name: "setInterval", pattern: /(?<![.\w$])setInterval\s*\(/ },
  { name: "console", pattern: /(?<![.\w$])console\s*\./ },
] as const;

const IMPORT_SOURCE = /(?:^|[\s;])(import|export)\b([^;]*?)\bfrom\s*["']([^"']+)["']/gm;
const SIDE_EFFECT_IMPORT = /(?:^|[\s;])import\s*["']([^"']+)["']/gm;

interface GraphFile {
  readonly path: string;
  readonly source: string;
  readonly specifiers: readonly { readonly specifier: string; readonly typeOnly: boolean }[];
}

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:"'`\\])\/\/.*$/gm, "$1");
}

function readGraphFile(path: string): GraphFile {
  const source = stripComments(readFileSync(resolve(REPO_ROOT, path), "utf8"));
  const specifiers: { specifier: string; typeOnly: boolean }[] = [];
  for (const match of source.matchAll(IMPORT_SOURCE)) {
    const clause = match[2] ?? "";
    const specifier = match[3];
    if (specifier === undefined) continue;
    specifiers.push({ specifier, typeOnly: /^\s*type\b/.test(clause) });
  }
  for (const match of source.matchAll(SIDE_EFFECT_IMPORT)) {
    const specifier = match[1];
    if (specifier !== undefined) specifiers.push({ specifier, typeOnly: false });
  }
  return { path, source, specifiers };
}

function walkGraph(): Map<string, GraphFile> {
  const reached = new Map<string, GraphFile>();
  const queue = [ENTRY];
  while (queue.length > 0) {
    const path = queue.shift();
    if (path === undefined || reached.has(path)) continue;
    const file = readGraphFile(path);
    reached.set(path, file);
    for (const { specifier } of file.specifiers) {
      if (!specifier.startsWith(".")) continue;
      const target = relative(REPO_ROOT, resolve(REPO_ROOT, dirname(path), specifier)).replace(/\.js$/, ".ts");
      if (!reached.has(target)) queue.push(target);
    }
  }
  return reached;
}

describe("the hook import graph", () => {
  const graph = walkGraph();

  it("reaches exactly the files the plan lists", () => {
    expect([...graph.keys()].sort()).toEqual([...EXPECTED_GRAPH].sort());
  });

  it("never reaches the core barrel", () => {
    expect(graph.has("src/core/index.ts")).toBe(false);
  });

  it("imports nothing but relative files and the claude-code types", () => {
    for (const file of graph.values()) {
      for (const { specifier, typeOnly } of file.specifiers) {
        if (specifier.startsWith(".")) continue;
        expect(`${file.path}: ${specifier}`).toBe(`${file.path}: claude-code`);
        expect(`${file.path}: type-only ${String(typeOnly)}`).toBe(`${file.path}: type-only true`);
      }
    }
  });

  for (const { name, pattern } of BANNED) {
    it(`uses no ${name}`, () => {
      const offenders = [...graph.values()].filter((file) => pattern.test(file.source)).map((file) => file.path);
      expect(offenders).toEqual([]);
    });
  }
});
