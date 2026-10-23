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
  const tool = async (name, args = {}) => {
    if (name === "context_mode" && args.mode)
      await session.extensionRunner.emitInput(
        `请把当前会话改成 ${args.mode} 模式`,
        undefined,
        "rpc",
      );
    return session.agent.state.tools
      .find((t) => t.name === name)
      .execute(
        "direct-" + crypto.randomUUID(),
        args,
        new AbortController().signal,
      );
  };
  const status = async () =>
    JSON.parse((await tool("context_mode")).content[0].text);
  const windows = () =>
    session.sessionManager
      .getBranch()
      .filter(
        (e) => e.type === "compaction" && e.details?.contextMode === "notes",
      );
  const run = async (args) => {
    await session.prompt("/context mode notes");
    return session.prompt(
      "V2_TEST:" + JSON.stringify({ op: "notes-cycle", file, ...args }),
    );
  };
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

test("offline provider selects the new command in a batched wake and does not replay healthy faults on maintenance", () =>
  harness(async (h) => {
    const trace = path.join(h.cwd, "batched-fixture.jsonl");
    const old =
      "V2_TEST:" +
      JSON.stringify({ op: "answer", text: "OLD_ALREADY_HANDLED" });
    const next =
      "V2_TEST:" +
      JSON.stringify({
        op: "flaky",
        key: "batch",
        failures: 0,
        traceFile: trace,
      });
    await h.session.prompt("Mission Control updates.\n" + old + "\n\n" + next);
    assert.equal(h.session.getLastAssistantText(), "RECOVERED_REQUEST_1");
    await h.session.prompt(
      "Mission Control updates.\nContinue the next approved step.",
    );
    assert.equal(h.session.getLastAssistantText(), "FIXTURE_UPDATES_OBSERVED");
    assert.equal(fs.readFileSync(trace, "utf8").trim().split("\n").length, 1);
  }));

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
  "real Pi injects a checkpoint index once, preserves newer revisions and reloads both compaction paths",
  { timeout: 20000 },
  () =>
    harness(async (h) => {
      const trace = path.join(h.cwd, "index-projection.jsonl"),
        oldTrace = process.env.MC_FIXTURE_CACHE_TRACE,
        oldMarker = process.env.MC_FIXTURE_INDEX_MARKER;
      process.env.MC_FIXTURE_CACHE_TRACE = trace;
      const first = "EXACT_INDEX_ONE_63fc",
        second = "EXACT_INDEX_TWO_42ae";
      const count = () =>
        JSON.parse(fs.readFileSync(trace, "utf8").trim().split("\n").at(-1))
          .markerOccurrences;
      const probe = () =>
        h.session.prompt('V2_TEST:{"op":"answer","text":"projection probe"}');
      try {
        h.session.settingsManager.applyOverrides({
          compaction: { keepRecentTokens: 128 },
        });
        await h.tool("context_mode", { mode: "notes" });
        await h.session.prompt(
          "V2_TEST:" +
            JSON.stringify({
              op: "answer",
              text: "Synthetic source for a native cut point. ".repeat(500),
            }),
        );
        await h.tool("context_note", {
          action: "write",
          notes: [
            { name: "index", text: first },
            { name: "handoff", text: "Continue from the saved position" },
          ],
        });
        process.env.MC_FIXTURE_INDEX_MARKER = first;
        await probe();
        assert.equal(
          count(),
          1,
          "first-time index must be visible in the hint",
        );
        await h.tool("context_note", {
          action: "write",
          name: "handoff",
          text: "Updated coverage before native compact",
        });
        await h.session.compact();
        assert.equal(
          h.windows().at(-1).details.injectedNotes.index.revision,
          1,
        );
        await probe();
        assert.equal(
          count(),
          1,
          "native checkpoint must not duplicate the index in the hint",
        );
        await h.session.reload();
        await probe();
        assert.equal(
          count(),
          1,
          "reload preserves the exact checkpoint metadata",
        );
        await h.tool("context_note", {
          action: "write",
          name: "index",
          text: second,
        });
        process.env.MC_FIXTURE_INDEX_MARKER = second;
        await probe();
        assert.equal(
          count(),
          1,
          "newer index must be visible before another rollover",
        );
        await h.session.reload();
        await probe();
        assert.equal(count(), 1, "newer note survives reload");
        await h.tool("context_note", {
          action: "write",
          name: "handoff",
          text: "Fresh tool boundary handoff",
        });
        await h.session.prompt(
          'V2_TEST:{"op":"tool","name":"context_rollover","args":{}}',
        );
        assert.equal(h.windows().at(-1).details.boundary, true);
        await probe();
        assert.equal(
          count(),
          1,
          "turn-boundary checkpoint must not duplicate the current index",
        );
      } finally {
        if (oldTrace === undefined) delete process.env.MC_FIXTURE_CACHE_TRACE;
        else process.env.MC_FIXTURE_CACHE_TRACE = oldTrace;
        if (oldMarker === undefined) delete process.env.MC_FIXTURE_INDEX_MARKER;
        else process.env.MC_FIXTURE_INDEX_MARKER = oldMarker;
      }
    }),
);

test(
  "real Pi history tools resume a low-budget search with its public schema after reload",
  { timeout: 20000 },
  () =>
    harness(async (h) => {
      for (let i = 0; i < 5; i++)
        await h.session.prompt(
          "V2_TEST:" +
            JSON.stringify({
              op: "answer",
              text: "PUBLIC_CURSOR_TARGET " + "中文🙂".repeat(400),
            }),
        );
      const seen = [];
      let cursor;
      for (let page = 0; page < 10; page++) {
        const response = await h.tool("context_history", {
          action: "batch",
          requests: [
            {
              action: "search",
              query: "PUBLIC_CURSOR_TARGET",
              role: "user",
              limit: 2,
              cursor,
            },
          ],
          budgetTokens: 256,
          startRequest: 0,
        });
        const result = JSON.parse(response.content[0].text);
        assert.ok(result.results[0].matches.length);
        seen.push(...result.results[0].matches.map((hit) => hit.id));
        cursor = result.results[0].nextCursor;
        if (!cursor) break;
        assert.equal(result.nextRequest, 0);
        await h.session.reload();
      }
      assert.equal(seen.length, 5);
      assert.equal(new Set(seen).size, 5);
    }),
);

test(
  "real Pi accepts filled history placeholders and diagnoses excluded receipts across reload",
  { timeout: 20000 },
  () =>
    harness(async (h) => {
      const phrase = "计划里已有 AMD64：只读测试原始消息";
      await h.session.prompt(
        "V2_TEST:" + JSON.stringify({ op: "answer", text: phrase }),
      );
      const original = h.session.sessionManager
        .getBranch()
        .find(
          (e) =>
            e.type === "message" &&
            e.message?.role === "assistant" &&
            e.message.content?.some(
              (b) => b.type === "text" && b.text === phrase,
            ),
        );
      assert.ok(original);
      const call = async (args) => {
        await h.session.prompt(
          "V2_TEST:" +
            JSON.stringify({ op: "tool", name: "context_history", args }),
        );
        return JSON.parse(h.session.getLastAssistantText());
      };
      const filled = {
        action: "search",
        budgetTokens: 1000,
        cursor: "",
        id: "",
        limit: 3,
        offset: 0,
        query: phrase,
        requests: [
          {
            action: "search",
            cursor: "",
            id: "",
            limit: 3,
            offset: 0,
            query: phrase,
            role: "assistant",
          },
        ],
        role: "assistant",
        startRequest: 0,
      };
      const first = await call(filled);
      assert.ok(!first.isError, first.text);
      assert.ok(
        JSON.parse(first.text).matches.some((hit) => hit.id === original.id),
      );
      const forged = await call({ ...filled, cursor: "0" });
      assert.equal(forged.isError, true);
      assert.match(forged.text, /omit cursor/);
      const receipt = h.session.sessionManager
        .getBranch()
        .findLast(
          (e) =>
            e.type === "message" &&
            e.message?.role === "toolResult" &&
            e.message.toolName === "context_history" &&
            e.message.isError,
        );
      assert.ok(receipt);
      const readReceipt = {
        ...filled,
        action: "read",
        id: receipt.id,
        query: "",
        role: "toolResult",
        limit: 1000,
        requests: [
          {
            action: "read",
            cursor: "",
            id: receipt.id,
            limit: 1000,
            offset: 0,
            query: "",
            role: "toolResult",
          },
        ],
      };
      const excluded = await call(readReceipt);
      assert.equal(excluded.isError, true);
      assert.match(excluded.text, /HISTORY_ITEM_EXCLUDED.*Do not retry/);
      const source = await call({ ...readReceipt, id: original.id });
      assert.ok(!source.isError, source.text);
      assert.equal(JSON.parse(source.text).text, phrase);
      const batch = await call({ ...filled, action: "batch" });
      assert.ok(!batch.isError, batch.text);
      assert.ok(JSON.parse(batch.text).results[0].matches.length);
      const sessionId = h.session.sessionManager.getSessionId();
      await h.session.reload();
      assert.equal(h.session.sessionManager.getSessionId(), sessionId);
      const restored = await call({ ...filled, cursor: null });
      assert.ok(!restored.isError, restored.text);
      assert.ok(JSON.parse(restored.text).matches.length);
      const batchNull = await call({
        ...filled,
        action: "batch",
        requests: [{ ...filled.requests[0], cursor: null }],
      });
      assert.ok(!batchNull.isError, batchNull.text);
      const stillExcluded = await call(readReceipt);
      assert.equal(stillExcluded.isError, true);
      assert.match(stillExcluded.text, /HISTORY_ITEM_EXCLUDED/);
      assert.equal(
        h.events.filter(
          (e) =>
            e.type === "tool_execution_end" &&
            e.toolName === "context_history" &&
            e.isError,
        ).length,
        3,
        "only the invented cursor and two intentional excluded reads fail",
      );
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
