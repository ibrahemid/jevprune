#!/usr/bin/env node
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import type { ParseArgsOptionsConfig } from "node:util";

import { runRun } from "./commands/run.js";
import { runSelect } from "./commands/select.js";
import { ConfigError, JevpruneError, SpawnError, UsageError, errorMessage } from "./errors.js";
import { processIo } from "./io.js";
import type { CliIo } from "./io.js";
import { VERSION } from "./version.js";

const HELP = `usage: jevprune <command> [options]

commands:
  run [--task <text>] [--hook] [--transcript <path>] -- <command> [args...]
  select [--task <text>] [--file <path>] [--command <text>]

options:
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
        hook: { type: "boolean" },
        transcript: { type: "string" },
      });
      return await runRun(
        {
          argv: rest,
          task: values.task,
          hook: values.hook,
          transcript: values.transcript,
        },
        io,
      );
    }
    case "select": {
      const values = parse(args, {
        task: { type: "string" },
        file: { type: "string" },
        command: { type: "string" },
      });
      return await runSelect({ task: values.task, file: values.file, command: values.command }, io);
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

const entry = process.argv[1];
if (entry !== undefined && import.meta.url === pathToFileURL(entry).href) {
  process.exitCode = await runCli(process.argv.slice(2), processIo());
}
