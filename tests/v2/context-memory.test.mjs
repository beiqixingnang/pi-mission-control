import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { ContextMemory, historyText } from "../../runtime/context-memory.ts";
import {
  summarizeChunks,
  estimateSummaryTokens,
} from "../../runtime/summarize.ts";
import { hostDir } from "../../scripts/host.mjs";

function usingMemory(run) {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "context-memory-test-"),
  );
  const memory = new ContextMemory(directory, "test");
  try {
    return run(memory, directory);
  } finally {
    memory.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
}
const entry = (id, text, role = "user") => ({
  id,
  type: "message",
  message: { role, content: [{ type: "text", text }] },
});

test("notes persist only the latest handoff, bound reads and reject stale revisions without truncation", () => {
  usingMemory((m, directory) => {
    m.setMode("notes");
    const receipt = m.write("handoff", "old handoff", "a", 0);
    assert.equal(receipt.revision, 1);
    assert.equal(
      receipt.text,
      undefined,
      "write receipts do not echo note content",
    );
    m.write("handoff", "latest handoff", "b", 1);
    assert.throws(
      () => m.write("handoff", "stale", "a", 1),
      /revision changed/,
    );
    assert.throws(
      () => m.write("handoff", "中文".repeat(3000), "b"),
      /No text was truncated/,
    );
    assert.equal(m.note("handoff").text, "latest handoff");
    assert.throws(() => m.write("../../escape", "data", "b"), /virtual note/);
    m.sync([entry("legacy-query", "derived old search index")]);
    m.db
      .prepare("DELETE FROM settings WHERE key='history-index-version'")
      .run();
    const reopened = new ContextMemory(directory, "test");
    try {
      assert.equal(reopened.mode, "notes");
      assert.equal(reopened.note("handoff").revision, 2);
      assert.throws(() => reopened.history("legacy-query"), /Unknown history/);
    } finally {
      reopened.close();
    }
    m.write("topic/unicode", "🙂中文abcdef".repeat(600), "b");
    const page = m.read("topic/unicode", 1, 6000);
    assert.ok(estimateSummaryTokens(page.text) <= 2000);
    assert.equal(page.text[0], "中");
    assert.equal(page.nextOffset, page.offset + Array.from(page.text).length);
  });
});

test("history search stays in the current branch, redacts private blocks and preserves public evidence", () => {
  usingMemory((m) => {
    const hidden = {
      id: "hidden",
      type: "custom",
      customType: "goal-ledger",
      data: "PRIVATE_DB",
    };
    const assistant = {
      id: "assistant",
      type: "message",
      message: {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "PRIVATE_THINKING" },
          { type: "text", text: "public outcome" },
          {
            type: "toolCall",
            name: "fixture",
            id: "call",
            arguments: { path: "decoder.py", apiKey: "PRIVATE_KEY" },
          },
        ],
      },
    };
    assert.equal(historyText(hidden), undefined);
    m.sync([entry("a", "old branch evidence"), assistant, hidden]);
    assert.equal(m.search("evidence").matches.length, 1);
    assert.doesNotMatch(m.history("assistant").text, /PRIVATE_|thinking/);
    assert.match(m.history("assistant").text, /decoder.py/);
    m.sync([entry("b", "current branch 中文 evidence 🙂中")]);
    assert.throws(() => m.history("a"), /Unknown history/);
    assert.equal(m.search("evidence").matches[0].id, "b");
    assert.equal(m.search("中文").matches[0].id, "b");
    assert.equal(m.search("🙂中").matches[0].id, "b");
    assert.equal(m.search("absent").matches.length, 0);
    m.sync([
      entry("original", "ORIGINAL_EVIDENCE_83"),
      {
        id: "query",
        type: "message",
        message: {
          role: "assistant",
          content: [
            {
              type: "toolCall",
              name: "context_history",
              id: "query-call",
              arguments: { action: "search", query: "ORIGINAL_EVIDENCE_83" },
            },
          ],
        },
      },
      {
        id: "echo",
        type: "message",
        message: {
          role: "toolResult",
          toolName: "context_history",
          content: [{ type: "text", text: "ORIGINAL_EVIDENCE_83" }],
        },
      },
    ]);
    assert.deepEqual(
      m.search("ORIGINAL_EVIDENCE_83").matches.map((x) => x.id),
      ["original"],
      "history queries and echoed results cannot cite themselves as source evidence",
    );
  });
});

test("notes rollover requires a current handoff, preserves history and excludes topic notes and obsolete versions", () => {
  usingMemory((m) => {
    const entries = [
      entry("a", "original objective"),
      entry("b", "older evidence"),
      entry("c", "recent evidence"),
    ];
    assert.throws(() => m.prepare(entries, "c"), /needs saved/);
    m.write("index", "current index", "a");
    m.write("handoff", "stale handoff", "a");
    assert.throws(() => m.prepare(entries, "c"), /stale/);
    m.write("topic/details", "DO_NOT_AUTO_INJECT", "b");
    m.write("handoff", "resume at decoder.py line 120; no acceptance yet", "b");
    const result = m.prepare(entries, "c");
    assert.match(result.summary, /decoder.py line 120/);
    assert.doesNotMatch(result.summary, /stale handoff|DO_NOT_AUTO_INJECT/);
    assert.equal(result.firstKeptEntryId, "c");
    assert.equal(m.history("a").text, "original objective");
    assert.throws(
      () => m.prepare([entry("z", "different branch")], "z"),
      /another branch/,
    );
  });
});

test("large mixed Unicode summaries use bounded inputs, short intermediate summaries and a separate final budget", async () => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "context-summary-test-"),
  );
  const requests = [];
  try {
    const result = await summarizeChunks(["多文件🙂 abc ".repeat(1800)], {
      directory,
      model: "fixture",
      maxInputChars: 9000,
      maxInputTokens: 2000,
      intermediateOutputChars: 200,
      maxOutputChars: 800,
      complete: async (prompt, signal, request) => {
        requests.push({ prompt, ...request });
        return {
          stopReason: "stop",
          content: [
            {
              type: "text",
              text:
                request.phase === "merge"
                  ? "final detailed checkpoint"
                  : "short intermediate checkpoint",
            },
          ],
        };
      },
    });
    assert.equal(result, "final detailed checkpoint");
    assert.ok(requests.length > 2);
    assert.ok(
      requests.every(
        (r) =>
          r.prompt.length <= 9000 && estimateSummaryTokens(r.prompt) <= 2000,
      ),
    );
    assert.ok(
      requests
        .filter((r) => r.phase === "chunk")
        .every((r) => r.outputChars === 200),
    );
    assert.equal(requests.at(-1).outputChars, 800);
    assert.equal(requests.at(-1).phase, "merge");
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("standalone memory extension handles unknown usage, reload and cancelled rollover without a task plugin", async () => {
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
    id = "context-test-" + Date.now();
  let compactCalls = 0;
  const ctx = {
    sessionManager: {
      getSessionId: () => id,
      getBranch: () => [entry("a", "data")],
      getLeafId: () => "a",
    },
    getContextUsage: () => ({ tokens: null }),
    model: { contextWindow: 1000 },
    isIdle: () => true,
    compact: () => compactCalls++,
    ui: { notify() {} },
  };
  const emit = async (type, event = {}) => {
    let result;
    for (const h of extension.handlers.get(type) ?? [])
      result = await h({ type, ...event }, ctx);
    return result;
  };
  const tool = (name, args) =>
    extension.tools
      .get(name)
      .definition.execute(
        "call",
        args,
        new AbortController().signal,
        () => {},
        ctx,
      );
  try {
    await emit("session_start");
    await tool("context_mode", { mode: "notes" });
    await tool("context_note", {
      action: "write",
      name: "index",
      text: "current index",
    });
    await tool("context_note", {
      action: "write",
      name: "handoff",
      text: "current handoff",
    });
    const tail = {
      role: "toolResult",
      toolCallId: "kept-call",
      content: [{ type: "text", text: "saved" }],
    };
    const unknown = await emit("context", { messages: [tail] });
    assert.equal(unknown.messages.length, 2);
    assert.equal(
      unknown.messages.at(-1),
      tail,
      "memory hints must not replace the trailing tool result seen by the provider",
    );
    assert.doesNotMatch(unknown.messages[0].content, /over 75%/);
    await tool("context_rollover", {});
    await emit("agent_settled", { aborted: true });
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(compactCalls, 0);
    await tool("context_rollover", {});
    await emit("agent_settled", { aborted: false });
    await emit("session_shutdown");
    await emit("session_start");
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(
      compactCalls,
      0,
      "reload invalidates the old scheduled rollover",
    );
    const status = await tool("context_mode", {});
    assert.equal(JSON.parse(status.content[0].text).mode, "notes");
    await tool("context_mode", { mode: "summary" });
    assert.equal(await emit("context", { messages: [] }), undefined);
  } finally {
    await emit("session_shutdown");
  }
});
