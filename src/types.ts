export type SelectionMode = "fast-path" | "passthrough" | "jev" | "fallback";

export type DecisionReason =
  | "fast-path"
  | "passthrough"
  | "tail"
  | "signature"
  | "context"
  | "blank"
  | "oversize"
  | "jev"
  | "collapse-min"
  | "head"
  | "fallback";

export type FallbackReason =
  | { readonly kind: "unavailable"; readonly detail: string }
  | { readonly kind: "size-limit"; readonly maxBytes: number }
  | { readonly kind: "not-utf8" };

export interface Decision {
  keep: boolean;
  reason: DecisionReason;
  noul?: number;
}

export interface DroppedRange {
  readonly from: number;
  readonly to: number;
  readonly count: number;
}
