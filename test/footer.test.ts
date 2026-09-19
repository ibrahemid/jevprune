import { describe, expect, it } from "vitest";

import { formatFooter } from "../src/core/footer.js";
import { displayPath, formatCount, withFooter } from "../src/footer.js";

describe("formatFooter", () => {
  it("reports a jev run with the log path", () => {
    expect(
      formatFooter({
        mode: "jev",
        linesIn: 3_104,
        linesOut: 88,
        exitCode: 0,
        logPath: "/home/dev/.jevprune/runs/abc-1234.log",
        userHome: "/home/dev",
      }),
    ).toBe("jevprune: 3,104 → 88 lines, exit 0, full output ~/.jevprune/runs/abc-1234.log");
  });

  it("names the reason Jev was unavailable", () => {
    expect(
      formatFooter({
        mode: "fallback",
        linesIn: 3_104,
        linesOut: 83,
        exitCode: 0,
        fallbackReason: { kind: "unavailable", detail: "timeout" },
        logPath: "/tmp/runs/abc-1234.log",
        userHome: "/home/dev",
      }),
    ).toBe("jevprune: fallback (Jev unavailable: timeout), 3,104 → 83 lines, exit 0, full output /tmp/runs/abc-1234.log");
  });

  it("names the size limit without claiming Jev was unavailable", () => {
    expect(
      formatFooter({
        mode: "fallback",
        linesIn: 3_104,
        linesOut: 83,
        exitCode: 0,
        fallbackReason: { kind: "size-limit", maxBytes: 1_048_576 },
        logPath: "/tmp/runs/abc-1234.log",
        userHome: "/home/dev",
      }),
    ).toBe("jevprune: fallback (output over 1048576 bytes), 3,104 → 83 lines, exit 0, full output /tmp/runs/abc-1234.log");
  });

  it("says a failed credential run was not saved", () => {
    expect(
      formatFooter({
        mode: "passthrough",
        linesIn: 4,
        linesOut: 4,
        exitCode: 1,
        fallbackReason: { kind: "secret" },
      }),
    ).toBe("jevprune: exit 1, 4 lines passed through (output looks like a credential, full output was not saved)");
  });

  it("says the output was not saved once", () => {
    expect(
      formatFooter({
        mode: "passthrough",
        linesIn: 3,
        linesOut: 3,
        exitCode: 0,
        fallbackReason: { kind: "secret" },
        storeFailureCode: "EACCES",
      }),
    ).toBe("jevprune: exit 0, 3 lines passed through (output looks like a credential, full output was not saved)");
  });

  it("names the code and the path when the saved log could not be removed", () => {
    expect(
      formatFooter({
        mode: "passthrough",
        linesIn: 122,
        linesOut: 122,
        fallbackReason: { kind: "secret" },
        storeFailureCode: "EACCES",
        logPath: "/home/dev/.jevprune/runs/m1xk2p7a-3f9c.log",
        userHome: "/home/dev",
      }),
    ).toBe(
      "jevprune: 122 lines passed through (output looks like a credential, saved log could not be removed (EACCES): ~/.jevprune/runs/m1xk2p7a-3f9c.log)",
    );
  });

  it("names the credential guard beside the size limit", () => {
    expect(
      formatFooter({
        mode: "fallback",
        linesIn: 40_000,
        linesOut: 80,
        exitCode: 0,
        fallbackReason: { kind: "size-limit", maxBytes: 1_048_576, isSecret: true },
      }),
    ).toBe(
      "jevprune: fallback (output over 1048576 bytes, output looked like a credential, full output was not saved), 40,000 → 80 lines, exit 0",
    );
  });

  it("names non-UTF-8 output in a fallback footer", () => {
    expect(
      formatFooter({
        mode: "fallback",
        linesIn: 12,
        linesOut: 8,
        exitCode: 0,
        fallbackReason: { kind: "not-utf8" },
      }),
    ).toBe("jevprune: fallback (output is not valid UTF-8), 12 → 8 lines, exit 0");
  });

  it("reports a passthrough run with the exit code first", () => {
    expect(
      formatFooter({ mode: "passthrough", linesIn: 3_104, linesOut: 3_104, exitCode: 1, logPath: "/tmp/a.log" }),
    ).toBe("jevprune: exit 1, 3,104 lines passed through, full output /tmp/a.log");
  });

  it("omits the exit code when the producer's status is unknown", () => {
    expect(formatFooter({ mode: "passthrough", linesIn: 2, linesOut: 2, exitCode: null, logPath: "/tmp/a.log" })).toBe(
      "jevprune: 2 lines passed through, full output /tmp/a.log",
    );
  });

  it("names the document guard in a passthrough footer", () => {
    expect(
      formatFooter({ mode: "passthrough", linesIn: 2_979, linesOut: 2_979, fallbackReason: { kind: "document" } }),
    ).toBe("jevprune: 2,979 lines passed through (output looks like a document)");
  });

  it("names the credential guard in a passthrough footer", () => {
    expect(
      formatFooter({ mode: "passthrough", linesIn: 2_979, linesOut: 2_979, fallbackReason: { kind: "secret" } }),
    ).toBe("jevprune: 2,979 lines passed through (output looks like a credential, full output was not saved)");
  });

  it("prefers a given note over the one the reason carries", () => {
    expect(
      formatFooter({
        mode: "passthrough",
        linesIn: 12,
        linesOut: 12,
        fallbackReason: { kind: "not-utf8" },
        passthroughNote: "output is not valid UTF-8",
      }),
    ).toBe("jevprune: 12 lines passed through (output is not valid UTF-8)");
  });

  it("prints no footer for the fast path", () => {
    expect(formatFooter({ mode: "fast-path", linesIn: 10, linesOut: 10, exitCode: 0 })).toBe("");
  });

  it("replaces the path with the store failure", () => {
    expect(
      formatFooter({
        mode: "passthrough",
        linesIn: 12,
        linesOut: 12,
        exitCode: 0,
        logPath: "/tmp/a.log",
        storeFailureCode: "EACCES",
      }),
    ).toBe("jevprune: exit 0, 12 lines passed through, full output was not saved (EACCES)");
  });
});

describe("formatCount", () => {
  it("groups thousands with commas", () => {
    expect(formatCount(0)).toBe("0");
    expect(formatCount(999)).toBe("999");
    expect(formatCount(1_000)).toBe("1,000");
    expect(formatCount(3_104)).toBe("3,104");
    expect(formatCount(1_234_567)).toBe("1,234,567");
  });
});

describe("displayPath", () => {
  it("shortens the home directory", () => {
    expect(displayPath("/home/dev/.jevprune/runs/a.log", "/home/dev")).toBe("~/.jevprune/runs/a.log");
    expect(displayPath("/home/dev", "/home/dev")).toBe("~");
    expect(displayPath("/var/log/a.log", "/home/dev")).toBe("/var/log/a.log");
    expect(displayPath("/home/developer/a.log", "/home/dev")).toBe("/home/developer/a.log");
  });
});

describe("withFooter", () => {
  it("separates the footer from output that does not end with a newline", () => {
    expect(withFooter("a\n", "jevprune: x")).toBe("a\njevprune: x\n");
    expect(withFooter("a", "jevprune: x")).toBe("a\njevprune: x\n");
    expect(withFooter("", "jevprune: x")).toBe("jevprune: x\n");
  });

  it("leaves output untouched when there is no footer", () => {
    expect(withFooter("a", "")).toBe("a");
  });
});
