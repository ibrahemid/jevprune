import { CONFIG_FILE } from "./config.js";
import { GAIN_FILE, RUNS_DIR } from "./store-types.js";

export function pathSeparator(home: string): "/" | "\\" {
  return home.includes("\\") && !home.includes("/") ? "\\" : "/";
}

export function joinHomePath(home: string, ...parts: readonly string[]): string {
  const separator = pathSeparator(home);
  let path = home.endsWith(separator) ? home.slice(0, -separator.length) : home;
  for (const part of parts) {
    if (part.length === 0) continue;
    path += separator + part;
  }
  return path;
}

export function runLogPath(home: string, id: string): string {
  return joinHomePath(home, RUNS_DIR, `${id}.log`);
}

export function runMetaPath(home: string, id: string): string {
  return joinHomePath(home, RUNS_DIR, `${id}.json`);
}

export function gainFilePath(home: string): string {
  return joinHomePath(home, GAIN_FILE);
}

export function configFilePath(home: string): string {
  return joinHomePath(home, CONFIG_FILE);
}

export function displayPath(path: string, userHome: string | undefined): string {
  if (userHome === undefined || userHome.length === 0) return path;
  if (path === userHome) return "~";
  const next = path.slice(userHome.length, userHome.length + 1);
  if (path.startsWith(userHome) && (next === "/" || next === "\\")) return `~${path.slice(userHome.length)}`;
  return path;
}
