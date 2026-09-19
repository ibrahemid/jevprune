import { describe, expect, it } from "vitest";

import type { PassthroughDecisionInput } from "../src/core/decide.js";
import { passthroughReason } from "../src/core/decide.js";

const HOME = "/home/dev/.jevprune";

const BASE: PassthroughDecisionInput = {
  denied: false,
  isError: false,
  interrupted: false,
  command: "pnpm test",
  output: "line one\nline two\n",
  lines: 400,
  fastPathLines: 40,
  bytes: 8_192,
  maxPruneBytes: 16_777_216,
  hasKey: true,
  home: HOME,
};

function decide(overrides: Partial<PassthroughDecisionInput>): ReturnType<typeof passthroughReason> {
  return passthroughReason({ ...BASE, ...overrides });
}

describe("passthroughReason", () => {
  it("passes a denied tool call through", () => {
    expect(decide({ denied: true })).toBe("denied");
  });

  it("passes a failed command through", () => {
    expect(decide({ isError: true })).toBe("tool-error");
  });

  it("passes an interrupted command through", () => {
    expect(decide({ interrupted: true })).toBe("interrupted");
  });

  it("passes a read of the run log directory through", () => {
    expect(decide({ command: `tail -n 50 ${HOME}/runs/m1xk2p7a-3f9c.log` })).toBe("recovery-read");
  });

  it("passes a read of the default run log directory through", () => {
    expect(decide({ command: "cat ~/.jevprune/runs/m1xk2p7a-3f9c.log", home: "" })).toBe("recovery-read");
  });

  it("passes a jevprune show through", () => {
    expect(decide({ command: "jevprune show m1xk2p7a-3f9c --lines 120-531" })).toBe("recovery-read");
    expect(decide({ command: "cd /tmp && jevprune show m1xk2p7a-3f9c" })).toBe("recovery-read");
  });

  it("passes output at or under the fast-path line count through", () => {
    expect(decide({ lines: 40 })).toBe("fast-path");
    expect(decide({ lines: 39 })).toBe("fast-path");
  });

  it("passes output over the byte limit through", () => {
    expect(decide({ bytes: 4_097, maxPruneBytes: 4_096 })).toBe("oversize");
  });

  it("prunes output at the byte limit", () => {
    expect(decide({ bytes: 4_096, maxPruneBytes: 4_096 })).toBeNull();
  });

  it("reports the fast path ahead of the byte limit", () => {
    expect(decide({ lines: 12, bytes: 4_097, maxPruneBytes: 4_096 })).toBe("fast-path");
  });

  it("reports the byte limit ahead of binary and document output", () => {
    expect(decide({ output: "header\u0000\u0001\u0002payload", bytes: 4_097, maxPruneBytes: 4_096 })).toBe(
      "oversize",
    );
    expect(
      decide({ command: "jq . package.json", output: '{\n  "name": "app"\n}\n', bytes: 4_097, maxPruneBytes: 4_096 }),
    ).toBe("oversize");
  });

  it("reports a secret ahead of the byte limit", () => {
    expect(decide({ output: "api_key: sk-live-3f9c2a\n", bytes: 4_097, maxPruneBytes: 4_096 })).toBe("secret");
  });

  it("passes binary output through", () => {
    expect(decide({ output: "header\u0000\u0001\u0002payload" })).toBe("binary");
  });

  it("passes document output through", () => {
    expect(decide({ command: "jq . package.json", output: '{\n  "name": "app"\n}\n' })).toBe("document");
  });

  it("passes credential output through", () => {
    expect(decide({ output: "api_key: sk-live-3f9c2a\n" })).toBe("secret");
  });

  it("passes everything through without a key", () => {
    expect(decide({ hasKey: false })).toBe("no-key");
  });

  it("returns null for a prunable result", () => {
    expect(decide({})).toBeNull();
  });

  it("reports denial ahead of every other reason", () => {
    expect(
      decide({
        denied: true,
        isError: true,
        interrupted: true,
        command: "jevprune show m1xk2p7a-3f9c",
        output: "api_key: sk-live-3f9c2a\n",
        lines: 1,
        hasKey: false,
      }),
    ).toBe("denied");
  });

  it("reports a secret ahead of a missing key", () => {
    expect(decide({ output: "api_key: sk-live-3f9c2a\n", hasKey: false })).toBe("secret");
  });

  it("reports a secret ahead of a document and binary output", () => {
    expect(decide({ command: "cat .env", output: "api_key: sk-live-3f9c2a\n" })).toBe("secret");
    expect(decide({ command: "cat /home/dev/.ssh/id_rsa", output: "-----BEGIN RSA PRIVATE KEY-----\n" })).toBe(
      "secret",
    );
    expect(decide({ command: "printenv", output: "header\u0000\u0001\u0002payload" })).toBe("secret");
  });

  it("reports the fast path ahead of a document", () => {
    expect(decide({ command: "jq . package.json", output: '{\n  "name": "app"\n}\n', lines: 3 })).toBe("fast-path");
  });
});
