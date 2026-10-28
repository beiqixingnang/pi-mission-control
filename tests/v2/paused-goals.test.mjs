import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { MissionKernel } from "../../runtime/kernel.ts";

async function using(run) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "mc-paused-goals-"));
  let kernel;
  const create = () => {
    const value = new MissionKernel({
      directory,
      cwd: directory,
      sessionId: "paused-goals",
      isLeadIdle: () => true,
      wake() {
        throw new Error("Paused planning must not wake the lead");
      },
      workerFactory: async () => {
        throw new Error("Paused planning must not launch work");
      },
    });
    value.start(false);
    return value;
  };
  kernel = create();
  try {
    await run({
      get kernel() {
        return kernel;
      },
      async reload() {
        await kernel.close();
        kernel = create();
      },
    });
  } finally {
    await kernel.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

test("paused planning edits the matching root and children, preserves evidence and usage, and stays paused after reload", () =>
  using(async (h) => {
    const root = h.kernel.setGoal("Item-by-item audit", [
      "Each item has its own treatment",
    ]);
    const [stage, leaf, accepted] = h.kernel.planGoals([
      {
        key: "stage",
        parentId: root.id,
        objective: "Review individual items",
        criteria: ["Leaves have dispositions"],
      },
      {
        key: "leaf",
        parentId: "stage",
        objective: "Old treatment for item 1",
        criteria: ["Original item 1 requirement"],
        scope: { unitKind: "file", items: ["item-1.md"] },
      },
      {
        parentId: "stage",
        objective: "Unchanged item 2",
        criteria: ["Existing accepted result"],
      },
    ]);
    const evidence = h.kernel.acceptGoal(
      accepted.id,
      [
        {
          criterion: 1,
          source: "statement",
          summary: "Item 2 was already verified",
        },
      ],
      0,
    );
    const previous = h.kernel.store.mission();
    previous.turns = 17;
    previous.outputTokens = 231;
    h.kernel.store.set("mission", previous);
    h.kernel.pauseGoal(
      root.id,
      "Pause execution while revising the individual items",
      0,
    );
    const revised = h.kernel.editGoal(
      leaf.id,
      {
        objective: "Keep item 1's implemented check",
        criteria: [
          "State the exact implemented behavior",
          "Remove only the obsolete suggestion",
        ],
        nextStep: "Apply this disposition to item 1 only",
      },
      0,
    );
    h.kernel.updateGoal(
      "Revised per-item audit",
      ["Every child records its own decision"],
      root.id,
      0,
    );
    const [extra] = h.kernel.planGoals([
      {
        parentId: stage.id,
        objective: "Review item 3",
        criteria: ["Decide which suggestions to simplify"],
      },
    ]);
    assert.equal(revised.id, leaf.id);
    assert.equal(h.kernel.goals.node(accepted.id).acceptanceId, evidence.id);
    assert.deepEqual(h.kernel.store.acceptance(evidence.id), evidence);
    assert.equal(h.kernel.goals.node(extra.id).parentId, stage.id);
    await h.kernel.tick();
    await h.reload();
    await h.kernel.tick();
    const paused = h.kernel.store.mission();
    assert.equal(paused.id, root.id);
    assert.equal(paused.status, "paused");
    assert.equal(paused.humanPaused, true);
    assert.equal(paused.pauseSource, "agent");
    assert.equal(paused.turns, 17);
    assert.equal(paused.outputTokens, 231);
    assert.equal(paused.budgetStartedAt, previous.budgetStartedAt);
    assert.equal(h.kernel.snapshot().planning.resumeRequiredForEditing, false);
    assert.equal(h.kernel.snapshot().planning.planEditable, true);
    assert.equal(h.kernel.store.tasks().length, 0);
    assert.throws(() => h.kernel.focusGoal(leaf.id, 1), /holds/);
    h.kernel.addMember({
      name: "reader",
      role: "Do not run while paused",
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
    assert.throws(
      () => h.kernel.dispatch("reader", "No execution authority"),
      /paused/,
    );
  }));

test("a mistakenly stopped archived goal restores only paused planning, preserving the archive and goal identity", () =>
  using(async (h) => {
    const root = h.kernel.setGoal("Keep this existing goal", [
      "Modify after pausing",
    ]);
    const [leaf] = h.kernel.planGoals([
      {
        parentId: root.id,
        objective: "Existing child",
        criteria: ["Keep its own ID"],
      },
    ]);
    await h.kernel.stopGoal(root.id, "Legacy pause was mistakenly archived");
    const archived = h.kernel.store.archived("goal", root.id);
    const result = h.kernel.pauseGoal(
      root.id,
      "Restore editable paused plan",
      0,
    );
    assert.equal(result.restoredStopped, true);
    assert.equal(result.goal.id, root.id);
    h.kernel.editGoal(
      leaf.id,
      {
        criteria: [
          "Keep implemented behavior",
          "Simplify this item separately",
        ],
      },
      0,
    );
    h.kernel.updateGoal(
      "Same goal, revised while paused",
      ["Updated child dispositions"],
      root.id,
      0,
    );
    await h.reload();
    await h.kernel.tick();
    assert.equal(h.kernel.store.mission().status, "paused");
    assert.equal(h.kernel.store.mission().humanPaused, true);
    assert.deepEqual(h.kernel.store.archived("goal", root.id), archived);
    assert.equal(h.kernel.goals.node(leaf.id).id, leaf.id);
    assert.equal(h.kernel.store.tasks().length, 0);
  }));

test("editing a non-selected paused goal does not switch or pause the current goal", () =>
  using(async (h) => {
    const old = h.kernel.setGoal("Previous goal", ["Retain history"]);
    await h.kernel.stopGoal(old.id);
    const current = h.kernel.setGoal("Current independent goal", [
      "Stay selected",
    ]);
    h.kernel.pauseGoal(old.id);
    h.kernel.updateGoal(
      "Previous goal's new plan",
      ["Edit without selecting"],
      old.id,
      0,
    );
    assert.equal(h.kernel.store.mission().id, current.id);
    assert.equal(h.kernel.store.mission().status, "active");
    assert.equal(h.kernel.store.savedMission(old.id).status, "paused");
    assert.equal(h.kernel.snapshot().held, false);
  }));

test("pause preserves independent holds and rejects a stale revision", () =>
  using(async (h) => {
    const root = h.kernel.setGoal("Original scope", [
      "Retain permission boundary",
    ]);
    h.kernel.requireDecision("User must choose the release scope");
    h.kernel.store.set("relocationHold", true);
    h.kernel.pauseGoal(root.id);
    const decision = h.kernel.store.mission().decision;
    h.kernel.updateGoal(
      "Edited approved scope",
      ["Still wait for release choice"],
      root.id,
      0,
    );
    assert.equal(h.kernel.store.mission().status, "paused");
    assert.equal(h.kernel.store.mission().decision.question, decision.question);
    assert.equal(h.kernel.snapshot().workspaceHeld, true);
    assert.throws(
      () => h.kernel.pauseGoal(root.id, "Stale request", 0),
      /revision/,
    );
  }));

test("a planning pause does not silently reopen an accepted main goal", () =>
  using(async (h) => {
    const root = h.kernel.setGoal("Already complete", ["Verified acceptance"]);
    h.kernel.complete([{ criterion: 1, evidence: "Existing verified result" }]);
    const before = h.kernel.store.mission();
    assert.throws(() => h.kernel.pauseGoal(root.id), /accepted|reopen/);
    assert.deepEqual(h.kernel.store.mission(), before);
  }));

test("AI can initiate a planning pause but cannot relabel an existing user pause", () =>
  using(async (h) => {
    const root = h.kernel.setGoal("AI may pause to revise this plan", [
      "Keep execution controlled",
    ]);
    h.kernel.pauseGoal(root.id, "AI detected a planning inconsistency");
    assert.equal(h.kernel.snapshot().planning.pauseSource, "agent");
    await h.kernel.userControl("pause");
    h.kernel.pauseGoal(root.id, "AI continues paused planning");
    assert.equal(h.kernel.snapshot().planning.pauseSource, "user");
    assert.equal(h.kernel.store.mission().humanPaused, true);
    assert.equal(h.kernel.store.mission().status, "paused");
  }));

test("AI resumes its own pause without renewing usage, while user pauses require the user's continue intent", () =>
  using(async (h) => {
    const root = h.kernel.setGoal("Pause, adjust and continue", [
      "Preserve usage",
    ]);
    const original = h.kernel.store.mission();
    original.turns = 8;
    original.outputTokens = 45;
    h.kernel.store.set("mission", original);
    h.kernel.pauseGoal(root.id);
    h.kernel.updateGoal(
      "Adjusted approved plan",
      ["Still the same approved task"],
      root.id,
      0,
    );
    h.kernel.resumeGoal(root.id, "AI adjustment complete", 1);
    assert.equal(h.kernel.store.mission().status, "active");
    assert.equal(h.kernel.store.mission().turns, 8);
    assert.equal(h.kernel.store.mission().outputTokens, 45);
    assert.equal(
      h.kernel.store.mission().budgetStartedAt,
      original.budgetStartedAt,
    );
    h.kernel.pauseGoal(root.id, "User requested a pause", 1, "user");
    h.kernel.editGoal(root.id, { nextStep: "Plan-only update" }, 1);
    assert.throws(
      () => h.kernel.resumeGoal(root.id),
      /user's pause|source:user/,
    );
    h.kernel.resumeGoal(root.id, "User said continue the goal", 1, "user");
    assert.equal(h.kernel.store.mission().status, "active");
    assert.equal(h.kernel.store.mission().humanPaused, false);
  }));

test("model goal resume never clears workspace or budget holds", () =>
  using(async (h) => {
    const root = h.kernel.setGoal("Preserve separate control", [
      "Do not bypass holds",
    ]);
    h.kernel.pauseGoal(root.id);
    h.kernel.store.set("relocationHold", true);
    assert.throws(() => h.kernel.resumeGoal(root.id), /independent/);
    assert.equal(h.kernel.snapshot().workspaceHeld, true);
    assert.equal(h.kernel.store.mission().status, "paused");
    h.kernel.store.set("relocationHold", false);
    const mission = h.kernel.store.mission();
    mission.blocker = {
      kind: "budget",
      reason: "Budget renewal remains separate",
    };
    h.kernel.store.set("mission", mission);
    assert.throws(
      () => h.kernel.resumeGoal(root.id, "User says resume", undefined, "user"),
      /independent/,
    );
    assert.deepEqual(h.kernel.store.mission().blocker, mission.blocker);
  }));
