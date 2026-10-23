import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { hostDir } from "../../scripts/host.mjs";
const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const {
  SessionManager,
  SettingsManager,
  createAgentSessionRuntime,
  createAgentSessionServices,
  createAgentSessionFromServices,
} = await import(pathToFileURL(path.join(hostDir, "dist/index.js")));
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
async function until(fn, ms = 15000) {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 30));
  }
  throw new Error("Workspace test timed out");
}
async function harness(fn, options = {}) {
  const base = fs.realpathSync.native(
    fs.mkdtempSync(path.join(os.tmpdir(), "mc-v2-project-")),
  );
  const source = path.join(base, options.sourceName ?? "source"),
    target = path.join(base, options.targetName ?? "target"),
    agent = path.join(base, "agent");
  fs.mkdirSync(source);
  fs.mkdirSync(agent);
  fs.writeFileSync(
    path.join(agent, "settings.json"),
    JSON.stringify({ retry: { enabled: false }, cacheWarming: "off" }),
  );
  fs.writeFileSync(
    path.join(agent, "mission-control.json"),
    JSON.stringify({
      workerExtensions: [path.join(root, "tests/v2/offline-provider.ts")],
    }),
  );
  const previousDir = process.cwd(),
    previousAgent = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agent;
  let runtime;
  const errors = [],
    notices = [];
  let resolveSwitched;
  const switched = new Promise((resolve) => {
    resolveSwitched = resolve;
  });
  const paths = [
    "extensions/mission-control/index.ts",
    "extensions/mission-control/compaction.ts",
    "tests/v2/offline-provider.ts",
  ].map((p) => path.join(root, p));
  const factory = async ({ cwd, sessionManager, sessionStartEvent }) => {
    const services = await createAgentSessionServices({
      cwd,
      agentDir: agent,
      settingsManager: SettingsManager.inMemory({
        retry: { enabled: false },
        cacheWarming: "off",
      }),
      resourceLoaderOptions: {
        noExtensions: true,
        noSkills: true,
        noContextFiles: true,
        noPromptTemplates: true,
        noThemes: true,
        additionalExtensionPaths: paths,
      },
    });
    return {
      ...(await createAgentSessionFromServices({
        services,
        sessionManager,
        sessionStartEvent,
        model,
      })),
      services,
      diagnostics: services.diagnostics,
    };
  };
  const bind = (session) =>
    session.bindExtensions({
      mode: "rpc",
      uiContext: {
        notify: (...args) => notices.push(args),
        setStatus() {},
        setWidget() {},
      },
      onError: (e) => errors.push(e),
      commandContextActions: {
        waitForIdle: () => runtime.session.waitForIdle(),
        newSession: (o) => runtime.newSession(o),
        fork: (id, o) => runtime.fork(id, o),
        navigateTree: (id, o) => runtime.session.navigateTree(id, o),
        reload: async () => {},
        switchSession: async (file, o) => {
          const value = await runtime.switchSession(file, o);
          resolveSwitched(value);
          return value;
        },
      },
    });
  try {
    const manager = SessionManager.create(
      source,
      options.customStorage ? path.join(source, "history") : undefined,
    );
    runtime = await createAgentSessionRuntime(factory, {
      cwd: source,
      agentDir: agent,
      sessionManager: manager,
    });
    runtime.setRebindSession(bind);
    await bind(runtime.session);
    const tool = (name, args = {}) =>
      runtime.session.agent.state.tools
        .find((t) => t.name === name)
        .execute(
          "test-" + crypto.randomUUID(),
          args,
          new AbortController().signal,
        );
    const state = async () =>
      JSON.parse((await tool("mission_status")).content[0].text);
    if (!options.noInitialResponse)
      await runtime.session.prompt(
        'V2_TEST:{"op":"answer","text":"MAIN_ORIGINAL_MEMORY"}',
      );
    await fn({
      get runtime() {
        return runtime;
      },
      source,
      target,
      agent,
      base,
      tool,
      state,
      command: (text) => runtime.session.prompt(text),
      input: (text, source = "interactive", options = {}) =>
        runtime.session.prompt(text, { ...options, source }),
      notices,
      switched,
      restart: async () => {
        const cwd = runtime.cwd,
          file = runtime.session.sessionFile;
        await runtime.dispose();
        runtime = await createAgentSessionRuntime(factory, {
          cwd,
          agentDir: agent,
          sessionManager: SessionManager.open(file),
        });
        runtime.setRebindSession(bind);
        await bind(runtime.session);
      },
    });
    assert.deepEqual(errors, []);
  } catch (error) {
    console.error(
      "PROJECT_DIAGNOSTIC",
      JSON.stringify({ notices, errors, cwd: runtime?.cwd }),
    );
    throw error;
  } finally {
    await runtime?.dispose();
    process.chdir(previousDir);
    if (previousAgent === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgent;
    assert.equal(path.dirname(base), fs.realpathSync.native(os.tmpdir()));
    fs.rmSync(base, { recursive: true, force: true });
  }
}
test(
  "v2 rename preserves main/member memory, state, permissions and receipt paths under a fresh runtime",
  { timeout: 35000 },
  () =>
    harness(async (h) => {
      assert.equal((await h.tool("project_recover")).isError, true);
      const file = path.join(h.source, "marker.txt");
      fs.writeFileSync(file, "CHILD_PERSISTENT_MEMORY");
      await h.tool("team_spawn", {
        name: "worker",
        role: "read",
        workspace: { root: h.source, access: "read-only", execution: "files" },
      });
      const running = h.command('V2_TEST:{"op":"hang"}');
      await until(() => h.runtime.session.isStreaming);
      const assignment = await h.tool("team_send", {
        to: "worker",
        message: "V2_TEST:" + JSON.stringify({ op: "read", file }),
        wait: true,
      });
      assert.ok(!assignment.isError, assignment.content[0].text);
      const before = await h.state(),
        oldFile = h.runtime.session.sessionFile,
        original = fs.readFileSync(oldFile);
      const previousId = h.runtime.session.sessionId;
      process.chdir(h.source);
      await h.command("/project rename target");
      await running;
      assert.equal(h.runtime.cwd, h.target, JSON.stringify(h.notices));
      assert.notEqual(h.runtime.session.sessionId, previousId);
      assert.ok(
        fs.readFileSync(oldFile).subarray(0, original.length).equals(original),
      );
      const next = await h.state();
      assert.equal(next.members[0].id, before.members[0].id);
      assert.equal(next.members[0].sessionId, before.members[0].sessionId);
      assert.equal(next.members[0].workspace.root, h.target);
      assert.equal(next.members[0].workspace.access, "read-only");
      assert.equal(next.mission.status, "paused");
      assert.ok(
        next.tasks.every(
          (t) =>
            fs.existsSync(t.inputPath) &&
            (!t.resultPath || fs.existsSync(t.resultPath)),
        ),
      );
      assert.match(
        fs.readFileSync(next.members[0].sessionFile, "utf8"),
        /CHILD_PERSISTENT_MEMORY/,
      );
      assert.equal(
        SessionManager.continueRecent(h.target).getSessionId(),
        h.runtime.session.sessionId,
      );
      await h.restart();
      assert.equal((await h.state()).members[0].id, before.members[0].id);
      assert.equal((await h.state()).mission.status, "paused");
      await h.command(
        'V2_TEST:{"op":"tool","name":"project_recover","args":{}}',
      );
      assert.equal(
        JSON.parse(h.runtime.session.getLastAssistantText()).isError,
        false,
      );
      assert.equal((await h.state()).mission.status, "paused");
      assert.equal((await h.state()).held, true);
      const resolved = JSON.parse(
        (await h.tool("project_resolve", { path: file })).content[0].text,
      );
      assert.equal(resolved.resolved, path.join(h.target, "marker.txt"));
      await h.command('V2_TEST:{"op":"recall"}');
      assert.match(
        h.runtime.session.getLastAssistantText(),
        /MAIN_ORIGINAL_MEMORY/,
      );
      const busy = h.command('V2_TEST:{"op":"hang"}');
      await until(() => h.runtime.session.isStreaming);
      await h.command("/mission resume");
      const recalled = await h.tool("team_send", {
        to: "worker",
        message: 'V2_TEST:{"op":"recall"}',
        wait: true,
      });
      assert.match(JSON.stringify(recalled), /CHILD_PERSISTENT_MEMORY/);
      await h.runtime.session.abort();
      await busy;
    }),
);
test(
  "switch changes main file tools while preserving members' original workspace permissions",
  { timeout: 20000 },
  () =>
    harness(async (h) => {
      fs.mkdirSync(h.target);
      fs.writeFileSync(path.join(h.source, "scope.txt"), "SOURCE_SCOPE");
      fs.writeFileSync(path.join(h.target, "scope.txt"), "TARGET_SCOPE");
      await h.tool("team_spawn", {
        name: "reader",
        role: "read",
        workspace: { root: h.source, access: "read-only", execution: "files" },
      });
      await h.command('/project switch "' + h.target + '"');
      assert.equal(h.runtime.cwd, h.target, JSON.stringify(h.notices));
      assert.equal((await h.state()).members[0].workspace.root, h.source);
      assert.ok(fs.existsSync(h.source));
      await h.command(
        'V2_TEST:{"op":"tool","name":"read","args":{"path":"scope.txt"}}',
      );
      assert.match(h.runtime.session.getLastAssistantText(), /TARGET_SCOPE/);
    }),
);

for (const action of ["rename", "switch"]) {
  test(
    `workspace ${action} retains standalone context mode, notes and explicit summary routing through reload`,
    { timeout: 20000 },
    () =>
      harness(async (h) => {
        if (action === "switch") fs.mkdirSync(h.target);
        await h.tool("context_mode", {
          mode: "notes",
          inputLimitTokens: 300000,
        });
        await h.tool("context_note", {
          action: "write",
          notes: [
            { name: "index", text: "WORKSPACE_INDEX_173" },
            {
              name: "handoff",
              text: "Next: decoder.py line 173; not accepted",
            },
            { name: "topic/decode", text: "UNCHANGED_TOPIC_DETAIL_173" },
          ],
        });
        await h.tool("compaction_model", {
          action: "set",
          model: "mission-fixture/summary",
        });
        const original = JSON.parse(
          (await h.tool("context_mode", {})).content[0].text,
        );
        const summaryBefore = JSON.parse(
          (
            await h.tool("compaction_model", {
              action: "status",
              target: "lead",
            })
          ).content[0].text,
        );
        assert.equal(summaryBefore.model, "mission-fixture/summary");
        const sourceId = h.runtime.session.sessionId;
        await h.command(
          action === "rename"
            ? "/project rename target"
            : '/project switch "' + h.target + '"',
        );
        assert.equal(h.runtime.cwd, h.target, JSON.stringify(h.notices));
        assert.notEqual(h.runtime.session.sessionId, sourceId);
        const after = JSON.parse(
          (await h.tool("context_mode", {})).content[0].text,
        );
        assert.equal(
          after.mode,
          "notes",
          "standalone memory mode must continue with the relocated conversation",
        );
        assert.equal(
          after.budget.inputLimitTokens,
          original.budget.inputLimitTokens,
        );
        assert.deepEqual(
          after.notes,
          original.notes,
          "note revisions, sources and timestamps must remain unchanged",
        );
        const handoff = JSON.parse(
          (await h.tool("context_note", { action: "read", name: "handoff" }))
            .content[0].text,
        );
        assert.equal(handoff.text, "Next: decoder.py line 173; not accepted");
        const summaryAfter = JSON.parse(
          (
            await h.tool("compaction_model", {
              action: "status",
              target: "lead",
            })
          ).content[0].text,
        );
        assert.equal(
          summaryAfter.model,
          summaryBefore.model,
          "never silently fall back to inference model during relocation",
        );
        await h.runtime.session.reload();
        const reloaded = JSON.parse(
          (await h.tool("context_mode", {})).content[0].text,
        );
        assert.equal(reloaded.mode, "notes");
        assert.deepEqual(reloaded.notes, original.notes);
        assert.equal(
          JSON.parse(
            (
              await h.tool("compaction_model", {
                action: "status",
                target: "lead",
              })
            ).content[0].text,
          ).model,
          summaryBefore.model,
        );
      }),
  );
}

test("a manual external directory rename cannot silently reassign the old session or member permissions", () =>
  harness(async (h) => {
    const before = h.runtime.session.sessionId;
    fs.renameSync(h.source, h.target);
    await h.command('/project switch "' + h.target + '"');
    assert.equal(h.runtime.cwd, h.source);
    assert.equal(h.runtime.session.sessionId, before);
    assert.ok(
      h.notices.some((notice) =>
        String(notice[0]).includes("restore its previous name first"),
      ),
      JSON.stringify(h.notices),
    );
    fs.renameSync(h.target, h.source);
  }));

test(
  "quoted CJK workspace rename retains goal evidence, native relative reads and new-directory resume discovery",
  { timeout: 20000 },
  () =>
    harness(
      async (h) => {
        const evidence = path.join(h.source, "evidence.txt");
        fs.writeFileSync(evidence, "RENAMED_EVIDENCE_173");
        const plan = JSON.parse(
          (
            await h.tool("goal_plan", {
              goals: [
                {
                  key: "root",
                  objective: "Quoted rename inventory",
                  criteria: ["All batches accepted"],
                },
                {
                  key: "leaf",
                  parentId: "root",
                  objective: "Inspect evidence file",
                  criteria: ["Evidence file exists"],
                  scope: { unitKind: "file", items: [evidence] },
                },
              ],
            })
          ).content[0].text,
        );
        const leaf = plan.created.find((n) => n.key === "leaf");
        const accepted = JSON.parse(
          (
            await h.tool("goal_accept", {
              goalId: leaf.id,
              revision: 0,
              evidence: [
                {
                  criterion: 1,
                  source: "artifact",
                  path: evidence,
                  summary: "Concrete evidence file retained during rename",
                },
              ],
            })
          ).content[0].text,
        );
        const before = JSON.parse(
          (await h.tool("goal_tree", {})).content[0].text,
        );
        process.chdir(h.source);
        await h.command('/project rename "' + path.basename(h.target) + '"');
        assert.equal(h.runtime.cwd, h.target, JSON.stringify(h.notices));
        assert.equal(fs.existsSync(h.source), false);
        const after = JSON.parse(
          (await h.tool("goal_tree", {})).content[0].text,
        );
        assert.deepEqual(
          after.nodes,
          before.nodes,
          "goal identity, revision and acceptance status remain unchanged",
        );
        const detail = JSON.parse(
          (await h.tool("goal_tree", { goalId: leaf.id })).content[0].text,
        );
        assert.equal(detail.acceptance.id, accepted.id);
        assert.equal(
          JSON.parse(
            (await h.tool("project_resolve", { path: evidence })).content[0]
              .text,
          ).resolved,
          path.join(h.target, "evidence.txt"),
        );
        await h.command(
          "V2_TEST:" +
            JSON.stringify({
              op: "tool",
              name: "read",
              args: { path: "evidence.txt" },
            }),
        );
        assert.match(
          h.runtime.session.getLastAssistantText(),
          /RENAMED_EVIDENCE_173/,
        );
        assert.equal(
          SessionManager.continueRecent(h.target).getSessionId(),
          h.runtime.session.sessionId,
        );
        await h.runtime.session.reload();
        assert.equal(
          JSON.parse(
            (await h.tool("goal_tree", { goalId: leaf.id })).content[0].text,
          ).acceptance.id,
          accepted.id,
        );
      },
      { sourceName: "原 工作区", targetName: "新 工作区 2026" },
    ),
);
test("a cancelled native switch rolls back rename and leaves the original runtime paused and usable", () =>
  harness(async (h) => {
    const original = h.runtime.session;
    await h.tool("context_mode", { mode: "notes", inputLimitTokens: 300000 });
    await h.tool("context_note", {
      action: "write",
      name: "index",
      text: "ORIGINAL_NOTE_AFTER_ROLLBACK",
    });
    const originalId = original.sessionId;
    original.resourceLoader
      .getExtensions()
      .extensions[0].handlers.set("session_before_switch", [
        async () => ({ cancel: true }),
      ]);
    await h.command("/project rename target");
    assert.equal(h.runtime.session, original);
    assert.equal(h.runtime.cwd, h.source);
    assert.ok(fs.existsSync(h.source));
    assert.equal(fs.existsSync(h.target), false);
    const journals = fs
      .readdirSync(path.join(h.agent, "project-migrations"))
      .map((id) =>
        JSON.parse(
          fs.readFileSync(
            path.join(h.agent, "project-migrations", id, "migration.json"),
            "utf8",
          ),
        ),
      );
    const rolled = journals.find((r) => r.previousSessionId === originalId);
    assert.equal(rolled.state, "rolled-back");
    assert.ok(rolled.memoryDirectory);
    assert.equal(
      fs.existsSync(rolled.memoryDirectory),
      false,
      "rollback removes only its newly created memory snapshot",
    );
    assert.equal(
      JSON.parse(
        (await h.tool("context_note", { action: "read", name: "index" }))
          .content[0].text,
      ).text,
      "ORIGINAL_NOTE_AFTER_ROLLBACK",
    );
    await h.command('V2_TEST:{"op":"recall"}');
    assert.match(
      h.runtime.session.getLastAssistantText(),
      /MAIN_ORIGINAL_MEMORY/,
    );
  }));
test(
  "workspace grant is exact, revocable, one-use and applied after the model run settles",
  { timeout: 20000 },
  () =>
    harness(async (h) => {
      assert.equal(
        (await h.tool("project_apply", { authorizationId: "forged" })).isError,
        true,
      );
      await h.command("/project allow rename target");
      let grant = JSON.parse(
        (await h.tool("project_status")).content[0].text,
      ).authorization;
      await h.command("/project revoke");
      assert.equal(
        (await h.tool("project_apply", { authorizationId: grant.id })).isError,
        true,
      );
      await h.command("/project allow rename target");
      grant = JSON.parse(
        (await h.tool("project_status")).content[0].text,
      ).authorization;
      await h.command(
        "V2_TEST:" +
          JSON.stringify({
            op: "tool",
            name: "project_apply",
            args: { authorizationId: grant.id },
          }),
      );
      await h.switched;
      assert.equal(
        (await h.tool("project_apply", { authorizationId: grant.id })).isError,
        true,
      );
      assert.equal(
        JSON.parse((await h.tool("project_status")).content[0].text)
          .authorization,
        null,
      );
    }),
);

for (const action of ["rename", "switch"]) {
  test(
    `natural-language ${action} is applied by the lead after settlement without user slash commands`,
    { timeout: 20000 },
    () =>
      harness(
        async (h) => {
          if (action === "switch") fs.mkdirSync(h.target);
          await h.tool("context_note", {
            action: "write",
            name: "index",
            text: "NL_WORKSPACE_MEMORY",
          });
          const previousId = h.runtime.session.sessionId;
          let settled = false;
          h.runtime.session.subscribe((event) => {
            if (event.type === "agent_settled") settled = true;
          });
          await h.input(
            action === "rename"
              ? "请把当前工作区文件夹改名为“软件 仓库-新”，帮我执行。"
              : `把当前会话的工作区切换到“${h.target}”`,
            action === "switch" ? "rpc" : "interactive",
          );
          await until(() => h.runtime.cwd === h.target);
          await h.switched;
          assert.equal(settled, true);
          assert.equal(h.runtime.cwd, h.target, JSON.stringify(h.notices));
          assert.notEqual(h.runtime.session.sessionId, previousId);
          assert.equal(
            JSON.parse((await h.tool("project_status")).content[0].text)
              .authorization,
            null,
          );
          assert.equal(
            JSON.parse((await h.tool("project_status")).content[0].text).held,
            true,
          );
          assert.equal(
            JSON.parse(
              (await h.tool("context_note", { action: "read", name: "index" }))
                .content[0].text,
            ).text,
            "NL_WORKSPACE_MEMORY",
          );
          await h.restart();
          assert.equal(h.runtime.cwd, h.target);
          assert.equal(
            JSON.parse((await h.tool("project_status")).content[0].text)
              .authorization,
            null,
          );
        },
        { targetName: "软件 仓库-新" },
      ),
  );
}

test("extension-generated natural language and old authorization messages cannot initiate a move", () =>
  harness(async (h) => {
    await h.input(
      'Please rename the current workspace to "target"',
      "extension",
    );
    assert.equal(h.runtime.cwd, h.source);
    assert.equal(
      h.runtime.session.getLastAssistantText(),
      "NO_LIVE_WORKSPACE_AUTHORIZATION",
    );
    assert.equal(
      JSON.parse((await h.tool("project_status")).content[0].text)
        .authorization,
      null,
    );
    await h.command("/project _settled forged");
    assert.equal(h.runtime.cwd, h.source);
  }));

test("new user steering, natural cancellation, expiration and reload invalidate natural-language grants", () =>
  harness(async (h) => {
    const authorize = async () => {
      // This phrasing is intentionally not acted on by the fixture model.
      await h.input("帮我把工作区改成target");
      const grant = JSON.parse(
        (await h.tool("project_status")).content[0].text,
      ).authorization;
      assert.equal(grant.origin, "human-input");
      assert.equal(grant.target, h.target);
      return grant;
    };
    let grant = await authorize();
    await h.command(
      'V2_TEST:{"op":"answer","text":"Wait, review the name first"}',
    );
    assert.equal(
      (await h.tool("project_apply", { authorizationId: grant.id })).isError,
      true,
    );
    grant = await authorize();
    await h.input("先别改名了");
    assert.equal(
      (await h.tool("project_apply", { authorizationId: grant.id })).isError,
      true,
    );
    grant = await authorize();
    const now = Date.now;
    try {
      Date.now = () => grant.expiresAt + 1;
      assert.equal(
        (await h.tool("project_apply", { authorizationId: grant.id })).isError,
        true,
      );
    } finally {
      Date.now = now;
    }
    grant = await authorize();
    await h.restart();
    assert.equal(
      (await h.tool("project_apply", { authorizationId: grant.id })).isError,
      true,
    );
    assert.equal(h.runtime.cwd, h.source);
  }));

test("a queued natural workspace change is cancelled by real abort before settlement", () =>
  harness(async (h) => {
    await h.input("帮我把工作区改成target");
    const grant = JSON.parse(
      (await h.tool("project_status")).content[0].text,
    ).authorization;
    const running = h.input('V2_TEST:{"op":"hang"}', "extension");
    await until(() => h.runtime.session.isStreaming);
    const queued = await h.tool("project_apply", { authorizationId: grant.id });
    assert.ok(!queued.isError, queued.content[0].text);
    assert.equal(JSON.parse(queued.content[0].text).queued, true);
    await h.runtime.session.abort();
    await running;
    assert.equal(
      JSON.parse((await h.tool("project_status")).content[0].text).busy,
      false,
    );
    await h.command('V2_TEST:{"op":"answer","text":"AFTER_REAL_ABORT"}');
    assert.equal(h.runtime.cwd, h.source);
  }));

test(
  "natural cancellation while members are settling fences the in-flight workspace grant",
  { timeout: 25000 },
  () =>
    harness(async (h) => {
      await h.tool("team_spawn", {
        name: "settling-worker",
        role: "wait fixture",
        workspace: { root: h.source, access: "read-only", execution: "files" },
      });
      await h.input("帮我把工作区改成target");
      const grant = JSON.parse(
        (await h.tool("project_status")).content[0].text,
      ).authorization;
      const running = h.input('V2_TEST:{"op":"hang"}', "extension");
      await until(() => h.runtime.session.isStreaming);
      await h.tool("team_send", {
        to: "settling-worker",
        message: 'V2_TEST:{"op":"hang"}',
      });
      await until(async () =>
        (await h.state()).tasks.some(
          (task) => task.state === "running" && task.sessionFile,
        ),
      );
      const applying = h.tool("project_apply", { authorizationId: grant.id });
      await h.input("先别改名了", "interactive", {
        streamingBehavior: "steer",
      });
      const response = await applying;
      assert.equal(response.isError, true, response.content[0].text);
      assert.match(response.content[0].text, /cancelled/);
      await h.runtime.session.abort();
      await running;
      assert.equal(h.runtime.cwd, h.source);
      assert.equal(fs.existsSync(h.target), false);
      assert.equal(
        JSON.parse((await h.tool("project_status")).content[0].text).busy,
        false,
      );
    }),
);
test("custom session storage inside a renamed project remains discoverable", () =>
  harness(
    async (h) => {
      await h.command("/project rename target");
      assert.equal(h.runtime.cwd, h.target, JSON.stringify(h.notices));
      assert.equal(
        path.dirname(h.runtime.session.sessionFile),
        path.join(h.target, "history"),
      );
      assert.equal(
        SessionManager.continueRecent(
          h.target,
          path.join(h.target, "history"),
        ).getSessionId(),
        h.runtime.session.sessionId,
      );
    },
    { customStorage: true },
  ));
test("invalid rename never overwrites a destination or changes a live workspace", () =>
  harness(async (h) => {
    fs.mkdirSync(h.target);
    fs.writeFileSync(path.join(h.target, "keep.txt"), "KEEP");
    await h.command("/project rename target");
    assert.equal(h.runtime.cwd, h.source);
    assert.equal(
      fs.readFileSync(path.join(h.target, "keep.txt"), "utf8"),
      "KEEP",
    );
  }));

test(
  "rename stops a running member before moving its workspace and never replays its task",
  { timeout: 25000 },
  () =>
    harness(async (h) => {
      await h.tool("team_spawn", {
        name: "running-worker",
        role: "wait fixture",
        workspace: { root: h.source, access: "read-only", execution: "files" },
      });
      const main = h.command('V2_TEST:{"op":"hang"}');
      await until(() => h.runtime.session.isStreaming);
      await h.tool("team_send", {
        to: "running-worker",
        message: 'V2_TEST:{"op":"hang"}',
      });
      await until(async () =>
        (await h.state()).tasks.some(
          (t) => t.state === "running" && t.sessionFile,
        ),
      );
      await h.command("/project rename target");
      await main;
      assert.equal(h.runtime.cwd, h.target, JSON.stringify(h.notices));
      const state = await h.state();
      assert.equal(state.tasks[0].state, "cancelled");
      assert.equal(state.tasks[0].processState, "stopped");
      assert.equal(state.mission.status, "paused");
      assert.ok(fs.existsSync(state.tasks[0].sessionFile));
    }),
);

test("expired workspace grants cannot be used or revived from their old visible messages", () =>
  harness(async (h) => {
    await h.command("/project allow rename target");
    const grant = JSON.parse(
      (await h.tool("project_status")).content[0].text,
    ).authorization;
    const now = Date.now;
    try {
      Date.now = () => grant.expiresAt + 1;
      assert.equal(
        (await h.tool("project_apply", { authorizationId: grant.id })).isError,
        true,
      );
    } finally {
      Date.now = now;
    }
    await h.command("/project revoke");
    assert.equal(
      (await h.tool("project_apply", { authorizationId: grant.id })).isError,
      true,
    );
    assert.equal(h.runtime.cwd, h.source);
  }));

test("a new persistent conversation can switch workspace before its first model response", () =>
  harness(
    async (h) => {
      fs.mkdirSync(h.target);
      await h.command('/project switch "' + h.target + '"');
      assert.equal(h.runtime.cwd, h.target, JSON.stringify(h.notices));
      assert.ok(fs.existsSync(h.runtime.session.sessionFile));
      await h.command(
        'V2_TEST:{"op":"answer","text":"FIRST_RESPONSE_AFTER_SWITCH"}',
      );
      assert.equal(
        h.runtime.session.getLastAssistantText(),
        "FIRST_RESPONSE_AFTER_SWITCH",
      );
    },
    { noInitialResponse: true },
  ));
