import type { RetentionConfig } from "./config.js";
import { JevpruneError } from "./errors.js";
import { RUN_ID_PATTERN } from "./store-types.js";

export interface RetentionEntry {
  readonly id: string;
  readonly bytes: number;
}

export function planRetention(
  entries: readonly RetentionEntry[],
  retention: RetentionConfig,
): readonly string[] {
  const sizes = new Map<string, number>();
  for (const entry of entries) {
    if (!RUN_ID_PATTERN.test(entry.id)) continue;
    if (!Number.isFinite(entry.bytes) || entry.bytes < 0) {
      throw new JevpruneError(`retention entry ${entry.id} must carry a byte count >= 0, got ${String(entry.bytes)}`);
    }
    sizes.set(entry.id, (sizes.get(entry.id) ?? 0) + entry.bytes);
  }

  const ids = [...sizes.keys()].sort();
  let count = ids.length;
  let total = 0;
  for (const bytes of sizes.values()) total += bytes;

  const doomed: string[] = [];
  for (const id of ids) {
    if (count <= retention.maxRuns && total <= retention.maxBytes) break;
    doomed.push(id);
    total -= sizes.get(id) ?? 0;
    count -= 1;
  }
  return doomed;
}
