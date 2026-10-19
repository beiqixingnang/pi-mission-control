import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { taskTiming, executionDeadline } from "../../runtime/task-policy.ts";
import { resolveSettings } from "../../runtime/types.ts";
import { MissionKernel } from "../../runtime/kernel.ts";

test("task deadlines are optional, accept long fixed durations and separate queue limits", () => {
  assert.equal(resolveSettings().taskTimeoutMs, 0);
  assert.equal(taskTiming().timeoutPolicy, "none");
  assert.equal(taskTiming({ timeoutPolicy: "none" }, 600000).timeoutMs, 0);
  assert.equal(taskTiming({ timeoutMs: 7200000 }).timeoutPolicy, "fixed");
  assert.equal(taskTiming({ queueTimeoutMs: 1000 }).timeoutMs, 0);
  for (const input of [
    { timeoutPolicy: "fixed", timeoutMs: 0 },
    { timeoutPolicy: "none", timeoutMs: 1000 },
    { timeoutMs: -1 },
    { timeoutMs: 999 },
    { queueTimeoutMs: NaN },
  ])
    assert.throws(() => taskTiming(input));
});

test("an explicit deadline still cancels, while none and multi-day durations do not overflow into an immediate kill", async () => {
  let fixed = 0,
    none = 0,
    long = 0;
  const clearFixed = executionDeadline(25, () => fixed++);
  const clearNone = executionDeadline(0, () => none++);
  const clearLong = executionDeadline(60 * 86400000, () => long++);
  try {
    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.equal(fixed, 1);
    assert.equal(none, 0);
    assert.equal(long, 0);
  } finally {
    clearFixed();
    clearNone();
    clearLong();
  }
});

async function harness(run) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "mc-task-policy-"));
  let now = 100000;
  const workers = [];
  const kernel = new MissionKernel({
    directory,
    cwd: directory,
    sessionId: "task-policy",
    now: () => now,
    settings: { maxParallel: 1 },
    isLeadIdle: () => false,
    wake: () => {},
    workerFactory: async (assignment, signal) => {
      let resolve;
      const result = new Promise((r) => (resolve = r));
      const worker = {
        assignment,
        result,
        resolve,
        stop: async () =>
          resolve({ ok: false, text: "", processState: "stopped" }),
      };
      signal.addEventListener("abort", () => worker.stop(), { once: true });
      workers.push(worker);
      return worker;
    },
  });
  kernel.start(false);
  const add = (name) =>
    kernel.addMember({
      name,
      role: name,
      thinkingLevel: "off",
      workspace: {
        root: directory,
        access: "read-write",
        execution: "host",
        extraReadRoots: [],
      },
      allow: [],
      temporary: false,
    });
  const flush = async () => {
    await new Promise(setImmediate);
    await new Promise(setImmediate);
  };
  try {
    await run({ kernel, add, workers, flush, advance: (ms) => (now += ms) });
  } finally {
    await kernel.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

test("queue time never spends execution time; only an explicit queue timeout expires queued work", () =>
  harness(async (h) => {
    h.add("first");
    h.add("second");
    h.add("third");
    const first = h.kernel.dispatch("first", "Long scan");
    const second = h.kernel.dispatch("second", "Fixed scan", {
      timeoutMs: 1000,
    });
    const third = h.kernel.dispatch("third", "Queue limited scan", {
      queueTimeoutMs: 1000,
    });
    await h.flush();
    h.advance(7200000);
    await h.kernel.tick();
    assert.equal(h.kernel.store.task(first.id).state, "running");
    assert.equal(h.kernel.store.task(second.id).state, "queued");
    assert.equal(h.kernel.store.task(third.id).state, "failed");
    h.workers[0].resolve({
      ok: true,
      text: "Finished scan",
      processState: "stopped",
    });
    await h.flush();
    await h.kernel.tick();
    assert.equal(h.kernel.store.task(second.id).state, "running");
    await h.kernel.tick();
    assert.equal(h.kernel.store.task(third.id).state, "failed");
    assert.match(h.kernel.store.task(third.id).error, /Queue deadline/);
    assert.equal(h.kernel.store.task(second.id).executionMs, 0);
  }));

test("members receive bounded goal context and can page full criteria without editing or accepting goals", () =>
  harness(async (h) => {
    h.add("reader");
    const nodes = h.kernel.planGoals([
      { key: "root", objective: "Inventory", criteria: ["Stages accepted"] },
      {
        key: "stage",
        parentId: "root",
        objective: "Decode scan",
        criteria: ["Batches accepted"],
      },
      {
        key: "leaf",
        parentId: "stage",
        objective: "Check decode files",
        criteria: Array.from(
          { length: 9 },
          (_, i) => "Criterion " + i + " " + "a".repeat(1000),
        ),
        scope: {
          unitKind: "file",
          items: ["decode/decoder.py", "decode/immediate.py"],
        },
        nextStep: "Trace immediate mapping",
      },
    ]);
    const leaf = nodes[2];
    h.kernel.focusGoal(leaf.id, 0);
    const task = h.kernel.dispatch(
      "reader",
      "Review the assigned decode batch",
    );
    await h.flush();
    const assignment = h.workers[0].assignment;
    assert.match(assignment.prompt, /assignedRevision/);
    assert.match(assignment.prompt, /decode\/decoder.py/);
    assert.match(assignment.prompt, /Decode scan/);
    assert.ok(assignment.prompt.length < 15000);
    const page = h.kernel.memberRequest(assignment.token, {
      id: "criteria",
      op: "goal-context",
      section: "criteria",
      offset: 5,
      limit: 4,
    });
    assert.equal(page.total, 9);
    assert.equal(page.entries[0].index, 6);
    assert.ok(page.entries[0].text.endsWith("a".repeat(1000)));
    assert.throws(
      () =>
        h.kernel.memberRequest(assignment.token, {
          id: "bad",
          op: "goal-accept",
        }),
      /Unsupported/,
    );
    assert.equal(h.kernel.goals.node(leaf.id).state, "active");
    assert.equal(h.kernel.store.task(task.id).timeoutMs, 0);
  }));
