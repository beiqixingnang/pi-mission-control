import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { hostDir } from "../../scripts/host.mjs";
import {
  contextBudget,
  contextBudgetKey,
  rejectedContextBudget,
} from "../../runtime/context-budget.ts";

test("context budgets reserve output and handoff room, honor lower ceilings and never infer an exact provider limit", () => {
  const model = {
    provider: "route",
    id: "luna",
    contextWindow: 1050000,
    maxTokens: 128000,
  };
  const b = contextBudget(model);
  assert.equal(b.inputLimitTokens, 889232);
  assert.ok(b.prepareAtTokens < b.repairBelowTokens);
  assert.ok(b.repairBelowTokens < b.inputLimitTokens);
  assert.equal(
    contextBudget(model, { inputLimitTokens: 800000 }).inputLimitTokens,
    800000,
  );
  assert.equal(
    contextBudget(model, { inputLimitTokens: 2000000 }).inputLimitTokens,
    b.inputLimitTokens,
  );
  const learned = rejectedContextBudget({}, 950000, "request1");
  assert.equal(learned.learnedLimitTokens, 807500);
  assert.equal(rejectedContextBudget(learned, 950000, "request1"), learned);
  assert.equal(contextBudget(model, learned).inputLimitTokens, 807500);
  assert.notEqual(
    contextBudgetKey({ ...model, baseUrl: "https://route-a" }),
    contextBudgetKey({ ...model, baseUrl: "https://route-b" }),
  );
  assert.equal(contextBudget().inputLimitTokens, 0);
  assert.ok(
    contextBudget({ contextWindow: 1000, maxTokens: 100000 })
      .inputLimitTokens >= 0,
  );
});

const entry = (id, text, role = "user") => ({
  id,
  type: "message",
  message: { role, content: [{ type: "text", text }] },
});
async function harness(fn) {
  const { loadExtensions, createExtensionRuntime } = await import(
    pathToFileURL(path.join(hostDir, "dist/core/extensions/loader.js"))
  );
  const { createEventBus } = await import(
    pathToFileURL(path.join(hostDir, "dist/core/event-bus.js"))
  );
  const loaded = await loadExtensions(
    [path.resolve("extensions/mission-control/compaction.ts")],
    process.cwd(),
    createEventBus(),
    createExtensionRuntime(),
  );
  assert.deepEqual(loaded.errors, []);
  const extension = loaded.extensions[0],
    cwd = fs.mkdtempSync(path.join(os.tmpdir(), "context-policy-")),
    notifications = [];
  let entries = [entry("a", "initial objective")],
    tokens = 10000;
  const ctx = {
    cwd,
    signal: undefined,
    isProjectTrusted: () => false,
    sessionManager: {
      getSessionId: () => "budget-" + path.basename(cwd),
      getBranch: () => entries,
      getLeafId: () => entries.at(-1)?.id,
    },
    getContextUsage: () => ({ tokens }),
    model: {
      provider: "fixture",
      id: "model",
      contextWindow: 64000,
      maxTokens: 4096,
    },
    isIdle: () => true,
    ui: { notify: (...args) => notifications.push(args) },
  };
  const emit = async (type, event = {}) => {
    let result;
    for (const handle of extension.handlers.get(type) ?? [])
      result = await handle({ type, ...event }, ctx);
    return result;
  };
  const tool = (name, args = {}) =>
    extension.tools
      .get(name)
      .definition.execute(
        "id",
        args,
        new AbortController().signal,
        () => {},
        ctx,
      );
  const state = async () =>
    JSON.parse((await tool("context_mode")).content[0].text);
  const turn = (event = {}) =>
    emit("turn_end", {
      outcome: "completed",
      entries: [],
      toolResults: [{}],
      message: { role: "assistant", stopReason: "toolUse" },
      context: {
        contextEntries: entries.map((sourceEntry) => ({ sourceEntry })),
        contextMessages: entries.map((e) => e.message),
      },
      ...event,
    });
  await emit("session_start");
  try {
    await fn({
      ctx,
      emit,
      tool,
      state,
      turn,
      notifications,
      setEntries: (value) => (entries = value),
      setTokens: (value) => (tokens = value),
    });
  } finally {
    await emit("session_shutdown");
    fs.rmSync(cwd, { recursive: true, force: true });
  }
}

test("model-specific local budgets survive reload, learn only context failures and do not change on 429", () =>
  harness(async (h) => {
    await h.tool("context_mode", { mode: "notes", inputLimitTokens: 40000 });
    h.setTokens(39000);
    await h.emit("context", { messages: [] });
    await h.emit("message_end", {
      message: {
        role: "assistant",
        stopReason: "error",
        timestamp: 1,
        errorMessage: "429 Too many requests",
      },
    });
    assert.equal((await h.state()).budget.policy.learnedLimitTokens, undefined);
    await h.emit("message_end", {
      message: {
        role: "assistant",
        stopReason: "error",
        timestamp: 11,
        errorMessage: "429 TPM quota exceeded: too many tokens",
      },
    });
    assert.equal(
      (await h.state()).budget.policy.learnedLimitTokens,
      undefined,
      "a token-per-minute quota is not a context limit",
    );
    await h.emit("message_end", {
      message: {
        role: "assistant",
        stopReason: "error",
        timestamp: 2,
        errorMessage: "context_length_exceeded",
      },
    });
    const learned = (await h.state()).budget.inputLimitTokens;
    assert.equal(learned, 33150);
    await h.emit("session_shutdown");
    await h.emit("session_start");
    assert.equal((await h.state()).budget.inputLimitTokens, learned);
    h.ctx.model = { ...h.ctx.model, id: "other" };
    assert.equal((await h.state()).budget.inputLimitTokens, 56704);
    h.ctx.model = { ...h.ctx.model, id: "model" };
    await h.tool("context_mode", { inputLimitTokens: 0 });
    assert.equal(
      (await h.state()).budget.inputLimitTokens,
      learned,
      "resetting explicit ceiling cannot erase a learned rejection",
    );
  }));

test("standalone host defaults initialize a fresh member but explicit mode and auto-budget survive reload", () =>
  harness(async (h) => {
    const previous = process.env.PI_CONTEXT_DEFAULTS;
    try {
      await h.emit("session_shutdown");
      const id = "defaults-" + crypto.randomUUID();
      h.ctx.sessionManager.getSessionId = () => id;
      h.ctx.model = {
        ...h.ctx.model,
        contextWindow: 1050000,
        maxTokens: 128000,
      };
      process.env.PI_CONTEXT_DEFAULTS = JSON.stringify({
        mode: "notes",
        inputLimitTokens: 300000,
      });
      await h.emit("session_start");
      assert.equal((await h.state()).mode, "notes");
      assert.equal((await h.state()).budget.prepareAtTokens, 225000);
      await h.tool("context_mode", { mode: "summary", inputLimitTokens: 0 });
      await h.emit("session_shutdown");
      await h.emit("session_start");
      assert.equal((await h.state()).mode, "summary");
      assert.equal((await h.state()).budget.inputLimitTokens, 889232);
    } finally {
      if (previous === undefined) delete process.env.PI_CONTEXT_DEFAULTS;
      else process.env.PI_CONTEXT_DEFAULTS = previous;
    }
  }));

test("automatic handoff is bounded, deduplicated across reload and pauses on cancellation", () =>
  harness(async (h) => {
    await h.tool("context_mode", { mode: "notes", inputLimitTokens: 40000 });
    h.setTokens(31000);
    const first = await h.turn();
    assert.equal(first.continue, true);
    assert.equal(first.entries.length, 1);
    assert.match(first.entries[0].content, /Save concise notes/);
    assert.equal((await h.emit("tool_call", { toolName: "read" })).block, true);
    await h.turn();
    assert.equal((await h.state()).preparation.turns, 1);
    await h.emit("session_shutdown");
    await h.emit("session_start");
    assert.equal((await h.state()).preparation.phase, "preparing");
    assert.equal((await h.state()).preparation.turns, 1);
    assert.equal(
      await h.turn(),
      undefined,
      "unchanged tool turns do not append repeated reminders",
    );
    for (let i = 0; i < 6; i++) await h.turn();
    assert.equal((await h.state()).preparation.phase, "exhausted");
    assert.equal(
      (await h.emit("tool_call", { toolName: "context_note" })).terminate,
      true,
    );
    const count = h.notifications.length;
    for (let i = 0; i < 3; i++) await h.turn();
    assert.equal(h.notifications.length, count);
    await h.emit("before_agent_start", {
      messageType: "user",
      systemPromptOptions: { promptGuidelines: [] },
    });
    assert.equal((await h.state()).preparation, undefined);
    await h.turn();
    await h.turn({ outcome: "aborted" });
    assert.equal((await h.state()).preparation.phase, "paused");
  }));

test("one oversized read cannot skip handoff by jumping past its reserved interval", () =>
  harness(async (h) => {
    await h.tool("context_mode", { mode: "notes", inputLimitTokens: 40000 });
    h.setTokens(48000);
    const turn = await h.turn();
    assert.equal(turn.continue, true);
    assert.equal((await h.state()).preparation.phase, "preparing");
    assert.equal((await h.emit("tool_call", { toolName: "read" })).block, true);
    assert.equal(
      await h.emit("tool_call", { toolName: "context_note" }),
      undefined,
    );
    await h.emit("session_shutdown");
    await h.emit("session_start");
    assert.equal((await h.state()).preparation.phase, "preparing");
  }));

test("an existing over-budget notes session starts handoff before another project tool after reload", () =>
  harness(async (h) => {
    await h.tool("context_mode", { mode: "notes", inputLimitTokens: 40000 });
    h.setTokens(800000);
    await h.emit("context", {
      messages: [{ role: "user", content: "continue original task" }],
    });
    assert.equal(
      (await h.emit("tool_call", { toolName: "powershell" })).block,
      true,
    );
    assert.equal((await h.state()).preparation.phase, "preparing");
  }));

test("notes rollover is committed at the tool boundary with no intermediate task settlement and retains full tool pairs", () =>
  harness(async (h) => {
    await h.tool("context_mode", { mode: "notes" });
    h.setEntries([
      entry("old", "early history ".repeat(20000)),
      entry("user", "read decoder.ts"),
      {
        id: "call",
        type: "message",
        message: {
          role: "assistant",
          content: [
            {
              type: "toolCall",
              id: "read-1",
              name: "read",
              arguments: { path: "decoder.ts" },
            },
          ],
        },
      },
      {
        id: "result",
        type: "message",
        message: {
          role: "toolResult",
          toolCallId: "read-1",
          toolName: "read",
          content: [{ type: "text", text: "decoder evidence" }],
        },
      },
    ]);
    await h.tool("context_note", {
      action: "write",
      name: "index",
      text: "decoder review index",
    });
    await h.tool("context_note", {
      action: "write",
      name: "handoff",
      text: "next decoder.ts:173; not accepted",
    });
    const receipt = await h.tool("context_rollover");
    assert.equal(receipt.terminate, true);
    const boundary = await h.turn();
    assert.equal(boundary.continue, true);
    assert.equal(boundary.entries[0].type, "compaction");
    assert.notEqual(
      boundary.entries[0].firstKeptEntryId,
      "result",
      "never keep an orphan tool result",
    );
    assert.equal(boundary.entries[1].customType, "context-memory-resume");
    const found = JSON.parse(
      (
        await h.tool("context_history", {
          action: "search",
          query: "early history",
        })
      ).content[0].text,
    );
    assert.equal(found.matches[0].id, "old");
    await h.tool("context_rollover");
    await h.emit("session_shutdown");
    await h.emit("session_start");
    assert.equal(
      await h.turn(),
      undefined,
      "reload invalidates an uncommitted rollover",
    );
  }));

test("failed native notes compaction requests one safe repair; manual cancellation and overflow never replay a giant window", () =>
  harness(async (h) => {
    await h.tool("context_mode", { mode: "notes" });
    const compact = (reason) =>
      h.emit("session_before_compact", {
        reason,
        branchEntries: [entry("a", "initial objective")],
        preparation: { firstKeptEntryId: "a", tokensBefore: 10000 },
        signal: new AbortController().signal,
      });
    assert.equal((await compact("threshold")).cancel, true);
    const event = {
      outcome: "completed",
      entries: [],
      context: { contextMessages: [] },
    };
    assert.equal((await h.emit("agent_before_settle", event)).continue, true);
    assert.equal(await h.emit("agent_before_settle", event), undefined);
    await h.tool("context_mode", { mode: "summary" });
    await h.tool("context_mode", { mode: "notes" });
    await compact("overflow");
    assert.equal(await h.emit("agent_before_settle", event), undefined);
    await compact("manual");
    assert.equal(await h.emit("agent_before_settle", event), undefined);
    h.setTokens(56000);
    await compact("threshold");
    assert.equal(await h.emit("agent_before_settle", event), undefined);
  }));

test("missing-note retries and an uncooperative final response have a finite repair allowance", () =>
  harness(async (h) => {
    await h.tool("context_mode", { mode: "notes" });
    await assert.rejects(
      h.tool("context_rollover"),
      /Save notes named exactly/,
    );
    assert.equal((await h.state()).preparation.phase, "preparing");
    await h.tool("context_mode", { mode: "notes" });
    assert.equal(
      (await h.state()).preparation.phase,
      "preparing",
      "reselecting the same mode cannot silently renew the allowance",
    );
    const stopped = {
      toolResults: [],
      message: { role: "assistant", stopReason: "stop" },
    };
    assert.equal((await h.turn(stopped)).continue, true);
    assert.equal((await h.turn(stopped)).continue, true);
    assert.equal(await h.turn(stopped), undefined);
    assert.equal((await h.state()).preparation.phase, "exhausted");
    const count = h.notifications.length;
    await h.turn(stopped);
    assert.equal(
      h.notifications.length,
      count,
      "unchanged exhausted state is reported once",
    );
    await h.tool("context_mode", { mode: "summary" });
    assert.equal(await h.emit("tool_call", { toolName: "read" }), undefined);
  }));
