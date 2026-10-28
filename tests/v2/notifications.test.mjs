import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { MissionKernel } from "../../runtime/kernel.ts";
import { resolveNotificationPolicy } from "../../runtime/notifications.ts";

const flush = async () => {
  await new Promise(setImmediate);
  await new Promise(setImmediate);
};
async function harness(run) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "mc-notifications-"));
  let now = 100000,
    idle = true,
    kernel;
  const workers = [],
    wakes = [];
  const make = () => {
    const value = new MissionKernel({
      directory,
      cwd: directory,
      sessionId: "notifications",
      now: () => now,
      isLeadIdle: () => idle,
      wake(wake) {
        wakes.push(wake);
        idle = false;
      },
      workerFactory: async (assignment, signal) => {
        let resolve;
        const result = new Promise((r) => (resolve = r));
        const worker = {
          assignment,
          result,
          resolve,
          deliveries: [],
          async deliver(message) {
            this.deliveries.push(message);
          },
          async stop() {
            resolve({ ok: false, text: "stopped", processState: "stopped" });
          },
        };
        signal.addEventListener("abort", worker.stop, { once: true });
        workers.push(worker);
        return worker;
      },
    });
    value.start(false);
    return value;
  };
  kernel = make();
  const h = {
    get kernel() {
      return kernel;
    },
    workers,
    wakes,
    idle(value = true) {
      idle = value;
    },
    advance(ms) {
      now += ms;
    },
    add(name, allow = []) {
      return kernel.addMember({
        name,
        role: name,
        thinkingLevel: "off",
        temporary: false,
        allow,
        workspace: {
          root: directory,
          access: "read-only",
          execution: "files",
          extraReadRoots: [],
        },
      });
    },
    async reload() {
      await kernel.close();
      kernel = make();
    },
    async settleWake() {
      const wake = wakes.at(-1);
      kernel.leadStarted(wake);
      kernel.includeWake(wake.batchId);
      kernel.leadMessage(false, 1);
      kernel.leadSettled();
      idle = true;
    },
  };
  try {
    await run(h);
  } finally {
    await kernel.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
}
const claim = [
  {
    criterion: 1,
    source: "statement",
    summary: "Concrete verification of this criterion",
  },
];

test("notification defaults preserve legacy wake behavior and invalid edits are rejected", () => {
  assert.deepEqual(resolveNotificationPolicy(), {
    taskSuccess: true,
    taskFailure: true,
    goalReadyLevels: [],
    goalAcceptedLevels: [],
  });
  assert.deepEqual(
    resolveNotificationPolicy({ goalReadyLevels: [3, 2, 2] }).goalReadyLevels,
    [2, 3],
  );
  for (const patch of [
    { taskSuccess: "false" },
    { taskFailure: null },
    { goalReadyLevels: [0] },
    { goalAcceptedLevels: [13] },
    { goalReadyLevels: [1.5] },
  ])
    assert.throws(() => resolveNotificationPolicy(patch));
});

test("success can stay quiet while failure wakes; the failure digest includes retained successful results", () =>
  harness(async (h) => {
    h.add("success");
    h.add("failure");
    h.kernel.setNotificationPolicy({ taskSuccess: false, taskFailure: true });
    const success = h.kernel.dispatch("success", "Finish quietly");
    await flush();
    h.workers[0].resolve({
      ok: true,
      text: "SAVED_SUCCESS",
      processState: "stopped",
    });
    await flush();
    h.advance(5000);
    await h.kernel.tick();
    assert.equal(
      h.wakes.length,
      0,
      "no synthetic continuation bypasses a quiet result",
    );
    assert.equal(
      h.kernel.store.deliveries("lead").find((d) => d.taskId === success.id)
        .state,
      "pending",
    );
    h.kernel.dispatch("failure", "Report a failure");
    await flush();
    h.workers[1].resolve({
      ok: false,
      text: "FAILED_TASK",
      error: "Business task failed",
      processState: "stopped",
    });
    await flush();
    assert.equal(h.wakes.length, 1);
    assert.match(h.wakes[0].content, /FAILED_TASK/);
    assert.match(h.wakes[0].content, /SAVED_SUCCESS/);
  }));

test("failure can stay quiet while success wakes, and quiet failures cannot crowd the triggering success out", () =>
  harness(async (h) => {
    h.add("worker");
    h.kernel.setNotificationPolicy({ taskSuccess: true, taskFailure: false });
    h.kernel.setGoal("Independent failure/success preferences");
    for (let i = 0; i < 10; i++)
      h.kernel.delivery({
        key: "failure-" + i,
        taskId: "fixture-" + i,
        from: "worker",
        to: "lead",
        kind: "failure",
        summary: "quiet failure " + i,
      });
    await h.kernel.tick();
    assert.equal(h.wakes.length, 0);
    h.kernel.dispatch("worker", "Success must trigger");
    await flush();
    h.workers[0].resolve({
      ok: true,
      text: "SUCCESS_TRIGGER",
      processState: "stopped",
    });
    await flush();
    assert.equal(h.wakes.length, 1);
    assert.match(h.wakes[0].content, /SUCCESS_TRIGGER/);
    assert.equal(
      h.kernel.validWake(h.wakes[0].batchId, h.wakes[0].generation),
      true,
    );
  }));

test("quiet results are retained for the unchanged scheduled report and policy survives reload", () =>
  harness(async (h) => {
    h.add("worker");
    h.kernel.setNotificationPolicy({ taskSuccess: false, taskFailure: false });
    const task = h.kernel.dispatch("worker", "Wait for the report");
    await flush();
    const nextReportAt = h.kernel.snapshot().nextReportAt;
    h.workers[0].resolve({
      ok: true,
      text: "REPORT_ONLY_RECEIPT",
      processState: "stopped",
    });
    await flush();
    await h.reload();
    assert.equal(h.kernel.notificationPolicy().taskSuccess, false);
    assert.equal(h.kernel.snapshot().nextReportAt, nextReportAt);
    h.advance(3599999);
    await h.kernel.tick();
    assert.equal(h.wakes.length, 0);
    h.advance(1);
    await h.kernel.tick();
    assert.equal(h.wakes.length, 1);
    assert.match(h.wakes[0].content, /Scheduled progress/);
    assert.match(h.wakes[0].content, /REPORT_ONLY_RECEIPT/);
    assert.ok(h.kernel.store.task(task.id).resultPath);
  }));

test("second-level batch readiness waits for all required leaves, wakes once and never accepts the goal", () =>
  harness(async (h) => {
    const nodes = h.kernel.planGoals([
      { key: "root", objective: "Main goal", criteria: ["Stage accepted"] },
      {
        key: "stage",
        parentId: "root",
        objective: "Stage two",
        criteria: ["Leaves accepted"],
      },
      {
        key: "one",
        parentId: "stage",
        objective: "File one",
        criteria: ["Verified"],
      },
      {
        key: "two",
        parentId: "stage",
        objective: "File two",
        criteria: ["Verified"],
      },
    ]);
    const [root, stage, one, two] = nodes;
    h.add("one");
    h.add("two");
    h.kernel.setNotificationPolicy({
      taskSuccess: false,
      taskFailure: true,
      goalReadyLevels: [2],
    });
    h.kernel.dispatch("one", "File one work", { goalId: one.id });
    h.kernel.dispatch("two", "File two work", { goalId: two.id });
    await flush();
    h.workers[0].resolve({
      ok: true,
      text: "ONE_DONE",
      processState: "stopped",
    });
    await flush();
    assert.equal(h.wakes.length, 0);
    h.workers[1].resolve({
      ok: true,
      text: "TWO_DONE",
      processState: "stopped",
    });
    await flush();
    assert.equal(h.wakes.length, 1);
    assert.match(h.wakes[0].content, /Level 2 execution batch settled/);
    assert.match(h.wakes[0].content, /does not accept/);
    assert.equal(h.kernel.goals.node(stage.id).state, "planned");
    assert.equal(h.kernel.goals.node(root.id).state, "planned");
    const ready = h.kernel.store
      .deliveries("lead")
      .filter((d) => d.kind === "goal");
    assert.equal(ready.length, 1);
    assert.equal(ready[0].goalId, stage.id);
    await h.settleWake();
    h.kernel.acceptGoal(one.id, claim, 0);
    h.kernel.acceptGoal(two.id, claim, 0);
    await h.kernel.tick();
    assert.equal(
      h.kernel.store.deliveries("lead").filter((d) => d.kind === "goal").length,
      1,
      "leaf acceptance does not duplicate a batch-ready event",
    );
  }));

test("accepted-level notifications are exact, idempotent and stale goal notifications are fenced", () =>
  harness(async (h) => {
    h.idle(false);
    const [root, stage, leaf] = h.kernel.planGoals([
      { key: "root", objective: "Root", criteria: ["Accepted stage"] },
      {
        key: "stage",
        parentId: "root",
        objective: "Second-level accepted stage",
        criteria: ["Accepted leaf"],
      },
      {
        parentId: "stage",
        objective: "Third-level leaf",
        criteria: ["Verified"],
      },
    ]);
    h.kernel.setNotificationPolicy({
      taskSuccess: false,
      goalAcceptedLevels: [2],
    });
    h.kernel.acceptGoal(leaf.id, claim, 0);
    assert.equal(h.kernel.store.deliveries("lead").length, 0);
    const accepted = h.kernel.acceptGoal(stage.id, claim, 0);
    h.kernel.acceptGoal(stage.id, claim, 0);
    assert.equal(h.kernel.store.deliveries("lead").length, 1);
    assert.equal(
      h.kernel.store.deliveries("lead")[0].key,
      "goal-accepted:" + accepted.id,
    );
    h.kernel.editGoal(
      stage.id,
      { state: "planned", reason: "Updated stage requirements" },
      0,
    );
    h.idle();
    await h.kernel.tick();
    assert.equal(h.wakes.length, 0);
    assert.equal(h.kernel.store.deliveries("lead")[0].state, "superseded");
    assert.equal(h.kernel.store.mission().id, root.id);
  }));

test("quiet task results still resume a waiting parent and direct peer notes do not trigger the lead", () =>
  harness(async (h) => {
    h.add("parent", ["child"]);
    h.add("child");
    h.kernel.setNotificationPolicy({ taskSuccess: false, taskFailure: false });
    const parentTask = h.kernel.dispatch("parent", "Review the child's work");
    await flush();
    const token = h.workers[0].assignment.token;
    h.kernel.memberRequest(token, {
      id: "child",
      op: "message",
      to: "child",
      operation: "assign",
      message: "Child implementation",
    });
    h.kernel.memberRequest(token, { id: "wait", op: "wait" });
    h.workers[0].resolve({
      ok: true,
      text: "waiting",
      processState: "stopped",
    });
    await flush();
    h.workers[1].resolve({
      ok: true,
      text: "CHILD_RECEIPT",
      processState: "stopped",
    });
    await flush();
    assert.equal(h.workers.length, 3);
    assert.equal(h.workers[2].assignment.task.id, parentTask.id);
    assert.match(h.workers[2].assignment.prompt, /CHILD_RECEIPT/);
    assert.equal(h.wakes.length, 0);
  }));

test("policy changes fence a not-yet-started wake and preserve explicit decision notifications", () =>
  harness(async (h) => {
    h.add("worker");
    h.kernel.dispatch("worker", "Complete a task");
    await flush();
    h.workers[0].resolve({
      ok: true,
      text: "queued result",
      processState: "stopped",
    });
    await flush();
    const old = h.wakes[0];
    assert.ok(old);
    h.kernel.setNotificationPolicy({ taskSuccess: false, taskFailure: false });
    assert.equal(h.kernel.validWake(old.batchId, old.generation), false);
    h.idle();
    await h.kernel.tick();
    assert.equal(h.wakes.length, 1);
    h.kernel.delivery({
      key: "authorization",
      from: "worker",
      to: "lead",
      kind: "decision",
      summary: "Need explicit permission for deployment",
    });
    await h.kernel.tick();
    assert.equal(h.wakes.length, 2);
    assert.match(h.wakes[1].content, /explicit permission/);
  }));

test("a failed stage stays unready until its explicit retry succeeds", () =>
  harness(async (h) => {
    const [, stage, leaf] = h.kernel.planGoals([
      { key: "root", objective: "Root retry", criteria: ["Stage accepted"] },
      {
        key: "stage",
        parentId: "root",
        objective: "Retry stage",
        criteria: ["Leaf done"],
      },
      { parentId: "stage", objective: "Retry leaf", criteria: ["Verified"] },
    ]);
    h.add("worker");
    h.kernel.setNotificationPolicy({
      taskSuccess: false,
      taskFailure: false,
      goalReadyLevels: [2],
    });
    const original = h.kernel.dispatch("worker", "Explicit retry fixture", {
      goalId: leaf.id,
    });
    await flush();
    h.workers[0].resolve({
      ok: false,
      text: "Failed attempt",
      error: "Fixture failure",
      processState: "stopped",
    });
    await flush();
    assert.equal(h.wakes.length, 0);
    h.kernel.resumeTask(original.id);
    await flush();
    h.workers[1].resolve({
      ok: true,
      text: "Retry verified",
      processState: "stopped",
    });
    await flush();
    assert.equal(h.wakes.length, 1);
    assert.equal(
      h.kernel.store.deliveries("lead").find((d) => d.kind === "goal").goalId,
      stage.id,
    );
  }));

test("main-goal acceptance can notify after completion without reopening the mission", () =>
  harness(async (h) => {
    const root = h.kernel.setGoal("Main acceptance notification", ["Verified"]);
    h.kernel.setNotificationPolicy({
      taskSuccess: false,
      goalAcceptedLevels: [1],
    });
    h.kernel.complete([
      { criterion: 1, evidence: "Verified outcome with concrete evidence" },
    ]);
    await h.kernel.tick();
    assert.equal(h.wakes.length, 1);
    assert.match(h.wakes[0].content, /Level 1 goal accepted/);
    assert.equal(h.kernel.store.mission().status, "complete");
    assert.equal(h.kernel.goals.node(root.id).state, "accepted");
  }));

test("quiet task receipts do not suppress independent runtime recovery probes", () =>
  harness(async (h) => {
    h.add("worker");
    h.kernel.setNotificationPolicy({ taskSuccess: false, taskFailure: false });
    h.kernel.dispatch("worker", "Retain this success during recovery");
    await flush();
    h.workers[0].resolve({
      ok: true,
      text: "QUIET_RECOVERY_RECEIPT",
      processState: "stopped",
    });
    await flush();
    h.kernel.leadStarted();
    h.kernel.leadMessage(true, 0, "Upstream temporarily unavailable");
    h.kernel.leadSettled();
    h.advance(600000);
    await h.kernel.tick();
    assert.equal(h.wakes.length, 1);
    assert.match(h.wakes[0].content, /Runtime recovery probe/);
    assert.match(h.wakes[0].content, /QUIET_RECOVERY_RECEIPT/);
  }));
