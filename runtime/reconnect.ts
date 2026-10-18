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
