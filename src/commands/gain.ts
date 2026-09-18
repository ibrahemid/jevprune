import { loadConfig } from "../config.js";
import { CHARS_PER_TOKEN } from "../core/index.js";
import { formatCount } from "../footer.js";
import type { CliIo } from "../io.js";
import { RunStore } from "../store.js";

export async function runGain(io: CliIo): Promise<number> {
  const config = await loadConfig(io.env);
  const store = new RunStore({ home: config.home, retention: config.retention });
  const totals = await store.readGain();
  const tokens = Math.max(0, Math.floor((totals.bytesIn - totals.bytesOut) / CHARS_PER_TOKEN));
  await io.write(
    `jevprune: ${formatCount(totals.runs)} runs, ${formatCount(totals.linesIn)} → ${formatCount(totals.linesOut)} lines, ~${formatCount(tokens)} output tokens removed (estimate: ${String(CHARS_PER_TOKEN)} bytes per token)\n`,
  );
  return 0;
}
