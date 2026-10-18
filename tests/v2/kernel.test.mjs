import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { MissionKernel } from "../../runtime/kernel.ts";
import { Store } from "../../runtime/store.ts";

const flush = async () => {
  await new Promise(setImmediate);
  await new Promise(setImmediate);
};
function harness() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "mc-v2-kernel-"));
  let now = 100000,
    idle = true;
  const wakes = [],
    notices = [],
    workers = [];
  const make = () =>
    new MissionKernel({
      directory,
      cwd: directory,
      sessionId: "fixture",
      now: () => now,
      settings: { progressIntervalMs: 1800000 },
      isLeadIdle: () => idle,
      wake: (w) => {
        wakes.push(w);
        idle = false;
      },
      notify: (n) => notices.push(n),
      workerFactory: async (assignment, signal) => {
        let resolve;
        const result = new Promise((r) => {
          resolve = r;
        });
        const worker = {
          assignment,
          resolve,
          signal,
          stopped: false,
          result,
          deliveries: [],
          async deliver(message) {
            this.deliveries.push(message);
          },
          async stop() {
            this.stopped = true;
            resolve({
              ok: false,
              text: "",
              error: "stopped",
              processState: "stopped",
            });
          },
        };
        signal.addEventListener("abort", () => worker.stop(), { once: true });
        workers.push(worker);
        return worker;
      },
    });
  let kernel = make();
  kernel.start(false);
  const add = (name, allow = []) =>
    kernel.addMember({
      name,
      role: name,
      thinkingLevel: "off",
      workspace: {
        root: directory,
        access: "read-only",
        execution: "files",
        extraReadRoots: [],
      },
      allow,
      temporary: false,
    });
  return {
    directory,
    wakes,
    notices,
    workers,
    add,
    get kernel() {
      return kernel;
    },
    advance(ms) {
      now += ms;
    },
    idle(v = true) {
      idle = v;
    },
    async restart() {
      await kernel.close();
      kernel = make();
      kernel.start(false);
    },
    async close() {
      await kernel.close();
      fs.rmSync(directory, { recursive: true, force: true });
    },
  };
}
async function using(fn) {
  const h = harness();
  try {
    await fn(h);
  } finally {
    await h.close();
  }
}

test("lead process reconciliation is atomic, fenced by epochs and idempotent before an explicit retry", () =>
  using(async (h) => {
    h.idle(false);
    h.add("one");
    h.add("two");
    const one = h.kernel.dispatch("one", "original command"),
      two = h.kernel.dispatch("two", "other command");
    await flush();
    for (const worker of h.workers)
      worker.resolve({
        ok: false,
        text: "",
        error: "termination unconfirmed",
        processState: "unknown",
      });
    await flush();
    const requests = [one, two].map((t) => ({
      taskId: t.id,
      expectedEpoch: h.kernel.store.task(t.id).epoch,
    }));
    assert.throws(
      () =>
        h.kernel.reconcileProcesses(
          [requests[0], { ...requests[1], expectedEpoch: 999 }],
          "Host process inventory confirms old workers are absent",
        ),
      /epoch/,
    );
    assert.equal(h.kernel.store.task(one.id).processState, "unknown");
    assert.equal(h.kernel.store.task(two.id).processState, "unknown");
    const receipt = h.kernel.reconcileProcesses(
      requests,
      "Inspected saved receipts and host process inventory; no old workers remain",
    );
    assert.equal(receipt.reconciled.length, 2);
    assert.ok(
      h.kernel
        .reconcileProcesses(requests, "Repeated verified inspection receipt")
        .reconciled.every((r) => r.alreadyStopped),
    );
    const retry = h.kernel.resumeTask(one.id);
    assert.equal(retry.attemptOf, one.id);
    assert.notEqual(retry.id, one.id);
    assert.equal(h.kernel.store.task(one.id).state, "failed");
  }));

test("lead reconciliation rejects a live execution and cancellation cannot fake a stopped unknown process", () =>
  using(async (h) => {
    h.idle(false);
    h.add("one");
    const task = h.kernel.dispatch("one", "work");
    await flush();
    assert.throws(
      () =>
        h.kernel.reconcileProcesses(
          [
            {
              taskId: task.id,
              expectedEpoch: h.kernel.store.task(task.id).epoch,
            },
          ],
          "Verified process stop evidence",
        ),
      /active/,
    );
    h.workers[0].resolve({ ok: false, text: "", processState: "unknown" });
    await flush();
    const old = h.kernel.store.task(task.id);
    old.state = "cancelled";
    h.kernel.store.putTask(old);
    await h.kernel.cancelTask(old.id);
    assert.equal(h.kernel.store.task(old.id).processState, "unknown");
  }));

test("lead no-progress recovery preserves budgets and cannot override user or decision holds", () =>
  using(async (h) => {
    const m = h.kernel.setGoal("Approved work");
    m.status = "attention";
    m.blocker = { kind: "no_progress", reason: "no progress" };
    m.turns = 22;
    m.outputTokens = 400;
    m.emptyTurns = 3;
    h.kernel.store.set("mission", m);
    assert.throws(
      () => h.kernel.resumeProgress("old", 0, "Saved receipts were inspected"),
      /identity/,
    );
    const restored = h.kernel.resumeProgress(
      m.id,
      0,
      "Reconciled interrupted work; continue the next approved step",
    );
    assert.equal(restored.turns, 22);
    assert.equal(restored.outputTokens, 400);
    assert.equal(restored.budgetStartedAt, m.budgetStartedAt);
    assert.equal(restored.status, "active");
    h.kernel.requireDecision("Which target?");
    assert.throws(
      () => h.kernel.resumeProgress(m.id, 0, "Inspected the saved results"),
      /decision/,
    );
    await h.kernel.userControl("pause");
    assert.throws(
      () => h.kernel.resumeProgress(m.id, 0, "Continue the saved results"),
      /User pause/,
    );
  }));

test("model-requested compaction waits for idle and runs only once without inventing a user pause", () =>
  using(async (h) => {
    let compactions = 0;
    h.kernel.options.compact = () => {
      compactions++;
    };
    h.kernel.setGoal("Approved work");
    h.idle(false);
    h.kernel.leadStarted();
    h.kernel.queueCompaction();
    h.kernel.queueCompaction();
    await h.kernel.tick();
    assert.equal(compactions, 0);
    h.kernel.leadMessage(false);
    h.kernel.leadSettled();
    h.idle();
    await h.kernel.tick();
    await h.kernel.tick();
    assert.equal(compactions, 1);
    assert.equal(h.kernel.snapshot().compactionQueued, false);
    assert.equal(h.kernel.snapshot().held, false);
    await h.kernel.userControl("pause");
    assert.throws(() => h.kernel.queueCompaction(), /hold/);
  }));

test("dispatch alone enrolls the mission and completion wakes without Goal or supervisor setup", () =>
  using(async (h) => {
    h.add("worker");
    h.kernel.onHumanInput("Continue approved development overnight");
    const task = h.kernel.dispatch("worker", "read the fixture");
    await flush();
    assert.equal(h.kernel.store.mission().status, "active");
    assert.equal(h.workers.length, 1);
    assert.equal(h.wakes.length, 0);
    h.workers[0].resolve({
      ok: true,
      text: "verified child result",
      processState: "stopped",
    });
    await flush();
    assert.equal(h.kernel.store.task(task.id).state, "completed");
    assert.equal(h.wakes.length, 1);
    assert.match(h.wakes[0].content, /verified child result/);
    assert.equal(
      h.kernel.store.deliveries("lead")[0].state,
      "leased",
      "submission is not observation",
    );
    h.kernel.leadStarted(h.wakes[0]);
    h.kernel.includeWake(h.wakes[0].batchId);
    h.kernel.leadMessage(false, 3);
    h.kernel.leadSettled();
    assert.equal(h.kernel.store.deliveries("lead")[0].state, "observed");
  }));

test("busy lead leaves results durable and does not build Pi follow-up queues", () =>
  using(async (h) => {
    h.add("worker");
    h.idle(false);
    h.kernel.dispatch("worker", "task");
    await flush();
    h.workers[0].resolve({
      ok: true,
      text: "late result",
      processState: "stopped",
    });
    await flush();
    assert.equal(h.wakes.length, 0);
    assert.equal(h.kernel.store.deliveries("lead")[0].state, "pending");
    await h.kernel.tick();
    assert.equal(h.wakes.length, 0);
    h.idle();
    await h.kernel.tick();
    assert.equal(h.wakes.length, 1);
  }));

test("answering an intermediate question neither stops the mission nor changes the report schedule", () =>
  using(async (h) => {
    h.add("worker");
    h.kernel.dispatch("worker", "long work");
    await flush();
    const initial = h.kernel.snapshot().nextReportAt;
    h.kernel.onHumanInput("What does waiting mean?");
    h.kernel.leadStarted();
    h.kernel.leadMessage(false, 1);
    h.kernel.leadSettled();
    assert.equal(h.kernel.store.mission().status, "active");
    assert.equal(h.kernel.snapshot().nextReportAt, initial);
    h.advance(1000);
    await h.kernel.tick();
    assert.equal(h.wakes.length, 0);
  }));

test("peer dispatch does not bypass the configured thirty-minute progress interval", () =>
  using(async (h) => {
    h.add("supervisor", ["worker"]);
    h.add("worker");
    h.kernel.dispatch("supervisor", "delegate");
    await flush();
    const parent = h.workers[0].assignment;
    h.kernel.memberRequest(parent.token, {
      op: "message",
      id: "assign-1",
      to: "worker",
      message: "child",
    });
    await flush();
    assert.equal(h.workers.length, 2);
    assert.equal(h.wakes.length, 0);
    h.advance(1799000);
    await h.kernel.tick();
    assert.equal(h.wakes.length, 0);
    h.advance(1000);
    await h.kernel.tick();
    assert.equal(h.wakes.length, 1);
    assert.match(h.wakes[0].content, /Scheduled progress/);
  }));

test("routine member progress is coalesced and never wakes the lead by itself", () =>
  using(async (h) => {
    h.add("worker");
    h.kernel.dispatch("worker", "long work");
    await flush();
    const worker = h.workers[0].assignment;
    for (let i = 0; i < 10; i++)
      h.kernel.memberRequest(worker.token, {
        op: "message",
        id: "progress-" + i,
        to: "lead",
        operation: "note",
        kind: "progress",
        message: "update " + i,
      });
    await h.kernel.tick();
    assert.equal(h.wakes.length, 0);
    const progress = h.kernel.store.deliveries("lead");
    assert.equal(progress.length, 1);
    assert.equal(progress[0].summary, "update 9");
    h.advance(1800000);
    await h.kernel.tick();
    assert.equal(h.wakes.length, 1);
    assert.match(h.wakes[0].content, /update 9/);
  }));

test("supervisor waits without a live process and resumes its same task for descendant review", () =>
  using(async (h) => {
    h.add("supervisor", ["worker"]);
    h.add("worker");
    const root = h.kernel.dispatch("supervisor", "review the child");
    await flush();
    const parent = h.workers[0].assignment;
    const child = h.kernel.memberRequest(parent.token, {
      op: "message",
      id: "child-request",
      to: "worker",
      message: "implement",
    });
    const duplicate = h.kernel.memberRequest(parent.token, {
      op: "message",
      id: "child-request",
      to: "worker",
      message: "implement",
    });
    assert.equal(child.id, duplicate.id);
    h.kernel.memberRequest(parent.token, { op: "wait", id: "wait" });
    h.workers[0].resolve({
      ok: true,
      text: "waiting",
      processState: "stopped",
    });
    await flush();
    assert.equal(h.kernel.store.task(root.id).state, "waiting");
    assert.equal(h.wakes.length, 0);
    h.workers[1].resolve({
      ok: true,
      text: "receipt: tests passed",
      processState: "stopped",
    });
    await flush();
    assert.equal(h.workers.length, 3);
    const review = h.workers[2].assignment;
    assert.equal(review.task.id, root.id);
    assert.equal(review.task.phase, "review");
    assert.equal(review.member.sessionId, parent.member.sessionId);
    assert.match(review.prompt, /receipt: tests passed/);
    h.workers[2].resolve({
      ok: true,
      text: "independently reviewed",
      processState: "stopped",
    });
    await flush();
    assert.equal(h.kernel.store.task(root.id).state, "completed");
    assert.equal(h.wakes.length, 1);
  }));

test("directed communication, ancestor-cycle checks and stale execution tokens reject unauthorized work", () =>
  using(async (h) => {
    h.add("reviewer");
    h.add("worker");
    const root = h.kernel.dispatch("reviewer", "review");
    await flush();
    const assignment = h.workers[0].assignment;
    assert.throws(
      () =>
        h.kernel.memberRequest(assignment.token, {
          op: "message",
          id: "bad",
          to: "worker",
          message: "escape",
        }),
      /Communication denied/,
    );
    h.kernel.store.putMember({
      ...h.kernel.store.member("reviewer"),
      allow: ["reviewer"],
    });
    assert.throws(
      () =>
        h.kernel.memberRequest(assignment.token, {
          op: "message",
          id: "cycle",
          to: "reviewer",
          message: "loop",
        }),
      /cycle/,
    );
    await h.kernel.cancelTask(root.id);
    assert.throws(
      () =>
        h.kernel.memberRequest(assignment.token, {
          op: "message",
          id: "late",
          to: "lead",
          message: "old",
        }),
      /Stale/,
    );
  }));

test("user stop fences late results, retains identity and never resumes through a normal question", () =>
  using(async (h) => {
    h.add("worker");
    const t = h.kernel.dispatch("worker", "long task");
    await flush();
    await h.kernel.userControl("stop");
    h.workers[0].resolve({
      ok: true,
      text: "obsolete success",
      processState: "stopped",
    });
    await flush();
    h.kernel.onHumanInput("What happened?");
    h.advance(100000);
    await h.kernel.tick();
    assert.equal(h.kernel.store.task(t.id).state, "cancelled");
    assert.equal(h.kernel.store.mission().status, "stopped");
    assert.equal(h.wakes.length, 0);
    assert.equal(h.kernel.store.members().length, 1);
  }));

test("restart records interrupted work and delivers recovery instead of replaying commands", () =>
  using(async (h) => {
    h.add("worker");
    const t = h.kernel.dispatch("worker", "side effect");
    await flush();
    await h.restart();
    assert.equal(h.kernel.store.task(t.id).state, "interrupted");
    h.advance(1000);
    await h.kernel.tick();
    assert.equal(h.workers.length, 1);
    assert.equal(h.wakes.length, 1);
    assert.match(h.wakes[0].content, /reconcile|Runtime closed/i);
  }));

test("failed wakes cool down and quarantine unread results after bounded recovery without pausing the goal", () =>
  using(async (h) => {
    h.add("worker");
    h.kernel.dispatch("worker", "task");
    await flush();
    h.workers[0].resolve({ ok: true, text: "result", processState: "stopped" });
    await flush();
    for (let i = 0; i < 4; i++) {
      h.kernel.leadStarted(h.wakes.at(-1));
      h.kernel.leadMessage(true);
      h.kernel.leadSettled();
      h.idle();
      h.advance(600000);
      await h.kernel.tick();
    }
    assert.equal(h.wakes.length, 4);
    assert.equal(h.kernel.store.mission().status, "active");
    assert.equal(h.kernel.snapshot().recovery.phase, "exhausted");
    assert.ok(
      h.kernel.store.deliveries("lead").some((d) => d.state === "quarantined"),
    );
    h.advance(20000);
    await h.kernel.tick();
    assert.equal(h.wakes.length, 4);
  }));

test("reminder occurrence and outbox commit together; missed intervals do not accumulate old reminders", () =>
  using(async (h) => {
    h.kernel.addSchedule("progress", "review", 101000, 1000);
    h.advance(9000);
    await h.kernel.tick();
    const reminders = h.kernel.store.deliveries("lead");
    assert.equal(reminders.length, 1);
    assert.equal(h.kernel.store.schedules()[0].nextAt, 110000);
    await h.kernel.tick();
    assert.equal(h.kernel.store.deliveries("lead").length, 1);
  }));

test("complete cannot hide outstanding work; owner lock prevents two runtime controllers", () =>
  using(async (h) => {
    h.add("worker");
    h.kernel.dispatch("worker", "task");
    await flush();
    assert.throws(
      () => h.kernel.complete([{ criterion: 1, evidence: "claimed complete" }]),
      /still/,
    );
    assert.throws(() => new Store(h.directory), /already/);
  }));

test("explicitly collected results are confirmed only after a successful model response", () =>
  using(async (h) => {
    h.add("worker");
    h.idle(false);
    const task = h.kernel.dispatch("worker", "task");
    await flush();
    h.workers[0].resolve({ ok: true, text: "result", processState: "stopped" });
    await flush();
    const delivery = h.kernel.store.deliveries("lead")[0];
    h.kernel.leadStarted();
    h.kernel.includeCollected([delivery.id]);
    assert.equal(h.kernel.store.deliveries("lead")[0].state, "admitted");
    h.kernel.leadMessage(true);
    h.kernel.leadSettled();
    assert.equal(h.kernel.store.deliveries("lead")[0].state, "pending");
    h.kernel.leadStarted();
    h.kernel.includeCollected([delivery.id]);
    h.kernel.leadMessage(false);
    h.kernel.leadSettled();
    assert.equal(h.kernel.store.deliveries("lead")[0].state, "observed");
  }));

test("user report timing persists across restart and an exhausted old mission cannot poison a new objective", () =>
  using(async (h) => {
    h.add("worker");
    h.kernel.setReportInterval(4000000);
    await h.restart();
    assert.equal(h.kernel.settings.progressIntervalMs, 4000000);
    h.kernel.dispatch("worker", "old work");
    await flush();
    await h.kernel.userControl("stop");
    h.kernel.onHumanInput("new objective");
    h.kernel.dispatch("worker", "new work");
    await h.kernel.tick();
    await flush();
    assert.equal(h.kernel.store.mission().status, "active");
    assert.notEqual(
      h.kernel.store.tasks()[0].missionId,
      h.kernel.store.tasks()[1].missionId,
    );
  }));

test("unknown execution cannot be retried until the user reconciles its process state", () =>
  using(async (h) => {
    h.add("worker");
    const task = h.kernel.dispatch("worker", "side effect");
    await flush();
    h.workers[0].resolve({
      ok: false,
      text: "",
      error: "termination unconfirmed",
      processState: "unknown",
    });
    await flush();
    assert.throws(() => h.kernel.resumeTask(task.id), /unknown process state/);
    h.kernel.acknowledgeProcess(task.id);
    const retry = h.kernel.resumeTask(task.id);
    assert.equal(retry.attemptOf, task.id);
  }));

test("notes to a running permitted peer are admitted through steering and confirmed on its successful response", () =>
  using(async (h) => {
    h.add("reviewer", ["worker"]);
    h.add("worker");
    h.kernel.dispatch("reviewer", "review");
    h.kernel.dispatch("worker", "implementation");
    await flush();
    const sender = h.workers.find(
        (w) => w.assignment.member.name === "reviewer",
      ),
      recipient = h.workers.find((w) => w.assignment.member.name === "worker");
    h.kernel.memberRequest(sender.assignment.token, {
      op: "message",
      id: "note-1",
      operation: "note",
      to: "worker",
      kind: "decision",
      message: "Keep the documented signal interface",
    });
    await h.kernel.tick();
    await flush();
    assert.match(recipient.deliveries[0], /documented signal/);
    assert.equal(h.kernel.store.deliveries("worker")[0].state, "leased");
    recipient.resolve({
      ok: true,
      text: "implemented and verified",
      processState: "stopped",
    });
    await flush();
    assert.equal(h.kernel.store.deliveries("worker")[0].state, "observed");
  }));

test("a decision needs an explicit resolution after a fresh human answer and never overrides a user pause", () =>
  using(async (h) => {
    h.kernel.setGoal("authorized work");
    h.kernel.requireDecision("Which approved target should be used?");
    const id = h.kernel.store.mission().decision.id;
    h.kernel.onHumanInput("What is the progress?");
    assert.equal(h.kernel.store.mission().status, "waiting_user");
    h.kernel.onHumanInput("Use target A");
    h.kernel.resolveDecision(id, "Use target A");
    assert.equal(h.kernel.store.mission().status, "active");
    await h.kernel.userControl("pause");
    h.kernel.onHumanInput("Explain the progress");
    assert.equal(h.kernel.store.mission().status, "paused");
  }));

test("goal update and stop have explicit lifecycle records", () =>
  using(async (h) => {
    const goal = h.kernel.setGoal("old objective", ["old criterion"]);
    const updated = h.kernel.updateGoal(
      "new objective",
      ["new criterion"],
      goal.id,
    );
    assert.equal(updated.id, goal.id);
    assert.equal(updated.revision, 1);
    assert.deepEqual(updated.criteria, ["new criterion"]);
    const stopped = await h.kernel.stopGoal(goal.id, "test cleanup");
    assert.equal(stopped.status, "stopped");
    assert.equal(h.kernel.store.mission(), undefined);
    assert.equal(h.kernel.lifecycleHistory().goals[0].archiveReason, "stopped");
  }));

test("completed goals remain inspectable while temporary subagents leave the active roster", () =>
  using(async (h) => {
    const member = h.kernel.addMember({
      name: "temporary-worker",
      role: "temporary",
      thinkingLevel: "off",
      workspace: {
        root: h.directory,
        access: "read-only",
        execution: "files",
        extraReadRoots: [],
      },
      allow: [],
      temporary: true,
    });
    const task = h.kernel.dispatch(member.name, "finish once");
    await flush();
    h.workers[0].resolve({
      ok: true,
      text: "verified",
      processState: "stopped",
    });
    await flush();
    assert.equal(h.kernel.store.member(member.name), undefined);
    const delivery = h.kernel.store.deliveries("lead")[0];
    h.kernel.leadStarted();
    h.kernel.includeCollected([delivery.id]);
    h.kernel.leadMessage(false);
    h.kernel.leadSettled();
    const completed = h.kernel.complete([
      { criterion: 1, evidence: "verified temporary result" },
    ]);
    assert.equal(completed.status, "complete");
    assert.equal(h.kernel.store.mission().status, "complete");
    assert.equal(h.kernel.store.members().length, 0);
    assert.equal(h.kernel.lifecycleHistory().counts.goal, 1);
    assert.equal(h.kernel.lifecycleHistory().counts.member, 1);
    assert.equal(h.kernel.store.task(task.id).state, "completed");
  }));

test("reminders can be revised, paused and deleted without stale deliveries", () =>
  using(async (h) => {
    const schedule = h.kernel.addSchedule("old", "check old", 101000, 1000);
    const updated = h.kernel.updateSchedule(schedule.id, {
      title: "new",
      prompt: "check new",
      state: "paused",
    });
    assert.equal(updated.title, "new");
    assert.equal(updated.state, "paused");
    h.kernel.updateSchedule(schedule.id, { state: "active", nextAt: 101000 });
    h.advance(1000);
    await h.kernel.tick();
    h.kernel.deleteSchedule(schedule.id);
    assert.equal(h.kernel.store.schedules().length, 0);
    assert.equal(
      h.kernel.store.schedule(schedule.id, true).archiveReason,
      "deleted",
    );
    assert.ok(
      h.kernel.store
        .deliveries("lead")
        .filter((delivery) => delivery.scheduleId === schedule.id)
        .every((delivery) => delivery.state === "cancelled"),
    );
  }));
