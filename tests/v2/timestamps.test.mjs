import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import ts from "typescript";
import { hostDir } from "../../scripts/host.mjs";
import {
  MARKER,
  patchPiTimestampFile,
} from "../../scripts/lib/pi-timestamp-patch.mjs";
import { readTime, formatTime, formatDuration } from "../../runtime/time.ts";
import { publicEntry } from "../../runtime/public.ts";
import { WorkerPublicStream } from "../../runtime/rpc-worker.ts";

const require = createRequire(path.join(hostDir, "package.json"));
const { createJiti } = await import(pathToFileURL(require.resolve("jiti")));
const tuiPath = require.resolve("@earendil-works/pi-tui");
const jiti = createJiti(import.meta.url, {
  alias: { "@earendil-works/pi-tui": tuiPath },
});
const { ToolTimes, decorateNativeTime, TIMESTAMP_RENDERER } = await jiti.import(
  path.resolve("extensions/mission-control/timestamps.ts"),
);
const { conversationItems } = await jiti.import(
  path.resolve("extensions/mission-control/viewer.ts"),
);
const { stripTerminalSequences, visibleWidth } = await import(
  pathToFileURL(tuiPath)
);
const { initTheme, theme, getMarkdownTheme } = await import(
  pathToFileURL(path.join(hostDir, "dist/modes/interactive/theme/theme.js"))
);
const { createBashToolDefinition } = await import(
  pathToFileURL(path.join(hostDir, "dist/index.js"))
);
const stampKey = Symbol.for("pi-mission-control.message-time.v1");
const start = new Date(2026, 9, 17, 23, 41, 8).getTime();

async function nativeFixture(name, fn) {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "mc-time-components-"),
  );
  const originalFile = path.join(
    hostDir,
    "dist/modes/interactive/components",
    name,
  );
  const relative = "dist/modes/interactive/components/" + name;
  const actual = fs.readFileSync(originalFile, "utf8");
  const source = actual.split(`\n/* ${MARKER} */`)[0];
  let patched = patchPiTimestampFile(relative, source);
  const tree = ts.createSourceFile(
    name,
    patched,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS,
  );
  const edits = tree.statements.filter(ts.isImportDeclaration).map((node) => {
    const spec = node.moduleSpecifier.text;
    const target = spec.startsWith(".")
      ? path.resolve(path.dirname(originalFile), spec)
      : require.resolve(spec);
    return {
      start: node.moduleSpecifier.getStart(tree),
      end: node.moduleSpecifier.end,
      text: JSON.stringify(pathToFileURL(target).href),
    };
  });
  for (const edit of edits.sort((a, b) => b.start - a.start))
    patched =
      patched.slice(0, edit.start) + edit.text + patched.slice(edit.end);
  const file = path.join(directory, "component.mjs");
  fs.writeFileSync(file, patched);
  const previous = globalThis[TIMESTAMP_RENDERER];
  const adapterKey = Symbol.for("pi-mission-control.timestamp-adapter.v1");
  const previousAdapter = globalThis[adapterKey];
  delete globalThis[TIMESTAMP_RENDERER];
  try {
    await fn(await import(pathToFileURL(file)));
  } finally {
    if (previousAdapter === undefined) delete globalThis[adapterKey];
    else globalThis[adapterKey] = previousAdapter;
    if (previous === undefined) delete globalThis[TIMESTAMP_RENDERER];
    else globalThis[TIMESTAMP_RENDERER] = previous;
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

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

test("native time decoration preserves exact user message identity, Markdown, shell zones and width", async () => {
  await nativeFixture("user-message.js", async ({ UserMessageComponent }) => {
    for (const name of ["dark", "light", "system"]) {
      initTheme(name, false);
      const text = "# 相同消息\n\n**粗体**\n\n```ts\nconst value = 1;\n```";
      const first = Object.assign(
        new UserMessageComponent(text, getMarkdownTheme()),
        { [stampKey]: start },
      );
      const second = Object.assign(
        new UserMessageComponent(text, getMarkdownTheme()),
        { [stampKey]: start + 10000 },
      );
      delete globalThis[TIMESTAMP_RENDERER];
      const native = first.render(80);
      globalThis[TIMESTAMP_RENDERER] = (lines, meta) =>
        decorateNativeTime(lines, meta, new ToolTimes(), start);
      const a = first.render(80),
        b = second.render(80);
      assert.match(stripTerminalSequences(a[0]), /23:41:08/);
      assert.match(stripTerminalSequences(b[0]), /23:41:18/);
      assert.deepEqual(a.slice(1), native.slice(1));
      assert.match(a[0], /\x1b\]133;A\x07/);
      for (const width of [5, 20, 80, 120])
        assert.ok(
          first.render(width).every((line) => visibleWidth(line) <= width),
        );
      globalThis[TIMESTAMP_RENDERER] = () => {
        throw Error("broken UI callback");
      };
      assert.deepEqual(first.render(80), native);
    }
  });
});

test("native assistant streaming retains request start and never mutates the message or body rendering", async () => {
  await nativeFixture(
    "assistant-message.js",
    async ({ AssistantMessageComponent }) => {
      initTheme("dark", false);
      const message = {
        role: "assistant",
        timestamp: start,
        content: [{ type: "text", text: "# Reply\n\n- evidence" }],
        stopReason: "stop",
      };
      const before = JSON.stringify(message),
        component = new AssistantMessageComponent(
          message,
          false,
          getMarkdownTheme(),
        );
      const native = component.render(80);
      globalThis[TIMESTAMP_RENDERER] = (lines, meta) =>
        decorateNativeTime(lines, meta, new ToolTimes(), start + 5000);
      assert.match(stripTerminalSequences(component.render(80)[0]), /23:41:08/);
      assert.deepEqual(component.render(80).slice(1), native.slice(1));
      component.updateContent(message, true);
      assert.match(stripTerminalSequences(component.render(80)[0]), /23:41:08/);
      assert.equal(JSON.stringify(message), before);
    },
  );
});

test("native command cards preserve built-in renderers and show running/final duration", async () => {
  await nativeFixture(
    "tool-execution.js",
    async ({ ToolExecutionComponent }) => {
      initTheme("dark", false);
      const times = new ToolTimes();
      times.start("tool-time", start);
      const ui = { requestRender() {} };
      const tool = new ToolExecutionComponent(
        "bash",
        "tool-time",
        { command: "echo visible" },
        {},
        createBashToolDefinition(process.cwd()),
        ui,
        process.cwd(),
      );
      tool.markExecutionStarted();
      globalThis[TIMESTAMP_RENDERER] = (lines, meta) =>
        decorateNativeTime(lines, meta, times, start + 5000);
      assert.match(
        tool.render(80).map(stripTerminalSequences).join("\n"),
        /已运行 5\.0秒/,
      );
      times.end("tool-time", 5000, start + 5000);
      tool.updateResult({
        content: [{ type: "text", text: "VISIBLE_NATIVE_OUTPUT" }],
        isError: false,
        durationMs: 5000,
      });
      const painted = tool.render(80);
      delete globalThis[TIMESTAMP_RENDERER];
      const native = tool.render(80);
      assert.match(
        painted.map(stripTerminalSequences).join("\n"),
        /耗时 5\.0秒/,
      );
      assert.deepEqual(painted.slice(1), native.slice(1));
      assert.match(
        painted.map(stripTerminalSequences).join("\n"),
        /VISIBLE_NATIVE_OUTPUT/,
      );
    },
  );
});

test("host adapter rejects changed constructor shapes and duplicate application", () => {
  const source =
    'class Interactive { addMessageToChat(message) { return new UserMessageComponent("x"); } }';
  assert.throws(
    () =>
      patchPiTimestampFile(
        "dist/modes/interactive/interactive-mode.js",
        source,
      ),
    /Expected two/,
  );
  assert.throws(() => patchPiTimestampFile("x.js", MARKER), /Already adapted/);
});

test("native notifications receive their own saved timestamp and keep the extension renderer intact", async () => {
  await nativeFixture(
    "custom-message.js",
    async ({ CustomMessageComponent }) => {
      initTheme("dark", false);
      const message = {
        role: "custom",
        customType: "mission-result",
        content: "DELIVERY_VISIBLE",
        display: true,
        timestamp: start,
      };
      const component = new CustomMessageComponent(
        message,
        undefined,
        getMarkdownTheme(),
      );
      const native = component.render(80);
      globalThis[TIMESTAMP_RENDERER] = (lines, meta) =>
        decorateNativeTime(lines, meta, new ToolTimes(), start);
      const result = component.render(80);
      assert.match(stripTerminalSequences(result[0]), /23:41:08/);
      assert.deepEqual(result.slice(1), native.slice(1));
      assert.match(
        result.map(stripTerminalSequences).join("\n"),
        /DELIVERY_VISIBLE/,
      );
    },
  );
});
