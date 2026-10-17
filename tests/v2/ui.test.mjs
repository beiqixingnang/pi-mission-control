import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { hostDir } from "../../scripts/host.mjs";
import { MissionKernel } from "../../runtime/kernel.ts";
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
const { board } = await jiti.import(
  path.resolve("extensions/mission-control/ui.ts"),
);
const { MissionPanel, teamRows } = await jiti.import(
  path.resolve("extensions/mission-control/viewer.ts"),
);
const { visibleWidth } = await import(
  pathToFileURL(
    path.join(hostDir, "node_modules/@earendil-works/pi-tui/dist/index.js"),
  )
);
test("public widget layout remains bounded at narrow/wide CJK widths and has stable member order", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mc-v2-ui-"));
  const kernel = new MissionKernel({
    directory: dir,
    cwd: dir,
    sessionId: "ui",
    workerFactory: async () => {
      throw new Error("unused");
    },
    isLeadIdle: () => false,
    wake: () => {},
  });
  try {
    for (const name of [
      "cpu-worker",
      "cpu-reviewer",
      "gpu-worker",
      "gpu-reviewer",
    ])
      kernel.addMember({
        name,
        role: "中文角色",
        workspace: {
          root: dir,
          access: "read-only",
          execution: "files",
          extraReadRoots: [],
        },
        allow: [],
        thinkingLevel: "off",
        temporary: false,
      });
    kernel.setGoal("实现中文目标，不干扰Pi原有界面", ["验收结果"]);
    for (const width of [20, 50, 80, 120, 180]) {
      const lines = board(kernel, width);
      assert.ok(
        lines.every((line) => visibleWidth(line) <= width),
        `width ${width}`,
      );
      assert.ok(!lines.some((line) => /\x1b\]/.test(line)));
      assert.deepEqual(
        board(kernel, width),
        lines,
        "rendering does not rotate members",
      );
    }
    assert.ok(
      board(kernel, 160, true).some((line) => line.includes("Esc 返回")),
    );
  } finally {
    await kernel.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("member viewer supports selection, expansion, paging, follow pause, history and safe return", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mc-v2-panel-"));
  let wakes = 0,
    closed = 0;
  const kernel = new MissionKernel({
    directory: dir,
    cwd: dir,
    sessionId: "viewer",
    workerFactory: async () => {
      throw new Error("unused");
    },
    isLeadIdle: () => false,
    wake: () => {
      wakes++;
    },
  });
  const panel = new MissionPanel(
    kernel,
    () => {},
    () => {
      closed++;
    },
    { pollMs: 0, height: () => 30 },
  );
  try {
    const member = kernel.addMember({
      name: "viewer-member",
      role: "只读审查",
      workspace: {
        root: dir,
        access: "read-only",
        execution: "files",
        extraReadRoots: [],
      },
      allow: [],
      thinkingLevel: "off",
      temporary: false,
    });
    kernel.setGoal("查看成员不改变任务", ["可以返回"]);
    const logs = path.join(dir, "sessions", member.id);
    fs.mkdirSync(logs, { recursive: true });
    const old = path.join(logs, "old.jsonl"),
      file = path.join(logs, "current.jsonl");
    const row = (text) =>
      JSON.stringify({
        type: "message",
        message: { role: "assistant", content: [{ type: "text", text }] },
      }) + "\n";
    fs.writeFileSync(old, row("RETIRED_HISTORY"));
    fs.writeFileSync(
      file,
      Array.from({ length: 100 }, (_, i) => row(`MESSAGE_${i}`)).join("") +
        JSON.stringify({
          type: "message",
          message: {
            role: "toolResult",
            toolName: "read",
            content: [
              { type: "text", text: "ONE\nTWO\nTHREE\nHIDDEN_FOUR\nFIVE" },
            ],
          },
        }) +
        "\n",
    );
    member.sessionFile = file;
    kernel.store.putMember(member);
    const before = kernel.snapshot();
    panel.render(120);
    panel.handleInput("\r");
    for (let i = 0; i < 200 && !panel.records.length; i++)
      await new Promise((r) => setTimeout(r, 5));
    assert.equal(panel.view, "conversation");
    assert.equal(panel.file, file);
    let visible = panel.render(120).join("\n");
    assert.match(visible, /工具返回/);
    assert.doesNotMatch(visible, /HIDDEN_FOUR/);
    panel.handleInput("\r");
    assert.match(panel.render(120).join("\n"), /HIDDEN_FOUR/);
    assert.equal(panel.following, false);
    fs.appendFileSync(file, row("NEW_AFTER_PAUSE"));
    await panel.refresh();
    assert.equal(panel.unread, true);
    assert.doesNotMatch(panel.render(120).join("\n"), /NEW_AFTER_PAUSE/);
    panel.handleInput("\x1b[F"); // End
    for (
      let i = 0;
      i < 30 &&
      !panel.records.some((r) => JSON.stringify(r).includes("NEW_AFTER_PAUSE"));
      i++
    )
      await new Promise((r) => setTimeout(r, 5));
    assert.match(panel.render(120).join("\n"), /NEW_AFTER_PAUSE/);
    await panel.older();
    assert.ok(panel.records.length > 40);
    for (const width of [5, 20, 50, 80, 120, 180]) {
      const lines = panel.render(width);
      assert.ok(lines.every((line) => visibleWidth(line) <= width));
      assert.ok(lines.length <= 25);
    }
    panel.handleInput("]");
    for (
      let i = 0;
      i < 30 &&
      !panel.records.some((r) => JSON.stringify(r).includes("RETIRED_HISTORY"));
      i++
    )
      await new Promise((r) => setTimeout(r, 5));
    assert.match(panel.render(120).join("\n"), /RETIRED_HISTORY/);
    panel.handleInput("\x1b");
    assert.equal(panel.view, "team");
    panel.handleInput("\t");
    assert.match(panel.render(120).join("\n"), /可以返回/);
    panel.handleInput("\x1b");
    panel.handleInput("\x1b");
    assert.equal(closed, 1);
    assert.deepEqual(kernel.snapshot(), before);
    assert.equal(wakes, 0);
  } finally {
    panel.dispose();
    await kernel.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("command and edit previews retain full logical arguments when copied", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mc-v2-action-copy-"));
  let copied = "";
  const kernel = new MissionKernel({
    directory: dir,
    cwd: dir,
    sessionId: "copy",
    workerFactory: async () => {
      throw new Error("unused");
    },
    isLeadIdle: () => false,
    wake: () => {},
  });
  const panel = new MissionPanel(
    kernel,
    () => {},
    () => {},
    {
      pollMs: 0,
      height: () => 60,
      copyMessage: async (value) => {
        copied = value;
      },
    },
  );
  try {
    const member = kernel.addMember({
      name: "executor",
      role: "执行员",
      workspace: {
        root: dir,
        access: "read-write",
        execution: "files",
        extraReadRoots: [],
      },
      allow: [],
      thinkingLevel: "off",
      temporary: false,
    });
    await panel.openMember(member.id);
    panel.records = [
      {
        offset: 0,
        entry: {
          role: "assistant",
          content: [{ type: "text", text: "公开回复" }],
        },
      },
      {
        offset: 1,
        entry: {
          role: "assistant",
          content: [
            {
              type: "toolCall",
              id: "cmd",
              name: "powershell",
              arguments: { command: "npm test", timeout: 120 },
            },
          ],
        },
      },
      {
        offset: 2,
        entry: {
          role: "toolResult",
          toolCallId: "cmd",
          toolName: "powershell",
          content: "PASS",
        },
      },
      {
        offset: 3,
        entry: {
          role: "assistant",
          content: [
            {
              type: "toolCall",
              id: "edit",
              name: "edit",
              arguments: { path: "module.ts", oldText: "old", newText: "new" },
            },
          ],
        },
      },
      {
        offset: 4,
        entry: {
          role: "toolResult",
          toolCallId: "edit",
          toolName: "edit",
          content: "Updated",
        },
      },
    ];
    for (const row of panel.records)
      row.entry.messageTimestamp = new Date(2026, 9, 17, 23, 41, 8).getTime();
    panel.records[2].entry.durationMs = 2500;
    const visible = panel.render(120).join("\n");
    assert.match(visible, /执行命令 · powershell/);
    assert.match(visible, /23:41:/);
    assert.match(visible, /耗时 2\.5秒/);
    assert.match(visible, /编辑文件 · module.ts/);
    assert.match(visible, /- old/);
    assert.match(visible, /\+ new/);
    assert.doesNotMatch(visible, /```/);
    for (let i = 0; i < 3; i++) {
      panel.handleInput("\x1b[A");
      panel.render(120);
    }
    panel.handleInput("c");
    await new Promise((resolve) => setImmediate(resolve));
    assert.match(copied, /"command": "npm test"/);
    assert.match(copied, /"timeout": 120/);
    assert.doesNotMatch(
      copied,
      /\x1b|[│┌┐└┘]|Enter 展开|23:41:|耗时|时间未记录/,
    );
  } finally {
    panel.dispose();
    await kernel.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("team tree expands descendants and retains idle members in stable order", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mc-v2-tree-view-"));
  const kernel = new MissionKernel({
    directory: dir,
    cwd: dir,
    sessionId: "tree",
    workerFactory: async () => {
      throw new Error("unused");
    },
    isLeadIdle: () => false,
    wake: () => {},
  });
  try {
    const members = ["supervisor", "worker", "idle"].map((name) =>
      kernel.addMember({
        name,
        role: "role",
        workspace: {
          root: dir,
          access: "read-only",
          execution: "files",
          extraReadRoots: [],
        },
        allow: [],
        thinkingLevel: "off",
        temporary: false,
      }),
    );
    const task = (id, member, parentId) => ({
      id,
      memberId: member.id,
      member: member.name,
      missionId: "m",
      parentId,
      rootId: "parent",
      state: "waiting",
      epoch: 1,
      phase: "work",
      inputPath: "unused",
      createdAt: 1,
      updatedAt: 1,
      timeoutMs: 1000,
      processState: "stopped",
      reviewDeliveryIds: [],
    });
    kernel.store.putTask(task("parent", members[0]));
    kernel.store.putTask(task("child", members[1], "parent"));
    const rows = teamRows(kernel.snapshot());
    assert.deepEqual(
      rows.map((r) => r.id),
      ["parent", "child", members[2].id],
    );
    assert.ok(
      teamRows(kernel.snapshot(), new Set(["parent"])).every(
        (r) => r.id !== "child",
      ),
    );
    const panel = new MissionPanel(
      kernel,
      () => {},
      () => {},
      { pollMs: 0 },
    );
    try {
      panel.render(120);
      panel.handleInput("\x1b[D");
      assert.doesNotMatch(panel.render(120).join("\n"), /· worker ·/);
      panel.handleInput("\x1b[C");
      assert.match(panel.render(120).join("\n"), /· worker ·/);
      panel.handleInput("\x1b[B");
      panel.render(120);
      panel.handleInput("\r");
      assert.equal(panel.memberId, members[1].id);
      panel.handleInput("\x1b");
      panel.handleInput("\x1b[A");
      assert.equal(panel.selected, 0);
      panel.handleInput("\t");
      panel.handleInput("\t");
      assert.match(panel.render(120).join("\n"), /暂无定时提醒/);
    } finally {
      panel.dispose();
    }
  } finally {
    await kernel.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("member conversation uses semantic markdown blocks and routes message/copy actions explicitly", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mc-v2-message-viewer-"));
  let copied = "";
  const kernel = new MissionKernel({
    directory: dir,
    cwd: dir,
    sessionId: "message-viewer",
    workerFactory: async () => {
      throw new Error("unused");
    },
    isLeadIdle: () => false,
    wake: () => {},
  });
  const panel = new MissionPanel(
    kernel,
    () => {},
    () => {},
    {
      pollMs: 0,
      height: () => 30,
      editMessage: async () => "Please continue the review",
      copyMessage: async (text) => {
        copied = text;
      },
    },
  );
  try {
    const member = kernel.addMember({
      name: "message-member",
      role: "可交互执行员",
      workspace: {
        root: dir,
        access: "read-write",
        execution: "files",
        extraReadRoots: [],
      },
      allow: [],
      thinkingLevel: "off",
      temporary: false,
    });
    kernel.setGoal("测试成员消息", ["消息发送"]);
    const logs = path.join(dir, "sessions", member.id);
    fs.mkdirSync(logs, { recursive: true });
    const file = path.join(logs, "current.jsonl");
    fs.writeFileSync(
      file,
      [
        JSON.stringify({
          type: "message",
          message: {
            role: "assistant",
            content: [
              {
                type: "text",
                text: "正在核对接口\n\n```ts\nconst value = 1;\n```",
              },
            ],
          },
        }),
        JSON.stringify({
          type: "message",
          message: {
            role: "toolResult",
            toolName: "read",
            isError: false,
            content: [{ type: "text", text: "PASS interface" }],
          },
        }),
      ].join("\n") + "\n",
    );
    member.sessionFile = file;
    kernel.store.putMember(member);
    await panel.openMember(member.id);
    const output = panel.render(100).join("\n");
    assert.match(output, /成员回复/);
    assert.match(output, /工具返回/);
    assert.match(output, /PASS interface/);
    panel.handleInput("c");
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.match(copied, /工具返回/);
    panel.handleInput("m");
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(kernel.store.tasks().length, 1);
    assert.equal(kernel.store.tasks()[0].member, "message-member");
    assert.match(panel.error, /消息已创建/);
  } finally {
    panel.dispose();
    await kernel.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
