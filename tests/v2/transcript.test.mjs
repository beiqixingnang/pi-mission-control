import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  transcriptPage,
  memberSessionFiles,
} from "../../runtime/transcript.ts";
import { workerPreview, WorkerPublicStream } from "../../runtime/rpc-worker.ts";

const row = (i) =>
  JSON.stringify({
    type: "message",
    message: {
      role: "assistant",
      content: [
        {
          type: "thinking",
          thinking: "PRIVATE_REASONING",
          signature: "PRIVATE_SIGNATURE",
        },
        { type: "text", text: `PUBLIC_${i} 中文\u2028同条记录` },
      ],
    },
  }) + "\n";
test("backward LF pages preserve boundaries, filter private blocks and ignore an incomplete tail", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mc-view-log-"));
  try {
    const file = path.join(dir, "session.jsonl");
    await fs.writeFile(
      file,
      Array.from({ length: 125 }, (_, i) => row(i)).join("") + '{"partial":',
    );
    let before,
      records = [];
    do {
      const page = await transcriptPage(file, before, 17);
      records = [...page.records, ...records];
      before = page.before;
    } while (before > 0);
    assert.equal(records.length, 125);
    assert.equal(new Set(records.map((r) => r.offset)).size, 125);
    const text = JSON.stringify(records);
    assert.doesNotMatch(text, /PRIVATE_|signature|thinking|partial/);
    assert.match(text, /PUBLIC_124/);
    assert.match(text, /同条记录/);
    for (let i = 1; i < records.length; i++)
      assert.ok(records[i].offset > records[i - 1].offset);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
test("large private/oversized records are scanned in bounded windows and paging makes progress", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mc-view-large-"));
  try {
    const file = path.join(dir, "session.jsonl");
    await fs.writeFile(
      file,
      row("older") +
        JSON.stringify({ type: "custom", data: "x".repeat(3 * 1024 * 1024) }) +
        "\n" +
        row("newer"),
    );
    const latest = await transcriptPage(file, undefined, 40, 131072);
    assert.equal(latest.records.length, 1);
    assert.ok(latest.before > 0);
    assert.ok(latest.skipped);
    let before = latest.before;
    for (let i = 0; i < 30 && before; i++) {
      const page = await transcriptPage(file, before, 40, 131072);
      assert.ok(page.before < before);
      if (!page.before)
        assert.match(JSON.stringify(page.records), /PUBLIC_older/);
      before = page.before;
    }
    assert.equal(before, 0);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
test("member history enumeration stays inside its member directory and ignores directories", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mc-view-files-"));
  try {
    const logs = path.join(dir, "sessions", "member");
    await fs.mkdir(logs, { recursive: true });
    await fs.writeFile(path.join(logs, "old.jsonl"), row(1));
    await fs.mkdir(path.join(logs, "directory.jsonl"));
    await fs.writeFile(path.join(logs, "secret.txt"), "PRIVATE");
    assert.deepEqual(await memberSessionFiles(dir, "member"), [
      path.join(logs, "old.jsonl"),
    ]);
    await assert.rejects(memberSessionFiles(dir, "../member"), /identity/);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
test("live public projection never exposes reasoning, signatures, embedded dumps or tool secrets", () => {
  const message = {
    role: "assistant",
    timestamp: 7,
    content: [
      {
        type: "thinking",
        thinking: "PRIVATE_REASONING",
        signature: "PRIVATE_SIGNATURE",
      },
      { type: "text", text: "VISIBLE_REPLY" },
    ],
  };
  assert.equal(
    workerPreview({
      type: "message_update",
      message,
      assistantMessageEvent: { type: "thinking_delta" },
    }),
    undefined,
  );
  const reply = workerPreview({
    type: "message_update",
    message,
    assistantMessageEvent: { type: "text_delta" },
  });
  assert.match(reply.preview.text, /VISIBLE_REPLY/);
  assert.doesNotMatch(JSON.stringify(reply), /PRIVATE_/);
  const tool = workerPreview({
    type: "tool_execution_update",
    toolCallId: "t",
    toolName: "read",
    args: { path: "file", apiKey: "PRIVATE_KEY" },
    partialResult: {
      content: [
        { type: "text", text: "VISIBLE_OUTPUT" },
        { type: "thinking", thinking: "PRIVATE_THOUGHT" },
      ],
    },
  });
  assert.match(tool.preview.text, /VISIBLE_OUTPUT/);
  assert.doesNotMatch(JSON.stringify(tool), /PRIVATE_/);
  assert.equal(
    workerPreview({ type: "tool_execution_end", toolCallId: "t" }).clearPreview,
    "tool:t",
  );
});

test("Pi RPC snapshot-free text deltas render live while reasoning deltas are never retained", () => {
  const stream = new WorkerPublicStream();
  stream.accept({
    type: "message_start",
    message: { role: "assistant", timestamp: 12 },
  });
  assert.equal(
    stream.accept({
      type: "message_update",
      assistantMessageEvent: {
        type: "thinking_delta",
        contentIndex: 0,
        delta: "PRIVATE_RPC_THOUGHT",
      },
    }),
    undefined,
  );
  stream.accept({
    type: "message_update",
    assistantMessageEvent: { type: "text_start", contentIndex: 1 },
  });
  const a = stream.accept({
    type: "message_update",
    assistantMessageEvent: {
      type: "text_delta",
      contentIndex: 1,
      delta: "LIVE_",
    },
  });
  const b = stream.accept({
    type: "message_update",
    assistantMessageEvent: {
      type: "text_delta",
      contentIndex: 1,
      delta: "RPC",
    },
  });
  assert.equal(a.preview.text, "LIVE_");
  assert.equal(b.preview.text, "LIVE_RPC");
  assert.doesNotMatch(JSON.stringify(stream), /PRIVATE_RPC_THOUGHT/);
  assert.equal(
    stream.accept({
      type: "message_end",
      message: { role: "assistant", timestamp: 12 },
    }).clearPreview,
    "assistant:12",
  );
});
