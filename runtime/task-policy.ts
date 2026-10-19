import type { TaskTiming } from "./types.ts";

/** A missing deadline is intentional; RPC and individual tools own their timeouts. */
export function taskTiming(input: TaskTiming = {}, defaultMs = 0) {
  const supplied = input.timeoutMs != null;
  let timeoutMs = supplied ? input.timeoutMs! : defaultMs;
  if (
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < 0 ||
    (timeoutMs > 0 && timeoutMs < 1000)
  )
    throw new Error(
      "timeoutMs must be 0 (no deadline) or a safe integer >= 1000",
    );
  const timeoutPolicy =
    input.timeoutPolicy ?? (timeoutMs > 0 ? "fixed" : "none");
  if (!["none", "fixed"].includes(timeoutPolicy))
    throw new Error("timeoutPolicy must be none or fixed");
  if (timeoutPolicy === "none") {
    if (supplied && timeoutMs > 0)
      throw new Error("timeoutPolicy:none conflicts with a positive timeoutMs");
    timeoutMs = 0;
  } else if (!timeoutMs)
    throw new Error("timeoutPolicy:fixed requires a positive timeoutMs");
  const queueTimeoutMs = input.queueTimeoutMs ?? 0;
  if (
    !Number.isSafeInteger(queueTimeoutMs) ||
    queueTimeoutMs < 0 ||
    (queueTimeoutMs > 0 && queueTimeoutMs < 1000)
  )
    throw new Error("queueTimeoutMs must be 0 or a safe integer >= 1000");
  return {
    timeoutPolicy,
    timeoutMs,
    queueTimeoutMs,
    timeoutSource:
      supplied || input.timeoutPolicy != null
        ? ("task" as const)
        : ("default" as const),
  };
}

/** Avoid Node's ~24 day setTimeout overflow when a caller chooses a long deadline. */
export function executionDeadline(ms: number, expire: () => void) {
  if (!ms) return () => {};
  const started = Date.now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const arm = () => {
    const left = ms - (Date.now() - started);
    if (left <= 0) {
      expire();
      return;
    }
    timer = setTimeout(arm, Math.min(left, 2_147_483_647));
    timer.unref?.();
  };
  arm();
  return () => clearTimeout(timer);
}
