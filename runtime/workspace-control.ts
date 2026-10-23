import type { Store } from "./store.ts";

export const workspaceResumeInstruction =
  "工作区仍处于迁移暂停。请在当前 Pi 会话手动执行 /mission resume 后继续，恢复任务与提醒。";

// Exact compatibility messages only. General mentions of migration, permissions
// or a workspace are not evidence that a business blocker can be removed.
const pauseReasons = new Set([
  workspaceResumeInstruction,
  "实际配置与验证已完成；工作区迁移hold仍由用户控制，不能通过运行时no-progress恢复工具解除。",
  "Resolve user or workspace holds before completion",
  "Resolve mission holds before executing planned work",
  "Workspace restored; review retained work before resuming",
]);
export const isWorkspacePauseReason = (reason?: string) =>
  reason !== undefined && pauseReasons.has(reason.trim());

/** A second migration carries its predecessor's identified pause with it. */
export function rebindWorkspaceGoalBlocks(
  store: Store,
  previousId: string,
  nextId: string,
) {
  for (const node of store.goals()) {
    const marker = node.workspaceBlock;
    if (
      node.state === "blocked" &&
      marker?.relocationId === previousId &&
      marker.revision === node.revision &&
      marker.reason === node.reason
    ) {
      marker.relocationId = nextId;
      store.putGoal(node);
    }
  }
}

/** Called only by the user's resume command for the current relocation. */
export function releaseWorkspaceGoalBlocks(
  store: Store,
  relocationId: string,
  now: number,
) {
  const migration = store.db
    .prepare(
      "SELECT sequence FROM events WHERE kind='project.relocated' AND entity=? ORDER BY sequence DESC LIMIT 1",
    )
    .get(relocationId);
  for (const node of store.goals()) {
    if (node.state !== "blocked") continue;
    const marker = node.workspaceBlock;
    let legacy = false;
    if (marker) {
      if (
        marker.relocationId !== relocationId ||
        marker.revision !== node.revision ||
        marker.reason !== node.reason
      )
        continue;
    } else {
      if (!migration || !isWorkspacePauseReason(node.reason)) continue;
      const update = store.db
        .prepare(
          "SELECT sequence,data FROM events WHERE kind='goal.updated' AND entity=? ORDER BY sequence DESC LIMIT 1",
        )
        .get(node.id);
      if (!update || Number(update.sequence) <= Number(migration.sequence))
        continue;
      const patch = JSON.parse(String(update.data));
      if (
        patch.state !== "blocked" ||
        patch.reason !== node.reason ||
        patch.revision !== node.revision
      )
        continue;
      legacy = true;
    }
    const oldReason = node.reason;
    node.state = marker?.previousState ?? "planned";
    node.reason = marker?.previousReason;
    if (marker) node.nextStep = marker.previousNextStep;
    delete node.workspaceBlock;
    node.updatedAt = now;
    store.putGoal(node);
    store.event("goal.workspace-unblocked", node.id, {
      relocationId,
      legacy,
      previousReason: oldReason,
      state: node.state,
    });
  }
}
