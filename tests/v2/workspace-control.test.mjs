import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { MissionKernel } from "../../runtime/kernel.ts";

const legacyReason =
  "实际配置与验证已完成；工作区迁移hold仍由用户控制，不能通过运行时no-progress恢复工具解除。";
async function usingWorkspace(run) {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "mc-workspace-control-"),
  );
  const create = () => {
    const kernel = new MissionKernel({
      directory,
      cwd: directory,
      sessionId: "fixture",
      isLeadIdle: () => false,
      wake() {},
      workerFactory: async () => {
        throw new Error("No old command may replay");
      },
    });
    kernel.start(false);
    return kernel;
  };
  let kernel = create();
  const h = {
    get kernel() {
      return kernel;
    },
    hold() {
      kernel.store.set("relocation", { id: "move", sessionId: "fixture" });
      kernel.store.set("relocationHold", true);
      kernel.store.event("project.relocated", "move", { action: "restore" });
    },
    async reload() {
      await kernel.close();
      kernel = create();
    },
  };
  try {
    await run(h);
  } finally {
    await kernel.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

test("one user resume after reload releases the tagged workspace block and retains business blockers and accepted evidence", () =>
  usingWorkspace(async (h) => {
    const root = h.kernel.setGoal("Continue recovered work");
    const [paused, business, accepted] = h.kernel.planGoals([
      {
        parentId: root.id,
        objective: "Migration pause",
        criteria: ["Write after resume"],
      },
      {
        parentId: root.id,
        objective: "Separate business boundary",
        criteria: ["User supplies input"],
      },
      {
        parentId: root.id,
        objective: "Already verified",
        criteria: ["Retain receipt"],
      },
    ]);
    h.kernel.editGoal(
      paused.id,
      { state: "review", nextStep: "Review existing artifact" },
      0,
    );
    h.kernel.editGoal(
      business.id,
      { state: "blocked", reason: "Missing agreed input file" },
      0,
    );
    const receipt = h.kernel.acceptGoal(
      accepted.id,
      [
        {
          criterion: 1,
          source: "statement",
          summary: "Verified before migration",
        },
      ],
      0,
    );
    h.hold();
    h.kernel.editGoal(
      paused.id,
      {
        state: "blocked",
        blockedBy: "workspace",
        reason: "等待本次迁移确认",
        nextStep: "/mission resume",
      },
      0,
    );
    const originalBusiness = h.kernel.goals.node(business.id);
    h.kernel.onHumanInput("继续修改 README");
    assert.equal(h.kernel.snapshot().workspaceHeld, true);
    assert.equal(h.kernel.recoveryPlan().userCommand, "/mission resume");
    await h.reload();
    assert.equal(h.kernel.goals.node(paused.id).state, "blocked");
    await h.kernel.userControl("resume");
    assert.equal(h.kernel.snapshot().workspaceHeld, false);
    const restored = h.kernel.goals.node(paused.id);
    assert.equal(restored.state, "review");
    assert.equal(restored.nextStep, "Review existing artifact");
    assert.equal(restored.workspaceBlock, undefined);
    assert.deepEqual(h.kernel.goals.node(business.id), originalBusiness);
    assert.equal(h.kernel.goals.node(accepted.id).acceptanceId, receipt.id);
    assert.equal(h.kernel.store.tasks().length, 0);
  }));

test("the exact legacy root blocker from the reported incident is released only by a user resume after reload", () =>
  usingWorkspace(async (h) => {
    const root = h.kernel.setGoal("Recovered README work");
    h.hold();
    // Reproduce the old plugin's persisted goal_edit result without a marker.
    h.kernel.goals.edit(root.id, { state: "blocked", reason: legacyReason }, 0);
    assert.throws(
      () => h.kernel.goals.captureStart("before", "write", {}),
      /迁移hold/,
    );
    await h.reload();
    assert.equal(h.kernel.goals.node(root.id).state, "blocked");
    assert.equal(h.kernel.snapshot().workspaceHeld, true);
    await h.kernel.userControl("resume");
    assert.doesNotThrow(() =>
      h.kernel.goals.captureStart("after", "write", {}),
    );
    assert.equal(h.kernel.goals.node(root.id).state, "planned");
    assert.equal(h.kernel.goals.node(root.id).revision, 0);
    assert.equal(
      h.kernel.store.db
        .prepare(
          "SELECT count(*) AS n FROM events WHERE kind='goal.workspace-unblocked'",
        )
        .get().n,
      1,
    );
  }));

test("resume preserves older, mixed, unrecorded, superseded and foreign workspace blockers", () =>
  usingWorkspace(async (h) => {
    const root = h.kernel.setGoal("Preserve genuine boundaries");
    const nodes = h.kernel.planGoals(
      ["older", "mixed", "unrecorded", "superseded", "foreign"].map(
        (objective) => ({
          parentId: root.id,
          objective,
          criteria: ["Preserve boundary"],
        }),
      ),
    );
    h.kernel.goals.edit(
      nodes[0].id,
      { state: "blocked", reason: legacyReason },
      0,
    );
    h.hold();
    h.kernel.editGoal(
      nodes[1].id,
      {
        state: "blocked",
        reason: "Workspace migration finished, but release needs approval",
      },
      0,
    );
    const unrecorded = h.kernel.goals.node(nodes[2].id);
    h.kernel.store.putGoal({
      ...unrecorded,
      state: "blocked",
      reason: legacyReason,
    });
    h.kernel.editGoal(
      nodes[3].id,
      {
        state: "blocked",
        blockedBy: "workspace",
        reason: "Waiting for workspace",
      },
      0,
    );
    h.kernel.editGoal(
      nodes[3].id,
      { reason: "New actual business blocker" },
      0,
    );
    h.kernel.editGoal(
      nodes[4].id,
      { state: "blocked", blockedBy: "workspace", reason: "Other migration" },
      0,
    );
    const foreign = h.kernel.goals.node(nodes[4].id);
    foreign.workspaceBlock.relocationId = "another-move";
    h.kernel.store.putGoal(foreign);
    const before = nodes.map((node) => h.kernel.goals.node(node.id));
    assert.throws(
      () =>
        h.kernel.editGoal(
          nodes[1].id,
          {
            state: "blocked",
            blockedBy: "workspace",
            reason: "Replace business blocker",
          },
          0,
        ),
      /existing business blocker/,
    );
    await h.kernel.userControl("resume");
    assert.deepEqual(
      nodes.map((node) => h.kernel.goals.node(node.id)),
      before,
    );
  }));

test("workspace pause classification validates the active session and does not reopen accepted goals", () =>
  usingWorkspace(async (h) => {
    const root = h.kernel.setGoal("Validate the pause source");
    assert.throws(
      () =>
        h.kernel.editGoal(
          root.id,
          { state: "blocked", blockedBy: "workspace" },
          0,
        ),
      /active relocation hold/,
    );
    h.hold();
    h.kernel.store.set("relocation", {
      id: "move",
      sessionId: "another-session",
    });
    assert.throws(
      () =>
        h.kernel.editGoal(
          root.id,
          { state: "blocked", blockedBy: "workspace" },
          0,
        ),
      /active relocation hold/,
    );
    h.kernel.store.set("relocation", { id: "move", sessionId: "fixture" });
    assert.throws(
      () =>
        h.kernel.editGoal(
          root.id,
          { state: "blocked", blockedBy: "workspace", criteria: ["Changed"] },
          0,
        ),
      /state-only/,
    );
    assert.equal(h.kernel.goals.node(root.id).state, "planned");
  }));

test("new objectives stay held after restoring a closed goal until the user resumes", () =>
  usingWorkspace(async (h) => {
    h.kernel.setGoal("Previously verified", ["Verification recorded"]);
    h.kernel.complete([{ criterion: 1, evidence: "Verified original work" }]);
    const before = h.kernel.store.mission();
    h.hold();
    assert.throws(
      () => h.kernel.setGoal("New README work"),
      /手动执行 \/mission resume/,
    );
    assert.deepEqual(h.kernel.store.mission(), before);
    await h.kernel.userControl("resume");
    assert.deepEqual(h.kernel.store.mission(), before);
    assert.notEqual(h.kernel.setGoal("New README work").id, before.id);
  }));

test("resuming a recovered conversation without a mission clears and persists its control state", () =>
  usingWorkspace(async (h) => {
    h.hold();
    await h.reload();
    assert.equal(h.kernel.snapshot().held, true);
    await h.kernel.userControl("resume");
    assert.equal(h.kernel.snapshot().held, false);
    assert.equal(h.kernel.recoveryPlan().state, "ready");
    await h.reload();
    assert.equal(h.kernel.snapshot().workspaceHeld, false);
  }));
