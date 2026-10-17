import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { hostDir } from "../../scripts/host.mjs";
import { createHash } from "node:crypto";
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
      const config = path.join(
        process.env.PI_CODING_AGENT_DIR,
        "compaction-summary.json",
      );
      const previous = process.env.MC_FIXTURE_SUMMARY;
      const previousSummaryModel = process.env.PI_COMPACTION_SUMMARY_MODEL;
      const previousDebug = process.env.PI_COMPACTION_DEBUG;
      process.env.MC_FIXTURE_SUMMARY = "success";
      process.env.PI_COMPACTION_SUMMARY_MODEL = "   ";
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
        await h.session.prompt("/compaction-model mission-fixture/model");
        const saved = JSON.parse(await fs.readFile(config, "utf8"));
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
          path.join(process.env.PI_CODING_AGENT_DIR, "compaction-summary.log"),
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
        await fs.rm(config, { force: true });
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
      assert.notEqual(state.members[0].sessionId, state.members[1].sessionId);
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
