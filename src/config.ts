import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

import { CONFIG_FILE, DEFAULT_CONFIG, HOME_ENV, parseConfig } from "./core/config.js";
import type { ResolvedConfig } from "./core/config.js";
import { ConfigError, errorCode, errorMessage } from "./core/errors.js";

export {
  CONFIG_FILE,
  DEFAULT_CONFIG,
  HOME_ENV,
  TASK_ENV,
  parseConfig,
  parseThreshold,
} from "./core/config.js";
export type { Config, ResolvedConfig, RetentionConfig } from "./core/config.js";

export function resolveHome(env: NodeJS.ProcessEnv = process.env): string {
  const override = env[HOME_ENV]?.trim() ?? "";
  if (override.length > 0) return resolve(override);
  return join(homedir(), ".jevprune");
}

export async function loadConfig(env: NodeJS.ProcessEnv = process.env): Promise<ResolvedConfig> {
  const home = resolveHome(env);
  const path = join(home, CONFIG_FILE);
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    if (errorCode(error) === "ENOENT") return { ...DEFAULT_CONFIG, home };
    throw new ConfigError(`config file ${path} could not be read: ${errorMessage(error)}`, { cause: error });
  }
  return { ...parseConfig(raw, path), home };
}
