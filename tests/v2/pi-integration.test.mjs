import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { hostDir } from "../../scripts/host.mjs";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const {
  createAgentSession,
  DefaultResourceLoader,
  SessionManager,
  SettingsManager,
} = await import(pathToFileURL(path.join(hostDir, "dist/index.js")));
const { exportSessionToHtml } = await import(
  pathToFileURL(path.join(hostDir, "dist/core/export-html/index.js"))
);
const { initTheme, theme: piTheme } = await import(
  pathToFileURL(path.join(hostDir, "dist/modes/interactive/theme/theme.js"))
);
const fixture = path.join(root, "tests/v2/offline-provider.ts");
const model = {
  id: "model",
  name: "fixture",
  provider: "mission-fixture",
  api: "mission-fixture",
  baseUrl: "http://127.0.0.1/unused",
  reasoning: false,
  input: ["text"],
  contextWindow: 64000,
  maxTokens: 4096,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};
async function harness(fn, mode = "rpc") {
  const cwd = fsSync.realpathSync.native(
      await fs.mkdtemp(path.join(os.tmpdir(), "mc-v2-pi-")),
    ),
    events = [],
    errors = [];
  const agentDir = process.env.PI_CODING_AGENT_DIR;
  assert.ok(
    agentDir,
    "Use scripts/test-v2.mjs for an isolated Pi agent directory",
  );
  const config = path.join(agentDir, "mission-control.json");
  await fs.writeFile(
    config,
    JSON.stringify({
      workerExtensions: [fixture],
      progressIntervalMs: 3600000,
    }),
  );
  const settings = SettingsManager.inMemory({
    retry: { enabled: false },
    cacheWarming: "off",
  });
  const resources = new DefaultResourceLoader({
    cwd,
    agentDir,
    settingsManager: settings,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noContextFiles: true,
    noThemes: true,
    additionalExtensionPaths: [
      fixture,
      path.join(root, "extensions/mission-control/index.ts"),
      path.join(root, "extensions/mission-control/compaction.ts"),
    ],
  });
  let session;
  try {
    await resources.reload();
    ({ session } = await createAgentSession({
      cwd,
      agentDir,
      model,
      settingsManager: settings,
      resourceLoader: resources,
      sessionManager: SessionManager.create(cwd, path.join(cwd, "sessions")),
    }));
    await session.bindExtensions({
      mode,
      onError: (error) => errors.push(error),
    });
    session.subscribe((event) => events.push(event));
    const tool = async (name, args = {}) => {
      const found = session.agent.state.tools.find((t) => t.name === name);
      assert.ok(found, `tool ${name}`);
      return await found.execute(
        "direct-" + crypto.randomUUID(),
        args,
        new AbortController().signal,
      );
    };
    const snapshot = async () =>
      JSON.parse((await tool("mission_status")).content[0].text);
    try {
      await fn({ cwd, session, settings, events, errors, tool, snapshot });
      assert.deepEqual(errors, []);
    } catch (error) {
      console.error(
        "INTEGRATION_DIAGNOSTIC",
        JSON.stringify(
          {
            last: session.getLastAssistantText()?.slice(0, 2000),
            state: await snapshot(),
            errors,
            tools: events
              .filter((e) => e.type === "tool_execution_end")
              .map((e) => ({ name: e.toolName, result: e.result })),
            settled: events.filter((e) => e.type === "agent_settled").length,
          },
          null,
          2,
        ),
      );
      throw error;
    }
  } finally {
    if (session) {
      await session.abort();
      await session.extensionRunner.emit({
        type: "session_shutdown",
        reason: "quit",
      });
      session.dispose();
    }
    await fs.rm(cwd, { recursive: true, force: true });
  }
}
async function until(fn, timeout = 25000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error("Timed out waiting for real Pi integration");
}

test(
  "real Pi recovers custom provider errors and exhausts exactly ten supplemental retries",
  { timeout: 25000 },
  () =>
    harness(async (h) => {
      await h.session.prompt("/reconnect on");
      await h.session.prompt("/reconnect delay 0");
      await h.session.prompt(
        "V2_TEST:" +
          JSON.stringify({
            op: "flaky",
            key: crypto.randomUUID(),
            failures: 2,
          }),
      );
      assert.equal(h.session.getLastAssistantText(), "RECOVERED_REQUEST_3");
      const before = h.events.filter(
        (e) => e.type === "message_end" && e.message?.role === "assistant",
      ).length;
      await h.session.prompt(
        "V2_TEST:" +
          JSON.stringify({
            op: "flaky",
            key: crypto.randomUUID(),
            failures: 100,
          }),
      );
      const responses = h.events
        .filter(
          (e) => e.type === "message_end" && e.message?.role === "assistant",
        )
        .slice(before);
      assert.equal(responses.length, 11, "initial request plus ten retries");
      assert.ok(responses.every((e) => e.message.stopReason === "error"));
    }),
);

test(
  "native Pi retry hands an exhausted 502 batch to the same bounded recovery path",
  { timeout: 15000 },
  () =>
    harness(async (h) => {
      h.settings.applyOverrides({
        retry: {
          enabled: true,
          maxRetries: 1,
          baseDelayMs: 0,
          maxAgentDelayMs: 0,
        },
      });
      await h.session.prompt("/reconnect on");
      await h.session.prompt("/reconnect delay 0");
      await h.session.prompt(
        "V2_TEST:" +
          JSON.stringify({
            op: "flaky",
            key: crypto.randomUUID(),
            failures: 3,
            error: "502 Bad Gateway",
          }),
      );
      assert.equal(h.session.getLastAssistantText(), "RECOVERED_REQUEST_4");
      assert.ok(h.events.some((e) => e.type === "auto_retry_start"));
      assert.ok(
        h.session.sessionManager
          .getEntries()
          .some(
            (e) =>
              e.type === "custom_message" &&
              e.customType === "mission-reconnect",
          ),
      );
    }),
);

test("real Pi never reconnects an unchanged request rejected for the screenshot's context overflow", () =>
  harness(async (h) => {
    await h.session.prompt("/reconnect on");
    await h.session.prompt("/reconnect delay 0");
    await h.session.prompt(
      "V2_TEST:" +
        JSON.stringify({
          op: "flaky",
          key: crypto.randomUUID(),
          failures: 100,
          error:
            "Your input exceeds the context window of this model. Please adjust your input and try again.",
        }),
    );
    assert.equal(
      h.events.filter(
        (e) => e.type === "message_end" && e.message?.role === "assistant",
      ).length,
      1,
    );
    assert.ok(
      !h.session.sessionManager
        .getBranch()
        .some(
          (e) =>
            e.type === "custom_message" && e.customType === "mission-reconnect",
        ),
    );
  }));

test(
  "aborting a real Pi provider backoff prevents another request",
  { timeout: 15000 },
  () =>
    harness(async (h) => {
      await h.session.prompt("/reconnect on");
      await h.session.prompt("/reconnect delay 0.3");
      const prompt = h.session.prompt(
        "V2_TEST:" +
          JSON.stringify({
            op: "flaky",
            key: crypto.randomUUID(),
            failures: 100,
          }),
      );
      await until(() =>
        h.events.some(
          (e) => e.type === "message_end" && e.message?.stopReason === "error",
        ),
      );
      await new Promise((r) => setTimeout(r, 20));
      await h.session.abort();
      await prompt;
      assert.equal(
        h.events.filter(
          (e) => e.type === "message_end" && e.message?.role === "assistant",
        ).length,
        1,
      );
    }),
);

test(
  "member provider requests inherit the user's recovery policy and keep their session",
  { timeout: 20000 },
  () =>
    harness(async (h) => {
      await h.session.prompt("/reconnect on");
      await h.session.prompt("/reconnect delay 0");
      const lead = h.session.prompt('V2_TEST:{"op":"hang"}');
      await until(() => h.session.isStreaming);
      try {
        await h.tool("team_spawn", {
          name: "flaky-worker",
          role: "recover fixture",
          workspace: { root: h.cwd, access: "read-only", execution: "files" },
        });
        const result = await h.tool("team_send", {
          to: "flaky-worker",
          message:
            "V2_TEST:" +
            JSON.stringify({
              op: "flaky",
              key: crypto.randomUUID(),
              failures: 2,
            }),
          wait: true,
        });
        assert.ok(!result.isError, result.content[0].text);
        assert.match(result.content[0].text, /RECOVERED_REQUEST_3/);
        assert.equal((await h.snapshot()).members.length, 1);
      } finally {
        await h.session.abort();
        await lead;
      }
    }),
);

test(
  "real Pi: no Goal/supervisor setup, child performs a read, lead ends and wakes automatically",
  { timeout: 40000 },
  () =>
    harness(async (h) => {
      const file = path.join(h.cwd, "marker.txt");
      await fs.writeFile(file, "CHILD_MARKER_7482");
      await h.session.prompt(
        "V2_TEST:" + JSON.stringify({ op: "lead", cwd: h.cwd, file }),
      );
      await until(() =>
        h.session.getLastAssistantText()?.includes("V2_WAKE_CONFIRMED"),
      );
      await until(
        async () =>
          h.session.isIdle &&
          (await h.snapshot()).deliveries.every((d) => d.state === "observed"),
      );
      const state = await h.snapshot();
      assert.equal(state.mission.status, "complete");
      assert.equal(state.members.length, 1);
      assert.equal(state.tasks[0].state, "completed");
      assert.match(state.tasks[0].summary, /CHILD_MARKER_7482/);
      const tools = h.events
        .filter((e) => e.type === "tool_execution_start")
        .map((e) => e.toolName);
      assert.ok(!tools.includes("goal_start"));
      assert.ok(!tools.includes("supervisor_control"));
      assert.ok(h.events.filter((e) => e.type === "agent_settled").length >= 2);
      const wake = h.session.sessionManager
        .getBranch()
        .find(
          (e) =>
            e.type === "custom_message" &&
            e.customType === "mission-control-wake",
        );
      assert.ok(wake);
      assert.ok(
        h.session.sessionManager
          .getBranch()
          .filter(
            (e) => e.type === "custom" && e.customType === "mission-control-v2",
          ).length === 1,
      );
      const html = await exportSessionToHtml(
        h.session.sessionManager,
        undefined,
        { outputPath: path.join(h.cwd, "native.html") },
      );
      assert.ok(html);
      assert.ok((await fs.stat(path.join(h.cwd, "native.html"))).size > 1000);
      assert.ok(
        (await fs.stat(h.session.sessionManager.getSessionFile())).size <
          150000,
        "sidecar state must not inflate native session export",
      );
    }),
);

test(
  "real Pi reactivates newly added Mission Control tools when an old session is reloaded",
  { timeout: 30000 },
  () =>
    harness(async (h) => {
      h.session.setActiveToolsByName(["read", "team_spawn"]);
      await h.session.reload();
      const active = h.session.agent.state.tools.map((tool) => tool.name);
      for (const name of [
        "goal_stop",
        "team_disband",
        "lifecycle_history",
        "schedule",
      ])
        assert.ok(active.includes(name), `missing reactivated tool ${name}`);
    }),
);

test(
  "real Pi tools: model cannot turn off maintenance, readonly host is rejected, native commands remain registered",
  { timeout: 10000 },
  () =>
    harness(async (h) => {
      const denied = await h.tool("supervisor_control", { action: "off" });
      assert.equal(denied.isError, true);
      assert.match(denied.content[0].text, /Only the user/);
      const invalid = await h.tool("team_spawn", {
        name: "bad-reader",
        role: "read",
        workspace: { root: h.cwd, access: "read-only", execution: "host" },
      });
      assert.equal(invalid.isError, true);
      const commands = h.session.getCommands?.() ?? [];
      const own = h.session.extensionRunner.getRegisteredCommands();
      assert.ok(
        !own.some((c) => ["export", "copy", "tree", "model"].includes(c.name)),
      );
      assert.equal(
        h.session.sessionManager
          .getBranch()
          .some((e) => e.type === "custom" && e.customType === "team-roster"),
        false,
      );
    }),
);

test("schedule ignores empty placeholders and resolves a meaningful one-shot selector", () =>
  harness(async (h) => {
    const result = await h.tool("schedule", {
      action: "create",
      at: "",
      afterSeconds: 3600,
      everySeconds: 1,
      id: "",
      title: "临时生命周期开关测试提醒",
      prompt: "随后的测试会删除",
    });
    assert.equal(result.isError, undefined, result.content?.[0]?.text);
    const schedule = JSON.parse(result.content[0].text);
    assert.equal(schedule.intervalMs, undefined);
    assert.equal((await h.snapshot()).schedules.length, 1);
  }));

test(
  "real RPC teammate review closes downstream work before the parent delivery",
  { timeout: 40000 },
  () =>
    harness(async (h) => {
      const file = path.join(h.cwd, "receipt.txt");
      await fs.writeFile(file, "DESCENDANT_EVIDENCE_419");
      for (const name of ["reviewer", "worker"]) {
        const r = await h.tool("team_spawn", {
          name,
          role: name,
          model: "mission-fixture/model",
          workspace: { root: h.cwd, access: "read-only", execution: "files" },
          communication: { allow: name === "reviewer" ? ["worker"] : [] },
        });
        assert.ok(!r.isError, r.content[0].text);
      }
      // Hold the actual lead busy with a hanging provider so ordinary root completion cannot race this direct-tool assertion.
      const running = h.session.prompt('V2_TEST:{"op":"hang"}');
      await until(() => h.events.some((e) => e.type === "agent_start"));
      const sent = JSON.parse(
        (
          await h.tool("team_send", {
            to: "reviewer",
            message:
              "V2_TEST:" +
              JSON.stringify({
                op: "delegate",
                to: "worker",
                child: { op: "read", file },
              }),
          })
        ).content[0].text,
      );
      await until(async () => {
        const s = await h.snapshot();
        return s.tasks.some(
          (t) => t.id === sent.taskId && t.state === "completed",
        );
      });
      const state = await h.snapshot();
      assert.equal(state.tasks.length, 2);
      const parent = state.tasks.find((t) => t.id === sent.taskId);
      assert.match(parent.summary, /REVIEWED_DESCENDANT/);
      assert.match(parent.summary, /DESCENDANT_EVIDENCE_419/);
      assert.equal(parent.phase, "review");
      assert.equal(parent.epoch, 2);
      await h.session.abort();
      await running;
    }),
);

test(
  "host member executes commands but its file tools still deny paths outside its workspace",
  { timeout: 25000 },
  () =>
    harness(async (h) => {
      const outside = path.join(
        os.tmpdir(),
        "mc-v2-outside-" + crypto.randomUUID() + ".txt",
      );
      await fs.writeFile(outside, "not granted");
      try {
        const added = await h.tool("team_spawn", {
          name: "host-worker",
          role: "trusted host fixture",
          workspace: { root: h.cwd, execution: "host", access: "read-write" },
        });
        assert.ok(!added.isError, added.content[0].text);
        const running = h.session.prompt('V2_TEST:{"op":"hang"}');
        await until(() => h.events.some((e) => e.type === "agent_start"));
        let sent = JSON.parse(
          (
            await h.tool("team_send", {
              to: "host-worker",
              message:
                "V2_TEST:" + JSON.stringify({ op: "read", file: outside }),
            })
          ).content[0].text,
        );
        await until(async () =>
          (await h.snapshot()).tasks.some(
            (t) => t.id === sent.taskId && t.state === "completed",
          ),
        );
        assert.match(
          (await h.snapshot()).tasks.find((t) => t.id === sent.taskId).summary,
          /WORKSPACE_DENIED|outside/,
        );
        const command =
          process.platform === "win32"
            ? `& '${process.execPath.replaceAll("'", "''")}' -e "console.log('HOST_EXECUTED_2084')"`
            : `"${process.execPath}" -e "console.log('HOST_EXECUTED_2084')"`;
        sent = JSON.parse(
          (
            await h.tool("team_send", {
              to: "host-worker",
              message:
                "V2_TEST:" +
                JSON.stringify({
                  op: "tool",
                  name: process.platform === "win32" ? "powershell" : "bash",
                  args: { command },
                }),
            })
          ).content[0].text,
        );
        await until(async () =>
          (await h.snapshot()).tasks.some(
            (t) => t.id === sent.taskId && t.state === "completed",
          ),
        );
        assert.match(
          (await h.snapshot()).tasks.find((t) => t.id === sent.taskId).summary,
          /HOST_EXECUTED_2084/,
        );
        await h.session.abort();
        await running;
      } finally {
        await fs.rm(outside, { force: true });
      }
    }),
);

test(
  "cancelling a real host command terminates its managed grandchild process",
  { timeout: 30000 },
  () =>
    harness(async (h) => {
      const ready = path.join(h.cwd, "grandchild.json"),
        script = path.join(h.cwd, "long-command.cjs");
      await fs.writeFile(
        script,
        `const fs=require('node:fs'),cp=require('node:child_process');const child=cp.spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});fs.writeFileSync(${JSON.stringify(ready)},JSON.stringify({parent:process.pid,child:child.pid}));setInterval(()=>{},1000);`,
      );
      await h.tool("team_spawn", {
        name: "executor",
        role: "process-tree fixture",
        workspace: { root: h.cwd, execution: "host", access: "read-write" },
      });
      const running = h.session.prompt('V2_TEST:{"op":"hang"}');
      await until(() => h.events.some((e) => e.type === "agent_start"));
      const command =
        process.platform === "win32"
          ? `& '${process.execPath.replaceAll("'", "''")}' '${script.replaceAll("'", "''")}'`
          : `"${process.execPath}" "${script}"`;
      const sent = JSON.parse(
        (
          await h.tool("team_send", {
            to: "executor",
            message:
              "V2_TEST:" +
              JSON.stringify({
                op: "tool",
                name: process.platform === "win32" ? "powershell" : "bash",
                args: { command },
              }),
          })
        ).content[0].text,
      );
      await until(() => fsSync.existsSync(ready));
      const pids = JSON.parse(await fs.readFile(ready, "utf8"));
      const cancelled = await h.tool("team_cancel", { taskId: sent.taskId });
      assert.ok(!cancelled.isError, cancelled.content[0].text);
      const alive = (pid) => {
        try {
          process.kill(pid, 0);
          return true;
        } catch {
          return false;
        }
      };
      await until(() => !alive(pids.parent) && !alive(pids.child), 5000);
      assert.equal(
        (await h.snapshot()).tasks.find((t) => t.id === sent.taskId).state,
        "cancelled",
      );
      await h.session.abort();
      await running;
    }),
);

test(
  "many sidecar changes leave Pi native HTML export and public stream export intact",
  { timeout: 20000 },
  () =>
    harness(async (h) => {
      await h.session.prompt(
        'V2_TEST:{"op":"answer","text":"NATIVE_CAPABILITY_MARKER"}',
      );
      const before = (await fs.stat(h.session.sessionManager.getSessionFile()))
        .size;
      await h.tool("team_spawn", {
        name: "reader",
        role: "read",
        workspace: { root: h.cwd, access: "read-only", execution: "files" },
      });
      for (let i = 0; i < 75; i++)
        await h.tool("team_configure", {
          name: "reader",
          role: "configuration " + i + " " + "x".repeat(5000),
        });
      const after = (await fs.stat(h.session.sessionManager.getSessionFile()))
        .size;
      assert.equal(
        after,
        before,
        "runtime state changes never append Pi snapshots",
      );
      const native = path.join(h.cwd, "native-after-state.html");
      await h.session.exportToHtml(native);
      assert.match(await fs.readFile(native, "utf8"), /<!DOCTYPE html>/i);
      const publicFile = path.join(h.cwd, "public.jsonl");
      await h.session.prompt("/mission export " + publicFile);
      const rows = (await fs.readFile(publicFile, "utf8"))
        .trim()
        .split("\n")
        .map(JSON.parse);
      assert.ok(
        rows.some((r) =>
          JSON.stringify(r).includes("NATIVE_CAPABILITY_MARKER"),
        ),
      );
      assert.ok(rows.every((r) => r.role !== "system"));
    }),
);

test(
  "one-shot print mode joins its worker before returning instead of silently abandoning background work",
  { timeout: 20000 },
  () =>
    harness(async (h) => {
      const file = path.join(h.cwd, "oneshot.txt");
      await fs.writeFile(file, "ONESHOT_RESULT_881");
      await h.session.prompt(
        "V2_TEST:" +
          JSON.stringify({ op: "lead", sync: true, cwd: h.cwd, file }),
      );
      assert.match(h.session.getLastAssistantText(), /V2_WAKE_CONFIRMED/);
      const state = await h.snapshot();
      assert.equal(state.tasks[0].state, "completed");
      assert.equal(state.mission.status, "complete");
      assert.equal(state.deliveries[0].state, "observed");
    }, "print"),
);

test(
  "custom compression failure retains original history without issuing a default fallback request",
  { timeout: 20000 },
  () =>
    harness(async (h) => {
      const config = path.join(
        process.env.PI_CODING_AGENT_DIR,
        "compaction-summary.json",
      );
      await fs.writeFile(
        config,
        JSON.stringify({
          model: "mission-fixture/model",
          maxTokens: 1024,
          maxInputChars: 4000,
        }),
      );
      try {
        h.settings.applyOverrides({
          compaction: {
            enabled: true,
            reserveTokens: 2048,
            keepRecentTokens: 512,
          },
        });
        // The fixture does not recognize a summarization request; this is an intentional provider failure.
        for (let i = 0; i < 3; i++)
          await h.session.prompt(
            "V2_TEST:" +
              JSON.stringify({
                op: "answer",
                text: "retain original turn " + "x".repeat(3000),
              }),
          );
        const before = h.session.sessionManager.getBranch().length;
        await assert.rejects(h.session.compact(), /cancel|abort/i);
        assert.ok(h.session.sessionManager.getBranch().length >= before);
        const diagnostic = JSON.parse(
          await fs.readFile(
            path.join(
              process.env.PI_CODING_AGENT_DIR,
              "mission-control",
              "v2",
              h.session.sessionManager.getSessionId(),
              "compaction-diagnostics.json",
            ),
            "utf8",
          ),
        );
        assert.equal(diagnostic.stage, "compact:failed");
        assert.equal(diagnostic.lastResponse.stopReason, "error");
        assert.equal(diagnostic.lastResponse.textChars, 0);
        assert.doesNotMatch(
          JSON.stringify(diagnostic),
          /retain original turn|PRIVATE_|thinkingSignature/,
        );
        assert.equal(
          h.session.sessionManager
            .getBranch()
            .some((e) => e.type === "compaction"),
          false,
        );
        assert.match(h.session.getLastAssistantText(), /retain original turn/);
      } finally {
        await fs.rm(config, { force: true });
      }
    }),
);

test(
  "custom chunked compression installs a usable checkpoint through the real Pi lifecycle",
  { timeout: 20000 },
  () =>
    harness(async (h) => {
      const agentDir = process.env.PI_CODING_AGENT_DIR;
      const legacyConfig = path.join(agentDir, "compaction-summary.json");
      const previous = process.env.MC_FIXTURE_SUMMARY;
      const previousSummaryModel = process.env.PI_COMPACTION_SUMMARY_MODEL;
      const previousDebug = process.env.PI_COMPACTION_DEBUG;
      process.env.MC_FIXTURE_SUMMARY = "success";
      process.env.PI_COMPACTION_SUMMARY_MODEL = "   ";
      process.env.PI_COMPACTION_DEBUG = "1";
      const sessionDir = path.join(
        agentDir,
        "mission-control",
        "v2",
        h.session.sessionManager.getSessionId(),
      );
      const leadConfig = path.join(sessionDir, "compaction-summary.json");
      const memberConfig = path.join(
        sessionDir,
        "member-compaction-summary.json",
      );
      await fs.writeFile(
        legacyConfig,
        JSON.stringify({
          model: "mission-fixture/model",
          maxTokens: 1024,
          maxInputChars: 4000,
        }),
      );
      try {
        await h.session.prompt(
          "/compaction-model member mission-fixture/model",
        );
        const savedMember = JSON.parse(await fs.readFile(memberConfig, "utf8"));
        assert.equal(savedMember.model, "mission-fixture/model");
        await h.session.prompt("/compaction-model lead mission-fixture/model");
        const saved = JSON.parse(await fs.readFile(leadConfig, "utf8"));
        assert.equal(saved.maxTokens, 1024);
        assert.equal(saved.maxInputChars, 4000);
        h.settings.applyOverrides({
          compaction: {
            enabled: true,
            reserveTokens: 2048,
            keepRecentTokens: 512,
          },
        });
        for (let i = 0; i < 3; i++)
          await h.session.prompt(
            "V2_TEST:" +
              JSON.stringify({
                op: "answer",
                text:
                  "History segment " +
                  i +
                  " " +
                  "retained objective and exact file ".repeat(300),
              }),
          );
        const compacted = await h.session.compact();
        assert.match(compacted.summary, /Summary retained/);
        const trace = await fs.readFile(
          path.join(sessionDir, "compaction-summary.log"),
          "utf8",
        );
        assert.match(trace, /compact:success/);
        assert.doesNotMatch(
          trace,
          /History segment|retained objective and exact file/,
        );
        assert.ok(
          h.session.sessionManager
            .getBranch()
            .some((e) => e.type === "compaction"),
        );
        await h.session.prompt(
          'V2_TEST:{"op":"answer","text":"AFTER_CUSTOM_COMPACTION"}',
        );
        assert.match(
          h.session.getLastAssistantText(),
          /AFTER_CUSTOM_COMPACTION/,
        );
      } finally {
        await fs.rm(legacyConfig, { force: true });
        await fs.rm(leadConfig, { force: true });
        await fs.rm(memberConfig, { force: true });
        if (previous === undefined) delete process.env.MC_FIXTURE_SUMMARY;
        else process.env.MC_FIXTURE_SUMMARY = previous;
        if (previousSummaryModel === undefined)
          delete process.env.PI_COMPACTION_SUMMARY_MODEL;
        else process.env.PI_COMPACTION_SUMMARY_MODEL = previousSummaryModel;
        if (previousDebug === undefined) delete process.env.PI_COMPACTION_DEBUG;
        else process.env.PI_COMPACTION_DEBUG = previousDebug;
      }
    }),
);

test("real Pi recovers gateway incomplete.length by subdividing the summary request", () =>
  harness(async (h) => {
    const directory = path.join(
      process.env.PI_CODING_AGENT_DIR,
      "mission-control",
      "v2",
      h.session.sessionManager.getSessionId(),
    );
    const config = path.join(directory, "compaction-summary.json");
    const previous = process.env.MC_FIXTURE_SUMMARY,
      previousDebug = process.env.PI_COMPACTION_DEBUG;
    process.env.MC_FIXTURE_SUMMARY = "subdivide";
    process.env.PI_COMPACTION_DEBUG = "1";
    await fs.writeFile(
      config,
      JSON.stringify({
        model: "mission-fixture/model",
        maxTokens: 1024,
        maxInputChars: 4000,
      }),
    );
    try {
      h.settings.applyOverrides({
        compaction: {
          enabled: true,
          reserveTokens: 2048,
          keepRecentTokens: 512,
        },
      });
      for (let i = 0; i < 3; i++)
        await h.session.prompt(
          "V2_TEST:" +
            JSON.stringify({
              op: "answer",
              text: "verified fixture " + "x".repeat(3000),
            }),
        );
      const result = await h.session.compact();
      assert.match(result.summary, /Summary retained/);
      assert.doesNotMatch(result.summary, /INCOMPLETE_SUMMARY/);
      const trace = (
        await fs.readFile(
          path.join(directory, "compaction-summary.log"),
          "utf8",
        )
      )
        .trim()
        .split("\n")
        .map(JSON.parse);
      assert.ok(
        trace.some(
          (row) =>
            row.stage === "summary:response" &&
            row.rawStopReason === "incomplete.length",
        ),
      );
      assert.ok(trace.some((row) => row.stage === "compact:success"));
      const requests = trace.filter((row) => row.stage === "summary:request");
      assert.ok(requests.some((row) => row.inputChars > 2600));
      assert.ok(requests.some((row) => row.inputChars < 2600));
    } finally {
      await fs.rm(config, { force: true });
      if (previous === undefined) delete process.env.MC_FIXTURE_SUMMARY;
      else process.env.MC_FIXTURE_SUMMARY = previous;
      if (previousDebug === undefined) delete process.env.PI_COMPACTION_DEBUG;
      else process.env.PI_COMPACTION_DEBUG = previousDebug;
    }
  }));

test("real Pi condenses a completed overlong summary and saves a usable checkpoint", () =>
  harness(async (h) => {
    const directory = path.join(
      process.env.PI_CODING_AGENT_DIR,
      "mission-control",
      "v2",
      h.session.sessionManager.getSessionId(),
    );
    const config = path.join(directory, "compaction-summary.json");
    const previous = process.env.MC_FIXTURE_SUMMARY,
      previousDebug = process.env.PI_COMPACTION_DEBUG;
    process.env.MC_FIXTURE_SUMMARY = "overlong";
    process.env.PI_COMPACTION_DEBUG = "1";
    await fs.writeFile(
      config,
      JSON.stringify({
        model: "mission-fixture/model",
        maxTokens: 1024,
        maxInputChars: 4000,
      }),
    );
    try {
      h.settings.applyOverrides({
        compaction: {
          enabled: true,
          reserveTokens: 2048,
          keepRecentTokens: 512,
        },
      });
      for (let i = 0; i < 3; i++)
        await h.session.prompt(
          "V2_TEST:" +
            JSON.stringify({
              op: "answer",
              text: "source evidence " + "x".repeat(3000),
            }),
        );
      const result = await h.session.compact();
      assert.match(result.summary, /KEEP_FINAL_EVIDENCE/);
      assert.doesNotMatch(result.summary, /OVERLONG_CANDIDATE/);
      assert.ok(result.summary.length <= 512);
      const trace = (
        await fs.readFile(
          path.join(directory, "compaction-summary.log"),
          "utf8",
        )
      )
        .trim()
        .split("\n")
        .map(JSON.parse);
      assert.ok(
        trace.some(
          (row) =>
            row.stage === "summary:response" &&
            row.stopReason === "stop" &&
            row.textChars > 512,
        ),
      );
      assert.ok(trace.some((row) => row.stage === "compact:success"));
      await h.session.prompt(
        'V2_TEST:{"op":"answer","text":"AFTER_OVERLONG_RECOVERY"}',
      );
      assert.match(h.session.getLastAssistantText(), /AFTER_OVERLONG_RECOVERY/);
    } finally {
      await fs.rm(config, { force: true });
      if (previous === undefined) delete process.env.MC_FIXTURE_SUMMARY;
      else process.env.MC_FIXTURE_SUMMARY = previous;
      if (previousDebug === undefined) delete process.env.PI_COMPACTION_DEBUG;
      else process.env.PI_COMPACTION_DEBUG = previousDebug;
    }
  }));

test(
  "subagent chain enforces dependency order and uses distinct persistent sessions",
  { timeout: 25000 },
  () =>
    harness(async (h) => {
      const result = await h.tool("subagent", {
        task: "",
        tasks: [],
        model: null,
        workspace: null,
        chain: [
          {
            agent: "scout",
            task: 'V2_TEST:{"op":"answer","text":"CHAIN_STAGE_ONE"}',
            model: null,
            workspace: {
              root: "",
              access: null,
              execution: null,
              extraReadRoots: null,
              sandbox: { engine: "podman", image: "" },
            },
          },
          {
            agent: "reviewer",
            task: 'V2_TEST:{"op":"answer","text":"CHAIN_STAGE_TWO"}',
          },
        ],
      });
      assert.ok(!result.isError, result.content[0].text);
      const accepted = JSON.parse(result.content[0].text).accepted;
      await until(
        async () =>
          (await h.snapshot()).tasks.filter((t) => t.state === "completed")
            .length === 2,
      );
      const state = await h.snapshot(),
        first = state.tasks.find((t) => t.id === accepted[0].taskId),
        second = state.tasks.find((t) => t.id === accepted[1].taskId);
      assert.equal(second.dependsOn, first.id);
      assert.ok(second.startedAt >= first.finishedAt);
      assert.equal(state.members.length, 0);
      const history = JSON.parse(
        (await h.tool("lifecycle_history")).content[0].text,
      );
      const archived = history.members.filter((member) =>
        [first.member, second.member].includes(member.name),
      );
      assert.equal(archived.length, 2);
      assert.notEqual(archived[0].sessionId, archived[1].sessionId);
    }),
);

test(
  "real model tool validation accepts optional placeholders without enabling a command backend",
  { timeout: 25000 },
  () =>
    harness(async (h) => {
      const file = path.join(h.cwd, "placeholder.txt");
      await fs.writeFile(file, "PLACEHOLDER_CHILD_OK");
      await h.session.prompt(
        "V2_TEST:" +
          JSON.stringify({ op: "lead", cwd: h.cwd, file, placeholders: true }),
      );
      await until(() =>
        h.session.getLastAssistantText()?.includes("V2_WAKE_CONFIRMED"),
      );
      const state = await h.snapshot();
      assert.equal(state.members.length, 1);
      assert.equal(state.members[0].workspace.execution, "files");
      assert.equal(state.members[0].workspace.access, "read-only");
      const configured = await h.tool("team_configure", {
        name: "fixture-worker",
        model: null,
        role: "",
        thinkingLevel: null,
        workspace: {},
        communication: null,
      });
      assert.ok(!configured.isError, configured.content[0].text);
      assert.equal(
        (await h.snapshot()).members[0].workspace.execution,
        "files",
      );
      assert.equal(
        (await h.snapshot()).members[0].model,
        "mission-fixture/model",
      );
      assert.ok(
        !h.events.some(
          (e) => e.type === "tool_execution_end" && e.result?.isError,
        ),
      );
    }),
);

test("invalid or ambiguous delegation is rejected before creating any members or tasks", () =>
  harness(async (h) => {
    for (const args of [
      { task: "one", tasks: [{ task: "two" }] },
      { tasks: [{ task: "one" }, { task: " " }] },
      {
        tasks: [
          { task: "one" },
          { task: "two", model: "not-configured/model" },
        ],
      },
    ]) {
      const result = await h.tool("subagent", args);
      assert.equal(result.isError, true);
      assert.equal((await h.snapshot()).members.length, 0);
      assert.equal((await h.snapshot()).tasks.length, 0);
    }
  }));

test(
  "real Pi dashboard opens live member history and returns without aborting the lead or changing work",
  { timeout: 30000 },
  () =>
    harness(async (h) => {
      let component,
        renders = 0,
        dispose;
      const widgets = [];
      const runner = h.session.extensionRunner;
      initTheme("dark", false);
      runner.setUIContext(
        {
          ...runner.getUIContext(),
          setWidget: (key, content, options) => {
            widgets.push({ key, content, options });
          },
          custom: async (factory) =>
            new Promise((resolve) => {
              component = factory(
                {
                  requestRender: () => {
                    renders++;
                  },
                },
                piTheme,
                {},
                resolve,
              );
              dispose = () => component.dispose?.();
            }),
        },
        "tui",
      );
      const file = path.join(h.cwd, "live.txt");
      await fs.writeFile(file, "LIVE_TOOL_RETURN_MARKER");
      const lead = h.session.prompt('V2_TEST:{"op":"hang"}');
      await until(() => h.session.isStreaming);
      await h.tool("team_spawn", {
        name: "live-reader",
        role: "Read fixture",
        workspace: { root: h.cwd, access: "read-only", execution: "files" },
      });
      const assigned = await h.tool("team_send", {
        to: "live-reader",
        message: "V2_TEST:" + JSON.stringify({ op: "stream-read", file }),
      });
      assert.ok(!assigned.isError, assigned.content[0].text);
      await until(() => widgets.some((w) => typeof w.content === "function"));
      assert.equal(
        widgets.find((w) => typeof w.content === "function").options.placement,
        "aboveEditor",
      );
      const opening = widgets.length;
      const showing = h.session.prompt("/mission view live-reader");
      try {
        await until(
          () =>
            component &&
            component.render(120).join("\n").includes("LIVE_PUBLIC_BEGIN"),
        );
        assert.equal(
          h.session.isStreaming,
          true,
          "viewing did not abort the lead",
        );
        assert.ok(
          (await h.snapshot()).tasks.some((t) => t.state === "running"),
        );
        await until(async () =>
          (await h.snapshot()).tasks.some((t) => t.state === "completed"),
        );
        await until(() =>
          component.render(120).join("\n").includes("LIVE_TOOL_RETURN_MARKER"),
        );
        const visible = component.render(120).join("\n");
        assert.doesNotMatch(visible, /PRIVATE_LIVE_/);
        assert.match(visible, /工具返回|调用工具/);
        const before = await h.snapshot();
        assert.ok(
          widgets.slice(opening).every((w) => w.content === undefined),
          "Main status panel stays hidden while viewing a member",
        );
        component.handleInput("\x1b"); // member -> team
        assert.match(component.render(120).join("\n"), /live-reader/);
        component.handleInput("\x1b"); // team -> Pi
        await showing;
        dispose();
        await until(() =>
          widgets.slice(opening).some((w) => typeof w.content === "function"),
        );
        assert.equal(h.session.isStreaming, true);
        assert.deepEqual((await h.snapshot()).tasks, before.tasks);
        assert.ok(renders > 0);
      } finally {
        dispose?.();
        await h.session.abort();
        await lead;
      }
    }),
);
test(
  "real Pi reload retains member identity and user pause without replaying an interrupted worker",
  { timeout: 20000 },
  () =>
    harness(async (h) => {
      await h.tool("team_spawn", {
        name: "persistent-reader",
        role: "reload fixture",
        workspace: { root: h.cwd, execution: "files", access: "read-only" },
      });
      const sent = JSON.parse(
        (
          await h.tool("team_send", {
            to: "persistent-reader",
            message: 'V2_TEST:{"op":"hang"}',
          })
        ).content[0].text,
      );
      await until(async () =>
        (await h.snapshot()).tasks.some(
          (t) => t.id === sent.taskId && t.state === "running",
        ),
      );
      const identity = (await h.snapshot()).members[0].id;
      await h.session.prompt("/mission pause");
      await h.session.reload();
      const state = await h.snapshot();
      assert.equal(state.members[0].id, identity);
      assert.equal(state.mission.status, "paused");
      assert.equal(state.mission.humanPaused, true);
      assert.equal(
        state.tasks.find((t) => t.id === sent.taskId).state,
        "interrupted",
      );
      assert.ok(state.deliveries.some((d) => d.kind === "recovery"));
      await new Promise((resolve) => setTimeout(resolve, 1200));
      assert.equal(
        (await h.snapshot()).tasks.filter((t) => t.state === "running").length,
        0,
      );
    }),
);

test(
  "real Pi opens the main public timeline during a live reply without modifying native Pi files",
  { timeout: 30000 },
  async () => {
    const nativeBase = path.join(hostDir, "dist/modes/interactive");
    const nativeFiles = [
      "components/user-message.js",
      "components/assistant-message.js",
      "components/tool-execution.js",
      "components/custom-message.js",
      "interactive-mode.js",
    ].map((file) => path.join(nativeBase, file));
    const chunks = path.join(hostDir, "dist/bundle/chunks");
    nativeFiles.push(
      ...fsSync
        .readdirSync(chunks)
        .filter((file) => file.endsWith(".js"))
        .map((file) => path.join(chunks, file)),
    );
    const fingerprint = () =>
      nativeFiles.map((file) =>
        createHash("sha256").update(fsSync.readFileSync(file)).digest("hex"),
      );
    const before = fingerprint();
    const { UserMessageComponent } = await import(
      pathToFileURL(path.join(nativeBase, "components/user-message.js"))
    );
    const nativeRender = UserMessageComponent.prototype.render;
    const nativeKey = Symbol.for("pi-mission-control.timestamp-renderer.v1"),
      previousRenderer = globalThis[nativeKey];
    await harness(async (h) => {
      let component, dispose;
      initTheme("dark", false);
      const runner = h.session.extensionRunner;
      runner.setUIContext(
        {
          ...runner.getUIContext(),
          custom: async (factory) =>
            new Promise((resolve) => {
              component = factory({ requestRender() {} }, piTheme, {}, resolve);
              dispose = () => component.dispose?.();
            }),
        },
        "tui",
      );
      const file = path.join(h.cwd, "main-read.txt");
      await fs.writeFile(file, "MAIN_TOOL_RETURN_MARKER");
      const lead = h.session.prompt(
        "V2_TEST:" + JSON.stringify({ op: "stream-read", file }),
      );
      await until(() => h.session.isStreaming);
      const viewing = h.session.prompt("/mission time");
      try {
        await until(
          () =>
            component &&
            component.render(160).join("\n").includes("LIVE_PUBLIC_BEGIN"),
        );
        assert.equal(h.session.isStreaming, true);
        assert.match(component.render(160).join("\n"), /公开时间线/);
        assert.doesNotMatch(component.render(160).join("\n"), /PRIVATE_LIVE_/);
        await lead;
        await until(() =>
          component.render(160).join("\n").includes("MAIN_TOOL_RETURN_MARKER"),
        );
        assert.doesNotMatch(component.render(160).join("\n"), /PRIVATE_LIVE_/);
        component.handleInput("m");
        await viewing;
        dispose();
        const state = await h.snapshot();
        assert.equal(state.members.length, 0);
        assert.equal(state.tasks.length, 0);
      } finally {
        dispose?.();
        await h.session.abort();
        await lead;
      }
    });
    assert.deepEqual(fingerprint(), before);
    assert.equal(UserMessageComponent.prototype.render, nativeRender);
    assert.equal(globalThis[nativeKey], previousRenderer);
  },
);

test(
  "real Pi reload migrates the screenshot's exhausted progress and can accept new approved work",
  { timeout: 25000 },
  () =>
    harness(async (h) => {
      await h.session.prompt(
        'V2_TEST:{"op":"answer","text":"LEGACY_RECOVERY_CONNECTION_OK"}',
      );
      await h.tool("goal_start", {
        objective: "Continue the existing approved fixture",
        criteria: ["Read saved evidence"],
      });
      const directory = path.join(
        process.env.PI_CODING_AGENT_DIR,
        "mission-control/v2",
        h.session.sessionManager.getSessionId(),
      );
      const db = new DatabaseSync(path.join(directory, "state.sqlite"));
      const mission = JSON.parse(
        db.prepare("SELECT data FROM meta WHERE key='mission'").get().data,
      );
      mission.status = "attention";
      mission.reason =
        "Automatic wake attempts failed. Results remain on disk; review /mission status and resume explicitly.";
      mission.turns = 6;
      mission.outputTokens = 321;
      const d = {
        id: crypto.randomUUID(),
        key: crypto.randomUUID(),
        from: "maintenance",
        to: "lead",
        kind: "progress",
        summary: "Old hourly report",
        state: "pending",
        createdAt: Date.now() - 60000,
        nextAttemptAt: 0,
        attempts: 3,
        missionId: mission.id,
      };
      db.prepare("UPDATE meta SET data=? WHERE key='mission'").run(
        JSON.stringify(mission),
      );
      db.prepare("INSERT INTO deliveries VALUES(?,?,?,?,?,?)").run(
        d.id,
        d.key,
        d.to,
        d.state,
        d.createdAt,
        JSON.stringify(d),
      );
      db.close();
      await h.session.reload();
      await until(async () =>
        (await h.snapshot()).deliveries.some(
          (x) => x.kind === "recovery" && x.state === "observed",
        ),
      );
      const restored = await h.snapshot();
      assert.equal(restored.mission.status, "active");
      assert.equal(restored.mission.budgetStartedAt, mission.budgetStartedAt);
      assert.ok(restored.mission.turns >= 6);
      assert.ok(restored.mission.outputTokens >= 321);
      await h.tool("team_spawn", {
        name: "recovered-worker",
        role: "read approved fixture",
        workspace: { root: h.cwd, access: "read-only", execution: "files" },
      });
      const file = path.join(h.cwd, "recovered.txt");
      await fs.writeFile(file, "RECOVERED_WORKER_EVIDENCE");
      const sent = await h.tool("team_send", {
        to: "recovered-worker",
        message: "V2_TEST:" + JSON.stringify({ op: "read", file }),
      });
      assert.ok(!sent.isError, sent.content[0].text);
      const task = JSON.parse(sent.content[0].text);
      await until(async () =>
        (await h.snapshot()).tasks.some(
          (t) => t.id === task.taskId && t.state === "completed",
        ),
      );
    }),
);

test(
  "real Pi automatically compacts overflow and schedules one idle recovery without renewing the goal budget",
  { timeout: 25000 },
  () =>
    harness(async (h) => {
      const previous = process.env.MC_FIXTURE_SUMMARY;
      process.env.MC_FIXTURE_SUMMARY = "success";
      const directory = path.join(
        process.env.PI_CODING_AGENT_DIR,
        "mission-control/v2",
        h.session.sessionManager.getSessionId(),
      );
      try {
        await h.session.prompt("/compaction-model lead mission-fixture/model");
        h.settings.applyOverrides({
          compaction: {
            enabled: false,
            reserveTokens: 2048,
            keepRecentTokens: 4096,
          },
        });
        for (let i = 0; i < 3; i++)
          await h.session.prompt(
            "V2_TEST:" +
              JSON.stringify({
                op: "answer",
                text:
                  "History " +
                  i +
                  " retained objective and evidence ".repeat(250),
              }),
          );
        await h.tool("goal_start", {
          objective: "Recover approved work",
          criteria: ["Preserve exact budget"],
        });
        const before = (await h.snapshot()).mission;
        await h.session.prompt(
          "V2_TEST:" +
            JSON.stringify({
              op: "flaky",
              key: crypto.randomUUID(),
              failures: 1,
              error:
                "Your input exceeds the context window of this model. Please adjust your input and try again.",
            }),
        );
        await until(
          async () =>
            h.events.some((e) => e.type === "compaction_end" && e.result) &&
            !(await h.snapshot()).recovery &&
            h.session.isIdle,
        );
        const after = await h.snapshot();
        assert.equal(after.mission.budgetStartedAt, before.budgetStartedAt);
        assert.equal(after.mission.humanPaused, false);
        assert.equal(after.held, false);
        assert.equal(after.mission.status, "active");
        assert.ok(
          h.session.getLastAssistantText().includes("RECOVERED_REQUEST_"),
        );
        assert.equal(
          h.events.filter((e) => e.type === "compaction_start").length,
          1,
        );
        assert.equal(
          h.session.sessionManager
            .getEntries()
            .filter(
              (e) =>
                e.type === "custom_message" &&
                e.customType === "mission-control-wake",
            ).length,
          1,
        );
        assert.equal(
          h.session.sessionManager
            .getEntries()
            .filter(
              (e) =>
                e.type === "custom_message" &&
                e.customType === "mission-reconnect",
            ).length,
          0,
        );
      } finally {
        if (previous === undefined) delete process.env.MC_FIXTURE_SUMMARY;
        else process.env.MC_FIXTURE_SUMMARY = previous;
        await fs.rm(path.join(directory, "compaction-summary.json"), {
          force: true,
        });
      }
    }),
);

test(
  "real Pi native retries cannot exceed the shared automatic recovery request cap",
  { timeout: 20000 },
  () =>
    harness(async (h) => {
      await fs.writeFile(
        path.join(process.env.PI_CODING_AGENT_DIR, "mission-control.json"),
        JSON.stringify({
          workerExtensions: [fixture],
          recoveryMaxRequests: 3,
          recoveryCooldownMs: 1000,
        }),
      );
      await h.session.reload();
      h.settings.applyOverrides({
        retry: {
          enabled: true,
          maxRetries: 20,
          baseDelayMs: 0,
          maxAgentDelayMs: 0,
        },
      });
      await h.session.prompt("/reconnect on");
      await h.session.prompt("/reconnect delay 0");
      await h.session.prompt(
        'V2_TEST:{"op":"answer","text":"READY_FOR_AUTOMATIC_REQUEST"}',
      );
      await h.tool("goal_start", {
        objective: "Bound the outage",
        criteria: ["No retry amplification"],
      });
      await h.tool("schedule", {
        action: "create",
        title: "outage",
        prompt:
          "V2_TEST:" +
          JSON.stringify({
            op: "flaky",
            key: crypto.randomUUID(),
            failures: 100,
            error: "502 Bad Gateway",
          }),
        afterSeconds: 1,
      });
      await until(
        async () =>
          (await h.snapshot()).recovery?.phase === "exhausted" &&
          h.session.isIdle,
      );
      const failures = () =>
        h.events.filter(
          (e) =>
            e.type === "message_end" &&
            e.message?.stopReason === "error" &&
            /502 Bad Gateway/.test(e.message.errorMessage ?? ""),
        ).length;
      assert.equal(failures(), 3);
      assert.equal((await h.snapshot()).recovery.requests, 3);
      assert.equal((await h.snapshot()).held, false);
      await new Promise((r) => setTimeout(r, 1200));
      assert.equal(failures(), 3);
    }),
);

test("a real provider-side abort remains a recoverable failure and never becomes a user Escape hold", () =>
  harness(async (h) => {
    await h.tool("goal_start", {
      objective: "Recover a provider abort",
      criteria: ["Preserve user control"],
    });
    await h.session.prompt(
      "V2_TEST:" +
        JSON.stringify({
          op: "flaky",
          key: crypto.randomUUID(),
          failures: 100,
          transportAbort: true,
        }),
    );
    const snapshot = await h.snapshot();
    assert.equal(snapshot.held, false);
    assert.equal(snapshot.recovery.kind, "provider");
    assert.equal(snapshot.mission.status, "active");
  }));

test(
  "real Pi upgrades an already expired default wall-time hold without erasing prior usage",
  { timeout: 15000 },
  () =>
    harness(async (h) => {
      await h.session.prompt(
        'V2_TEST:{"op":"answer","text":"BUDGET_UPGRADE_OK"}',
      );
      await h.tool("goal_start", {
        objective: "Continue long-running approved work",
        criteria: ["Preserve usage"],
      });
      const directory = path.join(
        process.env.PI_CODING_AGENT_DIR,
        "mission-control/v2",
        h.session.sessionManager.getSessionId(),
      );
      let prior;
      await h.session.reload({
        beforeSessionStart: () => {
          const db = new DatabaseSync(path.join(directory, "state.sqlite"));
          const m = JSON.parse(
            db.prepare("SELECT data FROM meta WHERE key='mission'").get().data,
          );
          m.budgetStartedAt = Date.now() - 13 * 3600000;
          m.turns = 250;
          m.outputTokens = 2100000;
          m.status = "attention";
          m.reason =
            "Mission continuation budget reached. Work/results are retained; /mission resume grants a new budget.";
          m.blocker = { kind: "budget", reason: m.reason };
          prior = m;
          db.prepare("UPDATE meta SET data=? WHERE key='mission'").run(
            JSON.stringify(m),
          );
          db.prepare("DELETE FROM meta WHERE key='missionActivityClock'").run();
          db.close();
        },
      });
      const state = await h.snapshot();
      assert.equal(state.mission.status, "active");
      assert.equal(state.mission.turns, 250);
      assert.equal(state.mission.outputTokens, 2100000);
      assert.equal(state.mission.budgetStartedAt, prior.budgetStartedAt);
      assert.deepEqual(state.budgets, {
        timeMs: null,
        turns: null,
        outputTokens: null,
      });
      await h.session.prompt(
        'V2_TEST:{"op":"answer","text":"STILL_USABLE_AFTER_UPGRADE"}',
      );
      assert.equal(
        h.session.getLastAssistantText(),
        "STILL_USABLE_AFTER_UPGRADE",
      );
    }),
);

test(
  "real Pi native member selection stays alive with four current members and many retired task identities",
  { timeout: 15000 },
  () =>
    harness(async (h) => {
      for (const name of [
        "cpu-executor",
        "cpu-supervisor",
        "gpu-executor",
        "gpu-supervisor",
      ])
        await h.tool("team_spawn", {
          name,
          role: name,
          workspace: { root: h.cwd, access: "read-only", execution: "files" },
        });
      const directory = path.join(
        process.env.PI_CODING_AGENT_DIR,
        "mission-control/v2",
        h.session.sessionManager.getSessionId(),
      );
      const db = new DatabaseSync(path.join(directory, "state.sqlite"));
      for (let i = 0; i < 25; i++) {
        const task = {
          id: `old-task-${i}`,
          memberId: `retired-member-${i}`,
          member: `retired-reader-${i}`,
          missionId: "old",
          rootId: `old-task-${i}`,
          state: "completed",
          epoch: 1,
          phase: "work",
          inputPath: "unused",
          createdAt: i,
          updatedAt: i,
          timeoutMs: 1000,
          processState: "stopped",
          reviewDeliveryIds: [],
        };
        db.prepare("INSERT INTO tasks VALUES(?,?,?,?,?,?)").run(
          task.id,
          task.memberId,
          null,
          task.state,
          i,
          JSON.stringify(task),
        );
      }
      db.close();
      let component, dispose;
      const runner = h.session.extensionRunner;
      initTheme("dark", false);
      runner.setUIContext(
        {
          ...runner.getUIContext(),
          custom: async (factory) =>
            new Promise((resolve) => {
              component = factory({ requestRender() {} }, piTheme, {}, resolve);
              dispose = () => component.dispose?.();
            }),
        },
        "tui",
      );
      const lead = h.session.prompt('V2_TEST:{"op":"hang"}');
      await until(() => h.session.isStreaming);
      const showing = h.session.prompt("/mission");
      try {
        await until(() => Boolean(component));
        const text = component.render(120).join("\n");
        for (const name of [
          "cpu-executor",
          "cpu-supervisor",
          "gpu-executor",
          "gpu-supervisor",
        ])
          assert.equal(text.split(name).length - 1, 1);
        assert.doesNotMatch(text, /retired-reader/);
        const member = (await h.snapshot()).members[0];
        const edit = new DatabaseSync(path.join(directory, "state.sqlite"));
        edit.prepare("DELETE FROM members WHERE id=?").run(member.id);
        edit.close();
        component.handleInput("\r");
        await new Promise(setImmediate);
        assert.match(component.render(120).join("\n"), /成员列表已更新/);
        assert.equal(h.session.isStreaming, true);
        component.handleInput("\r");
        await new Promise(setImmediate);
        component.render(120);
        assert.equal(h.session.isStreaming, true);
        component.handleInput("\x1b");
        component.handleInput("\x1b");
        await showing;
      } finally {
        dispose?.();
        await h.session.abort();
        await lead;
      }
    }),
);

test(
  "real Pi provider cooldown does not keep charging the goal activity clock",
  { timeout: 10000 },
  () =>
    harness(async (h) => {
      await h.tool("goal_start", {
        objective: "Measure actual activity",
        criteria: ["No idle charge"],
      });
      await h.session.prompt(
        "V2_TEST:" +
          JSON.stringify({
            op: "flaky",
            key: crypto.randomUUID(),
            failures: 100,
          }),
      );
      const before = await h.snapshot();
      assert.equal(before.activity.state, "stalled");
      await new Promise((resolve) => setTimeout(resolve, 1200));
      const after = await h.snapshot();
      assert.equal(after.activity.activeMs, before.activity.activeMs);
      assert.equal(after.mission.outputTokens, before.mission.outputTokens);
    }),
);

test(
  "one host registry directly exposes every plugin module and refreshes schemas after an old-tool reload",
  { timeout: 15000 },
  () =>
    harness(async (h) => {
      h.session.setActiveToolsByName(["read"]);
      await h.session.prompt(
        'V2_TEST:{"op":"tools","schemaFor":"mission_reconcile"}',
      );
      const declared = JSON.parse(h.session.getLastAssistantText());
      for (const name of [
        "mission_reconcile",
        "mission_control",
        "mission_report",
        "mission_export",
        "mission_history",
        "team_message",
        "mission_compact",
        "reconnect_config",
        "compaction_model",
        "project_apply",
        "project_recover",
      ])
        assert.ok(declared.names.includes(name), `not declared: ${name}`);
      assert.equal(
        declared.schema.properties.tasks.items.properties.expectedEpoch.type,
        "integer",
      );
      const catalog = JSON.parse(
        (await h.tool("mission_capabilities")).content[0].text,
      );
      assert.equal(catalog.tools.length, 43);
      assert.ok(catalog.tools.every((t) => t.active));
      h.session.setActiveToolsByName(["read"]);
      await h.session.reload();
      await h.session.prompt(
        'V2_TEST:{"op":"tools","schemaFor":"compaction_model"}',
      );
      const restored = JSON.parse(h.session.getLastAssistantText());
      assert.ok(restored.names.includes("project_apply"));
      assert.ok(restored.names.includes("compaction_model"));
      assert.ok(restored.schema.properties.target);
    }),
);

test(
  "real model tools reconcile the four stale executions then resume no-progress without a user slash command",
  { timeout: 20000 },
  () =>
    harness(async (h) => {
      await h.session.prompt(
        'V2_TEST:{"op":"answer","text":"RECOVERY_FIXTURE"}',
      );
      await h.tool("goal_start", {
        objective: "Continue the approved fixture",
        criteria: ["Read evidence"],
      });
      const file = path.join(h.cwd, "evidence.txt");
      await fs.writeFile(file, "RECONCILED_ATTEMPT_EVIDENCE");
      const members = [];
      for (const name of [
        "cpu-executor",
        "cpu-supervisor",
        "gpu-executor",
        "gpu-supervisor",
      ])
        members.push(
          JSON.parse(
            (
              await h.tool("team_spawn", {
                name,
                role: name,
                workspace: {
                  root: h.cwd,
                  access: "read-only",
                  execution: "files",
                },
              })
            ).content[0].text,
          ),
        );
      const directory = path.join(
        process.env.PI_CODING_AGENT_DIR,
        "mission-control/v2",
        h.session.sessionManager.getSessionId(),
      );
      const db = new DatabaseSync(path.join(directory, "state.sqlite"));
      const m = JSON.parse(
        db.prepare("SELECT data FROM meta WHERE key='mission'").get().data,
      );
      m.status = "attention";
      m.blocker = {
        kind: "no_progress",
        reason: "Three prior automatic requests did not progress",
      };
      m.turns = 22;
      m.outputTokens = 500;
      m.emptyTurns = 3;
      db.prepare("UPDATE meta SET data=? WHERE key='mission'").run(
        JSON.stringify(m),
      );
      const tasks = [];
      for (let i = 0; i < 4; i++) {
        const id = crypto.randomUUID(),
          inputPath = path.join(directory, "artifacts", id + ".input.txt");
        await fs.writeFile(
          inputPath,
          "V2_TEST:" + JSON.stringify({ op: "read", file }),
        );
        const task = {
          id,
          missionId: m.id,
          memberId: members[i].id,
          member: members[i].name,
          rootId: id,
          state: "interrupted",
          epoch: 3,
          phase: "work",
          inputPath,
          createdAt: Date.now(),
          updatedAt: Date.now(),
          timeoutMs: 600000,
          processState: "unknown",
          reviewDeliveryIds: [],
        };
        db.prepare("INSERT INTO tasks VALUES(?,?,?,?,?,?)").run(
          task.id,
          task.memberId,
          null,
          task.state,
          task.createdAt,
          JSON.stringify(task),
        );
        tasks.push({ taskId: id, expectedEpoch: 3 });
      }
      db.close();
      await h.session.prompt(
        "V2_TEST:" +
          JSON.stringify({
            op: "tool",
            name: "mission_reconcile",
            args: {
              tasks,
              evidence:
                "Inspected saved execution receipts and host inventory; these old fixture executions have no remaining workers",
            },
          }),
      );
      assert.equal(JSON.parse(h.session.getLastAssistantText()).isError, false);
      assert.ok(
        (await h.snapshot()).tasks
          .filter((t) => tasks.some((x) => x.taskId === t.id))
          .every((t) => t.processState === "stopped"),
      );
      await h.session.prompt(
        "V2_TEST:" +
          JSON.stringify({
            op: "tool",
            name: "mission_control",
            args: {
              action: "resume",
              goalId: m.id,
              expectedRevision: 0,
              reason:
                "Reconciled the four interrupted executions; continue the approved read fixture",
            },
          }),
      );
      const restored = await h.snapshot();
      assert.equal(restored.mission.status, "active");
      assert.equal(restored.mission.turns, 22);
      assert.equal(restored.mission.budgetStartedAt, m.budgetStartedAt);
      assert.ok(restored.mission.outputTokens >= 500);
      const retried = await h.tool("team_resume", { taskId: tasks[0].taskId });
      assert.ok(!retried.isError, retried.content[0].text);
      const next = JSON.parse(retried.content[0].text);
      assert.equal(next.attemptOf, tasks[0].taskId);
      await until(async () =>
        (await h.snapshot()).tasks.some(
          (t) => t.id === next.id && t.state === "completed",
        ),
      );
    }),
);

test(
  "model-visible settings, public history and export share their session command implementations",
  { timeout: 15000 },
  () =>
    harness(async (h) => {
      await h.session.prompt(
        'V2_TEST:{"op":"tool","name":"compaction_model","args":{"action":"set","target":"lead","model":"mission-fixture/model"}}',
      );
      assert.equal(JSON.parse(h.session.getLastAssistantText()).isError, false);
      const lead = JSON.parse(
        (await h.tool("compaction_model", { target: "lead" })).content[0].text,
      );
      await h.tool("compaction_model", {
        action: "set",
        target: "member",
        model: "mission-fixture/model",
      });
      const member = JSON.parse(
        (await h.tool("compaction_model", { target: "member" })).content[0]
          .text,
      );
      assert.notEqual(lead.file, member.file);
      const reconnect = await h.tool("reconnect_config", {
        action: "set",
        enabled: true,
        maxRetries: 2,
        delayMs: 1,
      });
      assert.ok(!reconnect.isError);
      assert.equal(JSON.parse(reconnect.content[0].text).maxRetries, 2);
      await h.tool("mission_report", { seconds: 7200 });
      assert.equal((await h.snapshot()).nextReportAt, undefined);
      h.session.sessionManager.appendMessage({
        role: "assistant",
        api: model.api,
        provider: model.provider,
        model: model.id,
        stopReason: "stop",
        timestamp: Date.now(),
        content: [
          {
            type: "thinking",
            thinking: "PRIVATE_HISTORY_REASONING",
            signature: "PRIVATE_HISTORY_SIGNATURE",
          },
          { type: "text", text: "PUBLIC_HISTORY_EVIDENCE" },
        ],
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
      });
      const history = await h.tool("mission_history", { limit: 100 });
      assert.match(history.content[0].text, /PUBLIC_HISTORY_EVIDENCE/);
      assert.doesNotMatch(history.content[0].text, /PRIVATE_HISTORY_/);
      const destination = path.join(h.cwd, "public-export.jsonl");
      const exported = await h.tool("mission_export", { destination });
      assert.ok(!exported.isError, exported.content[0].text);
      const text = await fs.readFile(destination, "utf8");
      assert.match(text, /PUBLIC_HISTORY_EVIDENCE/);
      assert.doesNotMatch(text, /PRIVATE_HISTORY_/);
      assert.ok(
        (await h.tool("mission_export", { destination })).isError,
        "export cannot overwrite an existing file",
      );
    }),
);

test(
  "a real model compaction request settles before compacting and preserves native cancel semantics",
  { timeout: 20000 },
  () =>
    harness(async (h) => {
      const previous = process.env.MC_FIXTURE_SUMMARY;
      process.env.MC_FIXTURE_SUMMARY = "success";
      try {
        await h.tool("compaction_model", {
          action: "set",
          target: "lead",
          model: "mission-fixture/model",
        });
        h.settings.applyOverrides({
          compaction: {
            enabled: false,
            reserveTokens: 2048,
            keepRecentTokens: 512,
          },
        });
        for (let i = 0; i < 3; i++)
          await h.session.prompt(
            "V2_TEST:" +
              JSON.stringify({
                op: "answer",
                text: "History " + i + " verified evidence ".repeat(300),
              }),
          );
        await h.session.prompt(
          'V2_TEST:{"op":"tool","name":"mission_compact","args":{}}',
        );
        await until(
          () =>
            h.events.some((e) => e.type === "compaction_end" && e.result) &&
            h.session.isIdle,
        );
        assert.equal((await h.snapshot()).held, false);
        assert.equal((await h.snapshot()).compactionQueued, false);
        assert.equal(
          h.events.filter((e) => e.type === "compaction_start").length,
          1,
        );
        await h.session.prompt(
          'V2_TEST:{"op":"answer","text":"AFTER_REQUESTED_COMPACTION"}',
        );
        assert.equal(
          h.session.getLastAssistantText(),
          "AFTER_REQUESTED_COMPACTION",
        );
      } finally {
        if (previous === undefined) delete process.env.MC_FIXTURE_SUMMARY;
        else process.env.MC_FIXTURE_SUMMARY = previous;
      }
    }),
);

test("real Pi decisions reject extension-origin answers and preserve waiting across a status question", () =>
  harness(async (h) => {
    await h.tool("goal_start", {
      objective: "Choose a fixture target",
      criteria: ["Human answer"],
    });
    const asked = JSON.parse(
        (
          await h.tool("mission_decision", {
            reason: "Which target should be used?",
          })
        ).content[0].text,
      ),
      id = asked.decision.id;
    await h.session.prompt(
      'V2_TEST:{"op":"answer","text":"What is the progress?"}',
      { source: "interactive" },
    );
    assert.equal((await h.snapshot()).mission.status, "waiting_user");
    await h.session.prompt('V2_TEST:{"op":"answer","text":"Use target A"}', {
      source: "extension",
    });
    const rejected = await h.tool("mission_decision", {
      action: "resolve",
      decisionId: id,
      answer: "Use target A",
    });
    assert.ok(rejected.isError);
    await h.session.prompt('V2_TEST:{"op":"answer","text":"Use target A"}', {
      source: "interactive",
    });
    const resolved = await h.tool("mission_decision", {
      action: "resolve",
      decisionId: id,
      answer: "Use target A",
    });
    assert.ok(!resolved.isError, resolved.content[0].text);
    assert.equal((await h.snapshot()).mission.status, "active");
  }));
