import { describe, expect, it } from "vitest";

import { looksSecret } from "../src/core/secrets.js";

const PRIVATE_KEY = [
  "-----BEGIN OPENSSH PRIVATE KEY-----",
  "b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAABAAABlwAAAAdz",
  "-----END OPENSSH PRIVATE KEY-----",
].join("\n");

describe("looksSecret", () => {
  it("flags a command that reads the environment", () => {
    expect(looksSecret("printenv", "PATH=/usr/bin\n")).toBe(true);
    expect(looksSecret("docker compose run app | env", "PATH=/usr/bin\n")).toBe(true);
  });

  it("flags a command that names a credential subject", () => {
    for (const command of [
      "cat .env",
      "grep -r token src",
      "security find-generic-password -s build",
      "ls ~/.ssh/id_rsa",
      "cat private_key.pem",
      "cat ~/.netrc",
    ]) {
      expect(looksSecret(command, "no output\n")).toBe(true);
    }
  });

  it("flags output holding a private key block", () => {
    expect(looksSecret("pnpm test", PRIVATE_KEY)).toBe(true);
  });

  it("flags output holding a credential assignment", () => {
    expect(looksSecret("pnpm test", "api_key: sk-live-3f9c2a\n")).toBe(true);
    expect(looksSecret("pnpm test", "AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI\n")).toBe(true);
    expect(looksSecret("pnpm test", "access-token = ghp_7f2a\n")).toBe(true);
  });

  it("flags output holding credentials inside a URL", () => {
    expect(looksSecret("pnpm test", "connecting to postgres://app:s3cret@db:5432/app\n")).toBe(true);
  });

  it("passes an ordinary build log", () => {
    expect(looksSecret("cargo build", "Compiling app v0.1.0\nFinished dev in 4.20s\n")).toBe(false);
  });
});
