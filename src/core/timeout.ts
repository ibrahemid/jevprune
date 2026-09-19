export type TimeoutSignalFactory = (ms: number) => AbortSignal;

interface TimeoutCapableAbortSignal {
  timeout?: (ms: number) => AbortSignal;
}

// The Claude Code hooks engine has no AbortSignal.timeout at runtime, so a
// caller that runs there passes a factory built on $.clock.after instead.
export function resolveTimeoutSignal(
  factory: TimeoutSignalFactory | undefined,
  ms: number,
): AbortSignal | undefined {
  if (factory !== undefined) return factory(ms);
  const runtime: TimeoutCapableAbortSignal = AbortSignal;
  return typeof runtime.timeout === "function" ? runtime.timeout(ms) : undefined;
}

export function combineSignals(signals: readonly AbortSignal[]): AbortSignal {
  const controller = new AbortController();
  for (const signal of signals) {
    if (signal.aborted) {
      controller.abort(signal.reason);
      return controller.signal;
    }
  }
  for (const signal of signals) {
    signal.addEventListener(
      "abort",
      () => {
        controller.abort(signal.reason);
      },
      { once: true },
    );
  }
  return controller.signal;
}
