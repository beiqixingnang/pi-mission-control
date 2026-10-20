import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { hostDir } from "../../scripts/host.mjs";
const {
  createAgentSession,
  DefaultResourceLoader,
  SessionManager,
  SettingsManager,
} = await import(pathToFileURL(path.join(hostDir, "dist/index.js")));

async function harness(fn) {
  const cwd = fs.realpathSync.native(
      fs.mkdtempSync(path.join(os.tmpdir(), "notes-pi-")),
    ),
    agentDir = process.env.PI_CODING_AGENT_DIR;
  assert.ok(agentDir, "Use scripts/test-v2.mjs for isolated settings");
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
      path.resolve("tests/v2/offline-provider.ts"),
      path.resolve("extensions/mission-control/compaction.ts"),
    ],
  });
  await resources.reload();
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
  const { session } = await createAgentSession({
    cwd,
    agentDir,
    model,
    settingsManager: settings,
    resourceLoader: resources,
    sessionManager: SessionManager.create(cwd, path.join(cwd, "sessions")),
  });
  const events = [],
    errors = [];
  await session.bindExtensions({
    mode: "rpc",
    onError: (error) => errors.push(error),
  });
  session.subscribe((event) => events.push(event));
  const file = path.join(cwd, "decoder.ts");
  fs.writeFileSync(
    file,
    "export const position = 173; // retain review position\n",
  );
  const tool = (name, args = {}) =>
    session.agent.state.tools
      .find((t) => t.name === name)
      .execute(
        "direct-" + crypto.randomUUID(),
        args,
        new AbortController().signal,
      );
  const status = async () =>
    JSON.parse((await tool("context_mode")).content[0].text);
  const windows = () =>
    session.sessionManager
      .getBranch()
      .filter(
        (e) => e.type === "compaction" && e.details?.contextMode === "notes",
      );
  const run = (args) =>
    session.prompt(
      "V2_TEST:" + JSON.stringify({ op: "notes-cycle", file, ...args }),
    );
  try {
    await fn({ cwd, session, events, tool, status, windows, run });
    assert.deepEqual(errors, []);
  } finally {
    await session.abort();
    await session.extensionRunner.emit({
      type: "session_shutdown",
      reason: "quit",
    });
    session.dispose();
    fs.rmSync(cwd, { recursive: true, force: true });
  }
}
const until = async (fn) => {
  const end = Date.now() + 10000;
  while (Date.now() < end) {
    if (fn()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw Error("Timed out waiting for notes fixture");
};

test(
  "real Pi keeps the stable source prefix across live index updates and handoff hints",
  { timeout: 20000 },
  () =>
    harness(async (h) => {
      const trace = path.join(h.cwd, "cache-prefix.jsonl"),
        before = process.env.MC_FIXTURE_CACHE_TRACE;
      process.env.MC_FIXTURE_CACHE_TRACE = trace;
      try {
        await h.tool("context_mode", { mode: "notes" });
        await h.session.prompt(
          "V2_TEST:" +
            JSON.stringify({
              op: "answer",
              text: "SYNTHETIC_STABLE_SOURCE ".repeat(1000),
            }),
        );
        await h.run({ windows: 1, auto: true });
        const rows = fs
          .readFileSync(trace, "utf8")
          .trim()
          .split("\n")
          .map(JSON.parse);
        assert.ok(
          rows.filter((r) => r.prefixChars > 20000).length >= 3,
          JSON.stringify(rows),
        );
        assert.equal(h.windows().length, 1);
        assert.match(h.session.getLastAssistantText(), /NOTES_CYCLES_COMPLETE/);
      } finally {
        if (before === undefined) delete process.env.MC_FIXTURE_CACHE_TRACE;
        else process.env.MC_FIXTURE_CACHE_TRACE = before;
      }
    }),
);

test(
  "a real Pi burst crossing the local handoff reserve still saves notes and resumes the next window",
  { timeout: 20000 },
  () =>
    harness(async (h) => {
      await h.run({ windows: 2, auto: true, burstOvershoot: true });
      assert.equal(h.windows().length, 2);
      assert.match(h.session.getLastAssistantText(), /NOTES_CYCLES_COMPLETE/);
      assert.equal(
        h.events.filter((e) => e.type === "tool_execution_end" && e.isError)
          .length,
        0,
      );
    }),
);

for (const ignored of ["read", "claim"]) {
  test(
    `real Pi stops uncooperative ${ignored} handoff as a local error without claiming task completion`,
    { timeout: 20000 },
    () =>
      harness(async (h) => {
        await h.run({ windows: 1, auto: true, ignorePreparation: ignored });
        assert.equal(h.windows().length, 0);
        const messages = h.events.filter(
          (e) => e.type === "message_end" && e.message.role === "assistant",
        );
        assert.ok(
          messages.length <= 10,
          "maintenance cannot loop indefinitely",
        );
        assert.equal(messages.at(-1).message.stopReason, "error");
        assert.match(
          messages.at(-1).message.errorMessage,
          /task has not completed/,
        );
        assert.equal((await h.status()).preparation.phase, "exhausted");
        assert.equal(
          h.events.filter((e) => e.type === "agent_settled").length,
          1,
        );
      }),
  );
}

test(
  "real Pi rolling summary preserves the previous checkpoint literally while the bounded output has room",
  { timeout: 20000 },
  () =>
    harness(async (h) => {
      const oldMode = process.env.MC_FIXTURE_SUMMARY,
        oldTrace = process.env.MC_FIXTURE_SUMMARY_TRACE;
      const trace = path.join(h.cwd, "summary-requests.jsonl");
      process.env.MC_FIXTURE_SUMMARY = "success";
      process.env.MC_FIXTURE_SUMMARY_TRACE = trace;
      try {
        h.session.settingsManager.applyOverrides({
          compaction: { keepRecentTokens: 128 },
        });
        await h.tool("compaction_model", {
          action: "set",
          model: "mission-fixture/summary",
        });
        await h.session.prompt(
          "V2_TEST:" +
            JSON.stringify({
              op: "answer",
              text:
                "EARLIER_ZERO_UNIT " + "older code observation ".repeat(500),
            }),
        );
        const first = await h.session.compact();
        const before = fs.readFileSync(trace, "utf8").trim().split("\n").length;
        await h.session.prompt(
          "V2_TEST:" +
            JSON.stringify({
              op: "answer",
              text: "NEW_UNIT_ONE " + "new code observation ".repeat(500),
            }),
        );
        const second = await h.session.compact();
        const requests = fs
          .readFileSync(trace, "utf8")
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line))
          .slice(before);
        assert.ok(requests.length >= 1);
        assert.equal(
          requests[0].previousCheckpoint,
          false,
          "new source is reduced independently",
        );
        assert.ok(requests.every((request) => !request.previousCheckpoint));
        assert.ok(
          second.summary.includes(first.summary),
          "the host persists the exact old checkpoint without another model rewrite",
        );
      } finally {
        if (oldMode === undefined) delete process.env.MC_FIXTURE_SUMMARY;
        else process.env.MC_FIXTURE_SUMMARY = oldMode;
        if (oldTrace === undefined) delete process.env.MC_FIXTURE_SUMMARY_TRACE;
        else process.env.MC_FIXTURE_SUMMARY_TRACE = oldTrace;
      }
    }),
);

test(
  "standalone real Pi automatically prepares five windows and settles only after the full reading task",
  { timeout: 20000 },
  () =>
    harness(async (h) => {
      await h.run({ windows: 5, auto: true });
      assert.match(h.session.getLastAssistantText(), /NOTES_CYCLES_COMPLETE/);
      assert.equal(h.windows().length, 5);
      assert.equal(
        h.events.filter((e) => e.type === "agent_settled").length,
        1,
      );
      assert.equal(
        h.events.filter(
          (e) => e.type === "tool_execution_end" && e.toolName === "read",
        ).length,
        5,
      );
      assert.equal(
        h.events.filter((e) => e.type === "tool_execution_end" && e.isError)
          .length,
        0,
      );
      const history = JSON.parse(
        (
          await h.tool("context_history", {
            action: "search",
            query: "export const position",
          })
        ).content[0].text,
      );
      assert.ok(history.matches.some((match) => match.role === "toolResult"));
      const originalId = h.session.sessionManager.getSessionId();
      await h.session.reload();
      assert.equal((await h.status()).mode, "notes");
      await h.run({ windows: 2 });
      assert.equal(h.session.sessionManager.getSessionId(), originalId);
      assert.equal(h.windows().length, 7);
      assert.equal(
        h.events.filter((e) => e.type === "agent_settled").length,
        2,
      );
    }),
);

test(
  "Escape during real Pi handoff stops without changing windows, and an explicit new run repairs it",
  { timeout: 20000 },
  () =>
    harness(async (h) => {
      const running = h.run({ windows: 1, auto: true, hangAt: 3 });
      await until(
        () =>
          h.events.filter(
            (e) => e.type === "message_start" && e.message.role === "assistant",
          ).length >= 3,
      );
      await h.session.abort();
      await running;
      assert.equal(h.windows().length, 0);
      assert.equal((await h.status()).preparation.phase, "paused");
      assert.equal(
        h.events.filter((e) => e.type === "agent_settled").at(-1).aborted,
        true,
      );
      await h.run({ windows: 1 });
      assert.equal(h.windows().length, 1);
      assert.match(h.session.getLastAssistantText(), /NOTES_CYCLES_COMPLETE/);
    }),
);

test(
  "429 during real Pi handoff does not fall back, shrink a context budget or spin in a maintenance loop",
  { timeout: 20000 },
  () =>
    harness(async (h) => {
      await h.run({ windows: 1, auto: true, failAt: 3 });
      assert.equal(h.windows().length, 0);
      assert.equal(
        h.events.filter(
          (e) => e.type === "message_end" && e.message.role === "assistant",
        ).length,
        3,
      );
      assert.equal(
        (await h.status()).budget.policy.learnedLimitTokens,
        undefined,
      );
      assert.match(
        h.events
          .filter(
            (e) => e.type === "message_end" && e.message.role === "assistant",
          )
          .at(-1).message.errorMessage,
        /429/,
      );
      assert.equal(
        h.events.filter((e) => e.type === "agent_settled").length,
        1,
      );
      await h.tool("context_mode", { mode: "summary" });
      assert.equal((await h.status()).preparation, undefined);
    }),
);
