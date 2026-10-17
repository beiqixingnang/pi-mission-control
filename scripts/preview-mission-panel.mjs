/** Isolated fixture rendered by the installed Pi theme and TUI, never a desktop screenshot. */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { hostDir } from "./host.mjs";

const root = process.cwd();
const tuiPath = path.join(
  hostDir,
  "node_modules/@earendil-works/pi-tui/dist/index.js",
);
const {
  TuiAltScreen,
  VStack,
  Text,
  ScrollView,
  Markdown,
  stripTerminalSequences,
} = await import(pathToFileURL(tuiPath));
const { createJiti } = await import(
  pathToFileURL(path.join(hostDir, "node_modules/jiti/lib/jiti.mjs"))
);
const jiti = createJiti(import.meta.url, {
  alias: { "@earendil-works/pi-tui": tuiPath },
});
const { MissionKernel } = await import(
  pathToFileURL(path.join(root, "runtime/kernel.ts"))
);
const { MissionPanel } = await jiti.import(
  path.join(root, "extensions/mission-control/viewer.ts"),
);
const { board } = await jiti.import(
  path.join(root, "extensions/mission-control/ui.ts"),
);
const { ToolTimes, decorateNativeTime, TIMESTAMP_RENDERER } = await jiti.import(
  path.join(root, "extensions/mission-control/timestamps.ts"),
);
const { UserMessageComponent } = await import(
  pathToFileURL(
    path.join(hostDir, "dist/modes/interactive/components/user-message.js"),
  )
);
const { AssistantMessageComponent } = await import(
  pathToFileURL(
    path.join(
      hostDir,
      "dist/modes/interactive/components/assistant-message.js",
    ),
  )
);
const { ToolExecutionComponent } = await import(
  pathToFileURL(
    path.join(hostDir, "dist/modes/interactive/components/tool-execution.js"),
  )
);
const { createPowerShellToolDefinition } = await import(
  pathToFileURL(path.join(hostDir, "dist/index.js"))
);
const { initTheme, theme, getMarkdownTheme } = await import(
  pathToFileURL(path.join(hostDir, "dist/modes/interactive/theme/theme.js"))
);
initTheme("dark", false);

const directory = fs.mkdtempSync(path.join(os.tmpdir(), "mc-v2-ui-preview-"));
const kernel = new MissionKernel({
  directory,
  cwd: directory,
  sessionId: "preview",
  workerFactory: async () => {
    throw new Error("No fixture workers may start");
  },
  isLeadIdle: () => false,
  wake: () => {},
});
const terminal = {
  columns: 120,
  rows: 38,
  kittyProtocolActive: false,
  start() {},
  stop() {},
  write() {},
  hideCursor() {},
  showCursor() {},
  clearLine() {},
  clearFromCursor() {},
  clearScreen() {},
  setTitle() {},
  setProgress() {},
  setProgramStatus() {},
  moveBy() {},
  async drainInput() {},
};
const tui = new TuiAltScreen(terminal, false, undefined, { mouse: false });
const panel = new MissionPanel(
  kernel,
  () => {},
  () => {},
  { pollMs: 0, height: () => terminal.rows, theme },
);
const frames = [];
function frame(name, title, component, columns, rows) {
  terminal.columns = columns;
  terminal.rows = rows;
  tui.setLayoutRoot(component);
  tui.renderNow(true);
  if (panel.renderError) throw new Error(panel.renderError);
  const lines = tui.getScreenLines();
  frames.push({ name, title, columns, rows, lines });
}
try {
  for (const [name, role] of [
    ["cpu-executor", "CPU执行员"],
    ["cpu-reviewer", "CPU监督员"],
    ["gpu-executor", "GPU执行员"],
    ["gpu-reviewer", "GPU监督员"],
  ])
    kernel.addMember({
      name,
      role,
      thinkingLevel: "max",
      workspace: {
        root: directory,
        access: "read-write",
        execution: "host",
        extraReadRoots: [],
      },
      allow: [],
      temporary: false,
    });
  kernel.setGoal("完成CPU/GPU辅助仓重写，保留图形输出并通过测试", [
    "实现完整",
    "监督员检查测试证据",
  ]);
  const now = Date.now();
  kernel.addSchedule("阶段复核", "复核两组阶段交付", now + 12 * 60000);
  for (const [name, state, id] of [
    ["cpu-executor", "running", "cpu-work"],
    ["cpu-reviewer", "waiting", "cpu-review"],
    ["gpu-executor", "completed", "gpu-work"],
    ["gpu-reviewer", "failed", "gpu-review"],
  ]) {
    const member = kernel.store.member(name);
    kernel.store.putTask({
      id,
      missionId: kernel.store.mission().id,
      memberId: member.id,
      member: member.name,
      rootId: id,
      state,
      epoch: 1,
      phase: state === "waiting" ? "review" : "work",
      inputPath: kernel.store.artifact(id, "input", "fixture task"),
      createdAt: now,
      updatedAt: now,
      timeoutMs: 600000,
      processState: state === "running" ? "running" : "stopped",
      reviewDeliveryIds: [],
    });
  }
  const member = kernel.store.member("cpu-executor");
  kernel.store.set(`activity:${member.id}`, {
    tool: "powershell",
    at: now - 4000,
  });
  const logDir = path.join(directory, "sessions", member.id);
  fs.mkdirSync(logDir, { recursive: true });
  member.sessionFile = path.join(logDir, "preview.jsonl");
  const messages = [
    { role: "user", content: "核对寄存器复位行为，保留已有接口并补充测试。" },
    {
      role: "assistant",
      content: [
        {
          type: "text",
          text: "已核对接口约束。接下来修正复位值，再执行边界测试。\n\n- 保留现有图形接口\n- 用实际测试结果提交监督员复核",
        },
      ],
    },
    {
      role: "assistant",
      content: [
        {
          type: "toolCall",
          id: "edit-1",
          name: "edit",
          arguments: {
            path: "src/register.ts",
            oldText: "const reset = 1;",
            newText: "const reset = 0;",
          },
        },
      ],
    },
    {
      role: "toolResult",
      toolName: "edit",
      toolCallId: "edit-1",
      content: [{ type: "text", text: "Updated src/register.ts" }],
    },
    {
      role: "assistant",
      content: [
        {
          type: "toolCall",
          id: "cmd-1",
          name: "powershell",
          arguments: { command: "npm test -- --filter register", timeout: 120 },
        },
      ],
    },
    {
      role: "toolResult",
      toolName: "powershell",
      toolCallId: "cmd-1",
      content: [
        { type: "text", text: "PASS register-interface\n2 tests passed" },
      ],
    },
    {
      role: "assistant",
      content: [
        {
          type: "toolCall",
          id: "cmd-2",
          name: "powershell",
          arguments: { command: "npm run verify:boundaries" },
        },
      ],
    },
  ];
  fs.writeFileSync(
    member.sessionFile,
    [
      JSON.stringify({
        type: "session",
        id: member.sessionId,
        cwd: directory,
        version: 3,
      }),
      ...messages.map((message, index) =>
        JSON.stringify({
          type: "message",
          timestamp: new Date(now - 120000 + index * 10000).toISOString(),
          message: {
            ...message,
            timestamp: now - 120000 + index * 10000,
            ...(message.role === "toolResult"
              ? { durationMs: message.toolName === "edit" ? 1200 : 4500 }
              : {}),
          },
        }),
      ),
    ].join("\n") + "\n",
  );
  kernel.store.putMember(member);
  const nativeTimes = new ToolTimes();
  nativeTimes.start("preview-native", now - 20000);
  nativeTimes.end("preview-native", 4500, now - 15500);
  globalThis[TIMESTAMP_RENDERER] = (lines, metadata) =>
    decorateNativeTime(lines, metadata, nativeTimes, now);
  const user = Object.assign(
    new UserMessageComponent(
      "继续推进CPU/GPU任务，保留图形输出，交付后由监督员复核。",
      getMarkdownTheme(),
    ),
    { [Symbol.for("pi-mission-control.message-time.v1")]: now - 70000 },
  );
  const assistant = new AssistantMessageComponent(
    {
      role: "assistant",
      timestamp: now - 65000,
      content: [
        {
          type: "text",
          text: "CPU执行员正在补充边界测试，监督员等待结果。\nGPU阶段交付已经保存，后续问题由组内继续复核。",
        },
      ],
      stopReason: "stop",
    },
    false,
    getMarkdownTheme(),
  );
  const command = new ToolExecutionComponent(
    "powershell",
    "preview-native",
    { command: "npm test -- --filter register" },
    {},
    createPowerShellToolDefinition(directory),
    { requestRender() {} },
    directory,
  );
  command.markExecutionStarted();
  command.updateResult({
    content: [
      { type: "text", text: "PASS register-interface\n2 tests passed" },
    ],
    isError: false,
    durationMs: 4500,
  });
  const main = new VStack([
    {
      component: new ScrollView(
        new VStack([
          { component: user },
          { component: assistant },
          { component: command },
        ]),
        { primary: true, follow: "end" },
      ),
      basis: 0,
      grow: 1,
    },
    {
      component: {
        render: (width) => board(kernel, width, false, theme, terminal.rows),
        invalidate() {},
      },
    },
    { component: new Text("› 尚未发送的主对话草稿", 0, 0) },
  ]);
  tui.start();
  frame("01-main-wide", "输入框上方横向看板 · Pi渲染器隔离预览", main, 120, 30);
  frame("02-main-narrow", "窄屏横向看板 · Pi渲染器隔离预览", main, 70, 24);
  frame("03-team", "团队工作台 · Pi渲染器隔离预览", panel, 120, 32);
  await panel.openMember(member.id);
  frame("04-member", "成员对话与动作底色 · Pi渲染器隔离预览", panel, 120, 44);
  panel.handleInput("\x1b[A");
  panel.render(120);
  panel.handleInput("\x1b[A");
  panel.render(120);
  panel.handleInput("\x1b[A");
  panel.render(120);
  panel.handleInput("\x1b[A");
  panel.render(120);
  panel.handleInput("\r");
  frame("05-edit", "编辑内容展开 · Pi渲染器隔离预览", panel, 100, 32);
  const output = path.join(root, ".reference/artifacts/ui");
  fs.mkdirSync(output, { recursive: true });
  fs.writeFileSync(
    path.join(output, "frames.json"),
    JSON.stringify(
      {
        source:
          "Installed Pi Theme + TuiAltScreen; fixture data, not a desktop screenshot",
        defaultForeground: "#d4d4d4",
        defaultBackground: "#111318",
        frames,
      },
      null,
      2,
    ) + "\n",
  );
  fs.writeFileSync(
    path.join(root, "docs/ui-preview-mission-panel.txt"),
    frames
      .map(
        (f) =>
          `=== ${f.title} (${f.columns}×${f.rows}) ===\n${f.lines.map((line) => stripTerminalSequences(line).trimEnd()).join("\n")}`,
      )
      .join("\n\n")
      .trimEnd() + "\n",
  );
  console.log(
    `Rendered ${frames.length} frames to .reference/artifacts/ui/frames.json and docs/ui-preview-mission-panel.txt`,
  );
} finally {
  delete globalThis[TIMESTAMP_RENDERER];
  panel.dispose();
  tui.stop();
  await kernel.close();
  fs.rmSync(directory, { recursive: true, force: true });
}
