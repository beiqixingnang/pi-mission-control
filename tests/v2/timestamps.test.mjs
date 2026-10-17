import test from "node:test";
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import path from "node:path";
import { hostDir } from "../../scripts/host.mjs";
import { readTime, formatTime, formatDuration } from "../../runtime/time.ts";
import { publicEntry } from "../../runtime/public.ts";
import { WorkerPublicStream } from "../../runtime/rpc-worker.ts";
const { createJiti } = await import(
  pathToFileURL(path.join(hostDir, "node_modules/jiti/lib/jiti.mjs"))
);
const jiti = createJiti(import.meta.url, {
  alias: {
    "@earendil-works/pi-tui": path.join(
      hostDir,
      "node_modules/@earendil-works/pi-tui/dist/index.js",
    ),
  },
});
const { conversationItems } = await jiti.import(
  path.resolve("extensions/mission-control/viewer.ts"),
);
const { LeadHistory } = await jiti.import(
  path.resolve("extensions/mission-control/lead-history.ts"),
);
const start = new Date(2026, 9, 17, 23, 41, 8).getTime();

test("times use the saved local timestamp, include dates across days and never invent missing history", () => {
  assert.equal(formatTime(start, start), "23:41:08");
  assert.equal(
    formatTime(start, new Date(2026, 9, 18).getTime()),
    "10-17 23:41:08",
  );
  assert.equal(
    formatTime(start, new Date(2027, 0, 1).getTime()),
    "2026-10-17 23:41:08",
  );
  assert.equal(formatTime(undefined, start), "时间未记录");
  assert.equal(readTime("invalid"), undefined);
  assert.equal(readTime(0), 0);
  assert.equal(formatDuration(1250), "1.3秒");
  assert.equal(formatDuration(125000), "2分05秒");
});

test("public projection retains only timestamp and duration metadata without changing saved entry time", () => {
  const row = publicEntry({
    type: "message",
    timestamp: new Date(start + 9000).toISOString(),
    message: {
      role: "assistant",
      timestamp: start,
      durationMs: 9000,
      content: [
        { type: "thinking", thinking: "PRIVATE_TIME_TEST" },
        { type: "text", text: "visible" },
      ],
    },
  });
  assert.equal(row.timestamp, new Date(start + 9000).toISOString());
  assert.equal(row.messageTimestamp, start);
  assert.equal(row.durationMs, 9000);
  assert.doesNotMatch(JSON.stringify(row), /PRIVATE_TIME_TEST/);
});

test("conversation call timing uses saved tool duration instead of model thinking time", () => {
  const items = conversationItems([
    {
      offset: 0,
      entry: {
        role: "assistant",
        messageTimestamp: start,
        content: [
          {
            type: "toolCall",
            id: "call",
            name: "bash",
            arguments: { command: "true" },
          },
        ],
      },
    },
    {
      offset: 1,
      entry: {
        role: "toolResult",
        toolCallId: "call",
        toolName: "bash",
        messageTimestamp: start + 20000,
        durationMs: 5000,
        content: "ok",
      },
    },
    { offset: 2, entry: { role: "user", content: "legacy" } },
  ]);
  assert.equal(items[0].timestamp, start + 15000);
  assert.equal(items[0].durationMs, 5000);
  assert.equal(items[1].timestamp, start + 20000);
  assert.equal(items[2].timestamp, undefined);
  assert.equal(items[0].body, '{\n  "command": "true"\n}');
});

test("live reply and command start timestamps stay fixed while RPC output grows", () => {
  const missing = new WorkerPublicStream().accept({
    type: "message_update",
    assistantMessageEvent: {
      type: "text_delta",
      contentIndex: 0,
      delta: "old",
    },
  });
  assert.equal(missing.preview.timestamp, undefined);
  const stream = new WorkerPublicStream();
  stream.accept({
    type: "message_start",
    message: { role: "assistant", timestamp: start },
  });
  const a = stream.accept({
    type: "message_update",
    assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "a" },
  });
  const b = stream.accept({
    type: "message_update",
    assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "b" },
  });
  assert.equal(a.preview.timestamp, start);
  assert.equal(b.preview.timestamp, start);
  const first = stream.accept({
    type: "tool_execution_start",
    toolCallId: "live",
    toolName: "bash",
    args: { command: "echo a" },
  });
  const update = stream.accept({
    type: "tool_execution_update",
    toolCallId: "live",
    toolName: "bash",
    args: { command: "echo a" },
    partialResult: { content: [] },
  });
  assert.equal(first.preview.startedAt, update.preview.startedAt);
  assert.equal(first.preview.timestamp, update.preview.timestamp);
});

test("lead live timeline keeps public text and stable times without retaining private model blocks", () => {
  const history = new LeadHistory();
  history.accept({
    type: "message_start",
    message: { role: "assistant", timestamp: start },
  });
  history.accept({
    type: "message_update",
    assistantMessageEvent: {
      type: "thinking_delta",
      contentIndex: 0,
      delta: "PRIVATE_LEAD_THOUGHT",
    },
  });
  assert.deepEqual(history.previews(), []);
  history.accept({
    type: "message_update",
    assistantMessageEvent: {
      type: "text_delta",
      contentIndex: 1,
      delta: "PUBLIC_LEAD_REPLY",
    },
  });
  assert.equal(history.previews()[0].timestamp, start);
  assert.equal(history.previews()[0].text, "PUBLIC_LEAD_REPLY");
  assert.doesNotMatch(JSON.stringify(history), /PRIVATE_LEAD_THOUGHT/);
  history.accept({
    type: "message_end",
    message: { role: "assistant", timestamp: start },
  });
  assert.deepEqual(history.previews(), []);
  history.clear();
  assert.deepEqual(history.previews(), []);
});

test("repeated public messages retain separate saved timestamps in the pure plugin timeline", () => {
  const items = conversationItems(
    [0, 1].map((index) => ({
      offset: index,
      entry: {
        role: "user",
        messageTimestamp: start + index * 10000,
        content: "duplicate",
      },
    })),
    "主会话回复",
  );
  assert.equal(items[0].body, items[1].body);
  assert.equal(items[0].timestamp, start);
  assert.equal(items[1].timestamp, start + 10000);
});
