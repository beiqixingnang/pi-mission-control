import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { MissionKernel } from "../../runtime/kernel.ts";
import { resolveSettings } from "../../runtime/types.ts";

test("stopping a root settles its running tail and retains an ended clock through reload and a new goal", () =>
  using(async (h) => {
    const root = h.kernel.store.mission().id;
    h.kernel.leadStarted();
    h.advance(4000);
    const stopped = await h.kernel.stopGoal(
      root,
      "Explicit test stop with no children",
    );
    const ended = h.kernel.store.get("goalActivityClock:" + root);
    assert.equal(ended.activeMs, 4000);
    assert.equal(ended.state, "ended");
    assert.equal(ended.updatedAt, 104000);
    assert.equal(h.kernel.goals.node(root).updatedAt, 104000);
    assert.equal(stopped.status, "stopped");
    assert.equal(h.kernel.store.mission(), undefined);
    await h.restart(3600000);
    h.kernel.setGoal("Another independent objective");
    assert.deepEqual(h.kernel.store.get("goalActivityClock:" + root), ended);
    h.advance(5000);
    await h.kernel.tick();
    assert.deepEqual(h.kernel.store.get("goalActivityClock:" + root), ended);
  }));

test("accepted root clocks retain their exact end time across repeated ticks, close, reload and a new root", () =>
  using(async (h) => {
    const root = h.kernel.store.mission().id;
    h.kernel.leadStarted();
    h.advance(4000);
    h.kernel.acceptGoal(
      root,
      h.kernel.store
        .mission()
        .criteria.map((_, i) => ({
          criterion: i + 1,
          source: "statement",
          summary: "Verified isolated clock fixture result",
        })),
      0,
    );
    const ended = h.kernel.store.get("goalActivityClock:" + root);
    assert.equal(ended.activeMs, 4000);
    assert.equal(ended.state, "ended");
    h.advance(5000);
    await h.kernel.tick();
    assert.deepEqual(h.kernel.store.get("goalActivityClock:" + root), ended);
    await h.restart(3600000);
    assert.deepEqual(h.kernel.store.get("goalActivityClock:" + root), ended);
    h.kernel.setGoal("Next independent root");
    assert.deepEqual(h.kernel.store.get("goalActivityClock:" + root), ended);
  }));

test("stopped clocks exclude paused, dependency-wait, cooldown and offline tails", async () => {
  for (const state of ["paused", "waiting", "cooldown", "offline"]) {
    await using(async (h) => {
      const root = h.kernel.store.mission().id;
      h.kernel.leadStarted();
      h.advance(1000);
      h.kernel.leadSettled();
      if (state === "paused") await h.kernel.userControl("pause");
      if (state === "waiting")
        h.kernel.waitExternal("Waiting for external producer", 10000000);
      if (state === "cooldown") {
        h.kernel.leadStarted();
        h.kernel.leadMessage(true, 0, "temporary network failure");
        h.kernel.leadSettled();
      }
      if (state === "offline") await h.restart(20000);
      h.advance(10000);
      await h.kernel.stopGoal(root, "Stop inactive interval");
      const clock = h.kernel.store.get("goalActivityClock:" + root);
      assert.equal(clock.activeMs, 1000, state);
      assert.equal(clock.state, "ended", state);
    });
  }
});

test("teammate execution keeps the activity clock running while the lead is recovering", () =>
  using(async (h) => {
    const member = h.kernel.addMember({
      name: "worker",
      role: "worker",
      thinkingLevel: "off",
      temporary: false,
      allow: [],
      workspace: {
        root: h.kernel.options.cwd,
        access: "read-only",
        execution: "files",
        extraReadRoots: [],
      },
    });
    h.kernel.store.putTask({
      id: "working",
      missionId: h.kernel.store.mission().id,
      memberId: member.id,
      member: member.name,
      rootId: "working",
      state: "running",
      epoch: 1,
      phase: "work",
      inputPath: "unused",
      createdAt: 100000,
      updatedAt: 100000,
      timeoutMs: 600000,
      processState: "running",
      reviewDeliveryIds: [],
    });
    await h.kernel.tick();
    h.kernel.leadMessage(true, 0, "lead connection unavailable");
    h.advance(5000);
    await h.kernel.tick();
    assert.equal(h.kernel.snapshot().activity.activeMs, 5000);
    assert.equal(h.kernel.snapshot().activity.state, "running");
    const task = h.kernel.store.task("working");
    task.state = "waiting";
    task.blockedReason = "Waiting for producer";
    h.kernel.store.putTask(task);
    await h.kernel.tick();
    h.advance(60000);
    await h.kernel.tick();
    assert.equal(h.kernel.snapshot().activity.activeMs, 5000);
    assert.equal(h.kernel.snapshot().activity.state, "stalled");
  }));

async function using(run, settings = {}) {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "mc-activity-clock-"),
  );
  let now = 100000;
  const make = () =>
    new MissionKernel({
      directory,
      cwd: directory,
      sessionId: "clock",
      now: () => now,
      settings,
      isLeadIdle: () => false,
      wake: () => {},
      workerFactory: async () => {
        let finish;
        const result = new Promise((r) => (finish = r));
        return {
          result,
          stop: async () =>
            finish({ ok: false, text: "", processState: "stopped" }),
        };
      },
    });
  let kernel = make();
  kernel.start(false);
  kernel.setGoal("Continue approved work");
  const h = {
    get kernel() {
      return kernel;
    },
    advance: (ms) => (now += ms),
    restart: async (gap = 0) => {
      await kernel.close();
      now += gap;
      kernel = make();
      kernel.start(false);
    },
  };
  try {
    await run(h);
  } finally {
    await kernel.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
}
test("default goals have no hidden time, turn or output deadline", () =>
  using(async (h) => {
    assert.equal(resolveSettings().maxMissionMs, 0);
    assert.equal(resolveSettings().maxAutonomousTurns, 0);
    assert.equal(resolveSettings().maxOutputTokens, 0);
    const m = h.kernel.store.mission();
    m.turns = 9999;
    m.outputTokens = 9000000;
    h.kernel.store.set("mission", m);
    h.kernel.leadStarted();
    h.advance(30 * 86400000);
    await h.kernel.tick();
    assert.equal(h.kernel.store.mission().status, "active");
    assert.deepEqual(h.kernel.snapshot().budgets, {
      timeMs: null,
      turns: null,
      outputTokens: null,
    });
  }));
test("cooldown, external waits and idle intervals do not consume active time", () =>
  using(async (h) => {
    h.kernel.leadStarted();
    h.advance(2000);
    h.kernel.leadMessage(true, 1, "Disconnected");
    h.kernel.leadSettled();
    assert.equal(h.kernel.snapshot().activity.activeMs, 2000);
    h.advance(3600000);
    await h.kernel.tick();
    assert.equal(h.kernel.snapshot().activity.activeMs, 2000);
    assert.equal(h.kernel.snapshot().activity.state, "stalled");
    h.kernel.leadStarted();
    h.advance(3000);
    h.kernel.leadMessage(false);
    h.kernel.leadSettled();
    assert.equal(h.kernel.snapshot().activity.activeMs, 5000);
    const wait = h.kernel.waitExternal("Waiting for producer", 7305000);
    h.advance(60000);
    await h.kernel.tick();
    assert.equal(h.kernel.snapshot().activity.activeMs, 5000);
    assert.equal(h.kernel.snapshot().activity.state, "waiting");
    h.kernel.signalExternal(wait.id, wait.token);
    h.advance(60000);
    await h.kernel.tick();
    assert.equal(h.kernel.snapshot().activity.activeMs, 5000);
  }));
test("an explicitly configured time cap charges actual activity and survives offline restore", () =>
  using(
    async (h) => {
      h.kernel.leadStarted();
      h.advance(30000);
      h.kernel.leadMessage(true, 1, "offline");
      h.kernel.leadSettled();
      await h.restart(12 * 3600000);
      assert.equal(h.kernel.snapshot().activity.cycleActiveMs, 30000);
      assert.equal(h.kernel.store.mission().status, "active");
      h.kernel.leadStarted();
      h.advance(30001);
      await h.kernel.tick();
      assert.equal(h.kernel.store.mission().blocker.kind, "budget");
      assert.match(h.kernel.store.mission().reason, /time/);
    },
    { maxMissionMs: 60000 },
  ));
test("a closed process interval never becomes active usage after a clean restart", () =>
  using(async (h) => {
    h.kernel.leadStarted();
    h.advance(2500);
    await h.restart(18 * 3600000);
    assert.equal(h.kernel.snapshot().activity.activeMs, 2500);
    h.advance(1000);
    await h.kernel.tick();
    assert.equal(h.kernel.snapshot().activity.activeMs, 2500);
  }));
test("a user pause stops the clock and renewal preserves lifetime activity", () =>
  using(async (h) => {
    h.kernel.leadStarted();
    h.advance(4000);
    await h.kernel.userControl("pause");
    h.kernel.leadSettled(true);
    h.advance(3600000);
    await h.kernel.tick();
    assert.equal(h.kernel.snapshot().activity.activeMs, 4000);
    await h.kernel.userControl("resume");
    assert.equal(h.kernel.snapshot().activity.activeMs, 4000);
    assert.equal(h.kernel.snapshot().activity.cycleActiveMs, 0);
  }));
test("the old default budget hold clears on reload without resetting recorded turn or token usage", () =>
  using(async (h) => {
    const m = h.kernel.store.mission();
    m.status = "attention";
    m.blocker = {
      kind: "budget",
      reason: "Mission continuation budget reached",
    };
    m.reason = m.blocker.reason;
    m.turns = 22;
    m.outputTokens = 36416;
    m.budgetStartedAt -= 13 * 3600000;
    h.kernel.store.set("mission", m);
    await h.restart();
    assert.equal(h.kernel.store.mission().status, "active");
    assert.equal(h.kernel.store.mission().turns, 22);
    assert.equal(h.kernel.store.mission().outputTokens, 36416);
    assert.equal(h.kernel.store.mission().budgetStartedAt, m.budgetStartedAt);
  }));
test("an explicit exhausted output cap and a user pause remain authoritative after reload", () =>
  using(
    async (h) => {
      const m = h.kernel.store.mission();
      m.status = "attention";
      m.blocker = { kind: "budget", reason: "limit" };
      m.outputTokens = 100;
      h.kernel.store.set("mission", m);
      await h.restart();
      assert.equal(h.kernel.store.mission().status, "attention");
      await h.kernel.userControl("pause");
      await h.restart();
      assert.equal(h.kernel.store.mission().status, "paused");
      assert.equal(h.kernel.store.mission().humanPaused, true);
    },
    { maxOutputTokens: 100 },
  ));
test("waiting for a business decision excludes elapsed time instead of exhausting an active-time cap", () =>
  using(
    async (h) => {
      h.kernel.leadStarted();
      h.advance(5000);
      h.kernel.requireDecision("Which target?");
      h.kernel.leadMessage(false);
      h.kernel.leadSettled();
      h.advance(24 * 3600000);
      await h.kernel.tick();
      h.kernel.onHumanInput("Use A");
      h.kernel.resolveDecision(h.kernel.store.mission().decision.id, "Use A");
      assert.equal(h.kernel.store.mission().status, "active");
      assert.equal(h.kernel.snapshot().activity.activeMs, 5000);
    },
    { maxMissionMs: 60000 },
  ));
