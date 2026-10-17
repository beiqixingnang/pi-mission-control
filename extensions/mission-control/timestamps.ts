import type { ExtensionAPI, ThemeBg } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences } from "@earendil-works/pi-tui";
import {
  readTime,
  readDuration,
  formatTime,
  formatDuration,
} from "../../runtime/time.ts";
import { panelLine, type UiTheme } from "./presentation.ts";

export const TIMESTAMP_RENDERER = Symbol.for(
  "pi-mission-control.timestamp-renderer.v1",
);
export const TIMESTAMP_ADAPTER = Symbol.for(
  "pi-mission-control.timestamp-adapter.v1",
);
const globals = globalThis as typeof globalThis & { [key: symbol]: unknown };
interface Timing {
  startedAt?: number;
  endedAt?: number;
  durationMs?: number;
}
export interface NativeTimeMetadata {
  kind: "user" | "assistant" | "tool" | "custom";
  timestamp?: number;
  toolCallId?: string;
  isPartial?: boolean;
  isError?: boolean;
  durationMs?: number;
  width: number;
  theme: UiTheme;
}

/** Small metadata index; never retains message bodies or private model content. */
export class ToolTimes {
  private values = new Map<string, Timing>();
  get(id = "") {
    return this.values.get(id);
  }
  put(id: string, timing: Timing) {
    this.values.set(id, timing);
    if (this.values.size > 5000)
      this.values.delete(this.values.keys().next().value!);
  }
  start(id: string, now = Date.now()) {
    this.put(id, { startedAt: now });
  }
  end(id: string, durationMs: unknown, now = Date.now()) {
    const duration = readDuration(durationMs);
    this.put(id, {
      startedAt:
        this.get(id)?.startedAt ??
        (duration === undefined ? undefined : now - duration),
      endedAt: now,
      durationMs: duration,
    });
  }
  load(entries: readonly unknown[]) {
    this.values.clear();
    for (const raw of entries) {
      const e = raw as {
        type?: string;
        timestamp?: unknown;
        message?: {
          role?: string;
          toolCallId?: string;
          timestamp?: unknown;
          durationMs?: unknown;
        };
      };
      const m = e.message;
      if (e.type !== "message" || m?.role !== "toolResult" || !m.toolCallId)
        continue;
      const end = readTime(m.timestamp) ?? readTime(e.timestamp),
        duration = readDuration(m.durationMs);
      this.put(m.toolCallId, {
        endedAt: end,
        durationMs: duration,
        startedAt:
          end !== undefined && duration !== undefined
            ? end - duration
            : undefined,
      });
    }
  }
}

export function decorateNativeTime(
  lines: string[],
  meta: NativeTimeMetadata,
  times: ToolTimes,
  now = Date.now(),
) {
  if (!lines.length) return lines;
  const timing = meta.kind === "tool" ? times.get(meta.toolCallId) : undefined;
  const timestamp =
    meta.kind === "tool" ? timing?.startedAt : readTime(meta.timestamp);
  const duration = timing?.durationMs ?? readDuration(meta.durationMs);
  const elapsed =
    meta.kind === "tool" && meta.isPartial && timing?.startedAt !== undefined
      ? now - timing.startedAt
      : undefined;
  const label = `${formatTime(timestamp, now)}${duration !== undefined && meta.kind === "tool" ? ` · 耗时 ${formatDuration(duration)}` : elapsed !== undefined ? ` · 已运行 ${formatDuration(elapsed)}` : ""}`;
  const text = meta.theme.fg?.("dim", label) ?? label;
  const bg: ThemeBg | undefined =
    meta.kind === "user"
      ? "userMessageBg"
      : meta.kind === "tool"
        ? meta.isPartial
          ? "toolPendingBg"
          : meta.isError
            ? "toolErrorBg"
            : "toolSuccessBg"
        : undefined;
  const header = panelLine(" " + text, meta.width, bg, meta.theme);
  if (!stripTerminalSequences(lines[0]).trim()) {
    const zones =
      lines[0].match(/\x1b\]133;[ABC](?:\x07|\x1b\\)/g)?.join("") ?? "";
    return [zones + header, ...lines.slice(1)];
  }
  return [header, ...lines];
}

export function timestampAdapterAvailable() {
  return globals[TIMESTAMP_ADAPTER] === true;
}
export function installTimestamps(pi: ExtensionAPI) {
  const times = new ToolTimes();
  const decorate = (lines: string[], meta: NativeTimeMetadata) =>
    decorateNativeTime(lines, meta, times);
  pi.on("session_start", (_event, ctx) => {
    times.load(ctx.sessionManager.getBranch());
    globals[TIMESTAMP_RENDERER] = decorate;
  });
  pi.on("tool_execution_start", (event) => times.start(event.toolCallId));
  pi.on("tool_execution_end", (event) =>
    times.end(event.toolCallId, event.durationMs),
  );
  pi.on("session_shutdown", () => {
    if (globals[TIMESTAMP_RENDERER] === decorate)
      delete globals[TIMESTAMP_RENDERER];
  });
}
