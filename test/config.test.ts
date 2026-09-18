import { writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DEFAULT_CONFIG, loadConfig, resolveHome } from "../src/config.js";
import { ConfigError } from "../src/errors.js";
import { homeEnv, makeHome, removeHome } from "./helpers/env.js";

let home = "";

beforeEach(async () => {
  home = await makeHome();
});

afterEach(async () => {
  await removeHome(home);
});

async function writeConfig(value: unknown): Promise<void> {
  await writeFile(join(home, "config.json"), JSON.stringify(value), "utf8");
}

describe("resolveHome", () => {
  it("prefers JEVPRUNE_HOME over the default directory", () => {
    expect(resolveHome(homeEnv(home))).toBe(home);
    expect(resolveHome({})).toBe(join(homedir(), ".jevprune"));
    expect(resolveHome({ JEVPRUNE_HOME: "  " })).toBe(join(homedir(), ".jevprune"));
  });
});

describe("loadConfig", () => {
  it("returns the defaults when no config file exists", async () => {
    const config = await loadConfig(homeEnv(home));
    expect(config).toEqual({ ...DEFAULT_CONFIG, home });
    expect(config.threshold).toBe(0.25);
  });

  it("overrides only the keys present in the file", async () => {
    await writeConfig({ threshold: 0.5, retention: { maxRuns: 10 } });
    const config = await loadConfig(homeEnv(home));
    expect(config.threshold).toBe(0.5);
    expect(config.retention).toEqual({ maxRuns: 10, maxBytes: DEFAULT_CONFIG.retention.maxBytes });
    expect(config.tailLines).toBe(DEFAULT_CONFIG.tailLines);
  });

  it("rejects an unknown key", async () => {
    await writeConfig({ nope: 1 });
    await expect(loadConfig(homeEnv(home))).rejects.toThrow(/unknown config key "nope"/);
  });

  it("rejects an unknown retention key", async () => {
    await writeConfig({ retention: { maxRuns: 2, nope: 1 } });
    await expect(loadConfig(homeEnv(home))).rejects.toThrow(/unknown config key "retention.nope"/);
  });

  it("names the key and the value in every validation error", async () => {
    const cases: [unknown, RegExp][] = [
      [{ threshold: 2 }, /config key "threshold" must be a number in \[0, 1\], got 2/],
      [{ threshold: "high" }, /config key "threshold" must be a number in \[0, 1\], got "high"/],
      [{ tailLines: 1.5 }, /config key "tailLines" must be an integer >= 0, got 1.5/],
      [{ minCollapseLines: 0 }, /config key "minCollapseLines" must be an integer >= 1, got 0/],
      [{ windowTokens: 0 }, /config key "windowTokens" must be an integer >= 1, got 0/],
      [{ autoWrap: "yes" }, /config key "autoWrap" must be a boolean, got "yes"/],
      [{ allowlist: ["ls", 2] }, /config key "allowlist" must be an array of strings, got \["ls",2\]/],
      [{ retention: 4 }, /config key "retention" must be an object, got 4/],
      [{ retention: { maxBytes: 0 } }, /config key "retention.maxBytes" must be an integer >= 1, got 0/],
    ];
    for (const [value, pattern] of cases) {
      await writeConfig(value);
      await expect(loadConfig(homeEnv(home))).rejects.toThrow(pattern);
    }
  });

  it("rejects a config file that is not a JSON object", async () => {
    await writeFile(join(home, "config.json"), "[1]", "utf8");
    await expect(loadConfig(homeEnv(home))).rejects.toBeInstanceOf(ConfigError);
    await writeFile(join(home, "config.json"), "{", "utf8");
    await expect(loadConfig(homeEnv(home))).rejects.toThrow(/is not valid JSON/);
  });
});
