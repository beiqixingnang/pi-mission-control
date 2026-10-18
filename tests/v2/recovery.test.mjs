import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { MissionKernel } from "../../runtime/kernel.ts";

test("collecting a result without a model response cannot mark it observed", () =>
  using(async (h) => {
    const d = h.delivery("result");
    h.kernel.leadStarted();
    h.kernel.includeCollected([d.id]);
    h.kernel.leadSettled();
    assert.equal(
      h.kernel.store.deliveries("lead").find((x) => x.id === d.id).state,
      "pending",
    );
  }));

test("goal revisions fence old decision answers and external event tokens without removing their holds", () =>
  using(async (h) => {
    h.kernel.requireDecision("Which target?");
    const old = h.kernel.store.mission().decision;
    h.kernel.onHumanInput("Use A");
    h.kernel.updateGoal("Refined target selection");
    const current = h.kernel.store.mission().decision;
    assert.notEqual(current.id, old.id);
    assert.equal(h.kernel.store.mission().status, "waiting_user");
    assert.throws(() => h.kernel.resolveDecision(old.id, "Use A"), /identity/);
    assert.throws(
      () => h.kernel.resolveDecision(current.id, "Use A"),
      /direct human/,
    );
    h.kernel.onHumanInput("Use A for the refined goal");
    h.kernel.resolveDecision(current.id, "Use A for the refined goal");
    const wait = h.kernel.waitExternal("Producer", 160000);
    h.kernel.updateGoal("Refined waiting objective");
    assert.throws(
      () => h.kernel.signalExternal(wait.id, wait.token),
      /identity/,
    );
    assert.equal(h.kernel.store.mission().externalWait.deadline, 160000);
  }));

test("goal edits rebase the fault revision while preserving its request allowance", () =>
  using(async (h) => {
    h.delivery("result");
    await h.kernel.tick();
    h.settle(true, "provider offline");
    const fault = h.kernel.snapshot().recovery;
    h.kernel.updateGoal("A text correction");
    assert.throws(() => h.kernel.requestRecovery(fault.id, 0), /revision/);
    const status = h.kernel.requestRecovery(fault.id, 1);
    assert.equal(status.recovery.requests, fault.requests);
    assert.equal(status.recovery.id, fault.id);
  }));

test("answering a business decision cannot renew a configured output budget", () =>
  using(
    async (h) => {
      h.kernel.requireDecision("Which target?");
      const id = h.kernel.store.mission().decision.id;
      const m = h.kernel.store.mission();
      m.outputTokens = 100;
      h.kernel.store.set("mission", m);
      h.kernel.onHumanInput("Use A");
      assert.throws(() => h.kernel.resolveDecision(id, "Use A"), /hold/);
      assert.equal(h.kernel.store.mission().blocker.kind, "budget");
    },
    { maxOutputTokens: 100 },
  ));

const flush = async () => {
  await new Promise(setImmediate);
  await new Promise(setImmediate);
};
async function using(run, settings = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "mc-recovery-test-"));
  let now = 100000,
    idle = true,
    compactions = 0;
  const wakes = [],
    workers = [];
  const make = () =>
    new MissionKernel({
      directory,
      cwd: directory,
      sessionId: "recovery-test",
      settings: { progressIntervalMs: 1800000, ...settings },
      now: () => now,
      isLeadIdle: () => idle,
      wake: (w) => {
        wakes.push(w);
        idle = false;
      },
      compact: () => {
        compactions++;
      },
      workerFactory: async (assignment) => {
        let resolve;
        const result = new Promise((r) => (resolve = r));
        workers.push({ assignment, resolve });
        return {
          result,
          stop: async () =>
            resolve({ ok: false, text: "", processState: "stopped" }),
        };
      },
    });
  let kernel = make();
  kernel.start(false);
  kernel.setGoal("Continue approved work", ["Verified result"]);
  const h = {
    directory,
    wakes,
    workers,
    get kernel() {
      return kernel;
    },
    get compactions() {
      return compactions;
    },
    advance: (ms) => (now += ms),
    idle: (value = true) => (idle = value),
    add: (name) =>
      kernel.addMember({
        name,
        role: name,
        thinkingLevel: "off",
        temporary: false,
        allow: [],
        workspace: {
          root: directory,
          access: "read-only",
          execution: "files",
          extraReadRoots: [],
        },
      }),
    delivery: (kind, attempts = 0) => {
      const d = kernel.delivery({
        key: crypto.randomUUID(),
        from: kind === "progress" ? "maintenance" : "worker",
        to: "lead",
        kind,
        summary: "Saved notification",
      });
      d.attempts = attempts;
      kernel.store.putDelivery(d);
      return d;
    },
    restart: async () => {
      await kernel.close();
      kernel = make();
      kernel.start(false);
    },
    settle: (error = false, text) => {
      const w = wakes.at(-1);
      kernel.leadStarted(w);
      kernel.includeWake(w.batchId);
      kernel.leadMessage(error, 2, text);
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

test("legacy failed progress is superseded and one recovery wake preserves budgets and unread results", () =>
  using(async (h) => {
    const before = h.kernel.store.mission();
    before.status = "attention";
    before.reason =
      "Automatic wake attempts failed. Results remain on disk; review /mission status and resume explicitly.";
    before.turns = 8;
    before.outputTokens = 700;
    h.kernel.store.set("mission", before);
    const progress = h.delivery("progress", 3),
      result = h.delivery("result", 3);
    await h.restart();
    const after = h.kernel.store.mission();
    assert.equal(after.status, "active");
    assert.equal(after.budgetStartedAt, before.budgetStartedAt);
    assert.equal(after.turns, 8);
    assert.equal(after.outputTokens, 700);
    assert.equal(
      h.kernel.store.deliveries().find((d) => d.id === progress.id).state,
      "superseded",
    );
    assert.equal(
      h.kernel.store.deliveries().find((d) => d.id === result.id).state,
      "quarantined",
    );
    await h.kernel.tick();
    await h.kernel.tick();
    assert.equal(h.wakes.length, 1);
    assert.match(h.wakes[0].content, /Delivery recovery/);
    h.settle();
    assert.equal(
      h.kernel.store.deliveries().find((d) => d.id === result.id).state,
      "pending",
      "a healthy connection does not prove that the saved result was consumed",
    );
    await h.kernel.tick();
    assert.equal(h.wakes.length, 2);
    assert.match(h.wakes[1].content, /Saved notification/);
  }));

test("legacy no-progress and unknown holds are retained on reload", () =>
  using(async (h) => {
    for (const [reason, kind] of [
      ["Three autonomous turns made no progress", "no_progress"],
      ["Unclassified historical reason", "unknown"],
    ]) {
      const m = h.kernel.store.mission();
      m.status = "attention";
      m.reason = reason;
      m.blocker = undefined;
      h.kernel.store.set("mission", m);
      await h.restart();
      assert.equal(h.kernel.store.mission().status, "attention");
      assert.equal(h.kernel.store.mission().blocker.kind, kind);
    }
  }));

test("failed requests and three successful reminders never count as no progress", () =>
  using(async (h) => {
    h.kernel.addSchedule("status", "Only check", 100001, 1000);
    h.advance(1);
    for (let i = 0; i < 3; i++) {
      await h.kernel.tick();
      h.settle();
      h.advance(1000);
    }
    assert.equal(h.kernel.store.mission().emptyTurns, 0);
    assert.equal(h.kernel.store.mission().status, "active");
    await h.kernel.tick();
    h.settle(true, "temporary provider disconnect");
    assert.equal(h.kernel.store.mission().emptyTurns, 0);
    assert.equal(h.kernel.snapshot().recovery.phase, "cooldown");
  }));

test("three successful continuation turns with no progress still require review", () =>
  using(async (h) => {
    for (let i = 0; i < 3; i++) {
      h.advance(2000);
      await h.kernel.tick();
      h.settle();
    }
    assert.equal(h.kernel.store.mission().emptyTurns, 3);
    assert.equal(h.kernel.store.mission().blocker.kind, "no_progress");
  }));

test("overflow requests one compaction and resumes once after an idle, successful checkpoint", () =>
  using(async (h) => {
    const before = h.kernel.store.mission();
    before.turns = 7;
    before.outputTokens = 50;
    h.kernel.store.set("mission", before);
    h.delivery("result");
    await h.kernel.tick();
    h.settle(true, "Your input exceeds the context window of this model");
    await h.kernel.tick();
    await h.kernel.tick();
    assert.equal(h.compactions, 1);
    assert.equal(h.wakes.length, 1);
    h.kernel.compactionSettled("checkpoint-1");
    h.kernel.compactionSettled("checkpoint-1");
    h.idle(false);
    await h.kernel.tick();
    assert.equal(h.wakes.length, 1);
    h.idle();
    await h.kernel.tick();
    await h.kernel.tick();
    assert.equal(h.wakes.length, 2);
    h.settle();
    const after = h.kernel.store.mission();
    assert.equal(after.status, "active");
    assert.equal(after.budgetStartedAt, before.budgetStartedAt);
    assert.equal(after.turns, 9);
    assert.equal(after.outputTokens, 54);
    assert.equal(h.kernel.snapshot().recovery, undefined);
  }));

test("failed compaction retains the fault and does not launch an automatic compaction loop", () =>
  using(async (h) => {
    h.delivery("result");
    await h.kernel.tick();
    h.settle(true, "maximum context exceeded");
    await h.kernel.tick();
    h.kernel.compactionSettled(undefined, "Summary provider failed");
    for (let i = 0; i < 4; i++) {
      h.advance(100000);
      await h.kernel.tick();
    }
    assert.equal(h.compactions, 1);
    assert.equal(h.wakes.length, 1);
    assert.equal(h.kernel.snapshot().recovery.phase, "waiting_compaction");
  }));

test("a repeated compaction checkpoint cannot rearm an already failed recovery probe", () =>
  using(async (h) => {
    h.delivery("result");
    await h.kernel.tick();
    h.settle(true, "maximum context exceeded");
    h.kernel.compactionSettled("checkpoint-1");
    h.advance(10000);
    await h.kernel.tick();
    h.settle(true, "maximum context exceeded");
    h.kernel.compactionSettled("checkpoint-1");
    await h.kernel.tick();
    assert.equal(h.wakes.length, 2);
    assert.equal(h.kernel.snapshot().recovery.phase, "waiting_compaction");
  }));

test("native and supplemental request admissions share a durable cap across reload", () =>
  using(
    async (h) => {
      h.delivery("result");
      await h.kernel.tick();
      const w = h.wakes[0];
      h.kernel.leadStarted(w);
      h.kernel.includeWake(w.batchId);
      assert.ok(h.kernel.admitLeadRequest());
      h.kernel.leadMessage(true, 1, "disconnect");
      assert.ok(h.kernel.admitLeadRequest());
      h.kernel.leadMessage(true, 1, "disconnect");
      assert.ok(h.kernel.admitLeadRequest());
      h.kernel.leadMessage(true, 1, "disconnect");
      assert.equal(h.kernel.snapshot().recovery.requests, 3);
      assert.equal(h.kernel.admitLeadRequest(), false);
      h.kernel.leadSettled(true);
      h.idle();
      assert.equal(
        h.kernel.snapshot().held,
        false,
        "a runtime budget abort is not Escape",
      );
      await h.restart();
      h.advance(100000);
      await h.kernel.tick();
      assert.equal(h.wakes.length, 1);
      assert.equal(h.kernel.snapshot().recovery.requests, 3);
      assert.equal(h.kernel.snapshot().recovery.phase, "exhausted");
      h.kernel.onHumanInput("Connection is repaired; inspect progress");
      h.kernel.leadStarted();
      assert.ok(h.kernel.admitLeadRequest());
      h.kernel.leadMessage(false);
      h.kernel.leadSettled();
      assert.equal(h.kernel.snapshot().recovery, undefined);
    },
    { recoveryMaxRequests: 3 },
  ));

test("cooldown survives a runtime restart and a new notification cannot reset it", () =>
  using(async (h) => {
    h.delivery("result");
    await h.kernel.tick();
    h.settle(true, "provider offline");
    const before = h.kernel.snapshot().recovery;
    await h.restart();
    h.delivery("failure");
    await h.kernel.tick();
    assert.equal(h.wakes.length, 1);
    assert.equal(h.kernel.snapshot().recovery.id, before.id);
    assert.equal(h.kernel.snapshot().recovery.requests, before.requests);
    h.advance(60000);
    await h.kernel.tick();
    assert.equal(h.wakes.length, 2);
  }));

test("goal edits and recovery cannot clear user pause, Escape, relocation or budget holds", () =>
  using(
    async (h) => {
      h.delivery("result");
      await h.kernel.tick();
      h.settle(true, "provider offline");
      const fault = h.kernel.snapshot().recovery;
      await h.kernel.userControl("pause");
      const paused = h.kernel.store.mission();
      h.kernel.updateGoal("Adjusted objective");
      assert.equal(h.kernel.store.mission().humanPaused, true);
      assert.equal(
        h.kernel.store.mission().budgetStartedAt,
        paused.budgetStartedAt,
      );
      assert.throws(
        () => h.kernel.requestRecovery(fault.id, 1),
        /revision changed|hold/,
      );
      h.kernel.compactionSettled("checkpoint");
      h.advance(120000);
      await h.kernel.tick();
      assert.equal(h.wakes.length, 1);
      await h.kernel.userControl("resume");
      h.kernel.leadStarted();
      h.kernel.leadSettled(true);
      h.kernel.updateGoal("Second edit");
      assert.equal(h.kernel.snapshot().held, true);
      await h.restart();
      assert.equal(h.kernel.snapshot().held, true);
      h.kernel.onHumanInput("Continue after Escape");
      h.kernel.store.set("relocationHold", true);
      h.kernel.updateGoal("Third edit");
      assert.equal(h.kernel.store.get("relocationHold"), true);
      h.kernel.store.set("relocationHold", false);
      h.kernel.leadStarted();
      h.advance(43_200_000);
      await h.kernel.tick();
      const exhausted = h.kernel.store.mission();
      assert.equal(exhausted.blocker.kind, "budget");
      h.kernel.updateGoal("Fourth edit");
      assert.equal(h.kernel.store.mission().status, "attention");
      assert.equal(h.kernel.store.mission().turns, exhausted.turns);
    },
    { maxMissionMs: 43_200_000 },
  ));

test("independent reminders can be delivered while a goal budget is exhausted", () =>
  using(
    async (h) => {
      h.kernel.leadStarted();
      h.advance(43_200_000);
      await h.kernel.tick();
      h.kernel.addSchedule(
        "independent",
        "A separate notification",
        43_300_001,
      );
      h.advance(1);
      await h.kernel.tick();
      assert.equal(h.wakes.length, 1);
      assert.match(h.wakes[0].content, /A separate notification/);
      assert.equal(h.kernel.store.mission().blocker.kind, "budget");
    },
    { maxMissionMs: 43_200_000 },
  ));

test("a runtime fault cannot be converted into a business decision or reset through the recovery tool", () =>
  using(async (h) => {
    h.delivery("result");
    await h.kernel.tick();
    h.settle(true, "provider offline");
    const fault = h.kernel.snapshot().recovery;
    assert.throws(
      () => h.kernel.requireDecision("Please run /mission resume"),
      /RUNTIME_RECOVERY_REQUIRED/,
    );
    const result = h.kernel.requestRecovery(fault.id, 0);
    assert.equal(result.eligible, false);
    assert.equal(result.recovery.requests, 1);
    assert.throws(() => h.kernel.requestRecovery("stale", 0), /identity/);
  }));

test("business decisions require exact identity and a new quoted human answer", () =>
  using(async (h) => {
    h.kernel.requireDecision("Which target?");
    const id = h.kernel.store.mission().decision.id;
    assert.throws(() => h.kernel.resolveDecision(id, "A"), /direct human/);
    h.kernel.onHumanInput("What is the progress?");
    assert.equal(h.kernel.store.mission().status, "waiting_user");
    assert.throws(() => h.kernel.resolveDecision(id, "A"), /direct human/);
    h.kernel.onHumanInput("Use target A");
    assert.throws(
      () => h.kernel.resolveDecision("old", "Use target A"),
      /identity/,
    );
    h.kernel.resolveDecision(id, "Use target A");
    assert.equal(h.kernel.store.mission().status, "active");
    assert.equal(h.kernel.store.mission().decision, undefined);
  }));

test("a task-scoped decision leaves unrelated queued work eligible", () =>
  using(
    async (h) => {
      h.idle(false);
      h.add("one");
      h.add("two");
      h.add("three");
      h.kernel.dispatch("one", "running");
      await flush();
      const blocked = h.kernel.dispatch("two", "needs selection");
      h.kernel.requireDecision("Which input for task two?", [blocked.id]);
      const other = h.kernel.dispatch("three", "independent");
      h.workers[0].resolve({ ok: true, text: "done", processState: "stopped" });
      await flush();
      await h.kernel.tick();
      await flush();
      assert.equal(h.kernel.store.task(blocked.id).state, "queued");
      assert.equal(h.kernel.store.task(other.id).state, "running");
      assert.equal(h.kernel.store.mission().status, "active");
    },
    { maxParallel: 1 },
  ));

test("external waits suppress no-op continuation and reports, then signal once", () =>
  using(async (h) => {
    const wait = h.kernel.waitExternal("Producer is computing", 160000);
    h.advance(50000);
    await h.kernel.tick();
    assert.equal(h.wakes.length, 0);
    assert.throws(() => h.kernel.signalExternal(wait.id, "wrong"), /token/);
    h.kernel.signalExternal(wait.id, wait.token);
    await h.kernel.tick();
    assert.equal(h.wakes.length, 1);
    assert.throws(
      () => h.kernel.signalExternal(wait.id, wait.token),
      /identity/,
    );
    h.settle();
    assert.equal(h.kernel.store.mission().emptyTurns, 0);
  }));

test("external wait expiry creates a single durable notification even during a user pause", () =>
  using(async (h) => {
    h.kernel.waitExternal("Producer", 101000);
    await h.kernel.userControl("pause");
    h.advance(2000);
    await h.kernel.tick();
    await h.kernel.tick();
    assert.equal(h.wakes.length, 0);
    assert.equal(
      h.kernel.store
        .deliveries("lead")
        .filter((d) => d.from === "external-wait").length,
      1,
    );
    await h.kernel.userControl("resume");
    assert.equal(h.wakes.length, 1);
  }));

test("old progress is superseded without observing it and newer occurrences coalesce", () =>
  using(async (h) => {
    h.idle(false);
    const old = h.delivery("progress", 3);
    await h.kernel.tick();
    assert.equal(h.kernel.store.mission().status, "active");
    assert.equal(
      h.kernel.store.deliveries().find((d) => d.id === old.id).state,
      "superseded",
    );
    h.kernel.addSchedule("recurring", "status", 100001, 1000);
    h.advance(1);
    await h.kernel.tick();
    h.advance(1000);
    await h.kernel.tick();
    assert.equal(
      h.kernel.store
        .deliveries()
        .filter((d) => d.kind === "reminder" && d.state === "pending").length,
      1,
    );
    assert.ok(
      h.kernel.store
        .deliveries()
        .some((d) => d.kind === "reminder" && d.state === "superseded"),
    );
  }));
