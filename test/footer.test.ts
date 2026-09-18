import { describe, expect, it } from "vitest";

import { displayPath, formatCount, formatFooter, withFooter } from "../src/footer.js";

describe("formatFooter", () => {
  it("reports a jev run with the log path", () => {
    expect(
      formatFooter({
        mode: "jev",
        linesIn: 3_104,
        linesOut: 88,
        exitCode: 0,
        logPath: "/home/dev/.jevprune/runs/abc-1234.log",
        home: "/home/dev",
      }),
    ).toBe("jevprune: 3,104 → 88 lines, exit 0, full output ~/.jevprune/runs/abc-1234.log");
  });

  it("names the fallback reason", () => {
    expect(
      formatFooter({
        mode: "fallback",
        linesIn: 3_104,
        linesOut: 83,
        exitCode: 0,
        fallbackReason: "timeout",
        logPath: "/tmp/runs/abc-1234.log",
        home: "/home/dev",
      }),
    ).toBe("jevprune: fallback (no Jev: timeout), 3,104 → 83 lines, exit 0, full output /tmp/runs/abc-1234.log");
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
    ).toBe("jevprune: exit 0, 12 lines passed through, run store unavailable (EACCES)");
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
