import {
  getAgentDir,
  SettingsManager,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import fs from "node:fs";
import path from "node:path";
import { cleanText } from "../../runtime/public.ts";
import {
  reconnectPolicy,
  contextLimitError,
  waitForReconnect,
  type ReconnectOptions,
} from "../../runtime/reconnect.ts";

interface Persistence {
  read(): ReconnectOptions | undefined;
  write(value: ReconnectOptions): void;
}
/** Native recovery runs first. This hook supplies bounded continuation after it settles. */
export default function installReconnect(
  pi: ExtensionAPI,
  persistence?: Persistence,
) {
  let failures = 0,
    extraAttempts = 0,
    generation = 0;
  let lastError = "",
    waiting: AbortController | undefined,
    nextAt: number | undefined;
  const reset = () => {
    generation++;
    waiting?.abort();
    waiting = undefined;
    failures = 0;
    extraAttempts = 0;
    lastError = "";
    nextAt = undefined;
  };
  function policy(ctx: ExtensionContext) {
    const native = SettingsManager.create(ctx.cwd, getAgentDir(), {
      projectTrusted: ctx.isProjectTrusted(),
    }).getRetrySettings();
    let raw: ReconnectOptions = {};
    try {
      raw =
        JSON.parse(
          fs.readFileSync(
            path.join(getAgentDir(), "mission-control.json"),
            "utf8",
          ),
        ).reconnect ?? {};
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (process.env.MC_V2_RECONNECT)
      raw = { ...raw, ...JSON.parse(process.env.MC_V2_RECONNECT) };
    raw = { ...raw, ...persistence?.read() };
    return { ...reconnectPolicy(raw, native.enabled), native };
  }
  const clear = (_event: unknown, ctx: ExtensionContext) => {
    reset();
    ctx.ui.setStatus("mission-reconnect", undefined);
  };
  pi.on("session_start", clear);
  pi.on("session_shutdown", clear);
  pi.on("session_tree", clear);
  pi.on("before_agent_start", clear);
  pi.events.on("mission-control:interrupt", reset);
  pi.on("message_end", (event) => {
    if (event.message.role !== "assistant") return;
    if (
      event.message.stopReason === "error" ||
      (event.message.errorMessage && event.message.stopReason !== "aborted")
    ) {
      failures++;
      lastError = cleanText(
        event.message.errorMessage ?? "Provider request failed",
        1500,
      );
    } else if (event.message.stopReason !== "aborted") {
      failures = 0;
      extraAttempts = 0;
      lastError = "";
    }
  });
  pi.on("agent_before_settle", async (event, ctx) => {
    if (event.outcome !== "error" || ctx.signal?.aborted) return;
    let config;
    try {
      config = policy(ctx);
    } catch (error) {
      ctx.ui.notify(String(error), "warning");
      return;
    }
    // Count the native failures already observed, rather than granting ten extra native batches.
    const used = Math.max(extraAttempts, failures - 1, 0);
    if (
      !config.enabled ||
      used >= config.maxRetries ||
      extraAttempts >= config.maxRetries ||
      contextLimitError(lastError) ||
      ctx.hasPendingMessages()
    )
      return;
    const expected = generation,
      controller = new AbortController();
    waiting = controller;
    const abort = () => controller.abort();
    ctx.signal?.addEventListener("abort", abort, { once: true });
    nextAt = Date.now() + config.delayMs;
    ctx.ui.setStatus(
      "mission-reconnect",
      `重连 ${used + 1}/${config.maxRetries} · ${config.delayMs / 1000}秒后`,
    );
    let ready: boolean;
    try {
      ready = await waitForReconnect(config.delayMs, controller.signal);
    } finally {
      ctx.signal?.removeEventListener("abort", abort);
      if (waiting === controller) waiting = undefined;
      nextAt = undefined;
      ctx.ui.setStatus("mission-reconnect", undefined);
    }
    if (
      !ready ||
      expected !== generation ||
      ctx.signal?.aborted ||
      ctx.hasPendingMessages()
    )
      return;
    extraAttempts++;
    return {
      entries: [
        ...event.entries,
        {
          type: "custom_message" as const,
          customType: "mission-reconnect",
          display: true,
          content: `Provider request failed; continue the approved request after reconnection (retry ${used + 1}/${config.maxRetries}). Inspect saved tool results before repeating any side effects.`,
          details: {
            retry: used + 1,
            maxRetries: config.maxRetries,
            delayMs: config.delayMs,
          },
        },
      ],
      continue: true,
    };
  });
  pi.on("agent_settled", (_event, ctx) => {
    waiting?.abort();
    waiting = undefined;
    nextAt = undefined;
    ctx.ui.setStatus("mission-reconnect", undefined);
  });
  if (!process.env.MC_V2_MEMBER)
    pi.registerCommand("reconnect", {
      description:
        "Provider recovery: status | on | off | retries <0..100> | delay <seconds>. Native Pi retry remains separate.",
      handler: async (args, ctx) => {
        try {
          const [action = "status", value] = args
            .trim()
            .split(/\s+/)
            .filter(Boolean);
          const raw = persistence?.read() ?? {};
          if (action === "on" || action === "off")
            raw.enabled = action === "on";
          else if (action === "retries") raw.maxRetries = Number(value);
          else if (action === "delay") raw.delayMs = Number(value) * 1000;
          else if (action !== "status")
            throw new Error(
              "Use /reconnect status|on|off|retries N|delay seconds",
            );
          reconnectPolicy(raw);
          if (action !== "status") {
            if (!persistence)
              throw new Error("No persistent lead runtime attached");
            reset();
            persistence.write(raw);
          }
          ctx.ui.notify(
            JSON.stringify(
              {
                ...policy(ctx),
                observedFailures: failures,
                extraAttempts,
                nextAt,
                lastError,
                note: "插件等待固定间隔；原生重试先运行并计入连续失败预算，当前原生批次可能略超剩余预算。off仅关闭插件兜底。",
              },
              null,
              2,
            ),
            "info",
          );
        } catch (error) {
          ctx.ui.notify(String(error), "error");
        }
      },
    });
}
