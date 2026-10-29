import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { MissionKernel } from "../../runtime/kernel.ts";

const flush = async () => {
  await new Promise(setImmediate);
  await new Promise(setImmediate);
};
async function using(run) {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "mc-execution-plans-"),
  );
  const workers = [];
  const make = () => {
    const value = new MissionKernel({
      directory,
      cwd: directory,
      sessionId: "execution-plans",
      now: () => 100000,
      isLeadIdle: () => false,
      wake() {
        throw new Error("No unexpected wake");
      },
      workerFactory: async (assignment) => {
        let resolve;
        const result = new Promise((done) => (resolve = done));
        const worker = {
          assignment,
          resolve,
          result,
          async stop() {
            resolve({ ok: false, text: "", processState: "stopped" });
          },
        };
        workers.push(worker);
        return worker;
      },
    });
    value.start(false);
    return value;
  };
  let kernel = make();
  const add = (name = "reader") =>
    kernel.addMember({
      name,
      role: "Execute the approved plan",
      thinkingLevel: "off",
      temporary: false,
      allow: [],
      workspace: {
        root: directory,
        access: "read-only",
        execution: "files",
        extraReadRoots: [],
      },
    });
  try {
    await run({
      get kernel() {
        return kernel;
      },
      workers,
      add,
      async start(goalId, name = "reader") {
        kernel.dispatch(name, "Execute the existing plan", { goalId });
        await flush();
        return workers.at(-1);
      },
      request(worker, args) {
        return kernel.memberRequest(worker.assignment.token, {
          id: crypto.randomUUID(),
          ...args,
        });
      },
      async reload() {
        await kernel.close();
        kernel = make();
      },
    });
  } finally {
    await kernel.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

test("execution plans are optional on roots and children; paused edits preserve acceptance, usage and independent holds", () =>
  using(async (h) => {
    const [root, child, done] = h.kernel.planGoals([
      {
        key: "root",
        objective: "Outcome",
        criteria: ["Existing outcome"],
        plan: "1. Inventory\n2. Verify",
      },
      {
        parentId: "root",
        objective: "Concrete child",
        criteria: ["Deliver"],
        plan: "Use the existing fixture",
      },
      {
        parentId: "root",
        objective: "Already verified",
        criteria: ["Keep evidence"],
      },
    ]);
    assert.equal(h.kernel.goals.node(done.id).plan, undefined);
    const receipt = h.kernel.acceptGoal(
      done.id,
      [{ criterion: 1, source: "statement", summary: "Verified" }],
      0,
    );
    h.kernel.pauseGoal(root.id, "User paused", 0, "user");
    h.kernel.store.set("relocationHold", true);
    const before = h.kernel.store.mission();
    h.kernel.updateGoalPlan(root.id, "Revised approved methods", 0);
    h.kernel.updateGoalPlan(child.id, "1. Reuse data\n2. Verify output", 0);
    assert.deepEqual(h.kernel.store.mission(), before);
    assert.equal(h.kernel.goals.node(child.id).revision, 0);
    assert.deepEqual(h.kernel.store.acceptance(receipt.id), receipt);
    assert.equal(h.kernel.goals.node(done.id).acceptanceId, receipt.id);
    assert.equal(h.kernel.snapshot().workspaceHeld, true);
    await h.reload();
    assert.equal(h.kernel.goalPlans.view(child.id).planRevision, 1);
    assert.equal(
      h.kernel.goalPlans.view(root.id).plan,
      "Revised approved methods",
    );
    assert.equal(h.kernel.store.mission().status, "paused");
  }));

test("an authorized member can add a previously absent plan, then modify it only under a permanent grant", () =>
  using(async (h) => {
    const [root] = h.kernel.planGoals([
      {
        objective: "Goal without an initial plan",
        criteria: ["Keep the plan optional"],
      },
    ]);
    const member = h.add();
    const worker = await h.start(root.id);
    assert.equal(h.kernel.goalPlans.view(root.id).plan, null);
    h.kernel.authorizeGoalPlan(root.id, member.name, "once");
    const added = h.request(worker, {
      op: "goal-plan-update",
      plan: "1. Inspect the approved files.\n2. Verify the saved result.",
      planRevision: 0,
    });
    assert.equal(added.planRevision, 1);
    assert.match(added.plan, /Inspect the approved files/);
    assert.equal(added.editPermission, "none");
    assert.throws(
      () =>
        h.request(worker, {
          op: "goal-plan-update",
          plan: "A second edit without a new grant",
          planRevision: 1,
        }),
      /authorization/,
    );
    h.kernel.authorizeGoalPlan(root.id, member.name, "permanent");
    const changed = h.request(worker, {
      op: "goal-plan-update",
      plan: "Updated methods after the first verification",
      planRevision: 1,
    });
    assert.equal(changed.planRevision, 2);
    assert.equal(changed.editPermission, "permanent");
  }));

test("members receive their plan and ancestor previews and can read the full paginated text", () =>
  using(async (h) => {
    const long = "步骤🙂".repeat(2500);
    const [root, leaf] = h.kernel.planGoals([
      {
        key: "root",
        objective: "Root",
        criteria: ["Outcome"],
        plan: "Root execution roadmap",
      },
      { parentId: "root", objective: "Leaf", criteria: ["Output"], plan: long },
    ]);
    h.add();
    const worker = await h.start(leaf.id);
    assert.match(worker.assignment.prompt, /Root execution roadmap/);
    assert.match(worker.assignment.prompt, /goal_plan_update/);
    const summary = h.request(worker, { op: "goal-context" });
    assert.equal(summary.plan.complete, false);
    assert.equal(summary.plan.editPermission, "none");
    const entries = [];
    let offset = 0;
    do {
      const page = h.request(worker, {
        op: "goal-context",
        section: "plan",
        offset,
        limit: 2,
      });
      entries.push(...page.entries.map((entry) => entry.text));
      offset = page.nextOffset;
    } while (offset !== undefined);
    assert.equal(entries.join(""), long);
    assert.equal(
      h.request(worker, {
        op: "goal-context",
        section: "plan",
        goalId: root.id,
      }).entries[0].text,
      "Root execution roadmap",
    );
    assert.throws(
      () =>
        h.request(worker, {
          op: "goal-plan-update",
          plan: "Unapproved",
          planRevision: 0,
        }),
      /authorization/,
    );
  }));

test("a once grant is consumed atomically by one changed write; invalid, stale and no-op writes preserve it and transport replay is idempotent", () =>
  using(async (h) => {
    const [root] = h.kernel.planGoals([
      { objective: "Root", criteria: ["Result"], plan: "Original" },
    ]);
    const member = h.add();
    const worker = await h.start(root.id);
    h.kernel.authorizeGoalPlan(root.id, member.name, "once");
    assert.throws(
      () =>
        h.request(worker, {
          op: "goal-plan-update",
          plan: "Stale",
          planRevision: 5,
        }),
      /revision/,
    );
    assert.throws(
      () =>
        h.request(worker, {
          op: "goal-plan-update",
          plan: 42,
          planRevision: 0,
        }),
      /text/,
    );
    assert.throws(
      () =>
        h.request(worker, {
          op: "goal-plan-update",
          plan: "x".repeat(16001),
          planRevision: 0,
        }),
      /16000/,
    );
    assert.equal(
      h.request(worker, {
        op: "goal-plan-update",
        plan: "Original",
        planRevision: 0,
      }).editPermission,
      "once",
    );
    const request = {
      op: "goal-plan-update",
      id: "successful-once",
      plan: "Approved refinement",
      planRevision: 0,
    };
    const result = h.request(worker, request);
    assert.equal(result.planRevision, 1);
    assert.equal(result.editPermission, "none");
    assert.deepEqual(h.request(worker, request), result);
    assert.throws(
      () =>
        h.request(worker, {
          ...request,
          id: "another-write",
          planRevision: 1,
          plan: "Second edit",
        }),
      /authorization/,
    );
    assert.equal(h.kernel.goals.node(root.id).revision, 0);
    assert.equal(
      h.kernel.store.task(worker.assignment.task.id).state,
      "running",
    );
  }));

test("permanent grants survive new tasks and reload, allow safe plan removal, and revoke immediately", () =>
  using(async (h) => {
    const root = h.kernel.setGoal("Root", ["Result"]);
    const member = h.add();
    h.kernel.authorizeGoalPlan(root.id, member.name, "permanent");
    let worker = await h.start(root.id);
    h.request(worker, {
      op: "goal-plan-update",
      plan: "First plan",
      planRevision: 0,
    });
    h.request(worker, {
      op: "goal-plan-update",
      plan: "Improved plan",
      planRevision: 1,
    });
    worker.resolve({
      ok: true,
      text: "Work checkpoint",
      processState: "stopped",
    });
    await flush();
    await h.reload();
    assert.equal(
      h.kernel.goalPlans.permission(root.id, member.id),
      "permanent",
    );
    worker = await h.start(root.id);
    assert.match(worker.assignment.prompt, /Improved plan/);
    assert.equal(
      h.request(worker, { op: "goal-plan-update", plan: null, planRevision: 2 })
        .plan,
      null,
    );
    h.kernel.authorizeGoalPlan(root.id, member.name, "revoke");
    assert.throws(
      () =>
        h.request(worker, {
          op: "goal-plan-update",
          plan: "Denied",
          planRevision: 3,
        }),
      /authorization/,
    );
  }));

test("plan grants are exact goal and identity permissions, never inherited or self-issued, and late task tokens stay fenced", () =>
  using(async (h) => {
    const [root, leaf, peer, other] = h.kernel.planGoals([
      {
        key: "root",
        objective: "Root",
        criteria: ["Outcome"],
        plan: "Read only",
      },
      { parentId: "root", objective: "Leaf", criteria: ["Output"] },
      { parentId: "root", objective: "Peer", criteria: ["Other output"] },
      { objective: "Another main goal", criteria: ["Independent"] },
    ]);
    const member = h.add();
    h.add("other-reader");
    h.kernel.authorizeGoalPlan(root.id, member.name, "permanent");
    h.kernel.authorizeGoalPlan(other.id, member.name, "permanent");
    const worker = await h.start(leaf.id);
    assert.throws(
      () =>
        h.request(worker, {
          op: "goal-plan-update",
          plan: "No child inheritance",
          planRevision: 0,
        }),
      /authorization/,
    );
    assert.throws(
      () =>
        h.request(worker, {
          op: "goal-context",
          section: "plan",
          goalId: peer.id,
        }),
      /outside/,
    );
    assert.throws(
      () =>
        h.request(worker, {
          op: "goal-plan-update",
          goalId: other.id,
          plan: "Other mission",
          planRevision: 0,
        }),
      /main goal/,
    );
    assert.throws(
      () =>
        h.request(worker, {
          op: "goal-plan-authorize",
          goalId: leaf.id,
          mode: "permanent",
        }),
      /Unsupported/,
    );
    h.kernel.authorizeGoalPlan(peer.id, member.name, "once");
    assert.equal(
      h.request(worker, {
        op: "goal-context",
        section: "plan",
        goalId: peer.id,
      }).editPermission,
      "once",
    );
    h.request(worker, {
      op: "goal-plan-update",
      goalId: peer.id,
      plan: "Explicit peer grant",
      planRevision: 0,
      criteria: ["Cannot change"],
      mode: "permanent",
    });
    assert.deepEqual(h.kernel.goals.node(peer.id).criteria, ["Other output"]);
    assert.equal(h.kernel.goalPlans.permission(peer.id, member.id), "none");
    const otherWorker = await h.start(peer.id, "other-reader");
    assert.throws(
      () =>
        h.request(otherWorker, {
          op: "goal-plan-update",
          goalId: root.id,
          plan: "Wrong member",
          planRevision: 0,
        }),
      /authorization/,
    );
    await h.kernel.cancelTask(worker.assignment.task.id);
    assert.throws(
      () =>
        h.request(worker, {
          op: "goal-plan-update",
          goalId: root.id,
          plan: "Late",
          planRevision: 0,
        }),
      /Stale/,
    );
  }));

test("live plan updates use an independent compare-and-swap version and never restart work or alter its goal revision", () =>
  using(async (h) => {
    const root = h.kernel.setGoal("Root", ["Same criterion"]);
    h.add();
    const worker = await h.start(root.id);
    h.kernel.authorizeGoalPlan(root.id, "reader", "permanent");
    const before = h.kernel.store.task(worker.assignment.task.id);
    h.kernel.updateGoalPlan(root.id, "Lead refinement", 0);
    assert.throws(
      () =>
        h.request(worker, {
          op: "goal-plan-update",
          plan: "Stale overwrite",
          planRevision: 0,
        }),
      /revision/,
    );
    h.request(worker, {
      op: "goal-plan-update",
      plan: "Merge lead refinement with exact steps",
      planRevision: 1,
    });
    assert.deepEqual(h.kernel.store.task(before.id), before);
    assert.equal(h.workers.length, 1);
    assert.equal(h.kernel.store.mission().revision ?? 0, 0);
    assert.equal(h.kernel.store.mission().status, "active");
    h.kernel.goals.edit(root.id, { state: "review" }, 0);
    worker.resolve({ ok: true, text: "Verified", processState: "stopped" });
    await flush();
    h.kernel.leadStarted();
    h.kernel.includeCollected(
      h.kernel.store.deliveries("lead").map((entry) => entry.id),
    );
    h.kernel.leadMessage(false);
    h.kernel.leadSettled();
    h.kernel.complete([{ criterion: 1, evidence: "Verified" }]);
    assert.throws(
      () => h.kernel.updateGoalPlan(root.id, "Cannot reopen implicitly", 2),
      /closed/,
    );
  }));
