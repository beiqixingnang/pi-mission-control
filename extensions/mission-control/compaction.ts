import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { Type } from "typebox";
import {
  getAgentDir,
  serializeConversation,
  convertToLlm,
  prepareBranchEntries,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import {
  summarizeChunks,
  summaryBudgets,
  completeSummaryWithBudget,
  SUMMARY_SYSTEM_PROMPT,
} from "../../runtime/summarize.ts";
import { installContextMemory } from "./context-memory.ts";

interface Config {
  model?: string;
  maxTokens?: number;
  maxInputChars?: number;
  maxInputTokens?: number;
  maxOutputChars?: number;
  intermediateOutputChars?: number;
  reasoningEffort?: "minimal" | "low" | "medium" | "high";
  disabled?: boolean;
  maxRetries?: number;
  requestTimeoutMs?: number;
}
interface MemberRuntime {
  member: { id: string; name: string };
  directory: string;
}
type Target = "lead" | "member";
export default function (pi: ExtensionAPI) {
  const memory = installContextMemory(pi);
  let generation = 0,
    lifecycle = new AbortController();
  let activeSummaryContext: any;
  pi.on("session_start", () => {
    lifecycle.abort(new Error("Summary scope restarted"));
    lifecycle = new AbortController();
    generation++;
  });
  pi.on("session_shutdown", () => {
    if (activeSummaryContext) {
      debug(activeSummaryContext, "compact:interrupted", undefined, {
        errorMessage: "Compaction interrupted by session shutdown or reload",
      });
      setProgressStatus(activeSummaryContext, undefined);
      activeSummaryContext = undefined;
    }
    lifecycle.abort(new Error("Summary scope closed or reloaded"));
    generation++;
  });
  const scopedContext = (ctx: any) => ({
    ...ctx,
    compactionEpoch: generation,
    sessionManager: { getSessionId: () => ctx.sessionManager.getSessionId() },
  });
  const setProgressStatus = (ctx: any, value: string | undefined) => {
    if (ctx.compactionEpoch === undefined || ctx.compactionEpoch === generation)
      ctx.ui.setStatus?.("mission-compaction", value);
  };
  const legacyFile = path.join(getAgentDir(), "compaction-summary.json");
  const memberRuntime = (): MemberRuntime | undefined => {
    const raw = process.env.MC_V2_MEMBER;
    if (!raw) return undefined;
    try {
      const value = JSON.parse(raw) as MemberRuntime;
      if (!value?.directory || !value.member?.id) return undefined;
      return value;
    } catch {
      return undefined;
    }
  };
  const sessionDir = (ctx: any) => {
    const member = memberRuntime();
    if (member)
      return path.join(member.directory, "sessions", member.member.id);
    const id = String(
      ctx?.sessionManager?.getSessionId?.() ?? "no-session",
    ).replace(/[^a-zA-Z0-9_-]/g, "_");
    return path.join(getAgentDir(), "mission-control", "v2", id);
  };
  const configFile = (ctx: any, target: Target) => {
    const member = memberRuntime();
    if (target === "member") {
      if (member)
        return path.join(
          member.directory,
          "sessions",
          member.member.id,
          "compaction-summary.json",
        );
      return path.join(sessionDir(ctx), "member-compaction-summary.json");
    }
    return path.join(sessionDir(ctx), "compaction-summary.json");
  };
  const memberDefaultFile = (ctx: any) =>
    path.join(
      memberRuntime()?.directory ?? sessionDir(ctx),
      "member-compaction-summary.json",
    );
  const readFile = (file: string): { exists: boolean; config: Config } => {
    try {
      const value = JSON.parse(fs.readFileSync(file, "utf8"));
      if (!value || typeof value !== "object" || Array.isArray(value))
        throw new Error("Invalid compaction-summary.json");
      if (
        value.maxTokens !== undefined &&
        (!Number.isSafeInteger(value.maxTokens) || value.maxTokens < 256)
      )
        throw new Error("Invalid compaction maxTokens");
      if (
        value.maxInputChars !== undefined &&
        (!Number.isSafeInteger(value.maxInputChars) ||
          value.maxInputChars < 1024)
      )
        throw new Error("Invalid compaction maxInputChars");
      if (value.disabled !== undefined && typeof value.disabled !== "boolean")
        throw new Error("Invalid compaction disabled flag");
      for (const key of [
        "maxInputTokens",
        "maxOutputChars",
        "intermediateOutputChars",
      ] as const)
        if (
          value[key] !== undefined &&
          (!Number.isSafeInteger(value[key]) ||
            value[key] < (key === "maxInputTokens" ? 1024 : 128))
        )
          throw new Error("Invalid compaction " + key);
      if (
        value.reasoningEffort !== undefined &&
        !["minimal", "low", "medium", "high"].includes(value.reasoningEffort)
      )
        throw new Error("Invalid summary reasoningEffort");
      if (
        value.maxRetries !== undefined &&
        (!Number.isSafeInteger(value.maxRetries) ||
          value.maxRetries < 0 ||
          value.maxRetries > 5)
      )
        throw new Error("Invalid summary maxRetries (0..5)");
      if (
        value.requestTimeoutMs !== undefined &&
        (!Number.isSafeInteger(value.requestTimeoutMs) ||
          value.requestTimeoutMs < 1000 ||
          value.requestTimeoutMs > 600000)
      )
        throw new Error("Invalid summary requestTimeoutMs (1000..600000)");
      return { exists: true, config: value };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT")
        return { exists: false, config: {} };
      throw error;
    }
  };
  const resolveConfig = (ctx: any, target: Target) => {
    const own = readFile(configFile(ctx, target));
    const member = memberRuntime();
    const shared =
      target === "member" && member
        ? readFile(memberDefaultFile(ctx))
        : { exists: false, config: {} };
    const legacy = readFile(legacyFile);
    const selected = own.exists
      ? {
          ...own,
          config: {
            ...(shared.exists ? shared.config : legacy.config),
            ...own.config,
          },
        }
      : shared.exists
        ? shared
        : legacy;
    return {
      ...selected,
      file: own.exists
        ? configFile(ctx, target)
        : shared.exists
          ? memberDefaultFile(ctx)
          : legacyFile,
      scopeFile: configFile(ctx, target),
      legacyFile,
      member,
    };
  };
  const specOf = (
    ctx: any,
    target: Target = memberRuntime() ? "member" : "lead",
  ) => {
    const resolved = resolveConfig(ctx, target);
    if (resolved.config.disabled) return undefined;
    const scoped = resolved.file !== legacyFile;
    const model = scoped
      ? resolved.config.model?.trim()
      : process.env.PI_COMPACTION_SUMMARY_MODEL?.trim() ||
        resolved.config.model?.trim();
    if (!model && resolved.exists)
      throw new Error(
        "Summary model is missing from the selected configuration; refusing an implicit fallback to the inference model. Configure compaction_model target=lead/member.",
      );
    if (!model && resolved.member) {
      const parent = readFile(
        path.join(resolved.member.directory, "compaction-summary.json"),
      );
      if (parent.config.model && !parent.config.disabled)
        throw new Error(
          "This member has no summary-model route while the lead uses a custom summary model. Configure compaction_model target=member; inference-model fallback is blocked.",
        );
    }
    if (model) return model;
    if (!ctx.model?.provider || !ctx.model?.id)
      throw new Error(
        "No current model is available for default chunked compaction. Select a model or configure compaction_model.",
      );
    return `${ctx.model.provider}/${ctx.model.id}`;
  };
  let diagnostic: Record<string, unknown> = {};
  const debug = (
    ctx: any,
    stage: string,
    model?: string,
    metadata?: Record<string, string | number | undefined>,
  ) => {
    if (ctx.compactionEpoch !== undefined && ctx.compactionEpoch !== generation)
      return;
    try {
      const at = new Date().toISOString();
      if (
        stage.startsWith("summary:") &&
        /^(compact|branch):(failed|success|interrupted)$/.test(
          String(diagnostic.stage ?? ""),
        )
      )
        return;
      if (stage === "compact:start" || stage === "branch:start")
        diagnostic = {
          runId: randomUUID(),
          startedAt: at,
          model,
          ...metadata,
          requests: 0,
          retries: 0,
        };
      if (
        stage === "summary:response" &&
        metadata?.requestId !== undefined &&
        metadata.requestId !== (diagnostic.lastRequest as any)?.requestId
      )
        return;
      Object.assign(diagnostic, { at, stage });
      if (model) diagnostic.model = model;
      if (stage === "summary:request") {
        diagnostic.requests = Number(diagnostic.requests ?? 0) + 1;
        diagnostic.lastRequest = metadata;
      }
      if (stage === "summary:response") diagnostic.lastResponse = metadata;
      if (stage === "summary:progress") diagnostic.progress = metadata;
      if (stage === "summary:retry") {
        diagnostic.retries = Number(diagnostic.retries ?? 0) + 1;
        diagnostic.lastRetry = metadata;
      }
      if (stage === "compact:failed")
        diagnostic.errorMessage = metadata?.errorMessage;
      const statusFile = path.join(
        path.dirname(configFile(ctx, memberRuntime() ? "member" : "lead")),
        "compaction-diagnostics.json",
      );
      fs.mkdirSync(path.dirname(statusFile), { recursive: true });
      const statusTmp = statusFile + "." + randomUUID() + ".tmp";
      fs.writeFileSync(statusTmp, JSON.stringify(diagnostic, null, 2) + "\n", {
        mode: 0o600,
      });
      fs.renameSync(statusTmp, statusFile);
      if (!process.env.PI_COMPACTION_DEBUG) return;
      const directory = path.dirname(
        resolveConfig(ctx, memberRuntime() ? "member" : "lead").file,
      );
      fs.mkdirSync(directory, { recursive: true });
      fs.appendFileSync(
        path.join(directory, "compaction-summary.log"),
        JSON.stringify({
          at,
          stage,
          model,
          ...metadata,
        }) + "\n",
        { mode: 0o600 },
      );
    } catch {
      /* diagnostics never replace history */
    }
  };
  async function run(
    messages: any[],
    previous: string | undefined,
    instructions: string | undefined,
    ctx: any,
    signal: AbortSignal,
  ) {
    const target: Target = memberRuntime() ? "member" : "lead";
    const config = resolveConfig(ctx, target).config,
      spec = specOf(ctx, target);
    if (!spec) return;
    const slash = spec.indexOf("/");
    if (slash < 1) throw new Error("Summary model must be provider/model-id");
    const model = ctx.modelRegistry.find(
      spec.slice(0, slash),
      spec.slice(slash + 1),
    );
    if (!model)
      throw new Error(`Configured summary model unavailable: ${spec}`);
    const {
      maxTokens,
      maxInputChars,
      maxOutputChars,
      maxInputTokens,
      intermediateOutputChars,
    } = summaryBudgets(model, config);
    const parts = function* () {
      if (instructions) yield `USER SUMMARY FOCUS:\n${instructions}\n\n`;
      for (const message of convertToLlm(messages))
        yield serializeConversation([message]) + "\n\n";
    };
    return summarizeChunks(parts(), {
      model: spec,
      directory: path.join(
        path.dirname(
          resolveConfig(ctx, memberRuntime() ? "member" : "lead").file,
        ),
        "summary-cache",
      ),
      maxInputChars,
      maxOutputChars,
      maxInputTokens,
      intermediateOutputChars,
      previousSummary: previous,
      cacheIdentity: config.reasoningEffort ?? "low",
      signal,
      requestTimeoutMs: config.requestTimeoutMs ?? 180000,
      retryBudget: { remaining: config.maxRetries ?? 2, used: 0 },
      onRetry: (event) => {
        debug(ctx, "summary:retry", spec, { ...event });
        setProgressStatus(
          ctx,
          `摘要重试 ${event.attempt}/${config.maxRetries ?? 2} · ${event.kind}`,
        );
      },
      onProgress: (event) => {
        debug(ctx, "summary:progress", spec, {
          phase: event.stage,
          chunks: event.chunks,
          completed: event.completed,
          cacheHits: event.cacheHits,
          round: event.round,
          inputChars: event.inputChars,
        });
        setProgressStatus(
          ctx,
          event.stage === "split"
            ? `摘要失败块降载 · ${event.inputChars}字符`
            : event.stage === "merge"
              ? `摘要合并 第${event.round}层`
              : `摘要分块 ${event.completed ?? 0}/${event.chunks ?? "—"} · 缓存 ${event.cacheHits ?? 0}`,
        );
      },
      complete: (prompt, requestSignal, request) =>
        completeSummaryWithBudget(
          async (requestMaxTokens) => {
            const requestId = randomUUID(),
              started = Date.now();
            debug(ctx, "summary:request", spec, {
              requestId,
              inputChars: prompt.length,
              phase: request?.phase,
              maxTokens: requestMaxTokens,
              maxOutputChars,
            });
            try {
              const response = await ctx.modelRegistry.complete(
                model,
                {
                  messages: [
                    {
                      role: "system",
                      content: SUMMARY_SYSTEM_PROMPT,
                      timestamp: Date.now(),
                    },
                    {
                      role: "user",
                      content: [{ type: "text", text: prompt }],
                      timestamp: Date.now(),
                    },
                  ],
                },
                {
                  maxTokens: requestMaxTokens,
                  signal: requestSignal ?? signal,
                  cacheRetention: "none",
                  maxRetries: 0,
                  reasoningEffort: config.reasoningEffort ?? "low",
                  sessionId: createHash("sha256")
                    .update(prompt)
                    .digest("hex")
                    .slice(0, 32),
                },
              );
              debug(ctx, "summary:response", spec, {
                requestId,
                elapsedMs: Date.now() - started,
                errorMessage: response.errorMessage?.slice(0, 1200),
                stopReason: response.stopReason,
                rawStopReason: response.rawStopReason,
                inputChars: prompt.length,
                maxTokens: requestMaxTokens,
                outputTokens: response.usage?.output,
                inputTokens: response.usage?.input,
                cacheReadTokens: response.usage?.cacheRead,
                totalTokens: response.usage?.totalTokens,
                reasoningTokens: response.usage?.reasoning,
                textChars: response.content
                  .filter((block: any) => block.type === "text")
                  .reduce(
                    (size: number, block: any) =>
                      size + (block.text?.length ?? 0),
                    0,
                  ),
              });
              return response;
            } catch (error) {
              debug(ctx, "summary:response", spec, {
                requestId,
                elapsedMs: Date.now() - started,
                stopReason: "error",
                errorMessage: String(
                  error instanceof Error ? error.message : error,
                ).slice(0, 1200),
              });
              throw error;
            }
          },
          maxTokens,
          config.maxTokens !== undefined
            ? maxTokens
            : Math.min(
                32768,
                model.maxTokens,
                Math.floor(model.contextWindow / 4),
              ),
        ),
    });
  }
  function summaryReport(ctx: any, scope: Target) {
    const r = resolveConfig(ctx, scope);
    let spec: string | undefined, routingError: string | undefined;
    try {
      spec = specOf(ctx, scope);
    } catch (error) {
      routingError = String(error instanceof Error ? error.message : error);
    }
    const slash = spec?.indexOf("/") ?? -1;
    const model =
      spec && slash > 0
        ? ctx.modelRegistry.find(spec.slice(0, slash), spec.slice(slash + 1))
        : undefined;
    const budgets = model ? summaryBudgets(model, r.config) : undefined;
    return {
      target: scope,
      engine: r.config.disabled ? "native" : "chunked",
      modelSelection:
        spec && !r.exists && !process.env.PI_COMPACTION_SUMMARY_MODEL?.trim()
          ? "current-model"
          : "configured",
      model:
        spec ??
        (routingError
          ? "Blocked: summary route missing"
          : "Pi native (explicitly disabled chunking)"),
      routingError,
      maxTokens: budgets?.maxTokens ?? r.config.maxTokens ?? 4096,
      maxInputChars: budgets?.maxInputChars ?? r.config.maxInputChars ?? 24000,
      maxOutputChars: budgets?.maxOutputChars,
      maxInputTokens: budgets?.maxInputTokens,
      inputTokenBudgetKind:
        "heuristic estimate; provider usage is authoritative",
      intermediateOutputChars: budgets?.intermediateOutputChars,
      reasoningEffort: r.config.reasoningEffort ?? "low",
      context: memory.status(ctx),
      maxRetries: r.config.maxRetries ?? 2,
      requestTimeoutMs: r.config.requestTimeoutMs ?? 180000,
      diagnostics: (() => {
        if (scope !== (memberRuntime() ? "member" : "lead")) return undefined;
        try {
          return JSON.parse(
            fs.readFileSync(
              path.join(sessionDir(ctx), "compaction-diagnostics.json"),
              "utf8",
            ),
          );
        } catch {
          return undefined;
        }
      })(),
      recoveryMaxTokens:
        budgets && model
          ? r.config.maxTokens !== undefined
            ? budgets.maxTokens
            : Math.min(
                32768,
                model.maxTokens,
                Math.floor(model.contextWindow / 4),
              )
          : undefined,
      file: r.file,
      source: r.config.disabled
        ? "disabled"
        : r.file === legacyFile
          ? process.env.PI_COMPACTION_SUMMARY_MODEL?.trim()
            ? "environment"
            : r.config.model
              ? "legacy config file"
              : "current model (chunked default)"
          : "scoped config file",
    };
  }
  function manageSummary(
    ctx: any,
    args: {
      action?: "status" | "set" | "off";
      target?: Target;
      model?: string;
      maxRetries?: number;
      requestTimeoutMs?: number;
      maxInputTokens?: number;
      maxInputChars?: number;
      maxTokens?: number;
      maxOutputChars?: number;
      intermediateOutputChars?: number;
      reasoningEffort?: Config["reasoningEffort"];
    },
  ) {
    const target = args.target ?? (memberRuntime() ? "member" : "lead");
    if (memberRuntime() && target === "lead")
      throw new Error("A member can only change its own compaction model");
    if (!args.action || args.action === "status")
      return !args.target && !memberRuntime()
        ? {
            lead: summaryReport(ctx, "lead"),
            member: summaryReport(ctx, "member"),
          }
        : summaryReport(ctx, target);
    const config = { ...resolveConfig(ctx, target).config };
    for (const key of [
      "maxInputTokens",
      "maxInputChars",
      "maxTokens",
      "maxOutputChars",
      "intermediateOutputChars",
    ] as const) {
      if (args[key] !== undefined) {
        if (
          !Number.isSafeInteger(args[key]) ||
          args[key]! <
            (key === "maxInputChars" || key === "maxInputTokens"
              ? 1024
              : key === "maxTokens"
                ? 256
                : 128)
        )
          throw new Error("Invalid summary " + key);
        config[key] = args[key];
      }
    }
    if (args.reasoningEffort !== undefined)
      config.reasoningEffort = args.reasoningEffort;
    if (args.maxRetries !== undefined) {
      if (
        !Number.isSafeInteger(args.maxRetries) ||
        args.maxRetries < 0 ||
        args.maxRetries > 5
      )
        throw new Error("Summary maxRetries must be 0..5");
      config.maxRetries = args.maxRetries;
    }
    if (args.requestTimeoutMs !== undefined) {
      if (
        !Number.isSafeInteger(args.requestTimeoutMs) ||
        args.requestTimeoutMs < 1000 ||
        args.requestTimeoutMs > 600000
      )
        throw new Error("Summary requestTimeoutMs must be 1000..600000");
      config.requestTimeoutMs = args.requestTimeoutMs;
    }
    if (args.action === "off") {
      delete config.model;
      config.disabled = true;
    } else {
      const value = args.model?.trim() ?? config.model?.trim() ?? "",
        slash = value.indexOf("/");
      if (
        slash < 1 ||
        !ctx.modelRegistry.find(value.slice(0, slash), value.slice(slash + 1))
      )
        throw new Error(
          "Summary model is not configured in Pi; use provider/model-id",
        );
      config.model = value;
      delete config.disabled;
    }
    const file =
      target === "member" && !memberRuntime()
        ? memberDefaultFile(ctx)
        : configFile(ctx, target);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = file + "." + randomUUID() + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(config, null, 2) + "\n", {
      mode: 0o600,
    });
    fs.renameSync(tmp, file);
    return summaryReport(ctx, target);
  }
  if (!memberRuntime())
    pi.registerTool({
      name: "compaction_model",
      label: "Summary model settings",
      executionMode: "sequential",
      description:
        "Inspect or set this lead session's summary model, or defaults for future member sessions. Summary mode uses bounded chunked compaction by default with the current model when no independent route is configured. Explicit configured routes remain authoritative; their failures never fall back to the inference model. target=lead/member; action=status/set/off. off explicitly opts out of chunking into Pi native compaction. This does not compact history, select summary/notes mode or alter the main inference model.",
      parameters: Type.Object({
        action: Type.Optional(
          Type.Union([
            Type.Literal("status"),
            Type.Literal("set"),
            Type.Literal("off"),
          ]),
        ),
        target: Type.Optional(
          Type.Union([Type.Literal("lead"), Type.Literal("member")]),
        ),
        model: Type.Optional(Type.String({ minLength: 1 })),
        maxInputTokens: Type.Optional(
          Type.Integer({ minimum: 1024, maximum: 1000000 }),
        ),
        maxInputChars: Type.Optional(
          Type.Integer({ minimum: 1024, maximum: 8000000 }),
        ),
        maxTokens: Type.Optional(
          Type.Integer({ minimum: 256, maximum: 128000 }),
        ),
        maxOutputChars: Type.Optional(
          Type.Integer({ minimum: 128, maximum: 32000 }),
        ),
        intermediateOutputChars: Type.Optional(
          Type.Integer({ minimum: 128, maximum: 16000 }),
        ),
        reasoningEffort: Type.Optional(
          Type.Union(
            ["minimal", "low", "medium", "high"].map((x) => Type.Literal(x)),
          ),
        ),
        maxRetries: Type.Optional(Type.Integer({ minimum: 0, maximum: 5 })),
        requestTimeoutMs: Type.Optional(
          Type.Integer({ minimum: 1000, maximum: 600000 }),
        ),
      }),
      async execute(_id, args, _signal, _update, ctx) {
        try {
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(manageSummary(ctx, args), null, 2),
              },
            ],
            details: undefined,
          };
        } catch (error) {
          return {
            content: [{ type: "text", text: String(error) }],
            details: undefined,
            isError: true,
          };
        }
      },
    });
  pi.registerCommand("compaction-model", {
    description:
      "Set the summary model for this lead/member conversation or future subagents. Use lead/member provider/model-id, off, or status.",
    handler: async (args, ctx) => {
      try {
        const tokens = args.trim().split(/\s+/).filter(Boolean);
        let target: Target | undefined;
        if (["lead", "main"].includes(tokens[0]?.toLowerCase())) {
          target = "lead";
          tokens.shift();
        } else if (
          ["member", "members", "subagent", "subagents"].includes(
            tokens[0]?.toLowerCase(),
          )
        ) {
          target = "member";
          tokens.shift();
        }
        const value = tokens.join(" ");
        const report = manageSummary(ctx, {
          target,
          action:
            !value || value === "status"
              ? "status"
              : value === "off"
                ? "off"
                : "set",
          model: value,
        });
        ctx.ui.notify(JSON.stringify(report, null, 2), "info");
      } catch (error) {
        ctx.ui.notify(String(error), "error");
      }
    },
  });
  pi.on("session_before_compact", async (event, ctx) => {
    const activeCtx = scopedContext(ctx),
      epoch = generation,
      sessionId = ctx.sessionManager.getSessionId(),
      runId = randomUUID();
    activeCtx.sessionManager.getSessionId = () => sessionId;
    activeSummaryContext = activeCtx;
    const signal = AbortSignal.any([event.signal, lifecycle.signal]);
    const reportState = (phase: string, error?: string) =>
      pi.events.emit("mission-control:compaction-state", {
        phase,
        error,
        sessionId,
        runId,
        scope: memberRuntime() ? "member" : "lead",
      });
    debug(activeCtx, "compact:start", undefined, {
      tokensBefore: event.preparation.tokensBefore,
    });
    reportState("started");
    try {
      const noteResult = memory.prepare(event, ctx);
      if (noteResult) {
        debug(activeCtx, "compact:success");
        return noteResult;
      }
      const spec = specOf(activeCtx);
      if (!spec) {
        debug(
          activeCtx,
          "compact:native",
          ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined,
        );
        return;
      }
      debug(activeCtx, "compact:route", spec);
      const p = event.preparation;
      const summary = await run(
        [...p.messagesToSummarize, ...p.turnPrefixMessages],
        p.previousSummary,
        event.customInstructions,
        activeCtx,
        signal,
      );
      if (!summary) throw new Error("No summary produced");
      debug(activeCtx, "compact:success", spec);
      return {
        compaction: {
          summary,
          firstKeptEntryId: p.firstKeptEntryId,
          tokensBefore: p.tokensBefore,
        },
      };
    } catch (error) {
      if (epoch !== generation) return { cancel: true };
      const reason = event.signal.aborted
        ? "Compaction cancelled by its initiating user"
        : String(error instanceof Error ? error.message : error);
      debug(activeCtx, "compact:failed", undefined, {
        errorMessage: reason.slice(0, 1200),
      });
      reportState("failed", reason);
      ctx.ui.notify(
        `Custom compaction stopped: ${String((error as Error).message)}. Original history and completed chunks are retained; no default fallback request was sent.`,
        "error",
      );
      return { cancel: true };
    } finally {
      setProgressStatus(activeCtx, undefined);
      if (activeSummaryContext === activeCtx) activeSummaryContext = undefined;
    }
  });
  pi.on("session_before_tree", async (event, ctx) => {
    if (!event.preparation.userWantsSummary) return;
    const activeCtx = scopedContext(ctx),
      epoch = generation,
      sessionId = ctx.sessionManager.getSessionId();
    activeCtx.sessionManager.getSessionId = () => sessionId;
    activeSummaryContext = activeCtx;
    const signal = AbortSignal.any([event.signal, lifecycle.signal]);
    try {
      const spec = specOf(activeCtx);
      if (!spec) return;
      debug(activeCtx, "branch:start", spec);
      const preparation = prepareBranchEntries(
        event.preparation.entriesToSummarize,
        16384,
      );
      const summary = await run(
        preparation.messages,
        undefined,
        event.preparation.customInstructions,
        activeCtx,
        signal,
      );
      if (!summary) throw new Error("No branch summary");
      debug(activeCtx, "branch:success", spec);
      return { summary: { summary } };
    } catch (error) {
      if (epoch !== generation) return { cancel: true };
      debug(activeCtx, "branch:failed", undefined, {
        errorMessage: String(
          error instanceof Error ? error.message : error,
        ).slice(0, 1200),
      });
      ctx.ui.notify(
        `Branch summary stopped; history retained: ${String(error)}`,
        "error",
      );
      return { cancel: true };
    } finally {
      setProgressStatus(activeCtx, undefined);
      if (activeSummaryContext === activeCtx) activeSummaryContext = undefined;
    }
  });
}
