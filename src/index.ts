export * from "./core/index.js";
export { byteLineStarts, countByteLines, isValidUtf8 } from "./bytes.js";
export { DEFAULT_ALLOWLIST, DEFAULT_CONFIG, loadConfig, parseThreshold, resolveHome } from "./config.js";
export type { Config, ResolvedConfig, RetentionConfig } from "./config.js";
export {
  ConfigError,
  JevpruneError,
  LineRangeError,
  RunNotFoundError,
  RunStoreError,
  SpawnError,
  TranscriptError,
  UsageError,
} from "./errors.js";
export { displayPath, footerAfter, formatCount, formatFooter, withFooter } from "./footer.js";
export type { FooterInput } from "./footer.js";
export {
  SIGNATURE_CASE_INSENSITIVE,
  SIGNATURE_CASE_SENSITIVE,
  computeKeeps,
  isSignatureLine,
} from "./keeps.js";
export type { KeepReason } from "./keeps.js";
export { joinLines, splitLines } from "./lines.js";
export type { Line, LineTerminator } from "./lines.js";
export { collapseMarker, mergeDecisions } from "./merge.js";
export type { MergeOptions, MergeResult } from "./merge.js";
export { pruneOutput, pruneStream } from "./prune.js";
export type { PruneInput, PruneResult, PruneStreamInput } from "./prune.js";
export {
  NOT_UTF8_NOTE,
  NOT_UTF8_REASON,
  RUBRIC,
  fallbackReasonText,
  passthroughSelection,
  questionFor,
  selectLines,
} from "./select.js";
export type { OversizeCapture, PassthroughInput, SelectInput, SelectionResult } from "./select.js";
export { RunStore, newRunId } from "./store.js";
export type { GainEntry, GainTotals, RunMeta, RunRecord, RunWriter } from "./store.js";
export { MAX_TASK_LENGTH, resolveTask } from "./task.js";
export type { ResolvedTask, TaskInput, TaskSource } from "./task.js";
export type { Decision, DecisionReason, DroppedRange, FallbackReason, SelectionMode } from "./types.js";
