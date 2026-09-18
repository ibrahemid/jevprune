import { RunStoreError } from "./errors.js";
import type { GainEntry, RunMeta, RunStore } from "./store.js";

export async function saveRun(
  store: RunStore | null,
  meta: RunMeta,
  gain: GainEntry,
): Promise<string | undefined> {
  if (store === null) return undefined;
  try {
    await store.finalizeRun(meta.id, meta);
    await store.appendGain(gain);
    await store.enforceRetention();
  } catch (error) {
    if (error instanceof RunStoreError) return error.code ?? "failed";
    throw error;
  }
  return undefined;
}
