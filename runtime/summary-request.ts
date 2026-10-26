import type { SummaryResponse } from "./summarize.ts";
import {
  contextLimitError,
  providerFailureKind,
  compactionFailureCause,
} from "./reconnect.ts";

export interface SummaryRetryBudget {
  remaining: number;
  used: number;
}
export interface SummaryRetryEvent {
  kind: "rate_limit" | "transport" | "provider";
  attempt: number;
  remaining: number;
  delayMs: number;
  reason: string;
}

/** Retry only identified transient failures; incomplete output never becomes a checkpoint. */
export function summaryFailureKind(
  reason: string,
): SummaryRetryEvent["kind"] | undefined {
  reason = compactionFailureCause(reason);
  if (
    contextLimitError(reason) ||
    providerFailureKind(reason) === "external" ||
    /(?:\b401\b|\b403\b|invalid api key|authentication|permission denied|model.{0,30}(?:not found|unavailable)|content.?filter|Response incomplete:|max_output_tokens)/i.test(
      reason,
    )
  )
    return;
  if (/\b429\b|rate.?limit|too many requests|resource.?exhausted/i.test(reason))
    return "rate_limit";
  if (
    /stream ended before a terminal response event|ended without|stream disconnected|malformed server-sent event JSON|error reading response|connection.{0,20}(?:reset|closed|lost|refused)|socket hang up|fetch failed|network.?error|timed? out|timeout|ECONNRESET|EPIPE|ENOTFOUND|terminated|\baborted\b|AbortError/i.test(
      reason,
    )
  )
    return "transport";
  if (
    /\b50[0234]\b|bad gateway|service temporarily unavailable|upstream.{0,30}(?:unavailable|connect|disconnect)/i.test(
      reason,
    )
  )
    return "provider";
}

export function summaryRetryDelay(
  reason: string,
  kind: SummaryRetryEvent["kind"],
  attempt: number,
) {
  const requested = reason.match(
    /retry[- ]after\s*[:=]?\s*(\d+(?:\.\d+)?)\s*(ms|milliseconds?|s|seconds?)?/i,
  );
  if (requested)
    return Math.max(
      0,
      Number(requested[1]) *
        (requested[2]?.toLowerCase().startsWith("m") ? 1 : 1000),
    );
  return Math.min(
    30000,
    (kind === "rate_limit" ? 5000 : 1000) * 2 ** Math.max(0, attempt - 1),
  );
}

function abortReason(signal: AbortSignal) {
  return signal.reason ?? new Error("Summary cancelled");
}
async function wait(ms: number, signal?: AbortSignal) {
  signal?.throwIfAborted();
  await new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
    };
    const abort = () => {
      cleanup();
      reject(abortReason(signal!));
    };
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
  });
}

export async function requestSummary(
  complete: (signal: AbortSignal) => Promise<SummaryResponse>,
  options: {
    signal?: AbortSignal;
    budget: SummaryRetryBudget;
    timeoutMs?: number;
    onRetry?: (event: SummaryRetryEvent) => void;
    wait?: (ms: number, signal?: AbortSignal) => Promise<void>;
  },
): Promise<SummaryResponse> {
  const timeoutMs = options.timeoutMs ?? 180000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1)
    throw new Error("Invalid summary request timeout");
  for (;;) {
    options.signal?.throwIfAborted();
    const controller = new AbortController();
    const signal = options.signal
      ? AbortSignal.any([options.signal, controller.signal])
      : controller.signal;
    let response: SummaryResponse | undefined, error: unknown;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let abort: (() => void) | undefined;
    try {
      response = await Promise.race([
        Promise.resolve().then(() => {
          signal.throwIfAborted();
          return complete(signal);
        }),
        new Promise<never>((_, reject) => {
          abort = () => reject(abortReason(signal));
          signal.addEventListener("abort", abort, { once: true });
          timer = setTimeout(
            () =>
              controller.abort(
                new Error(`Summary request timed out after ${timeoutMs}ms`),
              ),
            timeoutMs,
          );
          if (signal.aborted) abort();
        }),
      ]);
    } catch (caught) {
      error = caught;
    } finally {
      if (timer) clearTimeout(timer);
      if (abort) signal.removeEventListener("abort", abort);
    }
    options.signal?.throwIfAborted();
    const reason =
      error instanceof Error
        ? error.message
        : error
          ? String(error)
          : (response?.errorMessage ?? "");
    if (response?.content.some((block) => block.type === "toolCall"))
      return response;
    const kind = summaryFailureKind(reason);
    if (!kind || options.budget.remaining <= 0) {
      if (error) throw error;
      return response!;
    }
    const delayMs = summaryRetryDelay(reason, kind, options.budget.used + 1);
    // A long Retry-After is not permission to retry early. Leave it to an
    // explicit later attempt instead of holding an unbounded hidden backoff.
    if (delayMs > 60000) {
      if (error) throw error;
      return response!;
    }
    options.budget.remaining--;
    options.budget.used++;
    const event: SummaryRetryEvent = {
      kind,
      attempt: options.budget.used,
      remaining: options.budget.remaining,
      delayMs,
      reason: reason.slice(0, 1200),
    };
    options.onRetry?.(event);
    await (options.wait ?? wait)(event.delayMs, options.signal);
  }
}
