import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import {
  getAgentDir,
  serializeConversation,
  convertToLlm,
  prepareBranchEntries,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { summarizeChunks } from "../../runtime/summarize.ts";

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
  const debug = (ctx: any, stage: string, model?: string) => {
    if (!process.env.PI_COMPACTION_DEBUG) return;
    try {
      const directory = path.dirname(
        resolveConfig(ctx, memberRuntime() ? "member" : "lead").file,
      );
      fs.mkdirSync(directory, { recursive: true });
      fs.appendFileSync(
        path.join(directory, "compaction-summary.log"),
        JSON.stringify({ at: new Date().toISOString(), stage, model }) + "\n",
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
    const maxTokens = Math.min(
      config.maxTokens ?? 4096,
      model.maxTokens,
      Math.floor(model.contextWindow / 4),
    );
    if (!Number.isSafeInteger(maxTokens) || maxTokens < 256)
      throw new Error("Invalid summary maxTokens");
    const maxInputChars = Math.min(
      config.maxInputChars ?? 24000,
      Math.floor((model.contextWindow - maxTokens - 1024) / 4),
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
      maxOutputChars: Math.min(12000, Math.floor((maxInputChars - 512) / 2)),
      signal,
      complete: (prompt) =>
        ctx.modelRegistry.complete(
          model,
          {
            messages: [
              {
                role: "user",
                content: [{ type: "text", text: prompt }],
                timestamp: Date.now(),
              },
            ],
          },
          {
            maxTokens,
            signal,
            cacheRetention: "none",
            sessionId: createHash("sha256")
              .update(prompt)
              .digest("hex")
              .slice(0, 32),
          },
        ),
    });
  }
  pi.registerCommand("compaction-model", {
    description:
      "Set the summary model for this lead/member conversation or the lead's future subagents. Use lead/member provider/model-id, off, or status.",
    handler: async (args, ctx) => {
      try {
        const tokens = args.trim().split(/\s+/).filter(Boolean);
        let target: Target = memberRuntime() ? "member" : "lead";
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
        if (memberRuntime() && target === "lead")
          throw new Error("A member can only change its own compaction model");
        const value = tokens.join(" ");
        const resolved = resolveConfig(ctx, target);
        if (!value || value === "status") {
          const report = (scope: Target) => {
            const r = resolveConfig(ctx, scope);
            return {
              target: scope,
              model: specOf(ctx, scope) ?? "Pi default",
              maxTokens: r.config.maxTokens ?? 4096,
              maxInputChars: r.config.maxInputChars ?? 24000,
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
          };
          ctx.ui.notify(
            JSON.stringify(
              memberRuntime()
                ? report("member")
                : { lead: report("lead"), member: report("member") },
            ),
            "info",
          );
          return;
        }
        const config = { ...resolved.config };
        if (value === "off") {
          delete config.model;
          config.disabled = true;
        } else {
          const slash = value.indexOf("/");
          if (
            slash < 1 ||
            !ctx.modelRegistry.find(
              value.slice(0, slash),
              value.slice(slash + 1),
            )
          )
            throw new Error("Summary model is not configured in Pi");
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
        ctx.ui.notify(
          target === "member"
            ? "Member compaction model updated for future subagent sessions"
            : "Lead compaction model updated for this conversation",
          "info",
        );
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
