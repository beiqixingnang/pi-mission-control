import path from "node:path";
import { Type } from "typebox";
import {
  getAgentDir,
  findCutPoint,
  SettingsManager,
  type SessionBoundaryDraft,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import {
  ContextMemory,
  NOTE_LIMITS,
  appendContextHint,
  indexAlreadyIncluded,
  type ContextMode,
} from "../../runtime/context-memory.ts";
import {
  contextBudget,
  contextBudgetKey,
  rejectedContextBudget,
  type ContextBudgetPolicy,
} from "../../runtime/context-budget.ts";
import { contextLimitError } from "../../runtime/reconnect.ts";
import { estimateSummaryTokens } from "../../runtime/summarize.ts";

const MEMORY_TOOLS = new Set([
  "context_mode",
  "context_note",
  "context_history",
  "context_rollover",
]);
const REPAIR_TURNS = 8;
interface RepairState {
  window: string;
  turns: number;
  reminders: number;
  phase: "preparing" | "exhausted" | "paused";
  reason: string;
}

/** Standalone conversation memory: no Mission Control store or task/goal API dependency. */
export function installContextMemory(pi: ExtensionAPI) {
  let memory: ContextMemory | undefined,
    identity = "",
    pending = false,
    repair: RepairState | undefined,
    lastRequestTokens = 0,
    needsRepair = "";
  const open = (ctx: any) => {
    const id = ctx.sessionManager.getSessionId();
    if (!/^[a-zA-Z0-9_-]{1,120}$/.test(id ?? ""))
      throw Error("No valid Pi conversation identity");
    if (identity !== id || !memory) {
      memory?.close();
      identity = id;
      memory = new ContextMemory(
        path.join(getAgentDir(), "context-memory", id),
        id,
      );
    }
    // Optional standalone host defaults, also usable without Mission Control.
    // Explicit per-session choices always win; no other plugin database is read.
    const defaults = JSON.parse(process.env.PI_CONTEXT_DEFAULTS ?? "{}");
    if (
      defaults.mode !== undefined &&
      !["notes", "summary"].includes(defaults.mode)
    )
      throw Error("Invalid PI_CONTEXT_DEFAULTS mode");
    if (
      defaults.inputLimitTokens !== undefined &&
      (!Number.isSafeInteger(defaults.inputLimitTokens) ||
        defaults.inputLimitTokens < 1024 ||
        defaults.inputLimitTokens > 10000000)
    )
      throw Error("Invalid PI_CONTEXT_DEFAULTS inputLimitTokens");
    const key = contextBudgetKey(ctx.model),
      saved = JSON.parse(memory.setting(key, "{}"));
    if (
      (defaults.mode || defaults.inputLimitTokens) &&
      !memory.setting("host-defaults:" + key, "")
    ) {
      if (!memory.setting("mode", "") && defaults.mode)
        memory.setMode(defaults.mode);
      if (defaults.inputLimitTokens && saved.inputLimitTokens === undefined) {
        saved.inputLimitTokens = defaults.inputLimitTokens;
        memory.setSetting(key, JSON.stringify(saved));
      }
      memory.setSetting("host-defaults:" + key, "applied");
    }
    return memory;
  };
  const result = (value: any) => ({
    content: [{ type: "text" as const, text: JSON.stringify(value) }],
    details: undefined,
  });
  const branch = (ctx: any) => ctx.sessionManager.getBranch();
  const policy = (ctx: any): ContextBudgetPolicy =>
    JSON.parse(open(ctx).setting(contextBudgetKey(ctx.model), "{}"));
  const budget = (ctx: any) => contextBudget(ctx.model, policy(ctx));
  const windowId = (ctx: any) => {
    const entries = branch(ctx);
    return `${contextBudgetKey(ctx.model)}:${entries.findLast((e: any) => e.type === "compaction")?.id ?? entries[0]?.id ?? "empty"}`;
  };
  const saveRepair = (ctx: any) =>
    open(ctx).setSetting("repair", JSON.stringify(repair ?? null));
  const usage = (ctx: any, messages?: any[]) => {
    const value = ctx.getContextUsage()?.tokens;
    return value != null && Number.isFinite(value)
      ? { tokens: value, source: "Pi usage-backed estimate" }
      : messages
        ? {
            tokens: messages.reduce(
              (n, m) =>
                n + estimateSummaryTokens(JSON.stringify(m.content ?? "")),
              0,
            ),
            source: "message-size estimate; provider usage unavailable",
          }
        : { tokens: null, source: "unknown" };
  };
  const repairDraft = (reason: string): SessionBoundaryDraft => ({
    type: "custom_message",
    customType: "context-memory-prepare",
    content: `Context memory needs a safe handoff before more project work. ${reason} Save concise notes named exactly index and handoff in ONE context_note write batch, then CALL context_rollover. Preserve corrected identifiers, unresolved issues, exact file/line position, completed versus pending work and the next operation. Reference topic note names/history IDs for detail. This is memory maintenance, not task completion. Do not start another large read or claim that saying ready changes the window.`,
    display: false,
  });
  const startRepair = (ctx: any, reason: string) => {
    const window = windowId(ctx);
    if (repair?.window === window) return false;
    repair = { window, turns: 0, reminders: 0, phase: "preparing", reason };
    saveRepair(ctx);
    return true;
  };
  const mayRepair = (ctx: any, messages?: any[]) => {
    const b = budget(ctx),
      u = usage(ctx, messages);
    return (
      u.tokens != null &&
      b.inputLimitTokens > 0 &&
      u.tokens < b.repairBelowTokens
    );
  };
  const warnStopped = (ctx: any, reason: string) => {
    ctx.ui.notify(
      `Notes preparation stopped: ${reason}. Original history retained. Inspect /context status; after resolving the cause save index/handoff and retry, or explicitly select summary mode.`,
      "error",
    );
  };
  const status = (ctx: any) => {
    const m = open(ctx);
    return {
      mode: m.mode,
      notes: m.list(),
      limits: NOTE_LIMITS,
      storage:
        "this extension's own per-Pi-session database; no goal/task databases read",
      rolloverQueued: pending,
      budget: budget(ctx),
      usage: usage(ctx),
      preparation: repair?.window === windowId(ctx) ? repair : undefined,
    };
  };
  pi.on("session_start", (_event, ctx) => {
    pending = false;
    open(ctx);
    repair = JSON.parse(open(ctx).setting("repair", "null")) ?? undefined;
    needsRepair = "";
    lastRequestTokens = 0;
  });
  pi.on("session_shutdown", () => {
    pending = false;
    memory?.close();
    memory = undefined;
    identity = "";
    repair = undefined;
    needsRepair = "";
  });
  pi.registerTool({
    name: "context_mode",
    label: "Context mode",
    description:
      "Inspect or select summary/notes mode for this Pi conversation. Optional inputLimitTokens sets a conservative local input ceiling for this model route (0 resets the explicit override); it does not change the provider limit or Pi settings. Notes mode needs saved index and handoff notes; no goal/task plugin is consulted.",
    parameters: Type.Object({
      mode: Type.Optional(
        Type.Union([Type.Literal("summary"), Type.Literal("notes")]),
      ),
      inputLimitTokens: Type.Optional(
        Type.Integer({ minimum: 0, maximum: 10000000 }),
      ),
    }),
    async execute(_id, args, signal, _update, ctx) {
      signal?.throwIfAborted();
      if (args.mode && args.mode !== open(ctx).mode) {
        open(ctx).setMode(args.mode);
        pending = false;
        repair = undefined;
        needsRepair = "";
        saveRepair(ctx);
      }
      if (args.inputLimitTokens !== undefined) {
        if (args.inputLimitTokens !== 0 && args.inputLimitTokens < 1024)
          throw Error("inputLimitTokens must be 0 or at least 1024");
        const value = policy(ctx);
        if (args.inputLimitTokens)
          value.inputLimitTokens = args.inputLimitTokens;
        else delete value.inputLimitTokens;
        open(ctx).setSetting(
          contextBudgetKey(ctx.model),
          JSON.stringify(value),
        );
      }
      return result(status(ctx));
    },
  });
  pi.registerTool({
    name: "context_note",
    label: "Context notes",
    description:
      "Maintain this conversation's public working notes. action write/read/list. Prefer notes:[{name,text,expectedRevision}] to save index/handoff/topics atomically in one write; identical text keeps its version. index <=1500 estimated tokens, handoff <=4000, topics <=8000. Keep handoff concise: exact constraints, current file/line, corrected findings, uncertainty and next step; put detail in named topics/history IDs. Current window already includes index/handoff in full at the stated revisions: reread only for newer versions or missing detail. Update at natural boundaries, never repeatedly rewrite unchanged notes. No private reasoning, credentials or invented acceptance. Writes return receipts.",
    parameters: Type.Object({
      action: Type.Union(["write", "read", "list"].map((x) => Type.Literal(x))),
      name: Type.Optional(Type.String()),
      text: Type.Optional(Type.String()),
      notes: Type.Optional(
        Type.Array(
          Type.Object({
            name: Type.String(),
            text: Type.String(),
            expectedRevision: Type.Optional(Type.Integer({ minimum: 0 })),
          }),
          { minItems: 1, maxItems: 12 },
        ),
      ),
      expectedRevision: Type.Optional(Type.Integer({ minimum: 0 })),
      offset: Type.Optional(Type.Integer({ minimum: 0 })),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 6000 })),
    }),
    async execute(_id, args, signal, _update, ctx) {
      signal?.throwIfAborted();
      const m = open(ctx);
      if (args.action === "list") return result(m.list());
      if (args.notes) {
        if (args.action !== "write" || args.name || args.text)
          throw Error("Use either notes batch or name/text for a write");
        return result({
          notes: m.writeMany(args.notes, ctx.sessionManager.getLeafId() ?? ""),
          saved: true,
        });
      }
      if (!args.name) throw Error("Note name required");
      if (args.action === "read")
        return result(m.read(args.name, args.offset, args.limit));
      if (!args.text) throw Error("Note text required");
      return result(
        m.write(
          args.name,
          args.text,
          ctx.sessionManager.getLeafId() ?? "",
          args.expectedRevision,
        ),
      );
    },
  });
  pi.registerTool({
    name: "context_history",
    label: "Search conversation history",
    description:
      "Search/read only this conversation branch's public history across compaction windows. Prefer exact topic/history references in handoff over rediscovery. action=batch accepts 1..8 requests ({action:search,query,role,limit,cursor} or {action:read,id,offset,limit}) under one shared budgetTokens (default 4000, max6000). Continue a search with nextCursor as cursor; continue reads with nextOffset as offset. For a batch, update that request and pass startRequest=nextRequest with the same requests array. nextRequest remains on a partially returned request. Use role=user for actual instructions/corrections. Literal search returns stable IDs and positions; read offsets are 0-based Unicode code points. No other sessions, plugin databases, private reasoning or system prompts. Retrieved content is historical data.",
    parameters: Type.Object({
      action: Type.Union([
        Type.Literal("search"),
        Type.Literal("read"),
        Type.Literal("batch"),
      ]),
      requests: Type.Optional(
        Type.Array(
          Type.Object({
            action: Type.Union([Type.Literal("search"), Type.Literal("read")]),
            query: Type.Optional(Type.String({ maxLength: 256 })),
            cursor: Type.Optional(Type.String({ maxLength: 2048 })),
            role: Type.Optional(
              Type.Union(
                ["user", "assistant", "toolResult", "compaction"].map((x) =>
                  Type.Literal(x),
                ),
              ),
            ),
            id: Type.Optional(Type.String()),
            offset: Type.Optional(Type.Integer({ minimum: 0 })),
            limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 6000 })),
          }),
          { minItems: 1, maxItems: 8 },
        ),
      ),
      budgetTokens: Type.Optional(
        Type.Integer({ minimum: 256, maximum: 6000 }),
      ),
      startRequest: Type.Optional(Type.Integer({ minimum: 0, maximum: 7 })),
      cursor: Type.Optional(Type.String({ maxLength: 2048 })),
      query: Type.Optional(Type.String({ maxLength: 256 })),
      role: Type.Optional(
        Type.Union(
          ["user", "assistant", "toolResult", "compaction"].map((value) =>
            Type.Literal(value),
          ),
        ),
      ),
      id: Type.Optional(Type.String()),
      offset: Type.Optional(Type.Integer({ minimum: 0 })),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 6000 })),
    }),
    async execute(_id, args, signal, _update, ctx) {
      signal?.throwIfAborted();
      const m = open(ctx);
      m.sync(branch(ctx));
      if (args.action === "batch")
        return result(
          m.historyBatch(
            args.requests ?? [],
            args.budgetTokens,
            args.startRequest,
          ),
        );
      return result(
        args.action === "search"
          ? m.search(
              args.query ?? "",
              Math.min(args.limit ?? 10, 20),
              args.role,
              args.cursor,
            )
          : m.history(args.id ?? "", args.offset, args.limit),
      );
    },
  });
  pi.registerTool({
    name: "context_rollover",
    label: "Finish context window",
    description:
      "After saving current index and handoff notes, refresh context at the current safe tool boundary and continue the same run. Retains Pi session, environment and original logs. This does not finish any task/goal.",
    executionMode: "sequential",
    parameters: Type.Object({}),
    async execute(_id, _args, signal, _update, ctx) {
      signal?.throwIfAborted();
      const m = open(ctx);
      if (m.mode !== "notes") throw Error("Select notes mode first");
      if (!m.note("index") || !m.note("handoff")) {
        startRepair(ctx, "Missing required index or handoff note.");
        throw Error(
          "Save notes named exactly index and handoff, then call context_rollover. Original history is retained.",
        );
      }
      pending = true;
      return { ...result({ queued: true }), terminate: true };
    },
  });
  pi.on("turn_end", (event, ctx) => {
    const m = open(ctx);
    if (m.mode !== "notes") return;
    if (event.outcome === "aborted" || ctx.signal?.aborted) {
      pending = false;
      if (repair) {
        repair.phase = "paused";
        saveRepair(ctx);
      }
      return;
    }
    if (event.outcome === "error") {
      pending = false;
      return;
    }
    const active =
      repair?.window === windowId(ctx) && repair.phase === "preparing";
    if (active) {
      repair!.turns++;
      saveRepair(ctx);
    }
    if (pending) {
      pending = false;
      try {
        // Use Pi's projected branch and native cut-point algorithm, keeping complete tool pairs.
        // SettingsManager only reads the host's compaction settings; it never reads another plugin's data.
        const entries = branch(ctx),
          projected = event.context.contextEntries.map((e) => e.sourceEntry);
        const native = SettingsManager.create(ctx.cwd, getAgentDir(), {
          projectTrusted: ctx.isProjectTrusted(),
        }).getCompactionSettings(ctx.model);
        const start = projected[0]?.type === "compaction" ? 1 : 0;
        const cut = findCutPoint(
          projected,
          start,
          projected.length,
          native.keepRecentTokens,
        );
        const firstKept = projected[cut.firstKeptEntryIndex]?.id;
        if (!firstKept) throw Error("No safe tool boundary available");
        const prepared = m.prepare(entries, firstKept);
        repair = undefined;
        needsRepair = "";
        saveRepair(ctx);
        return {
          entries: [
            ...event.entries,
            {
              type: "compaction" as const,
              ...prepared,
              details: { ...prepared.details, boundary: true },
            },
            {
              type: "custom_message" as const,
              customType: "context-memory-resume",
              content:
                "The notes context window has been refreshed. Continue the latest user request from the saved handoff. Retrieve older facts with context_history when needed.",
              display: false,
            },
          ],
          continue: true,
        };
      } catch (error) {
        const reason = String((error as Error).message);
        if (!mayRepair(ctx, event.context.contextMessages)) {
          warnStopped(ctx, reason);
          return;
        }
        startRepair(ctx, reason);
        if (repair?.phase === "preparing" && repair.reminders < 2) {
          repair.reminders++;
          saveRepair(ctx);
          return {
            entries: [...event.entries, repairDraft(reason)],
            continue: true,
          };
        }
        warnStopped(ctx, reason);
      }
    }
    if (repair?.window === windowId(ctx)) {
      if (repair.phase !== "preparing") return;
      if (repair.turns >= REPAIR_TURNS) {
        repair.phase = "exhausted";
        saveRepair(ctx);
        warnStopped(
          ctx,
          `the ${REPAIR_TURNS}-turn preparation allowance was exhausted`,
        );
        return;
      }
      if (
        event.message.role === "assistant" &&
        event.message.stopReason === "stop" &&
        repair.reminders < 2
      ) {
        repair.reminders++;
        saveRepair(ctx);
        return {
          entries: [...event.entries, repairDraft(repair.reason)],
          continue: true,
        };
      }
      if (
        event.message.role === "assistant" &&
        event.message.stopReason === "stop"
      ) {
        repair.phase = "exhausted";
        saveRepair(ctx);
        warnStopped(ctx, "two repair reminders did not produce a rollover");
      }
      return;
    }
    const b = budget(ctx),
      u = usage(ctx, event.context.contextMessages);
    if (
      event.toolResults.length &&
      u.tokens != null &&
      u.tokens >= b.prepareAtTokens &&
      b.inputLimitTokens > 0
    ) {
      startRepair(
        ctx,
        `Local context estimate ${u.tokens} tokens reached the ${b.prepareAtTokens}-token preparation threshold; local input budget ${b.inputLimitTokens}.`,
      );
      return {
        entries: [...event.entries, repairDraft(repair!.reason)],
        continue: true,
      };
    }
  });
  pi.on("agent_before_settle", (event, ctx) => {
    if (
      !needsRepair ||
      event.outcome !== "completed" ||
      ctx.signal?.aborted ||
      open(ctx).mode !== "notes"
    )
      return;
    const reason = needsRepair;
    needsRepair = "";
    if (
      mayRepair(ctx, event.context.contextMessages) &&
      startRepair(ctx, reason)
    )
      return {
        entries: [...event.entries, repairDraft(reason)],
        continue: true,
      };
    warnStopped(ctx, reason);
  });
  pi.on("tool_call", (event, ctx) => {
    if (open(ctx).mode !== "notes" || repair?.window !== windowId(ctx)) return;
    if (repair.phase === "exhausted")
      return {
        block: true,
        terminate: true,
        reason:
          "Context note preparation allowance exhausted; original history retained. Start a fresh user run after inspecting /context status.",
      };
    if (repair.phase === "preparing" && !MEMORY_TOOLS.has(event.toolName))
      return {
        block: true,
        reason:
          "This tool was not executed and nothing was recorded. Save index/handoff notes with this exact operation still pending, call context_rollover, then retry it. The context window needs room before more project tools.",
      };
  });
  pi.on("message_end", (event, ctx) => {
    const message = event.message;
    if (message.role !== "assistant") return;
    if (
      open(ctx).mode === "notes" &&
      repair?.window === windowId(ctx) &&
      repair.phase === "preparing" &&
      message.stopReason !== "error" &&
      message.stopReason !== "aborted"
    ) {
      const completing = message.content.some(
        (block) =>
          block.type === "toolCall" && block.name === "context_rollover",
      );
      if (
        (repair.turns >= REPAIR_TURNS - 1 && !completing) ||
        (message.stopReason === "stop" && repair.reminders >= 2)
      ) {
        repair.phase = "exhausted";
        saveRepair(ctx);
        const reason =
          "Context note preparation allowance exhausted; original history retained. Inspect /context status and repair the saved notes before retrying. This task has not completed.";
        warnStopped(ctx, reason);
        // A local failure must reach RPC hosts as an error, not a successful empty member result.
        return {
          message: {
            ...message,
            content: [],
            stopReason: "error" as const,
            errorMessage: reason,
          },
        };
      }
    }
    if (
      message.stopReason !== "error" ||
      /\b429\b|rate.?limit|too many requests|tokens per (?:min|minute)|\btpm\b|quota/i.test(
        message.errorMessage ?? "",
      ) ||
      !contextLimitError(message.errorMessage ?? "")
    )
      return;
    const before = policy(ctx),
      after = rejectedContextBudget(
        before,
        lastRequestTokens,
        String(message.timestamp),
      );
    if (after !== before)
      open(ctx).setSetting(contextBudgetKey(ctx.model), JSON.stringify(after));
  });
  pi.on("session_tree", (_event, ctx) => {
    pending = false;
    repair = undefined;
    needsRepair = "";
    saveRepair(ctx);
  });
  pi.on("agent_settled", (event, ctx) => {
    pending = false;
    if (event.aborted && repair) {
      repair.phase = "paused";
      saveRepair(ctx);
    }
  });
  pi.on("before_agent_start", (event, ctx) => {
    const m = open(ctx);
    // A new user run may repair an exhausted/cancelled preparation. Reload alone does not renew it.
    if (
      event.messageType === "user" &&
      repair &&
      repair.phase !== "preparing"
    ) {
      repair = undefined;
      saveRepair(ctx);
    }
    if (m.mode === "notes")
      event.systemPromptOptions.promptGuidelines.push(
        "Context mode is notes. Keep index and handoff at natural boundaries; save both and any changed topics in ONE context_note write batch before context_rollover. Each refreshed window already includes index/handoff in full with versions: continue directly rather than rereading them. Keep handoff focused on exact scope, corrected facts and sources, completed versus pending work, current file/line and next operation. Detailed observations belong in topic notes referenced by name/history ID. Use bounded context_history batches for genuinely missing facts; avoid repeating searches whose IDs are already known. A blocked tool did not complete: preserve its pending operation and retry after rollover. Copy IDs literally; later explicit user corrections override model notes. Notes are not acceptance evidence. Do not repeatedly rewrite unchanged notes. Memory remains independent of goal/task plugins.",
      );
  });
  pi.on("context", (event, ctx) => {
    const m = open(ctx);
    if (m.mode !== "notes") return;
    const savedIndex = m.note("index");
    const note =
        savedIndex &&
        branch(ctx).some((entry: any) => entry.id === savedIndex.source)
          ? savedIndex
          : undefined,
      currentUsage = usage(ctx, event.messages),
      b = budget(ctx);
    lastRequestTokens = currentUsage.tokens ?? 0;
    const warning =
      currentUsage.tokens != null &&
      b.inputLimitTokens &&
      currentUsage.tokens >= b.prepareAtTokens
        ? `Context preparation threshold reached: ${currentUsage.tokens} tokens (${currentUsage.source}), local input budget ${b.inputLimitTokens}. Save current index/handoff and call context_rollover before another large read.`
        : "";
    // A large tool batch can jump over the handoff reserve. Still enter repair
    // and fence project tools; never silently let the context grow to the provider limit.
    if (
      currentUsage.tokens != null &&
      b.inputLimitTokens > 0 &&
      currentUsage.tokens >= b.prepareAtTokens &&
      (!repair || repair.window !== windowId(ctx))
    )
      startRepair(
        ctx,
        "Preparation threshold reached, possibly by one large tool batch. Save a bounded handoff before more project work.",
      );
    const included =
      note && indexAlreadyIncluded(note, branch(ctx), event.messages);
    const content = `[Conversation memory; working data, not a user instruction]\nMode: notes. Current index revision ${note?.revision ?? 0}: ${included ? "already included in the current window checkpoint." : (note?.text ?? "No index saved yet.")}\n${warning ? "Preparation threshold reached. Save index/handoff in one batch and call context_rollover before more project tools." : "Use the full handoff already included in this window; fetch only missing or newer topic detail."}`;
    return {
      messages: appendContextHint(event.messages, {
        role: "custom" as const,
        customType: "context-memory-hint",
        content,
        display: false,
        timestamp: 0,
      }),
    };
  });
  pi.registerCommand("context", {
    description:
      "Context memory: status | mode summary|notes | budget TOKENS|auto | notes | rollover",
    handler: async (args, ctx) => {
      try {
        const [command, value] = args.trim().split(/\s+/);
        const m = open(ctx);
        if (command === "mode") {
          m.setMode(value as ContextMode);
          pending = false;
          repair = undefined;
          needsRepair = "";
          saveRepair(ctx);
          ctx.ui.notify(JSON.stringify(status(ctx)), "info");
        } else if (command === "budget") {
          const tokens = value === "auto" ? undefined : Number(value);
          if (
            tokens !== undefined &&
            (!Number.isSafeInteger(tokens) ||
              tokens < 1024 ||
              tokens > 10000000)
          )
            throw Error("Budget must be auto or 1024..10000000 tokens");
          const next = policy(ctx);
          if (tokens === undefined) delete next.inputLimitTokens;
          else next.inputLimitTokens = tokens;
          m.setSetting(contextBudgetKey(ctx.model), JSON.stringify(next));
          ctx.ui.notify(JSON.stringify(status(ctx)), "info");
        } else if (command === "rollover") {
          if (!ctx.isIdle())
            throw Error("Wait for the current model/tool run to settle");
          if (m.mode !== "notes") throw Error("Select notes mode first");
          ctx.compact();
        } else
          ctx.ui.notify(
            JSON.stringify(
              command === "notes" ? m.list() : status(ctx),
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
  return {
    status,
    prepare: (event: any, ctx: any) => {
      const m = open(ctx);
      if (m.mode !== "notes") return;
      let prepared;
      try {
        prepared = m.prepare(
          event.branchEntries ?? branch(ctx),
          event.preparation.firstKeptEntryId,
        );
      } catch (error) {
        if (event.signal?.aborted) return { cancel: true };
        // Repair only while the smaller request still has room. Never resend a rejected full window.
        needsRepair =
          event.reason === "threshold" ? String((error as Error).message) : "";
        if (!needsRepair || event.reason === "manual")
          warnStopped(ctx, String((error as Error).message));
        return { cancel: true };
      }
      return {
        compaction: {
          ...prepared,
          tokensBefore: event.preparation.tokensBefore,
          details: prepared.details,
        },
      };
    },
  };
}
