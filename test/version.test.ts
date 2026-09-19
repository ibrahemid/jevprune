import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { VERSION } from "../src/version.js";

describe("VERSION", () => {
  it("matches the package version", async () => {
    const path = fileURLToPath(new URL("../package.json", import.meta.url));
    const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
    const version =
      typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>)["version"] : undefined;
    expect(VERSION).toBe(version);
  });

  it("matches the plugin manifest version", async () => {
    const path = fileURLToPath(new URL("../.claude-plugin/plugin.json", import.meta.url));
    const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
    const version =
      typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>)["version"] : undefined;
    expect(VERSION).toBe(version);
  });
});
