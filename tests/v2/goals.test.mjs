import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { MissionKernel } from "../../runtime/kernel.ts";

async function using(run) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "mc-goal-tree-"));
  let now = 100000,
    kernel;
  const make = () =>
    new MissionKernel({
      directory,
      cwd: directory,
      sessionId: "goals",
      now: () => now,
      isLeadIdle: () => false,
      wake: () => {},
      workerFactory: async () => {
        throw new Error("Unexpected worker");
      },
    });
  kernel = make();
  kernel.start(false);
  try {
    await run({
      directory,
      get kernel() {
        return kernel;
      },
      advance(ms) {
        now += ms;
      },
      async reload() {
        await kernel.close();
        kernel = make();
        kernel.start(false);
      },
    });
  } finally {
    await kernel.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
}
const claim = (criterion = 1) => ({
  criterion,
  source: "statement",
  summary: "Concrete fixture result recorded for this criterion",
});
function plan(h) {
  const nodes = h.kernel.planGoals([
    {
      key: "main",
      objective: "Processor project",
      criteria: ["All planned stages accepted"],
    },
    {
      key: "spec",
      parentId: "main",
      objective: "Module inventory",
      criteria: ["Module responsibilities and verification batches recorded"],
    },
    {
      key: "write",
      parentId: "main",
      objective: "Implement modules",
      criteria: ["Every module implementation accepted"],
      dependsOn: ["spec"],
    },
    {
      key: "module-a",
      parentId: "write",
      objective: "Implement module A",
      criteria: ["Implementation artifact exists"],
      module: "A",
      estimateMs: [60000, 120000],
    },
    {
      key: "module-b",
      parentId: "write",
      objective: "Implement module B",
      criteria: ["Implementation artifact exists"],
      module: "B",
    },
    {
      key: "export",
      parentId: "main",
      objective: "Export Verilog",
      criteria: ["Exports saved"],
      dependsOn: ["write"],
    },
  ]);
  return Object.fromEntries(nodes.map((n) => [n.key, n]));
}
test("three-level plans register atomically, survive reload and gate phases through ancestors", () =>
  using(async (h) => {
    const p = plan(h);
    assert.equal(h.kernel.store.mission().id, p.main.id);
    assert.equal(h.kernel.goals.maxDepth(), 3);
    assert.deepEqual(h.kernel.goals.summary().level2, {
      total: 3,
      completed: 0,
      excluded: 0,
    });
    assert.deepEqual(h.kernel.goals.summary().level3, {
      total: 2,
      completed: 0,
      excluded: 0,
    });
    assert.throws(
      () => h.kernel.focusGoal(p["module-a"].id, 0),
      /Await acceptance/,
    );
    h.kernel.focusGoal(p.spec.id, 0);
    h.kernel.acceptGoal(p.spec.id, [claim()], 0);
    h.kernel.focusGoal(p["module-a"].id, 0);
    await h.reload();
    assert.equal(h.kernel.goals.summary().focus.id, p["module-a"].id);
    assert.equal(h.kernel.goals.summary().level2.completed, 1);
    assert.equal(h.kernel.goals.summary().unestimated, 2);
    assert.throws(
      () => h.kernel.acceptGoal(p.main.id, [claim()], 0),
      /required child/,
    );
    assert.throws(
      () =>
        h.kernel.complete([
          {
            criterion: 1,
            evidence: "Old compatibility call cannot bypass planned acceptance",
          },
        ]),
      /exact main-goal revision/,
    );
    assert.throws(() => h.kernel.focusGoal(p.export.id, 0), /Await acceptance/);
  }));
test("missing parents, cycles, cross-main dependencies and default fourth levels leave no partial plan", () =>
  using((h) => {
    const p = plan(h),
      before = h.kernel.store.goals();
    for (const goals of [
      [
        {
          parentId: "missing",
          objective: "Bad parent",
          criteria: ["No partial state"],
        },
      ],
      [
        {
          parentId: p["module-a"].id,
          objective: "Too deep",
          criteria: ["Not created"],
        },
      ],
      [
        {
          key: "x",
          parentId: p.main.id,
          objective: "X",
          criteria: ["X"],
          dependsOn: ["y"],
        },
        {
          key: "y",
          parentId: p.main.id,
          objective: "Y",
          criteria: ["Y"],
          dependsOn: ["x"],
        },
      ],
      [
        {
          key: "other",
          objective: "Other root",
          criteria: ["Other"],
          dependsOn: [p.spec.id],
        },
      ],
      [
        { key: "x", parentId: p.main.id, objective: "X", criteria: ["X"] },
        {
          key: "y",
          parentId: "x",
          objective: "Y",
          criteria: ["Y"],
          dependsOn: ["x"],
        },
      ],
    ]) {
      assert.throws(() => h.kernel.planGoals(goals));
      assert.deepEqual(h.kernel.store.goals(), before);
    }
    h.kernel.goals.setMaxDepth(4);
    const [deep] = h.kernel.planGoals([
      {
        parentId: p["module-a"].id,
        objective: "Authorized fourth level",
        criteria: ["A deliberately smaller deliverable"],
      },
    ]);
    assert.equal(deep.depth, 4);
    assert.throws(() => h.kernel.goals.setMaxDepth(2));
  }));
test("acceptance checks criterion coverage, real artifacts and exact revisions without repeated reviews", () =>
  using(async (h) => {
    const p = plan(h);
    h.kernel.acceptGoal(p.spec.id, [claim()], 0);
    const goal = p["module-a"],
      file = path.join(h.directory, "module-a.v");
    assert.throws(() => h.kernel.acceptGoal(goal.id, [], 0), /evidence/i);
    assert.throws(
      () => h.kernel.acceptGoal(goal.id, [claim(2)], 0),
      /criterion/,
    );
    assert.throws(
      () =>
        h.kernel.acceptGoal(
          goal.id,
          [{ ...claim(), source: "artifact", path: file }],
          0,
        ),
      /ENOENT/,
    );
    assert.equal(h.kernel.goals.node(goal.id).state, "planned");
    fs.writeFileSync(file, "module a; endmodule");
    const record = h.kernel.acceptGoal(
      goal.id,
      [{ ...claim(), source: "artifact", path: file }],
      0,
    );
    assert.match(record.evidence[0].fingerprint.sha256, /^[a-f0-9]{64}$/);
    assert.deepEqual(h.kernel.acceptGoal(goal.id, [claim()], 0), record);
    assert.equal(h.kernel.store.acceptances(goal.id).length, 1);
    await h.reload();
    assert.equal(h.kernel.goals.detail(goal.id).acceptance.id, record.id);
    assert.throws(() => h.kernel.acceptGoal(goal.id, [claim()], 1), /revision/);
    h.kernel.acceptGoal(p["module-b"].id, [claim()], 0);
    fs.writeFileSync(file, "module a; wire changed; endmodule");
    assert.throws(
      () => h.kernel.acceptGoal(p.write.id, [claim()], 0),
      /file changed/,
    );
    assert.equal(h.kernel.goals.node(p.write.id).state, "planned");
  }));
test("parent acceptance references children and reopening invalidates only affected acceptances, retaining history", () =>
  using((h) => {
    const p = plan(h);
    h.kernel.acceptGoal(p.spec.id, [claim()], 0);
    const a = h.kernel.acceptGoal(p["module-a"].id, [claim()], 0);
    const b = h.kernel.acceptGoal(p["module-b"].id, [claim()], 0);
    const parent = h.kernel.acceptGoal(
      p.write.id,
      [{ ...claim(), source: "acceptance", acceptanceId: a.id }],
      0,
    );
    assert.equal(parent.children.length, 2);
    h.kernel.acceptGoal(p.export.id, [claim()], 0);
    h.kernel.acceptGoal(
      p.main.id,
      [{ ...claim(), source: "acceptance", acceptanceId: parent.id }],
      0,
    );
    assert.equal(h.kernel.store.mission().status, "complete");
    const oldUsage = h.kernel.store.mission();
    const acceptedTree = h.kernel.store.goals();
    assert.throws(
      () => h.kernel.editGoal(p["module-a"].id, { criteria: [] }, 0),
      /acceptance criteria/,
    );
    assert.deepEqual(h.kernel.store.goals(), acceptedTree);
    assert.deepEqual(h.kernel.store.mission(), oldUsage);
    h.kernel.editGoal(
      p["module-a"].id,
      { state: "planned", reason: "Relevant implementation changed" },
      0,
    );
    assert.equal(h.kernel.goals.node(p["module-a"].id).revision, 1);
    assert.equal(h.kernel.goals.node(p.write.id).state, "planned");
    assert.equal(h.kernel.goals.node(p.export.id).state, "planned");
    assert.equal(h.kernel.goals.node(p.main.id).state, "planned");
    assert.equal(h.kernel.goals.node(p["module-b"].id).acceptanceId, b.id);
    assert.equal(h.kernel.goals.node(p.spec.id).state, "accepted");
    assert.equal(h.kernel.store.acceptances(p["module-a"].id)[0].id, a.id);
    assert.equal(h.kernel.store.mission().status, "active");
    assert.equal(
      h.kernel.store.mission().budgetStartedAt,
      oldUsage.budgetStartedAt,
    );
    assert.equal(h.kernel.store.mission().turns, oldUsage.turns);
    assert.throws(
      () => h.kernel.acceptGoal(p["module-a"].id, [claim()], 0),
      /revision/,
    );
    assert.throws(
      () =>
        h.kernel.acceptGoal(
          p.write.id,
          [{ ...claim(), source: "acceptance", acceptanceId: a.id }],
          1,
        ),
      /required child/,
    );
  }));
test("main-goal switching preserves independent usage and measured activity through reload", () =>
  using(async (h) => {
    const p = plan(h),
      [other] = h.kernel.planGoals([
        { objective: "Second main goal", criteria: ["Its own evidence"] },
      ]);
    const m = h.kernel.store.mission();
    m.turns = 19;
    m.outputTokens = 1234;
    h.kernel.store.set("mission", m);
    h.kernel.leadStarted();
    h.advance(4000);
    h.kernel.leadSettled(false);
    const first = h.kernel.snapshot().activity.activeMs;
    assert.equal(first, 4000);
    h.kernel.activateGoal(other.id);
    h.kernel.leadStarted();
    h.advance(3000);
    h.kernel.leadSettled(false);
    assert.equal(h.kernel.snapshot().activity.activeMs, 3000);
    h.kernel.activateGoal(p.main.id);
    assert.equal(h.kernel.snapshot().activity.activeMs, 4000);
    assert.equal(h.kernel.store.mission().turns, 19);
    assert.equal(h.kernel.store.mission().outputTokens, 1234);
    assert.equal(h.kernel.store.mission().budgetStartedAt, m.budgetStartedAt);
    await h.reload();
    h.advance(900000);
    h.kernel.activateGoal(other.id);
    assert.equal(h.kernel.snapshot().activity.activeMs, 3000);
    h.kernel.activateGoal(p.main.id);
    assert.equal(h.kernel.snapshot().activity.activeMs, 4000);
    assert.equal(
      h.kernel.goals.snapshot().roots.filter((n) => n.selected).length,
      1,
    );
  }));
test("planning, selection and editing cannot bypass user, decision, workspace or budget holds", () =>
  using(async (h) => {
    const p = plan(h),
      [other] = h.kernel.planGoals([
        { objective: "Other main", criteria: ["Keep existing holds"] },
      ]);
    await h.kernel.userControl("pause");
    assert.throws(() => h.kernel.activateGoal(other.id), /holds/);
    assert.throws(() => h.kernel.focusGoal(p.spec.id, 0), /holds/);
    assert.throws(() => h.kernel.acceptGoal(p.spec.id, [claim()], 0), /holds/);
    h.kernel.editGoal(p.spec.id, { nextStep: "Record interfaces next" }, 0);
    assert.equal(h.kernel.store.mission().humanPaused, true);
    await h.kernel.userControl("resume");
    h.kernel.requireDecision("Which acceptance scope is approved?");
    assert.throws(() => h.kernel.activateGoal(other.id), /holds/);
    const decision = h.kernel.store.mission().decision.id;
    h.kernel.updateGoal("Refined project", ["Keep pending decision"]);
    assert.equal(h.kernel.store.mission().status, "waiting_user");
    assert.notEqual(h.kernel.store.mission().decision.id, decision);
    await h.kernel.userControl("resume");
    h.kernel.store.set("relocationHold", true);
    assert.throws(() => h.kernel.activateGoal(other.id), /holds/);
    h.kernel.store.set("relocationHold", false);
    const m = h.kernel.store.mission();
    m.status = "attention";
    m.blocker = { kind: "budget", reason: "Explicit budget exhausted" };
    h.kernel.store.set("mission", m);
    assert.throws(() => h.kernel.activateGoal(other.id), /holds/);
  }));
test("exclusions require a direct user action and remain visible without counting as acceptance", () =>
  using((h) => {
    const p = plan(h);
    assert.throws(
      () =>
        h.kernel.editGoal(
          p.write.id,
          { state: "skipped", reason: "Drop this stage" },
          0,
        ),
      /user command/,
    );
    h.kernel.editGoal(
      p.write.id,
      {
        state: "skipped",
        reason: "User removed implementation stage from scope",
      },
      0,
      true,
    );
    const progress = h.kernel.goals.summary();
    assert.deepEqual(progress.level2, { total: 2, completed: 0, excluded: 1 });
    assert.deepEqual(progress.level3, { total: 0, completed: 0, excluded: 2 });
    assert.equal(h.kernel.goals.node(p["module-a"].id).state, "skipped");
    assert.match(h.kernel.goals.node(p["module-a"].id).reason, /User removed/);
  }));
test("tool and task evidence uses runtime receipts and cannot borrow another goal's success", () =>
  using((h) => {
    const p = plan(h);
    h.kernel.acceptGoal(p.spec.id, [claim()], 0);
    h.kernel.focusGoal(p["module-a"].id, 0);
    h.kernel.goals.captureStart("tool-a", "bash", {
      command: "run module-a check",
    });
    h.advance(100);
    h.kernel.goals.captureEnd("tool-a", "Module A check passed", false);
    h.kernel.goals.captureStart("tool-failed", "bash", {
      command: "bad check",
    });
    h.kernel.goals.captureEnd("tool-failed", "Failure", true);
    assert.throws(
      () =>
        h.kernel.acceptGoal(
          p["module-b"].id,
          [{ ...claim(), source: "tool", receiptId: "tool-a" }],
          0,
        ),
      /exact goal/,
    );
    assert.throws(
      () =>
        h.kernel.acceptGoal(
          p["module-a"].id,
          [{ ...claim(), source: "tool", receiptId: "tool-failed" }],
          0,
        ),
      /successful/,
    );
    const result = h.kernel.store.artifact(
      "finished-a",
      "result",
      "Actual saved module A task result",
    );
    h.kernel.store.putTask({
      id: "finished-a",
      missionId: p.main.id,
      goalId: p["module-a"].id,
      memberId: "fixture",
      member: "fixture",
      rootId: "finished-a",
      state: "completed",
      epoch: 1,
      phase: "work",
      inputPath: "unused",
      resultPath: result,
      createdAt: 1,
      updatedAt: 1,
      timeoutMs: 1000,
      processState: "stopped",
      reviewDeliveryIds: [],
    });
    assert.throws(
      () =>
        h.kernel.acceptGoal(
          p["module-b"].id,
          [{ ...claim(), source: "task", taskId: "finished-a" }],
          0,
        ),
      /belonging/,
    );
    const record = h.kernel.acceptGoal(
      p["module-a"].id,
      [
        { ...claim(), source: "tool", receiptId: "tool-a" },
        { ...claim(), source: "task", taskId: "finished-a" },
      ],
      0,
    );
    assert.equal(record.evidence.length, 2);
    assert.equal(record.evidence[1].path, result);
    h.kernel.editGoal(
      p["module-a"].id,
      { state: "planned", reason: "Revised module acceptance" },
      0,
    );
    assert.throws(
      () =>
        h.kernel.acceptGoal(
          p["module-a"].id,
          [{ ...claim(), source: "task", taskId: "finished-a" }],
          1,
        ),
      /older goal revision/,
    );
  }));
test("assigned work must bind a ready leaf and blocks switching or revising its prerequisites", () =>
  using((h) => {
    const p = plan(h);
    h.kernel.addMember({
      name: "worker",
      role: "fixture",
      thinkingLevel: "off",
      workspace: {
        root: h.directory,
        access: "read-only",
        execution: "files",
        extraReadRoots: [],
      },
      allow: [],
      temporary: false,
    });
    assert.throws(
      () => h.kernel.dispatch("worker", "Module A work"),
      /Select a ready leaf/,
    );
    assert.throws(
      () =>
        h.kernel.dispatch("worker", "Module A work", {
          goalId: p["module-a"].id,
        }),
      /Await acceptance/,
    );
    h.kernel.acceptGoal(p.spec.id, [claim()], 0);
    const task = h.kernel.dispatch("worker", "Module A work", {
      goalId: p["module-a"].id,
    });
    assert.equal(task.goalId, p["module-a"].id);
    assert.throws(
      () => h.kernel.editGoal(p.spec.id, { state: "planned" }, 0),
      /affected dependent work/,
    );
    assert.throws(
      () => h.kernel.acceptGoal(p["module-a"].id, [claim()], 0),
      /Work or unknown/,
    );
    const [other] = h.kernel.planGoals([
      { objective: "Other work", criteria: ["Independent"] },
    ]);
    assert.throws(() => h.kernel.activateGoal(other.id), /Settle running/);
  }));
test("on-demand export is consistent, retains acceptance history and never overwrites a file", () =>
  using((h) => {
    const p = plan(h);
    h.kernel.acceptGoal(p.spec.id, [claim()], 0);
    assert.equal(
      fs.readdirSync(h.directory).filter((n) => n.endsWith(".json")).length,
      0,
    );
    const destination = path.join(h.directory, "ledger.json"),
      result = h.kernel.goals.export(destination, p.main.id);
    const exported = JSON.parse(fs.readFileSync(destination, "utf8"));
    assert.equal(result.goals, 6);
    assert.equal(exported.format, "pi-mission-goals");
    assert.equal(exported.activeRootId, p.main.id);
    assert.equal(
      exported.records.find((n) => n.goal.id === p.spec.id).history.length,
      1,
    );
    assert.equal(exported.missions[0].id, p.main.id);
    assert.throws(() => h.kernel.goals.export(destination), /EEXIST/);
  }));
test("legacy v2 SQLite upgrades in place without losing identity, evidence, holds or counters", () =>
  using(async (h) => {
    h.kernel.setGoal("Old flat goal", ["Old acceptance"]);
    const before = h.kernel.store.mission();
    await h.kernel.userControl("pause");
    await h.kernel.close();
    const db = new DatabaseSync(path.join(h.directory, "state.sqlite"));
    for (const name of [
      "goal_nodes",
      "goal_acceptances",
      "goal_receipts",
      "goal_missions",
    ])
      db.exec(`DROP TABLE ${name}`);
    db.close();
    await h.reload();
    assert.equal(h.kernel.store.mission().id, before.id);
    assert.equal(h.kernel.store.mission().humanPaused, true);
    assert.equal(h.kernel.goals.node(before.id).objective, before.objective);
    assert.equal(
      h.kernel.store.mission().budgetStartedAt,
      before.budgetStartedAt,
    );
    assert.deepEqual(h.kernel.goals.summary().level2, {
      total: 0,
      completed: 0,
      excluded: 0,
    });
    await h.kernel.userControl("resume");
    h.kernel.complete([
      {
        criterion: 1,
        evidence: "The original acceptance has retained evidence",
      },
    ]);
    await h.reload();
    assert.equal(h.kernel.goals.node(before.id).state, "accepted");
  }));
