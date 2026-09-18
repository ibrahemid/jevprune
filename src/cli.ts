#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import type { ParseArgsOptionsConfig } from "node:util";

import { runGain } from "./commands/gain.js";
import { runHook } from "./commands/hook.js";
import { runRun } from "./commands/run.js";
import { runSelect } from "./commands/select.js";
import { runShow } from "./commands/show.js";
import { parseThreshold } from "./config.js";
import { ConfigError, JevpruneError, SpawnError, UsageError, errorMessage } from "./errors.js";
import { processIo } from "./io.js";
import type { CliIo } from "./io.js";
import { VERSION } from "./version.js";

const HELP = `usage: jevprune <command> [options]

commands:
  run [--task <text>] [--threshold <n>] [--hook] [--transcript <path>] -- <command> [args...]
      runs the command, prints the kept lines and exits with the command's exit code
  select [--task <text>] [--threshold <n>] [--file <path>] [--command <text>]
      prunes a local file or stdin and reports only its own exit status
  show <id> [--lines A-B]
      prints a saved run, or one line range of it, exactly as it was captured
  gain
      totals the locally recorded runs and estimates the output tokens removed
  hook
      reads a plugin PreToolUse event on stdin and answers it

options:
  --task <text>     the task the kept lines have to serve
  --threshold <n>   minimum Jev score to keep a line, 0 to 1
  --help
  --version
`;

export async function runCli(argv: readonly string[], io: CliIo): Promise<number> {
  try {
    return await dispatch(argv, io);
  } catch (error) {
    return await report(error, io);
  }
}

async function dispatch(argv: readonly string[], io: CliIo): Promise<number> {
  const separator = argv.indexOf("--");
  const own = separator === -1 ? [...argv] : argv.slice(0, separator);
  const rest = separator === -1 ? [] : argv.slice(separator + 1);
  const command = own[0];

  if (command === undefined) {
    await io.writeError(HELP);
    return 2;
  }
  if (command === "--help" || command === "-h" || command === "help") {
    await io.write(HELP);
    return 0;
  }
  if (command === "--version" || command === "-v") {
    await io.write(`${VERSION}\n`);
    return 0;
  }

  const args = own.slice(1);
  switch (command) {
    case "run": {
      const values = parse(args, {
        task: { type: "string" },
        threshold: { type: "string" },
        hook: { type: "boolean" },
        transcript: { type: "string" },
      });
      return await runRun(
        {
          argv: rest,
          task: values.task,
          threshold: values.threshold === undefined ? undefined : parseThreshold(values.threshold),
          hook: values.hook,
          transcript: values.transcript,
        },
        io,
      );
    }
    case "select": {
      const values = parse(args, {
        task: { type: "string" },
        threshold: { type: "string" },
        file: { type: "string" },
        command: { type: "string" },
      });
      return await runSelect(
        {
          task: values.task,
          threshold: values.threshold === undefined ? undefined : parseThreshold(values.threshold),
          file: values.file,
          command: values.command,
        },
        io,
      );
    }
    case "show": {
      const parsed = parseWithPositionals(args, { lines: { type: "string" } });
      const id = parsed.positionals[0];
      if (id === undefined) throw new UsageError("show needs a run id");
      if (parsed.positionals.length > 1) {
        throw new UsageError(`show takes one run id, got ${String(parsed.positionals.length)}`);
      }
      return await runShow(
        { id, ...(parsed.values.lines !== undefined ? { lines: parsed.values.lines } : {}) },
        io,
      );
    }
    case "gain": {
      parse(args, {});
      return await runGain(io);
    }
    case "hook": {
      parse(args, {});
      return await runHook(io);
    }
    default:
      throw new UsageError(`unknown command "${command}"`);
  }
}

function parse<T extends ParseArgsOptionsConfig>(args: readonly string[], options: T) {
  try {
    return parseArgs({ args: [...args], options, strict: true, allowPositionals: false }).values;
  } catch (error) {
    throw new UsageError(errorMessage(error), { cause: error });
  }
}

function parseWithPositionals<T extends ParseArgsOptionsConfig>(args: readonly string[], options: T) {
  try {
    return parseArgs({ args: [...args], options, strict: true, allowPositionals: true });
  } catch (error) {
    throw new UsageError(errorMessage(error), { cause: error });
  }
}

async function report(error: unknown, io: CliIo): Promise<number> {
  if (error instanceof SpawnError) {
    await io.writeError(`jevprune: ${error.message}\n`);
    if (error.code === "ENOENT") return 127;
    if (error.code === "EACCES") return 126;
    return 1;
  }
  if (error instanceof UsageError || error instanceof ConfigError) {
    await io.writeError(`jevprune: ${error.message}\n`);
    return 2;
  }
  if (error instanceof JevpruneError) {
    await io.writeError(`jevprune: ${error.message}\n`);
    return 1;
  }
  await io.writeError(`jevprune: ${errorMessage(error)}\n`);
  return 1;
}

function entryUrl(path: string): string {
  try {
    return pathToFileURL(realpathSync(path)).href;
  } catch {
    return "";
  }
}

const entry = process.argv[1];
if (entry !== undefined && import.meta.url === entryUrl(entry)) {
  process.exitCode = await runCli(process.argv.slice(2), processIo());
}
