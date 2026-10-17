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
}
export default function (pi: ExtensionAPI) {
  const file = path.join(getAgentDir(), "compaction-summary.json");
  const read = (): Config => {
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
      return value;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
      throw error;
    }
  };
  const specOf = (config: Config) =>
    process.env.PI_COMPACTION_SUMMARY_MODEL?.trim() || config.model?.trim();
  const debug = (stage: string, model?: string) => {
    if (!process.env.PI_COMPACTION_DEBUG) return;
    try {
      fs.appendFileSync(
        path.join(getAgentDir(), "compaction-summary.log"),
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
    const config = read(),
      spec = specOf(config);
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
      directory: path.join(getAgentDir(), "mission-control", "summary-cache"),
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
      "Independent summary model: provider/model-id, off, or status. Requests are chunked; failures retain history and cached completed chunks.",
    handler: async (args, ctx) => {
      try {
        const value = args.trim();
        const config = read();
        if (!value || value === "status") {
          ctx.ui.notify(
            JSON.stringify({
              model: specOf(config) ?? "Pi default",
              maxTokens: config.maxTokens ?? 4096,
              maxInputChars: config.maxInputChars ?? 24000,
              source: process.env.PI_COMPACTION_SUMMARY_MODEL?.trim()
                ? "environment"
                : config.model
                  ? "config file"
                  : "Pi default",
            }),
            "info",
          );
          return;
        }
        if (value === "off") delete config.model;
        else {
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
        }
        fs.mkdirSync(path.dirname(file), { recursive: true });
        const tmp = file + "." + randomUUID() + ".tmp";
        fs.writeFileSync(tmp, JSON.stringify(config, null, 2) + "\n", {
          mode: 0o600,
        });
        fs.renameSync(tmp, file);
        ctx.ui.notify(
          process.env.PI_COMPACTION_SUMMARY_MODEL?.trim()
            ? "Saved summary model; PI_COMPACTION_SUMMARY_MODEL still overrides the file until that environment variable is changed or removed"
            : "Summary model updated",
          "info",
        );
      } catch (error) {
        ctx.ui.notify(String(error), "error");
      }
    },
  });
  pi.on("session_before_compact", async (event, ctx) => {
    try {
      const spec = specOf(read());
      if (!spec) return;
      debug("compact:start", spec);
      const p = event.preparation;
      const summary = await run(
        [...p.messagesToSummarize, ...p.turnPrefixMessages],
        p.previousSummary,
        event.customInstructions,
        ctx,
        event.signal,
      );
      if (!summary) throw new Error("No summary produced");
      debug("compact:success", spec);
      return {
        compaction: {
          summary,
          firstKeptEntryId: p.firstKeptEntryId,
          tokensBefore: p.tokensBefore,
        },
      };
    } catch (error) {
      debug("compact:failed");
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
      const spec = specOf(read());
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
