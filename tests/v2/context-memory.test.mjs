import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  ContextMemory,
  historyText,
  recentUserContext,
  NOTE_LIMITS,
  appendContextHint,
  indexAlreadyIncluded,
  snapshotContextMemory,
} from "../../runtime/context-memory.ts";
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

test("context snapshots include committed WAL notes, settings and cursor keys without modifying or overwriting source data", () =>
  usingMemory((m, directory) => {
    m.setMode("notes");
    m.setSetting("repair", '{"phase":"paused","turns":3}');
    m.write("index", "中文 snapshot version one", "public-source", 0);
    m.write("index", "中文 snapshot version two", "public-source", 1);
    m.sync([
      entry("older", "SNAPSHOT_TARGET old"),
      entry("newer", "SNAPSHOT_TARGET new"),
    ]);
    const cursor = m.search("SNAPSHOT_TARGET", 1, "user").nextCursor;
    const before = m.db
      .prepare("SELECT * FROM note_versions ORDER BY revision")
      .all();
    const destination = path.join(directory, "snapshot");
    fs.mkdirSync(destination);
    const file = path.join(destination, "memory.sqlite");
    snapshotContextMemory(path.join(directory, "memory.sqlite"), file);
    assert.deepEqual(
      m.db.prepare("SELECT * FROM note_versions ORDER BY revision").all(),
      before,
    );
    const copied = new ContextMemory(destination, "continuation");
    try {
      assert.equal(copied.mode, "notes");
      assert.equal(copied.note("index").revision, 2);
      assert.equal(
        copied.setting("repair", ""),
        ' {"phase":"paused","turns":3}'.trim(),
      );
      assert.deepEqual(
        copied.db
          .prepare("SELECT * FROM note_versions ORDER BY revision")
          .all(),
        before,
      );
      assert.equal(
        copied.search("SNAPSHOT_TARGET", 1, "user", cursor).matches[0].id,
        "older",
      );
      assert.throws(
        () =>
          snapshotContextMemory(path.join(directory, "memory.sqlite"), file),
        /exists|empty/i,
      );
      assert.equal(copied.note("index").text, "中文 snapshot version two");
    } finally {
      copied.close();
    }
  }));

test("empty optional search cursors start at the first page while invented nonempty cursors remain invalid", () =>
  usingMemory((m, directory) => {
    m.sync([
      entry("older", "计划里已有 AMD64，第一批"),
      entry("newer", "计划里已有 AMD64，第二批"),
    ]);
    const expected = m.search("计划里已有 AMD64", 1, "user");
    assert.ok(expected.nextCursor);
    for (const cursor of ["", "  \t ", null, undefined]) {
      assert.deepEqual(
        m.search("计划里已有 AMD64", 1, "user", cursor),
        expected,
      );
      const page = m.historyBatch(
        [
          {
            action: "search",
            query: "计划里已有 AMD64",
            role: "user",
            cursor,
            limit: 1,
          },
        ],
        1000,
      );
      assert.equal(page.results[0].matches[0].id, "newer");
      assert.equal(page.results[0].nextCursor, expected.nextCursor);
    }
    assert.equal(
      m.search("计划里已有 AMD64", 1, "user", expected.nextCursor).matches[0]
        .id,
      "older",
    );
    assert.throws(() => m.search("计划里已有 AMD64", 1, "user", "0"), /cursor/);
    assert.throws(
      () => m.search("计划里已有 AMD64", 1, "user", " " + expected.nextCursor),
      /cursor/,
    );
    const restored = new ContextMemory(directory, "test");
    try {
      assert.equal(
        restored.search("计划里已有 AMD64", 1, "user", "").matches[0].id,
        "newer",
      );
      assert.equal(
        restored.search("计划里已有 AMD64", 1, "user", expected.nextCursor)
          .matches[0].id,
        "older",
      );
    } finally {
      restored.close();
    }
  }));

test("reads distinguish excluded memory receipts from unknown or other-branch IDs without indexing tool echoes", () =>
  usingMemory((m) => {
    const source = entry("original", "计划里已有 AMD64，原始说明", "assistant");
    const receipt = {
      ...entry("failed-receipt", "PRIVATE_TOOL_ECHO", "toolResult"),
      message: {
        role: "toolResult",
        toolName: "context_history",
        content: [{ type: "text", text: "PRIVATE_TOOL_ECHO" }],
      },
    };
    const hint = {
      id: "memory-hint",
      type: "custom_message",
      customType: "context-memory-prepare",
      content: "PRIVATE_HINT",
    };
    m.sync([source, receipt, hint]);
    for (const id of [receipt.id, hint.id]) {
      assert.throws(
        () => m.history(id),
        /HISTORY_ITEM_EXCLUDED.*original user\/assistant.*Do not retry/i,
      );
      assert.throws(
        () => m.historyBatch([{ action: "read", id }], 1000),
        /HISTORY_ITEM_EXCLUDED/,
      );
    }
    assert.equal(m.search("PRIVATE_TOOL_ECHO").matches.length, 0);
    assert.equal(m.search("PRIVATE_HINT").matches.length, 0);
    assert.equal(m.history(source.id).text, "计划里已有 AMD64，原始说明");
    assert.throws(
      () => m.history("unrecognized"),
      /Unknown history item in this conversation branch/,
    );
    m.sync([entry("different", "Other branch")]);
    assert.throws(
      () => m.history(receipt.id),
      /Unknown history item in this conversation branch/,
    );
    assert.throws(
      () => m.history(source.id),
      /Unknown history item in this conversation branch/,
    );
  }));

test("256-token search batches page all long Unicode hits without duplicates, false empties or budget overruns", () =>
  usingMemory((m) => {
    const entries = Array.from({ length: 5 }, (_, i) =>
      entry("source-" + i, "TARGET " + "中文🙂".repeat(500)),
    );
    m.sync(entries);
    let cursor;
    const seen = [];
    for (let page = 0; page < 10; page++) {
      const result = m.historyBatch(
        [{ action: "search", query: "TARGET", role: "user", limit: 5, cursor }],
        256,
      );
      assert.ok(estimateSummaryTokens(JSON.stringify(result)) <= 256);
      assert.ok(
        result.results[0].matches.length > 0,
        "budget must not erase all real hits",
      );
      seen.push(...result.results[0].matches.map((v) => v.id));
      cursor = result.results[0].nextCursor;
      if (!cursor) {
        assert.equal(result.nextRequest, undefined);
        break;
      }
      assert.equal(result.nextRequest, 0);
      assert.equal(result.truncated, true);
      m.sync([...entries, entry("append-" + page, "new unrelated input")]);
    }
    assert.deepEqual(seen, [
      "source-4",
      "source-3",
      "source-2",
      "source-1",
      "source-0",
    ]);
    const empty = m.historyBatch(
      [{ action: "search", query: "NOT-PRESENT" }],
      256,
    );
    assert.deepEqual(empty.results[0].matches, []);
    assert.equal(empty.truncated, false);
    const first = m.search("TARGET", 1, "user");
    assert.ok(first.nextCursor);
    assert.throws(
      () => m.search("OTHER", 1, "user", first.nextCursor),
      /cursor/i,
    );
    assert.throws(
      () => m.search("TARGET", 1, "assistant", first.nextCursor),
      /cursor/i,
    );
    assert.throws(() => m.search("TARGET", 1, "user", "malformed"), /cursor/i);
    m.sync([entry("another-branch", "TARGET other branch")]);
    assert.throws(
      () => m.search("TARGET", 1, "user", first.nextCursor),
      /cursor|branch/i,
    );
  }));

test("budget-sheared search pages expose a cursor for every dropped hit after shrinking Unicode excerpts", () =>
  usingMemory((m) => {
    m.sync(
      Array.from({ length: 20 }, (_, i) =>
        entry("budget-hit-" + i, "TARGET 中文🙂".repeat(500)),
      ),
    );
    let cursor,
      pages = 0;
    const seen = [];
    do {
      const result = m.historyBatch(
        [{ action: "search", query: "TARGET", limit: 20, cursor }],
        256,
      );
      assert.ok(estimateSummaryTokens(JSON.stringify(result)) <= 256);
      assert.ok(result.results[0].matches.length > 0);
      seen.push(...result.results[0].matches.map((hit) => hit.id));
      cursor = result.results[0].nextCursor;
      if (cursor) assert.equal(result.nextRequest, 0);
      assert.ok(++pages < 30);
    } while (cursor);
    assert.ok(pages > 1);
    assert.deepEqual(
      seen,
      Array.from({ length: 20 }, (_, i) => "budget-hit-" + (19 - i)),
    );
  }));

test("mixed search/read batches resume the exact incomplete request and preserve Unicode offsets through reload", () =>
  usingMemory((m, directory) => {
    const original = "TARGET 中文🙂".repeat(100);
    const entries = Array.from({ length: 5 }, (_, i) =>
      entry("mixed-" + i, original),
    );
    m.sync(entries);
    const requests = [
      { action: "search", query: "TARGET", role: "user", limit: 2 },
      { action: "read", id: "mixed-0", offset: 0, limit: 6000 },
      { action: "search", query: "truly absent" },
    ];
    let startRequest = 0,
      collected = "",
      hits = [];
    for (let page = 0; page < 100; page++) {
      const result = m.historyBatch(requests, 256, startRequest);
      assert.ok(estimateSummaryTokens(JSON.stringify(result)) <= 256);
      assert.ok(result.results.length);
      for (const row of result.results) {
        if (row.requestIndex === 0) {
          hits.push(...row.matches.map((hit) => hit.id));
          requests[0].cursor = row.nextCursor;
        } else if (row.requestIndex === 1) {
          assert.equal(row.offset, Array.from(collected).length);
          collected += row.text;
          requests[1].offset = row.nextOffset;
        } else assert.deepEqual(row.matches, []);
      }
      if (result.nextRequest === undefined) break;
      startRequest = result.nextRequest;
    }
    assert.deepEqual(hits, [
      "mixed-4",
      "mixed-3",
      "mixed-2",
      "mixed-1",
      "mixed-0",
    ]);
    assert.equal(collected, original);
    const cursor = m.search("TARGET", 1, "user").nextCursor;
    const restored = new ContextMemory(directory, "test");
    try {
      assert.equal(
        restored.search("TARGET", 1, "user", cursor).matches[0].id,
        "mixed-3",
      );
      usingMemory((other) => {
        other.sync(entries);
        assert.throws(
          () => other.search("TARGET", 1, "user", cursor),
          /cursor/,
        );
      });
      assert.throws(
        () =>
          restored.search(
            "TARGET",
            1,
            "user",
            cursor.slice(0, -1) + (cursor.endsWith("A") ? "B" : "A"),
          ),
        /cursor/,
      );
    } finally {
      restored.close();
    }
  }));

test("index suppression requires branch checkpoint metadata and its exact projected summary, never just matching text", () =>
  usingMemory((m) => {
    const entries = [entry("a", "start"), entry("b", "recent")];
    m.write("index", "UNIQUE_INDEX_MARKER", "a");
    m.write("handoff", "resume b", "a");
    const prepared = m.prepare(entries, "b");
    const checkpoint = {
      ...prepared,
      type: "compaction",
      id: "cp",
      timestamp: new Date().toISOString(),
    };
    const projected = {
      role: "compactionSummary",
      summary: prepared.summary,
      timestamp: Date.parse(checkpoint.timestamp),
    };
    const note = m.note("index");
    assert.equal(
      indexAlreadyIncluded(note, [...entries, checkpoint], [projected]),
      true,
    );
    for (const messages of [
      [],
      [{ ...projected, role: "user" }],
      [{ ...projected, summary: "different" }],
      [{ ...projected, timestamp: 0 }],
    ])
      assert.equal(
        indexAlreadyIncluded(note, [...entries, checkpoint], messages),
        false,
      );
    assert.equal(
      indexAlreadyIncluded(
        note,
        [...entries, { ...checkpoint, details: { contextMode: "notes" } }],
        [projected],
      ),
      false,
    );
    assert.equal(indexAlreadyIncluded(note, entries, [projected]), false);
    m.write("index", "NEW_INDEX_MARKER", "b");
    assert.equal(
      indexAlreadyIncluded(
        m.note("index"),
        [...entries, checkpoint],
        [projected],
      ),
      false,
    );
  }));

test("batched note writes are atomic, preserve unchanged versions and refresh explicit handoff coverage", () =>
  usingMemory((m) => {
    m.writeMany(
      [
        { name: "index", text: "task G rev1" },
        { name: "handoff", text: "decoder.ts line173; not accepted" },
      ],
      "a",
    );
    assert.throws(
      () =>
        m.writeMany(
          [
            { name: "index", text: "changed", expectedRevision: 1 },
            { name: "handoff", text: "bad", expectedRevision: 0 },
          ],
          "b",
        ),
      /revision changed/,
    );
    assert.equal(m.note("index").text, "task G rev1");
    const receipts = m.writeMany(
      [
        { name: "index", text: "task G rev1", expectedRevision: 1 },
        {
          name: "handoff",
          text: "decoder.ts line173; not accepted",
          expectedRevision: 1,
        },
      ],
      "b",
    );
    assert.ok(
      receipts.every(
        (r) => r.unchanged && r.revision === 1 && r.source === "b",
      ),
    );
    assert.equal(
      m.db.prepare("select count(*) n from note_versions").get().n,
      2,
    );
    const prepared = m.prepare(
      [entry("a", "old"), entry("b", "latest operation")],
      "b",
    );
    assert.match(prepared.summary, /INCLUDED IN FULL/);
    assert.match(prepared.summary, /decoder.ts line173/);
  }));

test("batched history lookup bounds its total output and preserves Unicode read cursors and role filters", () =>
  usingMemory((m) => {
    m.sync([
      entry("user", "CORRECT-ID revision 1 中文🙂 ".repeat(100)),
      entry("claim", "WRONG-ID correction", "assistant"),
      entry("source", "dense source lines ".repeat(4000), "toolResult"),
    ]);
    const result = m.historyBatch(
      [
        { action: "search", query: "CORRECT-ID", role: "user" },
        { action: "read", id: "user", offset: 5, limit: 6000 },
        { action: "read", id: "source", limit: 6000 },
      ],
      600,
    );
    assert.ok(estimateSummaryTokens(JSON.stringify(result)) <= 610);
    assert.equal(result.results[0].matches[0].id, "user");
    const read = result.results.find((r) => r.id === "user");
    if (read?.nextOffset)
      assert.equal(read.nextOffset, read.offset + Array.from(read.text).length);
    assert.ok(result.truncated);
    assert.throws(
      () =>
        m.historyBatch(Array(9).fill({ action: "search", query: "source" })),
      /1..8/,
    );
  }));

test("changing an index or threshold hint preserves the large history prefix and complete final tool pairs", () => {
  const history = [
    { role: "user", content: "SOURCE ".repeat(20000) },
    {
      role: "assistant",
      content: [
        {
          type: "toolCall",
          id: "r",
          name: "read",
          arguments: { path: "decoder.ts" },
        },
      ],
    },
    { role: "toolResult", toolCallId: "r", content: "page1" },
  ];
  const hint = (content) => ({
    role: "custom",
    customType: "context-memory-hint",
    content,
    timestamp: 0,
  });
  const before = appendContextHint(history, hint("index rev1"));
  const after = appendContextHint(
    [
      ...history,
      {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: "r2",
            name: "read",
            arguments: { path: "decoder.ts", offset: 100 },
          },
        ],
      },
      { role: "toolResult", toolCallId: "r2", content: "page2" },
    ],
    hint("index rev2; threshold reached"),
  );
  const a = JSON.stringify(before),
    b = JSON.stringify(after);
  let common = 0;
  while (common < Math.min(a.length, b.length) && a[common] === b[common])
    common++;
  assert.ok(
    common > 140000,
    "mutable working notes must not replace the prefix before the source history",
  );
  assert.equal(before.at(-1), history.at(-1));
  assert.equal(after.at(-2).role, "assistant");
  assert.equal(after.at(-1).toolCallId, "r2");
});

test("bounded user excerpts retain literal latest corrections separately from erroneous working notes", () => {
  const entries = [
    entry("user-old", "Initial identifier OLD-ID."),
    entry(
      "user-correction",
      "USER CORRECTION: identifier CORRECT-ID revision 1.\n" +
        "中文🙂 source body ".repeat(8000) +
        "\nExact next file decoder.ts line 173.",
    ),
    entry("claim", "Wrong model claim: OLD-ID revision 1.", "assistant"),
    entry("continue", "继续，沿用之前的纠正。"),
  ];
  const pinned = recentUserContext(entries);
  assert.ok(estimateSummaryTokens(pinned) <= NOTE_LIMITS.userRequests);
  assert.match(pinned, /CORRECT-ID|User source user-correction/);
  assert.match(pinned, /decoder.ts line 173/);
  assert.match(pinned, /middle omitted/);
  assert.match(pinned, /继续/);
  assert.doesNotMatch(pinned, /Wrong model claim/);
  assert.ok(
    !Array.from(pinned).some(
      (char) => char.codePointAt(0) >= 0xd800 && char.codePointAt(0) <= 0xdfff,
    ),
  );
  usingMemory((m) => {
    const branch = [
      entry("a", "USER CORRECTION: identifier CORRECT-ID revision 1."),
      entry("b", "continue"),
    ];
    m.write("index", "review index", "b");
    m.write("handoff", "Wrong model note: OLD-ID revision 1.", "b");
    const summary = m.prepare(branch, "b").summary;
    assert.ok(
      summary.indexOf("RECENT USER SOURCE") >
        summary.indexOf("Wrong model note"),
    );
    assert.match(summary, /User source a/);
    assert.match(summary, /CORRECT-ID revision 1/);
    assert.equal(
      m.note("handoff").text,
      "Wrong model note: OLD-ID revision 1.",
      "raw user text is pinned without rewriting or verifying a model's notes",
    );
  });
});

test("history role filters find actual user corrections instead of newer repeated model claims", () =>
  usingMemory((m) => {
    m.sync([
      entry("user", "revision 1 使用 CORRECT-ID 中文"),
      entry("claim", "revision 1 OLD-ID 中文", "assistant"),
      {
        id: "compaction",
        type: "compaction",
        summary: "revision 1 OLD-ID 中文",
      },
    ]);
    assert.deepEqual(
      m.search("revision", 20, "user").matches.map((row) => row.id),
      ["user"],
    );
    assert.deepEqual(
      m.search("中文", 20, "user").matches.map((row) => row.id),
      ["user"],
    );
    assert.deepEqual(
      m.search("revision", 20, "assistant").matches.map((row) => row.id),
      ["claim"],
    );
    assert.deepEqual(
      m.search("revision", 20, "compaction").matches.map((row) => row.id),
      ["compaction"],
    );
    assert.throws(() => m.search("revision", 10, "system"), /Search needs/);
  }));

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
    const memoryCall = {
      id: "memory-call",
      type: "message",
      message: {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: "write-handoff",
            name: "context_note",
            arguments: {
              action: "write",
              name: "handoff",
              text: "mechanical save",
            },
          },
        ],
      },
    };
    const memoryReceipt = {
      id: "memory-receipt",
      type: "message",
      message: {
        role: "toolResult",
        toolName: "context_note",
        toolCallId: "write-handoff",
        content: [{ type: "text", text: "saved" }],
      },
    };
    m.write("handoff", "latest complete handoff", "c");
    assert.doesNotThrow(
      () =>
        m.prepare(
          [
            ...entries,
            memoryCall,
            memoryReceipt,
            entry("tail", "rollover boundary"),
          ],
          "tail",
        ),
      "saving memory and its receipt after the covered point must not make the handoff stale",
    );
    assert.throws(
      () =>
        m.prepare(
          [
            ...entries,
            entry("new-read", "new source evidence"),
            entry("tail", "rollover boundary"),
          ],
          "tail",
        ),
      /stale/,
      "new project facts still require a new handoff",
    );
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

test("rolling summaries keep the previous checkpoint outside lossy source chunks and merge it after new code is reduced", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "summary-prior-")),
    calls = [];
  try {
    const result = await summarizeChunks(
      ["new source code without the old identifier\n".repeat(300)],
      {
        directory,
        model: "fixture",
        maxInputChars: 2000,
        maxInputTokens: 1024,
        maxOutputChars: 400,
        intermediateOutputChars: 150,
        previousSummary:
          "Earlier unit: REF-OLD-ZERO, unaccepted. Continue original scope.",
        complete: async (prompt, _signal, request) => {
          calls.push({ prompt, ...request });
          return {
            stopReason: "stop",
            content: [
              {
                type: "text",
                text:
                  request.phase === "merge" && prompt.includes("REF-OLD-ZERO")
                    ? "REF-OLD-ZERO preserved; new source reviewed, unaccepted."
                    : "New source reviewed; no old metadata in this excerpt.",
              },
            ],
          };
        },
      },
    );
    assert.match(result, /REF-OLD-ZERO/);
    assert.ok(
      calls
        .filter((c) => c.phase === "chunk")
        .every((c) => !c.prompt.includes("REF-OLD-ZERO")),
      "no new-code chunk gets to erase the previous checkpoint",
    );
    assert.ok(
      calls.every((c) => !c.prompt.includes("REF-OLD-ZERO")),
      "old facts stay literal while the complete checkpoint fits its output budget",
    );
    assert.ok(
      calls.every(
        (c) =>
          c.prompt.length <= 2000 && estimateSummaryTokens(c.prompt) <= 1024,
      ),
    );
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("changing only a prior checkpoint reuses source chunks without reusing an obsolete merged checkpoint", async () => {
  const directory = fs.mkdtempSync(
      path.join(os.tmpdir(), "summary-prior-cache-"),
    ),
    calls = [];
  const options = {
    directory,
    model: "fixture",
    maxInputChars: 2000,
    maxOutputChars: 400,
    intermediateOutputChars: 150,
    complete: async (prompt, _signal, request) => {
      calls.push({ ...request, prompt });
      return {
        stopReason: "stop",
        content: [
          {
            type: "text",
            text:
              request.phase === "chunk"
                ? "New code result unchanged."
                : prompt.includes("REVISED-ONE")
                  ? "REVISED-ONE and unchanged new code result."
                  : prompt.includes("OLD-ZERO")
                    ? "OLD-ZERO and unchanged new code result."
                    : "Aggregated new code result.",
          },
        ],
      };
    },
  };
  try {
    const parts = ["unchanged new source\n".repeat(90)];
    assert.match(
      await summarizeChunks(parts, { ...options, previousSummary: "OLD-ZERO" }),
      /OLD-ZERO/,
    );
    const before = calls.length;
    const revised = await summarizeChunks(parts, {
      ...options,
      previousSummary: "REVISED-ONE",
    });
    assert.match(revised, /REVISED-ONE/);
    assert.doesNotMatch(revised, /OLD-ZERO/);
    assert.ok(calls.slice(before).every((call) => call.phase === "merge"));
    assert.equal(
      calls.length,
      before,
      "changing the old checkpoint does not resend already summarized new code while both fit",
    );
    const controller = new AbortController();
    controller.abort(Error("CANCELLED_PRIOR_ONLY"));
    await assert.rejects(
      summarizeChunks([], {
        ...options,
        previousSummary: "OLD-ZERO",
        signal: controller.signal,
      }),
      /CANCELLED_PRIOR_ONLY/,
    );
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("rolling checkpoint consolidation runs only under actual output pressure and stays inside request/output budgets", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "summary-pressure-")),
    calls = [];
  try {
    const result = await summarizeChunks(["new source observations"], {
      directory,
      model: "fixture",
      maxInputChars: 2000,
      maxInputTokens: 1024,
      maxOutputChars: 400,
      previousSummary: "EARLIER_UNIT_REFERENCE status unaccepted. ".repeat(5),
      complete: async (prompt, _signal, request) => {
        calls.push({ prompt, ...request });
        return {
          stopReason: "stop",
          content: [
            {
              type: "text",
              text:
                request.phase === "merge"
                  ? "EARLIER_UNIT_REFERENCE retained; latest unit reviewed, not accepted."
                  : "Latest unit observation. ".repeat(10),
            },
          ],
        };
      },
    });
    assert.match(result, /EARLIER_UNIT_REFERENCE/);
    assert.ok(result.length <= 400);
    assert.equal(calls.filter((call) => call.phase === "merge").length, 1);
    assert.ok(calls.at(-1).prompt.includes("PREVIOUS CHECKPOINT"));
    assert.ok(
      calls.every(
        (call) =>
          call.prompt.length <= 2000 &&
          estimateSummaryTokens(call.prompt) <= 1024,
      ),
    );
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
  const tool = async (name, args) => {
    if (name === "context_mode" && args.mode)
      await emit("input", {
        source: "interactive",
        text: `请把当前会话改成 ${args.mode} 模式`,
      });
    return extension.tools
      .get(name)
      .definition.execute(
        "call",
        args,
        new AbortController().signal,
        () => {},
        ctx,
      );
  };
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
