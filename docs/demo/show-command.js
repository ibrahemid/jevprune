import { readdir, readFile, realpath, stat } from "node:fs/promises";
import process from "node:process";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

class TranscriptError extends Error {
  constructor(message) {
    super(message);
    this.name = "TranscriptError";
  }
}

const demo = process.argv[2] ?? "/tmp/checkout-service";
const MARKER = /\[jevprune: \d+ lines dropped, run ([a-z0-9]+-[a-f0-9]{4}), lines (\d+)-(\d+)\]/g;

async function slugsFor(path) {
  const paths = new Set([resolve(path)]);
  try {
    paths.add(await realpath(path));
  } catch {
    /* empty */
  }
  return [...paths].map((entry) => entry.replaceAll("/", "-"));
}

async function transcriptsFor(slug) {
  const dir = join(homedir(), ".claude", "projects", slug);
  let names;
  try {
    names = await readdir(dir);
  } catch {
    return [];
  }
  const files = [];
  for (const name of names) {
    if (!name.endsWith(".jsonl")) continue;
    const path = join(dir, name);
    files.push({ path, modified: (await stat(path)).mtimeMs });
  }
  return files;
}

const files = [];
for (const slug of await slugsFor(demo)) files.push(...(await transcriptsFor(slug)));
files.sort((a, b) => b.modified - a.modified);

for (const file of files) {
  const matches = [...(await readFile(file.path, "utf8")).matchAll(MARKER)];
  const last = matches.at(-1);
  if (last === undefined) continue;
  const [, runId, from, to] = last;
  const end = Math.min(Number(from) + 3, Number(to));
  process.stdout.write(`jevprune show ${runId} --lines ${from}-${end}\n`);
  process.exit(0);
}

throw new TranscriptError(`no jevprune marker in any Claude Code transcript for ${demo}`);
