import { ConfigError, errorMessage } from "./errors.js";
import { DEFAULT_WINDOW_TOKENS } from "./tokens.js";

export interface RetentionConfig {
  readonly maxRuns: number;
  readonly maxBytes: number;
}

export interface Config {
  readonly threshold: number;
  readonly fastPathLines: number;
  readonly tailLines: number;
  readonly headLines: number;
  readonly contextLines: number;
  readonly minCollapseLines: number;
  readonly windowTokens: number;
  readonly windowTimeoutMs: number;
  readonly concurrency: number;
  readonly maxPruneBytes: number;
  readonly retention: RetentionConfig;
}

export interface ResolvedConfig extends Config {
  readonly home: string;
}

export const HOME_ENV = "JEVPRUNE_HOME";
export const TASK_ENV = "JEVPRUNE_TASK";
export const CONFIG_FILE = "config.json";

export const LEGACY_CONFIG_KEYS = ["autoWrap", "allowlist"] as const;

export const DEFAULT_CONFIG: Config = {
  threshold: 0.3,
  fastPathLines: 60,
  tailLines: 40,
  headLines: 40,
  contextLines: 3,
  minCollapseLines: 3,
  windowTokens: DEFAULT_WINDOW_TOKENS,
  windowTimeoutMs: 10_000,
  concurrency: 4,
  maxPruneBytes: 16_777_216,
  retention: { maxRuns: 200, maxBytes: 268_435_456 },
};

export function parseConfig(raw: string, path: string): Config {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new ConfigError(`config file ${path} is not valid JSON: ${errorMessage(error)}`, { cause: error });
  }
  if (!isRecord(parsed)) {
    throw new ConfigError(`config file ${path} must contain a JSON object, got ${describeValue(parsed)}`);
  }
  for (const key of Object.keys(parsed)) {
    if (key in DEFAULT_CONFIG) continue;
    if (LEGACY_CONFIG_KEYS.some((legacy) => legacy === key)) continue;
    throw new ConfigError(`unknown config key "${key}" in ${path}`);
  }
  return {
    threshold: readNumber(parsed, "threshold", DEFAULT_CONFIG.threshold, 0, 1),
    fastPathLines: readInteger(parsed, "fastPathLines", DEFAULT_CONFIG.fastPathLines, 0),
    tailLines: readInteger(parsed, "tailLines", DEFAULT_CONFIG.tailLines, 0),
    headLines: readInteger(parsed, "headLines", DEFAULT_CONFIG.headLines, 0),
    contextLines: readInteger(parsed, "contextLines", DEFAULT_CONFIG.contextLines, 0),
    minCollapseLines: readInteger(parsed, "minCollapseLines", DEFAULT_CONFIG.minCollapseLines, 1),
    windowTokens: readInteger(parsed, "windowTokens", DEFAULT_CONFIG.windowTokens, 1),
    windowTimeoutMs: readInteger(parsed, "windowTimeoutMs", DEFAULT_CONFIG.windowTimeoutMs, 1),
    concurrency: readInteger(parsed, "concurrency", DEFAULT_CONFIG.concurrency, 1),
    maxPruneBytes: readInteger(parsed, "maxPruneBytes", DEFAULT_CONFIG.maxPruneBytes, 1),
    retention: readRetention(parsed["retention"]),
  };
}

export function parseThreshold(value: string): number {
  const parsed = Number(value);
  if (value.trim().length === 0 || !Number.isFinite(parsed) || parsed < 0 || parsed > 1) {
    throw new ConfigError(`--threshold must be a number in [0, 1], got ${describeValue(value)}`);
  }
  return parsed;
}

function readNumber(source: Record<string, unknown>, key: string, fallback: number, min: number, max: number): number {
  const value = source[key];
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max) {
    throw new ConfigError(
      `config key "${key}" must be a number in [${String(min)}, ${String(max)}], got ${describeValue(value)}`,
    );
  }
  return value;
}

function readInteger(
  source: Record<string, unknown>,
  key: string,
  fallback: number,
  min: number,
  label: string = key,
): number {
  const value = source[key];
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isInteger(value) || value < min) {
    throw new ConfigError(
      `config key "${label}" must be an integer >= ${String(min)}, got ${describeValue(value)}`,
    );
  }
  return value;
}

function readRetention(value: unknown): RetentionConfig {
  if (value === undefined) return DEFAULT_CONFIG.retention;
  if (!isRecord(value)) {
    throw new ConfigError(`config key "retention" must be an object, got ${describeValue(value)}`);
  }
  for (const key of Object.keys(value)) {
    if (key !== "maxRuns" && key !== "maxBytes") {
      throw new ConfigError(`unknown config key "retention.${key}"`);
    }
  }
  return {
    maxRuns: readInteger(value, "maxRuns", DEFAULT_CONFIG.retention.maxRuns, 1, "retention.maxRuns"),
    maxBytes: readInteger(value, "maxBytes", DEFAULT_CONFIG.retention.maxBytes, 1, "retention.maxBytes"),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function describeValue(value: unknown): string {
  if (typeof value === "string") return JSON.stringify(value);
  if (value === undefined) return "undefined";
  if (value === null || typeof value === "number" || typeof value === "boolean") return String(value);
  try {
    return JSON.stringify(value) ?? typeof value;
  } catch {
    return typeof value;
  }
}
