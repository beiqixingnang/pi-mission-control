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
            settled: events.filter((e) => e.type === "agent_settled"),
            compactions: events.filter((e) => e.type.startsWith("compaction")),
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
  "new real Pi members inherit notes and a 300k budget while the lead retains summary mode",
  { timeout: 20000 },
  () =>
    harness(async (h) => {
      await fs.writeFile(
        path.join(process.env.PI_CODING_AGENT_DIR, "mission-control.json"),
        JSON.stringify({
          workerExtensions: [fixture],
          memberContext: { mode: "notes", inputLimitTokens: 300000 },
        }),
      );
      await h.session.reload();
      const lead = h.session.prompt('V2_TEST:{"op":"hang"}');
      await until(() => h.session.isStreaming);
      try {
        await h.tool("team_spawn", {
          name: "notes-default-reader",
          role: "Inspect current standalone memory preferences",
          model: "mission-fixture/wide",
        });
        const result = await h.tool("team_send", {
          to: "notes-default-reader",
          message: 'V2_TEST:{"op":"tool","name":"context_mode","args":{}}',
          wait: true,
        });
        assert.ok(!result.isError, result.content[0].text);
        const reply = JSON.parse(JSON.parse(result.content[0].text).result);
        const state = JSON.parse(reply.text);
        assert.equal(state.mode, "notes");
        assert.equal(state.budget.inputLimitTokens, 300000);
        assert.equal(
          JSON.parse((await h.tool("context_mode")).content[0].text).mode,
          "summary",
        );
      } finally {
        await h.session.abort();
        await lead;
      }
    }),
);

test(
  "real Pi member drains cumulative RPC snapshots above 8 MiB, retries a stream failure and keeps every notes window",
  { timeout: 45000 },
  () =>
    harness(async (h) => {
      await h.session.prompt("/reconnect on");
      await h.session.prompt("/reconnect delay 0");
      const held = h.session.prompt('V2_TEST:{"op":"hang"}');
      await until(() => h.session.isStreaming);
      try {
        const accepted = await h.tool("subagent", {
          task: 'V2_TEST:{"op":"large-rpc-run","windows":4,"readsPerWindow":40}',
          timeoutPolicy: "none",
        });
        const id = JSON.parse(accepted.content[0].text).accepted[0].taskId;
        await until(
          async () =>
            ["completed", "failed"].includes(
              (await h.snapshot()).tasks.find((t) => t.id === id)?.state,
            ),
          35000,
        );
        const task = (await h.snapshot()).tasks.find((t) => t.id === id);
        assert.equal(task.state, "completed", task.error);
        const result = JSON.parse(
          (await h.tool("team_collect", { taskId: id })).content[0].text,
        )[0].result;
        assert.match(result, /BIG_RPC_RECOVERED_WITHOUT_REPLAY/);
        const rows = (await fs.readFile(task.sessionFile, "utf8"))
          .trim()
          .split("\n")
          .map(JSON.parse);
        assert.equal(
          rows.filter(
            (r) =>
              r.type === "compaction" && r.details?.contextMode === "notes",
          ).length,
          4,
        );
        assert.equal(
          rows.filter(
            (r) =>
              r.message?.role === "toolResult" &&
              r.message.toolName === "fixture_large_read" &&
              !r.message.isError,
          ).length,
          160,
        );
        const bytes = rows.reduce(
          (n, r) =>
            n + (r.message ? Buffer.byteLength(JSON.stringify(r.message)) : 0),
          0,
        );
        assert.ok(bytes > 8 * 1024 * 1024, `only ${bytes} bytes accumulated`);
        assert.ok(
          rows.some(
            (r) =>
              r.message?.stopReason === "error" &&
              r.message.errorMessage?.includes("malformed"),
          ),
        );
      } finally {
        await h.session.abort();
        await held;
      }
    }),
);

test(
  "real Pi notes rollover automatically resumes the same conversation and keeps searchable public history",
  { timeout: 20000 },
  () =>
    harness(async (h) => {
      const sessionId = h.session.sessionManager.getSessionId();
      h.settings.applyOverrides({ compaction: { keepRecentTokens: 1024 } });
      await h.tool("context_mode", { mode: "notes" });
      await h.session.prompt(
        "V2_TEST:" +
          JSON.stringify({
            op: "tool",
            name: "context_note",
            args: {
              action: "write",
              name: "topic/warmup",
              text: "Older synthetic evidence for native compaction. ".repeat(
                200,
              ),
            },
          }),
      );
      await h.session.prompt(
        'V2_TEST:{"op":"tool","name":"context_note","args":{"action":"write","name":"index","text":"Review the synthetic decoder; no acceptance yet."}}',
      );
      await h.session.prompt(
        'V2_TEST:{"op":"tool","name":"context_note","args":{"action":"write","name":"handoff","text":"Continue decoder.py at line 173. HISTORY_NEEDLE_173 remains unverified."}}',
      );
      await h.session.prompt(
        'V2_TEST:{"op":"tool","name":"context_rollover","args":{}}',
      );
      await until(() =>
        h.session.getLastAssistantText()?.includes("CONTEXT_WINDOW_RESUMED"),
      );
      assert.equal(h.session.sessionManager.getSessionId(), sessionId);
      const result = JSON.parse(
        (
          await h.tool("context_history", {
            action: "search",
            query: "HISTORY_NEEDLE_173",
          })
        ).content[0].text,
      );
      assert.ok(result.matches.length > 0);
      await h.session.reload();
      const status = JSON.parse((await h.tool("context_mode")).content[0].text);
      assert.equal(status.mode, "notes");
      await h.tool("context_mode", { mode: "summary" });
    }),
);

test(
  "managed Pi members survive three automatic notes windows without an early task completion",
  { timeout: 30000 },
  () =>
    harness(async (h) => {
      const file = path.join(h.cwd, "cycle-decoder.ts");
      await fs.writeFile(
        file,
        "export const readingPosition = 173; // synthetic review\n",
      );
      const accepted = await h.tool("subagent", {
        task:
          "V2_TEST:" +
          JSON.stringify({ op: "notes-cycle", windows: 3, auto: true, file }),
        timeoutPolicy: "none",
      });
      const id = JSON.parse(accepted.content[0].text).accepted[0].taskId;
      await until(async () =>
        ["completed", "failed"].includes(
          (await h.snapshot()).tasks.find((t) => t.id === id)?.state,
        ),
      );
      const task = (await h.snapshot()).tasks.find((t) => t.id === id);
      assert.equal(task.state, "completed", task.error);
      const result = JSON.parse(
        (await h.tool("team_collect", { taskId: id })).content[0].text,
      )[0].result;
      assert.match(result, /NOTES_CYCLES_COMPLETE/);
      const messages = (await fs.readFile(task.sessionFile, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      const windows = messages.filter(
        (e) => e.type === "compaction" && e.details?.contextMode === "notes",
      );
      assert.equal(windows.length, 3);
      assert.ok(windows.every((e) => e.details.boundary === true));
    }),
);

test(
  "a managed member that refuses a notes handoff fails instead of returning a successful empty task",
  { timeout: 30000 },
  () =>
    harness(async (h) => {
      const file = path.join(h.cwd, "uncooperative-decoder.ts");
      await fs.writeFile(file, "export const position = 173;\n");
      const accepted = await h.tool("subagent", {
        task:
          "V2_TEST:" +
          JSON.stringify({
            op: "notes-cycle",
            windows: 1,
            auto: true,
            file,
            ignorePreparation: "claim",
          }),
      });
      const id = JSON.parse(accepted.content[0].text).accepted[0].taskId;
      await until(async () =>
        ["completed", "failed"].includes(
          (await h.snapshot()).tasks.find((t) => t.id === id)?.state,
        ),
      );
      const task = (await h.snapshot()).tasks.find((t) => t.id === id);
      assert.equal(task.state, "failed");
      assert.match(task.error, /Context note preparation allowance exhausted/);
      assert.equal(task.processState, "stopped");
    }),
);

test(
  "real Pi role labels do not narrow development tools; explicit tool/workspace limits remain effective",
  { timeout: 30000 },
  () =>
    harness(async (h) => {
      const run = async (args) => {
        const result = await h.tool("subagent", args);
        assert.ok(!result.isError, result.content[0].text);
        const id = JSON.parse(result.content[0].text).accepted[0].taskId;
        await until(async () =>
          ["completed", "failed"].includes(
            (await h.snapshot()).tasks.find((t) => t.id === id)?.state,
          ),
        );
        const task = (await h.snapshot()).tasks.find((t) => t.id === id);
        assert.equal(task.state, "completed", task.error);
        return {
          task,
          text: JSON.parse(
            (await h.tool("team_collect", { taskId: id })).content[0].text,
          )[0].result,
        };
      };
      const full = await run({
        agent: "reviewer",
        task: 'V2_TEST:{"op":"tools"}',
      });
      const tools = JSON.parse(full.text).names;
      for (const name of [
        "write",
        "edit",
        "bash",
        "find",
        "web_search",
        "web_fetch",
        "goal_context",
      ])
        assert.ok(tools.includes(name), name);
      for (const name of [
        "goal_stop",
        "goal_activate",
        "team_cancel",
        "team_disband",
      ])
        assert.ok(!tools.includes(name), name);
      assert.equal(full.task.timeoutPolicy, "none");
      assert.equal(full.task.timeoutMs, 0);
      const limited = await run({
        agent: "worker",
        workspace: { access: "read-only", execution: "files" },
        tools: ["read", "find"],
        timeoutPolicy: "fixed",
        timeoutMs: 7200000,
        queueTimeoutMs: 10000,
        task: 'V2_TEST:{"op":"tools"}',
      });
      const selected = JSON.parse(limited.text).names;
      assert.ok(selected.includes("read"));
      assert.ok(selected.includes("find"));
      assert.ok(!selected.includes("bash"));
      assert.ok(!selected.includes("write"));
      assert.ok(!selected.includes("web_search"));
      assert.equal(limited.task.timeoutMs, 7200000);
      assert.equal(limited.task.queueTimeoutMs, 10000);
    }),
);

test(
  "real Pi members can use configured project tools and scoped goal criteria after reload",
  { timeout: 30000 },
  () =>
    harness(async (h) => {
      await fs.writeFile(
        path.join(process.env.PI_CODING_AGENT_DIR, "mission-control.json"),
        JSON.stringify({
          workerExtensions: [
            fixture,
            path.join(root, "tests/v2/member-project-fixture.ts"),
          ],
          progressIntervalMs: 3600000,
        }),
      );
      await h.session.reload();
      const planned = JSON.parse(
        (
          await h.tool("goal_plan", {
            goals: [
              {
                key: "main",
                objective: "Member context regression",
                criteria: ["Batch accepted"],
              },
              {
                key: "stage",
                parentId: "main",
                objective: "Decode stage",
                criteria: ["Decode criteria covered"],
              },
              {
                key: "leaf",
                parentId: "stage",
                objective: "Audit decode file group",
                criteria: ["FULL_CRITERION_FROM_LEDGER"],
                scope: {
                  unitKind: "file",
                  items: ["decode.py", "immediate.py"],
                },
              },
            ],
          })
        ).content[0].text,
      );
      const leaf = planned.created.find((n) => n.key === "leaf");
      await h.tool("goal_focus", { goalId: leaf.id, revision: 0 });
      await h.tool("team_spawn", {
        name: "project-reader",
        role: "Review files",
      });
      const assign = async (name, args) => {
        const accepted = await h.tool("team_send", {
          to: "project-reader",
          message: "V2_TEST:" + JSON.stringify({ op: "tool", name, args }),
        });
        const id = JSON.parse(accepted.content[0].text).taskId;
        await until(
          async () =>
            (await h.snapshot()).tasks.find((t) => t.id === id)?.state ===
            "completed",
        );
        return JSON.parse(
          (await h.tool("team_collect", { taskId: id })).content[0].text,
        )[0].result;
      };
      assert.match(
        await assign("project_build_probe", {}),
        /PROJECT_TOOL_AVAILABLE/,
      );
      assert.match(
        await assign("goal_context", { section: "criteria" }),
        /FULL_CRITERION_FROM_LEDGER/,
      );
      assert.equal((await h.snapshot()).goals.focus.state, "active");
      await h.session.prompt("/mission pause");
      await h.session.reload();
      const definition = JSON.parse(
        (await h.tool("goal_tree", { goalId: leaf.id, section: "scope" }))
          .content[0].text,
      );
      assert.equal(definition.entries[1].value, "immediate.py");
    }),
);

test(
  "real Pi members load project instructions and can read configured skill resources without broadening file writes",
  { timeout: 30000 },
  () =>
    harness(async (h) => {
      await fs.writeFile(
        path.join(h.cwd, "AGENTS.md"),
        "MEMBER_PROJECT_CONTEXT_MARKER: carry the assigned task through.\n",
      );
      const skillRoot = path.join(
        process.env.PI_CODING_AGENT_DIR,
        "skills",
        "member-resource-fixture",
      );
      await fs.mkdir(skillRoot, { recursive: true });
      const skill = path.join(skillRoot, "SKILL.md");
      await fs.writeFile(
        skill,
        "---\nname: member-resource-fixture\ndescription: MEMBER_SKILL_CATALOG_MARKER\n---\nMEMBER_SKILL_BODY_MARKER\n",
      );
      try {
        await h.tool("team_spawn", {
          name: "resource-reader",
          role: "Inspect task resources",
          workspace: { root: h.cwd, access: "read-only", execution: "files" },
        });
        const run = async (command) => {
          const accepted = await h.tool("team_send", {
            to: "resource-reader",
            message: "V2_TEST:" + JSON.stringify(command),
          });
          const id = JSON.parse(accepted.content[0].text).taskId;
          await until(
            async () =>
              (await h.snapshot()).tasks.find((t) => t.id === id)?.state ===
              "completed",
          );
          return JSON.parse(
            (await h.tool("team_collect", { taskId: id })).content[0].text,
          )[0].result;
        };
        const marker = JSON.parse(
          await run({
            op: "prompt-markers",
            markers: [
              "MEMBER_PROJECT_CONTEXT_MARKER",
              "MEMBER_SKILL_CATALOG_MARKER",
              fsSync.realpathSync.native(skill).replaceAll("\\", "\\\\"),
            ],
          }),
        );
        assert.ok(marker.present.every((entry) => entry.present));
        assert.match(
          await run({ op: "read", file: skill }),
          /MEMBER_SKILL_BODY_MARKER/,
        );
        await fs.writeFile(
          path.join(process.env.PI_CODING_AGENT_DIR, "private-fixture.txt"),
          "PRIVATE_RESOURCE_MUST_STAY_OUTSIDE",
        );
        assert.match(
          await run({
            op: "read",
            file: path.join(
              process.env.PI_CODING_AGENT_DIR,
              "private-fixture.txt",
            ),
          }),
          /WORKSPACE_DENIED/,
        );
      } finally {
        await fs.rm(skillRoot, { recursive: true, force: true });
      }
    }),
);

test(
  "all Pi delegation entrypoints accept independent task deadlines and keep malformed batches atomic",
  { timeout: 30000 },
  () =>
    harness(async (h) => {
      await h.tool("team_spawn", {
        name: "timed-member",
        role: "Small bounded task",
      });
      const broadcast = await h.tool("team_broadcast", {
        members: ["timed-member"],
        message: 'V2_TEST:{"op":"answer","text":"BROADCAST_POLICY"}',
        timeoutPolicy: "fixed",
        timeoutMs: 7200000,
      });
      assert.ok(!broadcast.isError, broadcast.content[0].text);
      const first = JSON.parse(broadcast.content[0].text)[0];
      assert.equal(first.timeoutMs, 7200000);
      await until(
        async () =>
          (await h.snapshot()).tasks.find((t) => t.id === first.id)?.state ===
          "completed",
      );
      const before = (await h.snapshot()).members.length;
      const invalid = await h.tool("subagent", {
        tasks: [
          { task: "Valid" },
          { task: "Invalid", timeoutPolicy: "fixed", timeoutMs: 0 },
        ],
      });
      assert.equal(invalid.isError, true);
      assert.equal((await h.snapshot()).members.length, before);
      const chain = await h.tool("subagent", {
        timeoutPolicy: "none",
        chain: [
          { task: 'V2_TEST:{"op":"answer","text":"CHAIN_FIRST"}' },
          {
            task: 'V2_TEST:{"op":"answer","text":"CHAIN_SECOND"}',
            timeoutPolicy: "fixed",
            timeoutMs: 7200000,
          },
        ],
      });
      const ids = JSON.parse(chain.content[0].text).accepted.map(
        (t) => t.taskId,
      );
      await until(async () => {
        const snapshot = await h.snapshot();
        return ids.every(
          (id) =>
            snapshot.tasks.find((t) => t.id === id)?.state === "completed",
        );
      });
      const tasks = (await h.snapshot()).tasks;
      assert.equal(tasks.find((t) => t.id === ids[0]).timeoutPolicy, "none");
      assert.equal(tasks.find((t) => t.id === ids[1]).timeoutMs, 7200000);
    }),
);

test(
  "real Pi reload exposes archive export and both tool and command preserve the same live session",
  { timeout: 30000 },
  () =>
    harness(async (h) => {
      await h.session.prompt(
        'V2_TEST:{"op":"answer","text":"ARCHIVE_REAL_PI_READY"}',
      );
      await h.session.prompt(
        "/mission start Archive the real session | Preserve its original identity",
      );
      await h.session.prompt("/mission pause");
      const before = await h.snapshot(),
        id = h.session.sessionManager.getSessionId(),
        file = h.session.sessionManager.getSessionFile();
      await h.session.reload();
      const destination = path.join(h.cwd, "联合归档");
      const result = await h.tool("mission_export", {
        destination,
        format: "archive",
      });
      assert.ok(!result.isError, result.content[0].text);
      const receipt = JSON.parse(result.content[0].text),
        manifest = JSON.parse(await fs.readFile(receipt.manifest, "utf8"));
      assert.equal(manifest.sessionId, id);
      assert.equal(manifest.status, "complete");
      assert.ok(manifest.catalog.goal.count >= 1);
      assert.equal(h.session.sessionManager.getSessionId(), id);
      assert.equal(h.session.sessionManager.getSessionFile(), file);
      assert.equal(
        (await h.snapshot()).mission.outputTokens,
        before.mission.outputTokens,
      );
      const command = path.join(h.cwd, "command-archive");
      await h.session.prompt("/mission archive " + command);
      assert.equal(
        JSON.parse(
          await fs.readFile(path.join(command, "manifest.json"), "utf8"),
        ).sessionId,
        id,
      );
      assert.equal(h.session.sessionManager.getSessionId(), id);
    }),
);

test(
  "real Pi keeps an explicit summary route across transient streams, rate limits and reload without a GPT fallback",
  { timeout: 25000 },
  () =>
    harness(async (h) => {
      const before = {
        mode: process.env.MC_FIXTURE_SUMMARY,
        trace: process.env.MC_FIXTURE_SUMMARY_TRACE,
        model: process.env.PI_COMPACTION_SUMMARY_MODEL,
      };
      const trace = path.join(h.cwd, "summary-requests.jsonl");
      try {
        await h.tool("goal_start", {
          objective: "Compaction recovery fixture",
          criteria: [
            "Preserve precise failures and the independent summary model",
          ],
        });
        await h.tool("compaction_model", {
          action: "set",
          target: "lead",
          model: "mission-fixture/summary",
          maxRetries: 2,
        });
        process.env.PI_COMPACTION_SUMMARY_MODEL = "mission-fixture/model";
        process.env.MC_FIXTURE_SUMMARY = "stream-once";
        process.env.MC_FIXTURE_SUMMARY_TRACE = trace;
        h.settings.applyOverrides({
          compaction: {
            enabled: true,
            reserveTokens: 1024,
            keepRecentTokens: 100,
          },
        });
        for (let i = 0; i < 2; i++)
          await h.session.prompt(
            "V2_TEST:" +
              JSON.stringify({
                op: "answer",
                text: "Completed audit evidence ".repeat(100) + i,
              }),
          );
        const result = await h.session.compact();
        assert.match(result.summary, /Summary retained/);
        const requests = JSON.parse(
          "[" +
            (await fs.readFile(trace, "utf8")).trim().split("\n").join(",") +
            "]",
        );
        assert.ok(requests.length >= 2);
        assert.ok(requests.every((r) => r.model === "summary"));
        process.env.MC_FIXTURE_SUMMARY = "rate-limit";
        await h.session.prompt(
          "V2_TEST:" +
            JSON.stringify({
              op: "answer",
              text: "New audit evidence after the saved checkpoint. ".repeat(
                150,
              ),
            }),
        );
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
            (await h.snapshot()).recovery?.phase === "compaction_failed",
          12000,
        );
        const failed = await h.snapshot();
        assert.equal(failed.recovery.phase, "compaction_failed");
        assert.ok(failed.recovery.nextAt > Date.now());
        assert.match(failed.recovery.reason, /429/);
        assert.equal(failed.recoveryPlan.state, "compaction_failed");
        const status = JSON.parse(
          (await h.tool("compaction_model", { target: "lead" })).content[0]
            .text,
        );
        assert.equal(status.model, "mission-fixture/summary");
        assert.match(status.diagnostics.errorMessage, /429/);
        assert.equal(status.diagnostics.retries, 2);
        const count = (await fs.readFile(trace, "utf8"))
          .trim()
          .split("\n").length;
        await h.session.reload();
        assert.equal((await h.snapshot()).recovery.phase, "compaction_failed");
        assert.match((await h.snapshot()).recovery.reason, /429/);
        assert.equal(
          (await fs.readFile(trace, "utf8")).trim().split("\n").length,
          count,
        );
      } finally {
        for (const [key, value] of [
          ["MC_FIXTURE_SUMMARY", before.mode],
          ["MC_FIXTURE_SUMMARY_TRACE", before.trace],
          ["PI_COMPACTION_SUMMARY_MODEL", before.model],
        ]) {
          if (value === undefined) delete process.env[key];
          else process.env[key] = value;
        }
      }
    }),
);

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
        const memberSession = (await h.snapshot()).members[0].sessionId;
        const aborted = await h.tool("team_send", {
          to: "flaky-worker",
          wait: true,
          message:
            "V2_TEST:" +
            JSON.stringify({
              op: "flaky",
              key: crypto.randomUUID(),
              failures: 1,
              transportAbort: true,
              error: "This operation was aborted",
            }),
        });
        assert.ok(!aborted.isError, aborted.content[0].text);
        assert.match(aborted.content[0].text, /RECOVERED_REQUEST_2/);
        assert.equal((await h.snapshot()).members[0].sessionId, memberSession);
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
        tools: ["read", "find"],
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
      assert.deepEqual(state.members[0].tools, ["read", "find"]);
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
  "real Pi bounds native retry bursts and automatically resumes after cooldown without human input",
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
            failures: 5,
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
      assert.ok((await h.snapshot()).recovery.nextAt > Date.now());
      await until(
        () => h.session.getLastAssistantText() === "RECOVERED_REQUEST_6",
      );
      assert.equal(failures(), 5);
      assert.equal((await h.snapshot()).recovery, undefined);
      assert.equal((await h.snapshot()).mission.status, "active");
    }),
);

test(
  "real Pi continues 24 tool calls after an aborted request without replaying saved writes or exposing stale recovery",
  { timeout: 20000 },
  () =>
    harness(async (h) => {
      await h.session.prompt("/reconnect on");
      await h.session.prompt("/reconnect delay 0");
      await h.session.prompt(
        'V2_TEST:{"op":"answer","text":"READY_FOR_RECOVERY_CHAIN"}',
      );
      await h.tool("goal_start", {
        objective: "Preserve long automatic tool sequences",
        criteria: ["Each evidence file is written once"],
      });
      const key = crypto.randomUUID();
      await h.tool("schedule", {
        action: "create",
        title: "long tool chain",
        afterSeconds: 1,
        prompt:
          "V2_TEST:" +
          JSON.stringify({
            op: "recovery-chain",
            key,
            directory: h.cwd,
            steps: 24,
          }),
      });
      await until(() =>
        h.session.getLastAssistantText()?.startsWith("RECOVERY_CHAIN_COMPLETE"),
      );
      const writes = h.events.filter(
        (e) => e.type === "tool_execution_end" && e.toolName === "write",
      );
      assert.equal(writes.length, 24);
      assert.equal(new Set(writes.map((e) => e.toolCallId)).size, 24);
      for (let i = 0; i < 24; i++)
        assert.equal(
          await fs.readFile(path.join(h.cwd, `step-${i}.txt`), "utf8"),
          `Evidence ${key} ${i}\n`,
        );
      const status = h.events
        .filter(
          (e) =>
            e.type === "tool_execution_end" && e.toolName === "mission_status",
        )
        .at(-1);
      const withinRun = JSON.parse(status.result.content[0].text);
      assert.equal(withinRun.recovery, undefined);
      assert.equal(withinRun.recoveryPlan.state, "ready");
      assert.equal((await h.snapshot()).held, false);
      assert.equal(
        h.events.filter(
          (e) =>
            e.type === "message_end" &&
            e.message?.errorMessage?.includes("This operation was aborted"),
        ).length,
        1,
      );
    }),
);

test("real Pi reconnects a provider-side aborted response in the same run", () =>
  harness(async (h) => {
    await h.session.prompt("/reconnect on");
    await h.session.prompt("/reconnect delay 0");
    await h.tool("goal_start", {
      objective: "Recover provider cancellation",
      criteria: ["Continue without another human request"],
    });
    await h.session.prompt(
      "V2_TEST:" +
        JSON.stringify({
          op: "flaky",
          key: crypto.randomUUID(),
          failures: 1,
          transportAbort: true,
          error: "This operation was aborted",
        }),
    );
    assert.equal(h.session.getLastAssistantText(), "RECOVERED_REQUEST_2");
    assert.equal((await h.snapshot()).recovery, undefined);
    assert.equal((await h.snapshot()).held, false);
    assert.equal(
      h.events.filter((e) => e.type === "agent_settled").at(-1).aborted,
      false,
    );
  }));

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
  "real Pi recovers the existing request without requiring an explicit mission",
  { timeout: 15000 },
  () =>
    harness(async (h) => {
      await fs.writeFile(
        path.join(process.env.PI_CODING_AGENT_DIR, "mission-control.json"),
        JSON.stringify({ recoveryMaxRequests: 1, recoveryCooldownMs: 1000 }),
      );
      await h.session.reload();
      await h.session.prompt(
        "V2_TEST:" +
          JSON.stringify({
            op: "flaky",
            key: crypto.randomUUID(),
            failures: 1,
            error: "This operation was aborted",
          }),
      );
      assert.equal((await h.snapshot()).mission, undefined);
      assert.equal((await h.snapshot()).recovery.phase, "exhausted");
      await until(
        () => h.session.getLastAssistantText() === "RECOVERED_REQUEST_2",
      );
      assert.equal((await h.snapshot()).recovery, undefined);
    }),
);

test(
  "real user stop fences persistent cooldown probes even after reload",
  { timeout: 15000 },
  () =>
    harness(async (h) => {
      await fs.writeFile(
        path.join(process.env.PI_CODING_AGENT_DIR, "mission-control.json"),
        JSON.stringify({ recoveryMaxRequests: 1, recoveryCooldownMs: 1000 }),
      );
      await h.session.reload();
      await h.tool("goal_start", {
        objective: "Respect user stop during an outage",
        criteria: ["No automatic resume"],
      });
      await h.session.prompt(
        "V2_TEST:" +
          JSON.stringify({
            op: "flaky",
            key: crypto.randomUUID(),
            failures: 100,
            error: "This operation was aborted",
          }),
      );
      assert.equal((await h.snapshot()).recovery.phase, "exhausted");
      await h.session.prompt("/mission stop");
      const count = () =>
        h.events.filter(
          (e) => e.type === "message_end" && e.message?.role === "assistant",
        ).length;
      const stopped = count();
      await h.session.reload();
      await new Promise((r) => setTimeout(r, 2200));
      assert.equal(count(), stopped);
      assert.equal((await h.snapshot()).mission.status, "stopped");
      assert.equal((await h.snapshot()).mission.humanPaused, true);
    }),
);

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
      assert.equal(catalog.tools.length, 55);
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
        'V2_TEST:{"op":"answer","text":"OBSOLETE_HISTORY_FIXTURE: Only a user slash command can reconcile; these tools are unavailable."}',
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
      m.objective = "LONG_APPROVED_OBJECTIVE_".repeat(300);
      m.criteria = Array.from({ length: 30 }, () =>
        "LONG_CRITERION_".repeat(140),
      );
      m.blocker = {
        kind: "no_progress",
        reason:
          "Three autonomous turns made no task or goal progress. Review /mission status and resume explicitly.",
      };
      m.reason = m.blocker.reason;
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
        'V2_TEST:{"op":"tool","name":"mission_status","args":{}}',
      );
      const statusResult = JSON.parse(h.session.getLastAssistantText());
      assert.equal(statusResult.isError, false);
      const statusPrefix = statusResult.text.slice(0, 6000);
      assert.ok(
        statusPrefix.includes(
          '"version": "' +
            JSON.parse(
              fsSync.readFileSync(path.join(root, "package.json"), "utf8"),
            ).version +
            '"',
        ),
      );
      assert.match(statusPrefix, /"mission_reconcile": true/);
      assert.match(statusPrefix, /"mission_control": true/);
      assert.match(statusPrefix, /process_inspection_required/);
      assert.match(statusPrefix, /"tool": "mission_reconcile"/);
      assert.match(statusPrefix, /"tool": "mission_control"/);
      for (const task of tasks) assert.ok(statusPrefix.includes(task.taskId));
      assert.ok(
        statusResult.text.indexOf('"recoveryPlan"') <
          statusResult.text.indexOf("LONG_APPROVED_OBJECTIVE_"),
      );
      const system = h.session.sessionManager
        .getBranch()
        .filter((e) => e.type === "message" && e.message.role === "system")
        .at(-1);
      const instructions = JSON.stringify(system.message.sections);
      assert.match(instructions, /old claims that only a user slash command/);
      assert.match(instructions, /Current Mission Control recovery plan/);
      assert.equal((await h.snapshot()).mission.status, "attention");
      assert.equal(
        (await h.snapshot()).tasks.filter((t) => t.processState === "unknown")
          .length,
        4,
      );
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

test("the default policy can be applied by a real model tool without turning a pending decision into a human answer", () =>
  harness(async (h) => {
    assert.equal((await h.snapshot()).decisionPolicy, "business-only");
    await h.tool("goal_start", {
      objective: "Approved fixture",
      criteria: ["Evidence retained"],
    });
    const asked = JSON.parse(
      (
        await h.tool("mission_decision", {
          reason: "Which acceptance boundary should apply?",
        })
      ).content[0].text,
    );
    const id = asked.decision.id;
    await h.session.prompt(
      'V2_TEST:{"op":"tool","name":"mission_policy","args":{"action":"apply","policy":"business-only"}}',
    );
    const response = JSON.parse(h.session.getLastAssistantText());
    assert.equal(response.isError, false);
    const policy = JSON.parse(response.text);
    assert.equal(policy.policy, "business-only");
    assert.equal(policy.default, true);
    assert.equal(policy.existingDecision, id);
    assert.equal((await h.snapshot()).mission.status, "waiting_user");
    await h.session.reload();
    assert.equal((await h.snapshot()).decisionPolicy, "business-only");
    assert.equal((await h.snapshot()).mission.decision.id, id);
    const answer = "此项选择由你在已批准范围内决定，保留现有证据并说明依据。";
    await h.session.prompt(
      "V2_TEST:" + JSON.stringify({ op: "answer", text: answer }),
      { source: "interactive" },
    );
    await h.session.prompt(
      "V2_TEST:" +
        JSON.stringify({
          op: "tool",
          name: "mission_decision",
          args: { action: "resolve", decisionId: id, answer },
        }),
    );
    assert.equal(JSON.parse(h.session.getLastAssistantText()).isError, false);
    assert.equal((await h.snapshot()).mission.status, "active");
    assert.equal((await h.snapshot()).mission.decision, undefined);
  }));

test(
  "real Pi model tools enforce staged goals, save native tool evidence and reload the same conversation",
  { timeout: 20000 },
  () =>
    harness(async (h) => {
      const call = async (name, args) => {
        await h.session.prompt(
          "V2_TEST:" + JSON.stringify({ op: "tool", name, args }),
        );
        return JSON.parse(h.session.getLastAssistantText());
      };
      const started = JSON.parse(
        (
          await h.tool("goal_start", {
            objective: "Staged processor fixture",
            criteria: ["Inventory and implementation accepted"],
          })
        ).content[0].text,
      );
      const sessionId = h.session.sessionManager.getSessionId(),
        sessionFile = h.session.sessionManager.getSessionFile();
      const response = await call("goal_plan", {
        goals: [
          {
            key: "inventory",
            parentId: started.id,
            objective: "Inventory",
            criteria: ["Module responsibilities and checks listed"],
          },
          {
            key: "implementation",
            parentId: started.id,
            objective: "Implementation",
            criteria: ["Module artifact accepted"],
            dependsOn: ["inventory"],
          },
          {
            key: "module",
            parentId: "implementation",
            objective: "Module A",
            criteria: ["Module file exists"],
          },
        ],
      });
      assert.equal(response.isError, false);
      const created = JSON.parse(response.text).created,
        p = Object.fromEntries(created.map((n) => [n.key, n]));
      assert.equal((await h.snapshot()).goals.level2.total, 2);
      const file = path.join(h.cwd, "module-a.py");
      const untracked = await call("write", {
        path: file,
        content: "NO_FOCUS_MUST_NOT_WRITE",
      });
      assert.equal(untracked.isError, true);
      assert.match(untracked.text, /Select a ready leaf/);
      assert.equal(fsSync.existsSync(file), false);
      const early = await call("goal_focus", {
        goalId: p.module.id,
        revision: 0,
      });
      assert.equal(early.isError, true);
      assert.match(early.text, /Await acceptance/);
      await call("goal_focus", { goalId: p.inventory.id, revision: 0 });
      const spec = await call("goal_accept", {
        goalId: p.inventory.id,
        revision: 0,
        evidence: [
          {
            criterion: 1,
            source: "statement",
            summary:
              "Module A responsibilities and verification steps recorded",
          },
        ],
      });
      assert.equal(spec.isError, false);
      await call("goal_focus", { goalId: p.module.id, revision: 0 });
      const written = await call("write", {
        path: file,
        content: "MODULE_A = 64\n",
      });
      assert.equal(written.isError, false);
      const detail = JSON.parse(
        (await h.tool("goal_tree", { goalId: p.module.id })).content[0].text,
      );
      const receipt = detail.receipts.find((r) => r.tool === "write");
      assert.ok(receipt);
      assert.equal(receipt.isError, false);
      assert.equal(
        (await h.snapshot()).goals.level3.completed,
        0,
        "writing does not accept a goal",
      );
      const accepted = await call("goal_accept", {
        goalId: p.module.id,
        revision: 0,
        evidence: [
          {
            criterion: 1,
            source: "tool",
            receiptId: receipt.id,
            summary: "Native Pi write returned successfully for module A",
          },
          {
            criterion: 1,
            source: "artifact",
            path: file,
            summary: "Module A source artifact saved with its fingerprint",
          },
        ],
      });
      assert.equal(accepted.isError, false);
      const acceptance = JSON.parse(accepted.text);
      await h.session.reload();
      assert.equal(h.session.sessionManager.getSessionId(), sessionId);
      assert.equal(h.session.sessionManager.getSessionFile(), sessionFile);
      assert.equal((await h.snapshot()).goals.level3.completed, 1);
      const retained = JSON.parse(
        (
          await h.tool("goal_tree", {
            goalId: p.module.id,
            section: "acceptance",
          })
        ).content[0].text,
      );
      assert.equal(retained.acceptanceId, acceptance.id);
      assert.equal(retained.entries.length, 2);
      const group = await call("goal_accept", {
        goalId: p.implementation.id,
        revision: 0,
        evidence: [
          {
            criterion: 1,
            source: "acceptance",
            acceptanceId: acceptance.id,
            summary: "Module A acceptance supplies the implementation result",
          },
        ],
      });
      assert.equal(group.isError, false);
      const finished = await call("goal_accept", {
        goalId: started.id,
        revision: 0,
        evidence: [
          {
            criterion: 1,
            source: "acceptance",
            acceptanceId: JSON.parse(group.text).id,
            summary:
              "All required stages and implementation acceptance recorded",
          },
        ],
      });
      assert.equal(finished.isError, false);
      assert.equal((await h.snapshot()).mission.status, "complete");
      assert.deepEqual((await h.snapshot()).goals.level2, {
        total: 2,
        completed: 2,
        excluded: 0,
      });
      const exported = path.join(h.cwd, "goal-ledger.json");
      await h.session.prompt(`/mission goals export ${exported}`);
      const ledger = JSON.parse(await fs.readFile(exported, "utf8"));
      assert.equal(ledger.records.length, 4);
    }),
);

test(
  "real Pi reload upgrades old flat SQLite and exposes goal tools without a new session",
  { timeout: 15000 },
  () =>
    harness(async (h) => {
      const started = JSON.parse(
        (
          await h.tool("goal_start", {
            objective: "Legacy goal survives reload",
            criteria: ["Preserve original identity and usage"],
          })
        ).content[0].text,
      );
      await h.session.prompt("/mission pause");
      const sessionId = h.session.sessionManager.getSessionId(),
        sessionFile = h.session.sessionManager.getSessionFile();
      const directory = path.join(
        process.env.PI_CODING_AGENT_DIR,
        "mission-control/v2",
        sessionId,
      );
      h.session.setActiveToolsByName(["read"]);
      await h.session.reload({
        beforeSessionStart: () => {
          const db = new DatabaseSync(path.join(directory, "state.sqlite"));
          for (const name of [
            "goal_nodes",
            "goal_acceptances",
            "goal_receipts",
            "goal_missions",
          ])
            db.exec(`DROP TABLE ${name}`);
          const m = JSON.parse(
            db.prepare("SELECT data FROM meta WHERE key='mission'").get().data,
          );
          m.turns = 17;
          m.outputTokens = 1299;
          db.prepare("UPDATE meta SET data=? WHERE key='mission'").run(
            JSON.stringify(m),
          );
          db.close();
        },
      });
      const state = await h.snapshot();
      assert.equal(state.mission.id, started.id);
      assert.equal(state.mission.humanPaused, true);
      assert.equal(state.mission.turns, 17);
      assert.equal(state.mission.outputTokens, 1299);
      assert.equal(h.session.sessionManager.getSessionId(), sessionId);
      assert.equal(h.session.sessionManager.getSessionFile(), sessionFile);
      assert.ok(h.session.getActiveToolNames().includes("goal_plan"));
      assert.ok(h.session.getActiveToolNames().includes("goal_accept"));
      const tree = JSON.parse((await h.tool("goal_tree")).content[0].text);
      assert.equal(tree.nodes[0].id, started.id);
      await h.session.prompt("/mission resume");
      await h.session.prompt(
        'V2_TEST:{"op":"tools","schemaFor":"goal_accept"}',
      );
      const declared = JSON.parse(h.session.getLastAssistantText());
      assert.ok(declared.names.includes("goal_export"));
      assert.equal(declared.schema.properties.revision.type, "integer");
    }),
);

test(
  "real Pi worker results stay attached to their leaf and do not auto-accept it",
  { timeout: 20000 },
  () =>
    harness(async (h) => {
      const planResult = await h.tool("goal_plan", {
        goals: [
          {
            key: "main",
            objective: "Delegated leaf fixture",
            criteria: ["Accepted member output"],
          },
          {
            key: "leaf",
            parentId: "main",
            objective: "Read fixture",
            criteria: ["Read result retained"],
          },
        ],
      });
      const created = JSON.parse(planResult.content[0].text).created,
        rootGoal = created.find((n) => n.key === "main"),
        leaf = created.find((n) => n.key === "leaf");
      await h.tool("goal_focus", { goalId: leaf.id, revision: 0 });
      const file = path.join(h.cwd, "input.txt");
      await fs.writeFile(file, "REAL_WORKER_GOAL_EVIDENCE");
      await h.tool("team_spawn", {
        name: "goal-reader",
        role: "Read a tracked leaf",
        model: "mission-fixture/model",
        thinkingLevel: "off",
        workspace: { root: h.cwd, access: "read-only", execution: "files" },
      });
      await h.session.prompt(
        "V2_TEST:" +
          JSON.stringify({
            op: "tool",
            name: "team_send",
            args: {
              to: "goal-reader",
              message: "V2_TEST:" + JSON.stringify({ op: "read", file }),
              goalId: leaf.id,
              wait: true,
            },
          }),
      );
      const response = JSON.parse(h.session.getLastAssistantText());
      assert.equal(response.isError, false, response.text);
      const state = await h.snapshot(),
        task = state.tasks.find((t) => t.goalId === leaf.id);
      assert.ok(task);
      assert.equal(task.missionId, rootGoal.id);
      assert.equal(task.state, "completed");
      assert.equal(state.goals.level2.completed, 0);
      const accepted = await h.tool("goal_accept", {
        goalId: leaf.id,
        revision: 0,
        evidence: [
          {
            criterion: 1,
            source: "task",
            taskId: task.id,
            summary: "Real RPC member read result was saved and collected",
          },
        ],
      });
      assert.ok(!accepted.isError, accepted.content[0].text);
      assert.equal((await h.snapshot()).goals.level2.completed, 1);
    }),
);

test(
  "real Pi depth authorization and multiple main goals survive reload without automatic selection",
  { timeout: 15000 },
  () =>
    harness(async (h) => {
      const response = await h.tool("goal_plan", {
        goals: [
          { key: "a", objective: "Main A", criteria: ["A"] },
          { key: "b", objective: "Main B", criteria: ["B"] },
          {
            key: "two",
            parentId: "a",
            objective: "Second level",
            criteria: ["Two"],
          },
          {
            key: "three",
            parentId: "two",
            objective: "Third level",
            criteria: ["Three"],
          },
        ],
      });
      const p = Object.fromEntries(
        JSON.parse(response.content[0].text).created.map((n) => [n.key, n]),
      );
      assert.equal((await h.snapshot()).mission.id, p.a.id);
      const definition = {
        parentId: p.three.id,
        objective: "Authorized fourth level",
        criteria: ["Small delivery"],
      };
      assert.equal(
        (await h.tool("goal_plan", { goals: [definition] })).isError,
        true,
      );
      await h.session.prompt("/mission goals depth 4");
      assert.ok(!(await h.tool("goal_plan", { goals: [definition] })).isError);
      const switched = await h.tool("goal_activate", { goalId: p.b.id });
      assert.ok(!switched.isError, switched.content[0].text);
      await h.session.reload();
      assert.equal((await h.snapshot()).mission.id, p.b.id);
      assert.equal((await h.snapshot()).goals.maxDepth, 4);
      const all = JSON.parse((await h.tool("goal_tree")).content[0].text);
      assert.equal(all.roots.filter((n) => n.selected).length, 1);
    }),
);

test(
  "portable /mnt/c package source discovers both plugin entrypoints from normal Pi settings",
  { timeout: 15000 },
  async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "mc-package-source-"));
    try {
      const source =
        process.platform === "win32"
          ? "/mnt/" +
            root[0].toLowerCase() +
            root.slice(2).replaceAll("\\", "/")
          : root;
      const settings = SettingsManager.inMemory({
        packages: [source],
        retry: { enabled: false },
        cacheWarming: "off",
      });
      const resources = new DefaultResourceLoader({
        cwd,
        agentDir: process.env.PI_CODING_AGENT_DIR,
        settingsManager: settings,
        noSkills: true,
        noPromptTemplates: true,
        noContextFiles: true,
        noThemes: true,
      });
      await resources.reload();
      const loaded = resources.getExtensions();
      assert.deepEqual(loaded.errors, []);
      const tools = loaded.extensions.flatMap((extension) => [
        ...extension.tools.keys(),
      ]);
      for (const name of [
        "goal_plan",
        "goal_accept",
        "goal_export",
        "compaction_model",
      ])
        assert.ok(
          tools.includes(name),
          `Package settings did not load ${name}`,
        );
    } finally {
      await fs.rm(cwd, { recursive: true, force: true });
    }
  },
);

test(
  "large goal definitions and evidence stay readable through bounded model tool pages",
  { timeout: 15000 },
  () =>
    harness(async (h) => {
      const response = await h.tool("goal_plan", {
        goals: [
          {
            key: "root",
            objective: "Large goal ledger fixture",
            criteria: ["All evidence retained"],
          },
          {
            key: "leaf",
            parentId: "root",
            objective: "Long deliverable ".repeat(400),
            criteria: Array.from(
              { length: 30 },
              (_, i) => `${i}:` + "Acceptance detail ".repeat(100),
            ),
          },
        ],
      });
      assert.ok(!response.isError, response.content[0].text);
      const nodes = JSON.parse(response.content[0].text).created,
        leaf = nodes.find((n) => n.key === "leaf");
      const tree = JSON.parse((await h.tool("goal_tree")).content[0].text);
      assert.equal(tree.nodes.length, 2);
      const exact = JSON.parse(
        (
          await h.tool("goal_tree", {
            goalId: leaf.id,
            section: "definition",
            offset: 25,
          })
        ).content[0].text,
      );
      assert.equal(exact.criteria[0].criterion, 26);
      assert.ok(exact.criteria[0].text.length > 1000);
      const evidence = Array.from({ length: 100 }, (_, i) => ({
        criterion: (i % 30) + 1,
        source: "statement",
        summary: "Recorded explanatory acceptance evidence ".repeat(40),
      }));
      const accepted = await h.tool("goal_accept", {
        goalId: leaf.id,
        revision: 0,
        evidence,
      });
      assert.ok(!accepted.isError, accepted.content[0].text);
      assert.equal(JSON.parse(accepted.content[0].text).evidenceCount, 100);
      const page = JSON.parse(
        (
          await h.tool("goal_tree", {
            goalId: leaf.id,
            section: "acceptance",
            offset: 90,
          })
        ).content[0].text,
      );
      assert.equal(page.total, 100);
      assert.equal(page.entries.length, 10);
      assert.equal(page.entries[0].summary, evidence[90].summary.trim());
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
      const budgetOnly = await h.tool("compaction_model", {
        action: "set",
        target: "lead",
        maxInputTokens: 32000,
        intermediateOutputChars: 2000,
      });
      assert.ok(!budgetOnly.isError);
      assert.equal(
        JSON.parse(budgetOnly.content[0].text).maxInputTokens,
        32000,
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
