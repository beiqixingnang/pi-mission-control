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
  const source = path.join(base, "source"),
    target = path.join(base, "target"),
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
test("a cancelled native switch rolls back rename and leaves the original runtime paused and usable", () =>
  harness(async (h) => {
    const original = h.runtime.session;
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
