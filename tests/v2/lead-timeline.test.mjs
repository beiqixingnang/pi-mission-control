import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import { hostDir } from "../../scripts/host.mjs";
import { MissionKernel } from "../../runtime/kernel.ts";
const { createJiti } = await import(
  pathToFileURL(path.join(hostDir, "node_modules/jiti/lib/jiti.mjs"))
);
const tui = path.join(
  hostDir,
  "node_modules/@earendil-works/pi-tui/dist/index.js",
);
const jiti = createJiti(import.meta.url, {
  alias: { "@earendil-works/pi-tui": tui },
});
const { MissionPanel } = await jiti.import(
  path.resolve("extensions/mission-control/viewer.ts"),
);
const { visibleWidth } = await import(pathToFileURL(tui));
const start = new Date(2026, 9, 17, 23, 41, 8).getTime();

test("pure plugin lead timeline reads bounded public pages, follows updates and copies without time metadata", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mc-lead-timeline-"));
  const kernel = new MissionKernel({
    directory: dir,
    cwd: dir,
    sessionId: "lead-view",
    workerFactory: async () => {
      throw Error("Viewing must not create a worker");
    },
    isLeadIdle: () => false,
    wake: () => assert.fail("Viewing must not wake the model"),
  });
  const file = path.join(dir, "lead.jsonl");
  let copied = "",
    closed = 0;
  const panel = new MissionPanel(
    kernel,
    () => {},
    () => closed++,
    {
      pollMs: 0,
      height: () => 45,
      leadSessionFile: () => file,
      copyMessage: async (text) => {
        copied = text;
      },
      editMessage: () =>
        assert.fail("Main editing belongs to Pi's native editor"),
    },
  );
  const row = (i, text = "REPEATED_BODY") =>
    JSON.stringify({
      type: "message",
      id: `lead-${i}`,
      timestamp: new Date(start + i * 1000).toISOString(),
      message: {
        role: "assistant",
        timestamp: start + i * 1000,
        content: [
          {
            type: "thinking",
            thinking: "PRIVATE_LEAD_HISTORY",
            signature: "PRIVATE_SIGNATURE",
          },
          { type: "text", text },
        ],
      },
    }) + "\n";
  const original =
    JSON.stringify({
      type: "message",
      message: { role: "system", content: "PRIVATE_SYSTEM" },
    }) +
    "\n" +
    Array.from({ length: 120 }, (_, i) => row(i)).join("");
  fs.writeFileSync(file, original);
  try {
    const before = kernel.snapshot();
    await panel.openLead();
    assert.equal(panel.scope, "lead");
    assert.equal(panel.records.length, 40);
    let text = panel.render(140).join("\n");
    assert.match(text, /主会话 · 公开时间线/);
    assert.match(text, /非模型上下文/);
    assert.match(text, /23:4/);
    assert.doesNotMatch(text, /PRIVATE_/);
    assert.doesNotMatch(JSON.stringify(panel.records), /PRIVATE_/);
    panel.handleInput("c");
    await new Promise((resolve) => setImmediate(resolve));
    assert.match(copied, /主会话回复/);
    assert.match(copied, /REPEATED_BODY/);
    assert.doesNotMatch(copied, /23:4|时间未记录|\x1b/);
    panel.handleInput("f");
    const appended = row(120, "NEW_MAIN_PUBLIC");
    fs.appendFileSync(file, appended);
    await panel.refresh();
    assert.equal(panel.unread, true);
    assert.doesNotMatch(panel.render(140).join("\n"), /NEW_MAIN_PUBLIC/);
    panel.handleInput("\x1b[F");
    for (
      let i = 0;
      i < 100 &&
      !panel.records.some((r) => JSON.stringify(r).includes("NEW_MAIN_PUBLIC"));
      i++
    )
      await new Promise((resolve) => setTimeout(resolve, 5));
    assert.match(panel.render(140).join("\n"), /NEW_MAIN_PUBLIC/);
    await panel.older();
    assert.ok(panel.records.length > 40);
    for (const width of [5, 20, 50, 80, 120, 180])
      assert.ok(
        panel.render(width).every((line) => visibleWidth(line) <= width),
      );
    assert.deepEqual(kernel.snapshot(), before);
    assert.equal(fs.readFileSync(file, "utf8"), original + appended);
    panel.handleInput("m");
    assert.equal(closed, 1);
  } finally {
    panel.dispose();
    await kernel.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("team shortcut opens live-only main history without taking over the main input or dispatching work", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mc-lead-ephemeral-"));
  let closed = 0;
  const kernel = new MissionKernel({
    directory: dir,
    cwd: dir,
    sessionId: "ephemeral",
    workerFactory: async () => {
      throw Error("unused");
    },
    isLeadIdle: () => false,
    wake: () => assert.fail("Viewing must not request a model"),
  });
  const panel = new MissionPanel(
    kernel,
    () => {},
    () => closed++,
    {
      pollMs: 0,
      height: () => 40,
      leadSessionFile: () => undefined,
      leadPreviews: () => [
        {
          id: "live-main",
          kind: "assistant",
          title: "live",
          text: "LIVE_MAIN_TEXT",
          at: start,
          timestamp: start,
        },
      ],
    },
  );
  try {
    const before = kernel.snapshot();
    panel.handleInput("t");
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(panel.scope, "lead");
    assert.match(panel.render(140).join("\n"), /LIVE_MAIN_TEXT/);
    assert.match(panel.render(140).join("\n"), /尚无磁盘记录/);
    assert.equal(panel.file, undefined);
    panel.handleInput("\x1b");
    assert.equal(panel.view, "team");
    panel.handleInput("q");
    assert.equal(closed, 1);
    assert.deepEqual(kernel.snapshot(), before);
  } finally {
    panel.dispose();
    await kernel.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("withdrawn patch installer rejects apply against an isolated fake Pi installation", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mc-no-core-patch-"));
  try {
    fs.mkdirSync(path.join(dir, "dist"));
    fs.writeFileSync(path.join(dir, "dist/index.js"), "export {};\n");
    fs.writeFileSync(
      path.join(dir, "package.json"),
      JSON.stringify({ name: "fake-pi", version: "1.4.0" }),
    );
    const before = fs.readFileSync(path.join(dir, "dist/index.js"));
    const result = spawnSync(
      process.execPath,
      ["scripts/pi-timestamps.mjs", "apply"],
      {
        cwd: process.cwd(),
        env: { ...process.env, PI_TEST_PACKAGE_DIR: dir },
        encoding: "utf8",
        windowsHide: true,
      },
    );
    assert.equal(result.status, 1);
    assert.match(result.stderr, /installer has been removed/);
    assert.deepEqual(fs.readFileSync(path.join(dir, "dist/index.js")), before);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
