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

interface Config {
  model?: string;
  maxTokens?: number;
  maxInputChars?: number;
  disabled?: boolean;
}
interface MemberRuntime {
  member: { id: string; name: string };
  directory: string;
}
type Target = "lead" | "member";
export default function (pi: ExtensionAPI) {
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
      target === "member" && !member
        ? readFile(memberDefaultFile(ctx))
        : { exists: false, config: {} };
    const legacy = readFile(legacyFile);
    const selected = own.exists ? own : shared.exists ? shared : legacy;
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
    if (target === "member" && scoped) return resolved.config.model?.trim();
    return (
      process.env.PI_COMPACTION_SUMMARY_MODEL?.trim() ||
      resolved.config.model?.trim()
    );
  };
  let diagnostic: Record<string, unknown> = {};
  const debug = (
    ctx: any,
    stage: string,
    model?: string,
    metadata?: Record<string, string | number | undefined>,
  ) => {
    try {
      const at = new Date().toISOString();
      if (stage === "compact:start")
        diagnostic = { startedAt: at, model, requests: 0 };
      Object.assign(diagnostic, { at, stage });
      if (model) diagnostic.model = model;
      if (stage === "summary:request") {
        diagnostic.requests = Number(diagnostic.requests ?? 0) + 1;
        diagnostic.lastRequest = metadata;
      }
      if (stage === "summary:response") diagnostic.lastResponse = metadata;
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
    const { maxTokens, maxInputChars, maxOutputChars } = summaryBudgets(
      model,
      config,
    );
    const parts = function* () {
      if (instructions) yield `USER SUMMARY FOCUS:\n${instructions}\n\n`;
      if (previous) yield `PREVIOUS SUMMARY:\n${previous}\n\n`;
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
      signal,
      complete: (prompt) =>
        completeSummaryWithBudget(
          async (requestMaxTokens) => {
            debug(ctx, "summary:request", spec, {
              inputChars: prompt.length,
              maxTokens: requestMaxTokens,
              maxOutputChars,
            });
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
                signal,
                cacheRetention: "none",
                sessionId: createHash("sha256")
                  .update(prompt)
                  .digest("hex")
                  .slice(0, 32),
              },
            );
            debug(ctx, "summary:response", spec, {
              stopReason: response.stopReason,
              rawStopReason: response.rawStopReason,
              inputChars: prompt.length,
              maxTokens: requestMaxTokens,
              outputTokens: response.usage?.output,
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
    const r = resolveConfig(ctx, scope),
      spec = specOf(ctx, scope),
      slash = spec?.indexOf("/") ?? -1;
    const model =
      spec && slash > 0
        ? ctx.modelRegistry.find(spec.slice(0, slash), spec.slice(slash + 1))
        : undefined;
    const budgets = model ? summaryBudgets(model, r.config) : undefined;
    return {
      target: scope,
      model: spec ?? "Pi default",
      maxTokens: budgets?.maxTokens ?? r.config.maxTokens ?? 4096,
      maxInputChars: budgets?.maxInputChars ?? r.config.maxInputChars ?? 24000,
      maxOutputChars: budgets?.maxOutputChars,
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
              : "Pi default"
          : "scoped config file",
    };
  }
  function manageSummary(
    ctx: any,
    args: {
      action?: "status" | "set" | "off";
      target?: Target;
      model?: string;
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
    if (args.action === "off") {
      delete config.model;
      config.disabled = true;
    } else {
      const value = args.model?.trim() ?? "",
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
        "Inspect or set this lead session's summary model, or defaults for future member sessions. target=lead/member; action=status/set/off. Configured provider/model-id only; scopes remain separate. This does not compact history or alter the main inference model.",
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
    try {
      const spec = specOf(ctx);
      if (!spec) return;
      debug(ctx, "compact:start", spec);
      const p = event.preparation;
      const summary = await run(
        [...p.messagesToSummarize, ...p.turnPrefixMessages],
        p.previousSummary,
        event.customInstructions,
        ctx,
        event.signal,
      );
      if (!summary) throw new Error("No summary produced");
      debug(ctx, "compact:success", spec);
      return {
        compaction: {
          summary,
          firstKeptEntryId: p.firstKeptEntryId,
          tokensBefore: p.tokensBefore,
        },
      };
    } catch (error) {
      debug(ctx, "compact:failed");
      ctx.ui.notify(
        `Custom compaction stopped: ${String((error as Error).message)}. Original history and completed chunks are retained; no default fallback request was sent.`,
        "error",
      );
      return { cancel: true };
    }
  });
  pi.on("session_before_tree", async (event, ctx) => {
    if (!event.preparation.userWantsSummary) return;
    try {
      const spec = specOf(ctx);
      if (!spec) return;
      const preparation = prepareBranchEntries(
        event.preparation.entriesToSummarize,
        16384,
      );
      const summary = await run(
        preparation.messages,
        undefined,
        event.preparation.customInstructions,
        ctx,
        event.signal,
      );
      if (!summary) throw new Error("No branch summary");
      return { summary: { summary } };
    } catch (error) {
      ctx.ui.notify(
        `Branch summary stopped; history retained: ${String(error)}`,
        "error",
      );
      return { cancel: true };
    }
  });
}
