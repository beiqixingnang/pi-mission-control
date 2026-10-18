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
const { MissionPanel } = await jiti.import(
  path.resolve("extensions/mission-control/viewer.ts"),
);
const { board } = await jiti.import(
  path.resolve("extensions/mission-control/ui.ts"),
);
const { initTheme, theme } = await import(
  pathToFileURL(path.join(hostDir, "dist/modes/interactive/theme/theme.js"))
);
const { visibleWidth, stripTerminalSequences } = await import(
  pathToFileURL(
    path.join(hostDir, "node_modules/@earendil-works/pi-tui/dist/index.js"),
  )
);

async function withPanel(themeValue, fn) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "mc-v2-theme-"));
  const kernel = new MissionKernel({
    directory,
    cwd: directory,
    sessionId: "theme",
    workerFactory: async () => {
      throw new Error("No worker should run while viewing");
    },
    isLeadIdle: () => false,
    wake: () => assert.fail("Viewing must not wake lead"),
  });
  let returned = 0;
  const panel = new MissionPanel(
    kernel,
    () => {},
    () => {
      returned++;
    },
    { pollMs: 0, height: () => 60, theme: themeValue },
  );
  try {
    const member = kernel.addMember({
      name: "reviewer",
      role: "只读审查",
      workspace: {
        root: directory,
        access: "read-only",
        execution: "files",
        extraReadRoots: [],
      },
      allow: [],
      thinkingLevel: "off",
      temporary: false,
    });
    const logs = path.join(directory, "sessions", member.id);
    fs.mkdirSync(logs, { recursive: true });
    member.sessionFile = path.join(logs, "theme.jsonl");
    const messages = [
      { role: "user", content: "请*审查接口*，并核对 **测试证据**。" },
      {
        role: "assistant",
        content: [
          {
            type: "text",
            text: "# 审查结果\n\n*斜体*、**粗体**、~~删除线~~和`行内代码`。\n\n> 引用 *待复核项*\n\n- 完成读取\n- 继续检查\n\n1. 顺序一\n2. 顺序二\n\n[参考链接](https://example.com/source)\n\n---\n\n```ts\nconst checked = true;\n```\n\n| 项目 | 状态 |\n| --- | --- |\n| 接口 | 通过 |",
          },
        ],
      },
      {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            name: "read",
            arguments: { path: "interface.ts" },
          },
        ],
      },
      {
        role: "toolResult",
        toolName: "read",
        content: [{ type: "text", text: "TOOL_RETURN_VERIFIED" }],
      },
      {
        role: "toolResult",
        toolName: "read",
        isError: true,
        content: [{ type: "text", text: "EXPECTED_TOOL_ERROR" }],
      },
    ];
    fs.writeFileSync(
      member.sessionFile,
      messages
        .map((message) => JSON.stringify({ type: "message", message }))
        .join("\n") + "\n",
    );
    kernel.store.putMember(member);
    await panel.openMember(member.id);
    await fn({ panel, kernel, member, returned: () => returned });
  } finally {
    panel.dispose();
    await kernel.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

test("real installed Pi themes render user quotes, emphasis, lists, links and tool blocks without unsupported tokens", async () => {
  // 2.0.3 used mdItalic/mdBullet as colors. Real Theme rejects these; empty mocks did not.
  for (const name of ["dark", "light", "system"]) {
    initTheme(name, false);
    assert.equal(
      theme.name,
      name,
      "Verify the requested installed theme really loaded",
    );
    await withPanel(theme, async ({ panel }) => {
      for (const width of [20, 50, 80, 120, 180]) {
        let lines;
        assert.doesNotThrow(() => {
          lines = panel.render(width);
        }, `${name}/${width}`);
        assert.equal(
          panel.renderError,
          undefined,
          `${name}/${width}: ${panel.renderError}`,
        );
        assert.ok(lines.every((line) => visibleWidth(line) <= width));
      }
      const text = panel.render(120).map(stripTerminalSequences).join("\n");
      assert.match(text, /审查结果/);
      assert.match(text, /工具调用/);
      assert.match(text, /TOOL_RETURN_VERIFIED/);
      assert.doesNotMatch(text, /成员视图渲染失败/);
      panel.handleInput("\x1b");
      assert.match(
        panel.render(120).map(stripTerminalSequences).join("\n"),
        /TEAM STATUS/,
      );
    });
  }
});

test("a rendering exception stays inside the workbench and Escape still returns without changing runtime state", async () => {
  const broken = {
    fg: () => {
      throw new Error("fixture theme failed");
    },
  };
  await withPanel(broken, async ({ panel, kernel, returned }) => {
    const before = kernel.snapshot();
    for (const width of [20, 80, 120]) {
      const lines = panel.render(width);
      assert.match(lines.join("\n"), /成员视图渲染失败/);
      assert.match(panel.renderError, /fixture theme failed/);
      assert.ok(lines.every((line) => visibleWidth(line) <= width));
    }
    panel.handleInput("\x1b");
    assert.equal(panel.view, "team");
    assert.doesNotThrow(() => panel.render(80));
    panel.handleInput("\x1b");
    assert.equal(returned(), 1);
    assert.deepEqual(kernel.snapshot(), before);
  });
});

test("completed missions hide expired progress checks and completed members retain their visible status", async () => {
  initTheme("dark", false);
  await withPanel(theme, async ({ panel, kernel, member }) => {
    kernel.setGoal("Check completion display", ["Evidence present"]);
    kernel.complete([
      { criterion: 1, evidence: "Verified fixture evidence is present" },
    ]);
    assert.doesNotMatch(board(kernel, 120).join("\n"), /下次进度检查/);
    const now = Date.now();
    kernel.store.putTask({
      id: "completed",
      missionId: kernel.store.mission().id,
      member: member.name,
      memberId: member.id,
      rootId: "completed",
      state: "completed",
      phase: "work",
      epoch: 1,
      inputPath: "fixture",
      createdAt: now,
      updatedAt: now,
      timeoutMs: 1000,
      processState: "stopped",
      reviewDeliveryIds: [],
    });
    assert.match(
      panel.render(120).map(stripTerminalSequences).join("\n"),
      /完成 · 跟随最新/,
    );
    assert.equal(panel.renderError, undefined);
  });
});

test("status table separates goal, schedules and members while retaining the input viewport", async () => {
  for (const name of ["dark", "light", "system"]) {
    initTheme(name, false);
    await withPanel(theme, async ({ kernel, member }) => {
      kernel.setGoal("保留图形输出并完成验证", ["证据充分"]);
      kernel.addSchedule("阶段复核", "核查结果", Date.now() + 600000);
      for (let i = 0; i < 7; i++)
        kernel.addMember({ ...member, name: `member-${i}`, role: "执行员" });
      for (const [width, rows] of [
        [20, 12],
        [50, 24],
        [80, 30],
        [120, 40],
      ]) {
        const lines = board(kernel, width, false, theme, rows);
        const text = lines.map(stripTerminalSequences).join("\n");
        assert.ok(
          lines.length <= Math.max(4, Math.min(10, Math.floor(rows / 3))),
        );
        assert.ok(lines.every((line) => visibleWidth(line) <= width));
        if (width >= 76 && rows >= 24)
          assert.match(text, /类别.*名称.*状态.*时间/);
        else assert.doesNotMatch(text, /[│┌┐└┘]/);
      }
      const visible = board(kernel, 120, false, theme, 30)
        .map(stripTerminalSequences)
        .join("\n");
      assert.match(visible, /目标.*保留图形输出/);
      assert.match(visible, /定时任务.*阶段复核/);
      assert.match(visible, /另有 \d名成员/);
    });
  }
});

test("native panel backgrounds distinguish actions and errors while assistant replies remain unpainted", async () => {
  initTheme("dark", false);
  const painted = [];
  const real = {
    fg: (token, text) => theme.fg(token, text),
    bg: (token, text) => {
      painted.push({ token, text: stripTerminalSequences(text) });
      return theme.bg(token, text);
    },
    bold: (text) => theme.bold(text),
    italic: (text) => theme.italic(text),
    strikethrough: (text) => theme.strikethrough(text),
    underline: (text) => theme.underline(text),
  };
  await withPanel(real, async ({ panel }) => {
    panel.render(120);
    assert.equal(panel.renderError, undefined);
    for (const token of [
      "userMessageBg",
      "toolPendingBg",
      "toolSuccessBg",
      "toolErrorBg",
    ])
      assert.ok(
        painted.some((line) => line.token === token),
        token,
      );
    assert.ok(
      !painted.some((line) => /审查结果|删除线|参考链接/.test(line.text)),
      "Assistant prose does not get an action background",
    );
  });
});
