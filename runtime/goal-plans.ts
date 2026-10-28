import { createHash } from "node:crypto";
import type { Store } from "./store.ts";
import type { GoalNode } from "./types.ts";
import { cleanText } from "./public.ts";

export function executionPlan(value: unknown): string | undefined {
  if (value === null || value === undefined) return undefined;
  if (typeof value !== "string" || value.length > 16000)
    throw new Error(
      "Execution plan must be text up to 16000 characters, or null to remove it",
    );
  return cleanText(value, 16000).trim() || undefined;
}

/** Plan text never grants execution, changes scope or invalidates acceptance. */
export class GoalPlans {
  private store: Store;
  private now: () => number;
  constructor(store: Store, now: () => number) {
    this.store = store;
    this.now = now;
  }
  private node(id: string) {
    const goal = this.store.goal(id);
    if (!goal) throw new Error(`Unknown goal: ${id}`);
    return goal;
  }
  private editable(goal: GoalNode) {
    for (
      let node: GoalNode | undefined = goal;
      node;
      node = node.parentId ? this.node(node.parentId) : undefined
    )
      if (["accepted", "cancelled", "skipped"].includes(node.state))
        throw new Error(
          "Reopen the closed goal before changing its execution plan or edit authorization",
        );
    if (
      ["complete", "stopped"].includes(
        this.store.savedMission(goal.rootId)?.status ?? "",
      )
    )
      throw new Error(
        "Restore or reopen the closed main goal before editing its execution plan",
      );
  }
  permission(id: string, memberId: string) {
    return (
      this.node(id).planEditors?.find((entry) => entry.memberId === memberId)
        ?.mode ?? "none"
    );
  }
  view(id: string, memberId?: string) {
    const goal = this.node(id);
    return {
      goalId: id,
      plan: goal.plan ?? null,
      planRevision: goal.planRevision ?? 0,
      updatedAt: goal.planUpdatedAt,
      updatedBy: goal.planUpdatedBy,
      ...(memberId
        ? { editPermission: this.permission(id, memberId) }
        : {
            editors: (goal.planEditors ?? []).map((entry) => ({
              ...entry,
              member: this.store.member(entry.memberId)?.name,
            })),
          }),
    };
  }
  authorize(
    id: string,
    memberId: string,
    mode: "once" | "permanent" | "revoke",
  ) {
    return this.store.transaction(() => {
      if (!["once", "permanent", "revoke"].includes(mode))
        throw new Error("Plan authorization must be once, permanent or revoke");
      const goal = this.node(id);
      if (mode !== "revoke") this.editable(goal);
      if (!this.store.member(memberId))
        throw new Error("Unknown member identity");
      const editors = (goal.planEditors ?? []).filter(
        (entry) => entry.memberId !== memberId,
      );
      if (mode !== "revoke")
        editors.push({ memberId, mode, grantedAt: this.now() });
      goal.planEditors = editors;
      this.store.putGoal(goal);
      this.store.event("goal.plan-authorized", id, { memberId, mode });
      return this.view(id);
    });
  }
  update(
    id: string,
    value: unknown,
    revision: number,
    actor?: { memberId: string; taskId: string },
  ) {
    return this.store.transaction(() => {
      const goal = this.node(id);
      this.editable(goal);
      if (
        !Number.isSafeInteger(revision) ||
        revision < 0 ||
        revision !== (goal.planRevision ?? 0)
      )
        throw new Error(
          `Execution plan revision changed; read revision ${goal.planRevision ?? 0} before editing`,
        );
      const permission = actor
        ? this.permission(id, actor.memberId)
        : undefined;
      if (permission === "none")
        throw new Error(
          "Plan editing requires an explicit once or permanent authorization from the lead for this goal",
        );
      if (value === undefined)
        throw new Error("Supply plan text or null to remove it");
      const plan = executionPlan(value);
      if (plan === goal.plan) return this.view(id, actor?.memberId);
      goal.plan = plan;
      goal.planRevision = revision + 1;
      goal.planUpdatedAt = goal.updatedAt = this.now();
      goal.planUpdatedBy = actor ? `member:${actor.memberId}` : "lead";
      if (permission === "once")
        goal.planEditors = goal.planEditors?.filter(
          (entry) => entry.memberId !== actor!.memberId,
        );
      this.store.putGoal(goal);
      this.store.event("goal.plan-updated", id, {
        planRevision: goal.planRevision,
        by: goal.planUpdatedBy,
        taskId: actor?.taskId,
        consumedOnce: permission === "once",
        removed: !plan,
        sha256: plan
          ? createHash("sha256").update(plan).digest("hex")
          : undefined,
      });
      return this.view(id, actor?.memberId);
    });
  }
}
