export interface ReconnectOptions {
  enabled?: boolean;
  maxRetries?: number;
  delayMs?: number;
}
export interface ReconnectPolicy {
  enabled: boolean;
  maxRetries: number;
  delayMs: number;
}
export function reconnectPolicy(
  raw: ReconnectOptions = {},
  nativeEnabled = true,
): ReconnectPolicy {
  const maxRetries = raw.maxRetries ?? 10,
    delayMs = raw.delayMs ?? 5000;
  if (
    (typeof raw.enabled !== "undefined" && typeof raw.enabled !== "boolean") ||
    !Number.isSafeInteger(maxRetries) ||
    maxRetries < 0 ||
    maxRetries > 100 ||
    !Number.isSafeInteger(delayMs) ||
    delayMs < 0 ||
    delayMs > 300000
  )
    throw new Error(
      "Invalid reconnect settings: maxRetries 0..100, delayMs 0..300000",
    );
  return { enabled: raw.enabled ?? nativeEnabled, maxRetries, delayMs };
}
export function contextLimitError(text: string) {
  if (/rate limit|too many requests/i.test(text)) return false;
  return /context.{0,30}(?:exceed|overflow|too (?:long|large))|exceed[^\n]{0,80}context|maximum context|too many tokens|context[_ ]length[_ ]exceeded|prompt (?:is )?too long|token limit exceeded/i.test(
    text,
  );
}
/** Unknown gateway errors are recoverable; explicit configuration/account failures need repair. */
export function providerFailureKind(
  text: string,
): "context" | "external" | "transient" {
  if (contextLimitError(text)) return "context";
  if (
    /\b40[13]\b|invalid.{0,12}api.{0,6}key|authentication.{0,20}(?:failed|required)|permission denied|insufficient_quota|quota exceeded|out of budget|insufficient (?:balance|credits|funds)|billing|GoUsageLimitError|FreeUsageLimitError|Monthly usage limit reached|available balance|subscription_sharing_usage_limit_exceeded|model.{0,40}(?:not found|does not exist)|unsupported (?:model|parameter)|invalid (?:parameter|argument)|content.?filter/i.test(
      text,
    )
  )
    return "external";
  return "transient";
}

/** Pi's overflow recovery wrapper describes the operation, not the failed
 * summary request. Classify the nested cause before deciding whether to retry
 * compaction; a genuine context rejection still requires smaller inputs.
 */
export function compactionFailureCause(text: string) {
  let cause = text.trim().replace(/^Error:\s*/i, "");
  for (let i = 0; i < 8; i++) {
    const next = cause.replace(
      /^(?:Error:\s*)?(?:Context overflow recovery failed|Auto-compaction failed|Manual compaction failed|Turn prefix summarization failed|Summarization failed|Custom compaction stopped|Summary request was truncated after bounded subdivision|Summary request failed or was truncated):\s*/i,
      "",
    );
    if (next === cause) break;
    cause = next;
  }
  return cause.replace(/^Error:\s*/i, "");
}
export function compactionFailureKind(text: string) {
  return providerFailureKind(compactionFailureCause(text));
}
export function waitForReconnect(
  ms: number,
  signal: AbortSignal,
): Promise<boolean> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve(false);
      return;
    }
    const finish = (ok: boolean) => {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      resolve(ok);
    };
    const abort = () => finish(false);
    const timer = setTimeout(() => finish(true), ms);
    signal.addEventListener("abort", abort, { once: true });
  });
}
