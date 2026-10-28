import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import type { Store } from "./store.ts";
import type {
  GoalAcceptance,
  GoalDefinition,
  GoalEvidence,
  GoalNode,
  GoalReceipt,
  GoalState,
  GoalScope,
  Mission,
} from "./types.ts";
import { cleanText } from "./public.ts";
import { executionPlan } from "./goal-plans.ts";
import { mappedPath, type PathMapping } from "./path-mapping.ts";

const excluded = (goal: GoalNode) =>
  goal.state === "cancelled" || goal.state === "skipped";
const text = (value: string, name: string, max = 2000) => {
  if (typeof value !== "string" || !value.trim() || value.length > max)
    throw new Error(`${name} requires 1..${max} characters`);
  return cleanText(value.trim(), max);
};
function criteria(values: string[]) {
  if (!Array.isArray(values) || !values.length || values.length > 30)
    throw new Error("Supply 1..30 explicit acceptance criteria");
  return values.map((value) => text(value, "Acceptance criterion"));
}
function estimate(value?: [number, number]) {
  if (
    value &&
    (value.length !== 2 ||
      value.some((n) => !Number.isSafeInteger(n) || n < 0) ||
      value[1] < value[0])
  )
    throw new Error(
      "estimateMs must be [minimum, maximum] remaining effort in milliseconds",
    );
  return value;
}
function scope(value?: GoalScope | null): GoalScope | undefined {
  if (value == null) return undefined;
  if (!["file", "module", "batch", "artifact"].includes(value.unitKind))
    throw new Error("Scope unitKind must be file, module, batch or artifact");
  const list = (items: string[], name: string) => {
    if (!Array.isArray(items) || !items.length || items.length > 100)
      throw new Error(`${name} requires 1..100 explicit entries`);
    return [...new Set(items.map((item) => text(item, name, 400)))];
  };
  const result = {
    unitKind: value.unitKind,
    items: list(value.items, "Scope items"),
    ...(value.files !== undefined
      ? { files: list(value.files, "Scope files") }
      : {}),
  };
  if (JSON.stringify(result).length > 16000)
    throw new Error("Scope exceeds 16000 characters; use a smaller batch");
  return result;
}

/** Durable acceptance ledger. Task settlement is deliberately separate from acceptance. */
export class GoalLedger {
  private store: Store;
  private cwd: string;
  private now: () => number;
  constructor(store: Store, cwd: string, now: () => number) {
    this.store = store;
    this.cwd = cwd;
    this.now = now;
    store.transaction(() => {
      const current = store.mission();
      if (current) this.enroll(current);
      for (const archived of store.archives<Mission>("goal", 1000))
        if (!store.goal(archived.id)) this.enroll(archived);
    });
  }
  maxDepth() {
    return this.store.get<number>("goalMaxDepth") ?? 3;
  }
  setMaxDepth(value: number) {
    if (!Number.isSafeInteger(value) || value < 3 || value > 12)
      throw new Error(
        "Goal depth must be 3..12; more than three levels is not recommended",
      );
    this.store.set("goalMaxDepth", value);
    this.store.event(
      "goal.depth-authorized",
      this.store.mission()?.id ?? "session",
      { maxDepth: value },
    );
    return { maxDepth: value, recommended: 3 };
  }
  enroll(mission: Mission) {
    this.store.putMission(mission);
    const existing = this.store.goal(mission.id);
    if (existing) return existing;
    const goal: GoalNode = {
      id: mission.id,
      rootId: mission.id,
      depth: 1,
      order: this.store.goals().filter((n) => n.depth === 1).length,
      objective: mission.objective,
      criteria: mission.criteria,
      dependsOn: [],
      revision: mission.revision ?? 0,
      state:
        mission.status === "complete"
          ? "accepted"
          : mission.status === "stopped"
            ? "cancelled"
            : "planned",
      createdAt: mission.createdAt,
      updatedAt: mission.updatedAt,
    };
    if (mission.status === "complete" && mission.evidence?.length) {
      const acceptance: GoalAcceptance = {
        id: randomUUID(),
        goalId: goal.id,
        revision: goal.revision,
        at: mission.updatedAt,
        imported: true,
        children: [],
        evidence: mission.evidence.map((item) => ({
          criterion: item.criterion,
          source: "statement",
          summary: item.evidence,
        })),
      };
      this.store.putAcceptance(acceptance);
      goal.acceptanceId = acceptance.id;
    }
    this.store.putGoal(goal);
    return goal;
  }
  node(id: string) {
    const goal = this.store.goal(id);
    if (!goal) throw new Error(`Unknown goal: ${id}`);
    return goal;
  }
  children(id: string) {
    return this.store
      .goals(this.node(id).rootId)
      .filter((n) => n.parentId === id);
  }
  subtree(id: string) {
    const all = this.store.goals(this.node(id).rootId),
      ids = new Set([id]);
    for (const node of all.sort((a, b) => a.depth - b.depth))
      if (node.parentId && ids.has(node.parentId)) ids.add(node.id);
    return all.filter((node) => ids.has(node.id));
  }
  private assertRevision(goal: GoalNode, revision?: number) {
    if (revision !== undefined && goal.revision !== revision)
      throw new Error(
        `Goal revision changed: ${goal.id} is revision ${goal.revision}`,
      );
  }
  private assertGraph(nodes: GoalNode[]) {
    const byId = new Map(nodes.map((node) => [node.id, node]));
    const children = new Map<string, GoalNode[]>();
    for (const node of nodes)
      if (node.parentId)
        children.set(node.parentId, [
          ...(children.get(node.parentId) ?? []),
          node,
        ]);
    const visiting = new Set<string>(),
      visited = new Set<string>();
    const visit = (node: GoalNode) => {
      if (visiting.has(node.id))
        throw new Error(
          "Goal dependency cycle, including parent acceptance dependencies",
        );
      if (visited.has(node.id)) return;
      visiting.add(node.id);
      for (const id of node.dependsOn) {
        const dependency = byId.get(id);
        if (!dependency || dependency.rootId !== node.rootId)
          throw new Error(
            "Dependencies must refer to goals in the same main goal",
          );
        if (dependency.id === node.id)
          throw new Error("A goal cannot depend on itself");
        visit(dependency);
      }
      for (const child of children.get(node.id) ?? []) visit(child);
      visiting.delete(node.id);
      visited.add(node.id);
    };
    for (const node of nodes) visit(node);
  }
  plan(definitions: GoalDefinition[]) {
    if (
      !Array.isArray(definitions) ||
      !definitions.length ||
      definitions.length > 100
    )
      throw new Error("Plan 1..100 goals per batch");
    return this.store.transaction(() => {
      const previous = this.store.goals();
      if (previous.length + definitions.length > 5000)
        throw new Error(
          "Goal limit reached (5000); export or reuse existing goals",
        );
      const ids = new Map<string, string>();
      for (const definition of definitions)
        if (definition.key) {
          if (
            ids.has(definition.key) ||
            previous.some((n) => n.id === definition.key)
          )
            throw new Error("Duplicate or ambiguous plan key");
          ids.set(definition.key, randomUUID());
        }
      const pending = definitions.map((d) => ({
        ...d,
        id: d.key ? ids.get(d.key)! : randomUUID(),
      }));
      const created: GoalNode[] = [];
      while (pending.length) {
        const index = pending.findIndex(
          (d) =>
            !d.parentId ||
            [...previous, ...created].some(
              (n) => n.id === (ids.get(d.parentId!) ?? d.parentId),
            ),
        );
        if (index < 0)
          throw new Error(
            "Missing parent or cyclic parent references in goal plan",
          );
        const definition = pending.splice(index, 1)[0];
        const parentId = definition.parentId
          ? (ids.get(definition.parentId) ?? definition.parentId)
          : undefined;
        const parent = parentId
          ? [...previous, ...created].find((n) => n.id === parentId)!
          : undefined;
        if (parent && (parent.state === "accepted" || excluded(parent)))
          throw new Error("Reopen a closed parent before adding goals");
        const depth = (parent?.depth ?? 0) + 1;
        if (depth > this.maxDepth())
          throw new Error(
            `Goal depth limit is ${this.maxDepth()}. Flatten the plan or use ordinary execution tasks. Only the user may authorize /mission goals depth ${depth}; more than three levels is not recommended.`,
          );
        const node: GoalNode = {
          id: definition.id,
          rootId: parent?.rootId ?? definition.id,
          parentId,
          depth,
          order: [...previous, ...created].filter(
            (n) => n.parentId === parentId,
          ).length,
          objective: text(definition.objective, "Objective", 8000),
          criteria: criteria(definition.criteria),
          dependsOn: [
            ...new Set(
              (definition.dependsOn ?? []).map((id) => ids.get(id) ?? id),
            ),
          ],
          module: definition.module
            ? text(definition.module, "Module", 200)
            : undefined,
          scope: scope(definition.scope),
          nextStep: definition.nextStep
            ? text(definition.nextStep, "Next step")
            : undefined,
          ...(definition.plan !== undefined
            ? { plan: executionPlan(definition.plan), planRevision: 0 }
            : {}),
          estimateMs: estimate(definition.estimateMs),
          state: "planned",
          revision: 0,
          createdAt: this.now(),
          updatedAt: this.now(),
        };
        created.push(node);
      }
      this.assertGraph([...previous, ...created]);
      for (const node of created) {
        if (
          node.parentId &&
          this.store
            .missionTasks(node.rootId)
            .some(
              (t) =>
                t.goalId === node.parentId &&
                (!["completed", "failed", "cancelled", "interrupted"].includes(
                  t.state,
                ) ||
                  t.processState === "unknown"),
            )
        )
          throw new Error(
            "Settle the parent's assigned work before splitting it",
          );
        this.store.putGoal(node);
        this.store.event("goal.created", node.id, {
          rootId: node.rootId,
          parentId: node.parentId,
          depth: node.depth,
        });
        if (!node.parentId) this.store.putMission(this.newMission(node));
      }
      return created.map((node) => ({
        ...node,
        key: [...ids].find(([, id]) => id === node.id)?.[0],
      }));
    });
  }
  newMission(root: GoalNode): Mission {
    return {
      id: root.id,
      objective: root.objective,
      criteria: root.criteria,
      status: "active",
      createdAt: root.createdAt,
      updatedAt: this.now(),
      budgetStartedAt: this.now(),
      turns: 0,
      outputTokens: 0,
      emptyTurns: 0,
      lastReportAt: this.now(),
      nextContinueAt: this.now() + 1500,
      humanPaused: false,
      revision: root.revision,
    };
  }
  blockers(id: string): string[] {
    const goal = this.node(id),
      result: string[] = [];
    for (
      let node: GoalNode | undefined = goal;
      node;
      node = node.parentId ? this.node(node.parentId) : undefined
    ) {
      if (excluded(node)) result.push(`${node.id}: ${node.state}`);
      if (node.state === "blocked")
        result.push(`${node.id}: ${node.reason ?? "Blocked"}`);
      for (const dep of node.dependsOn) {
        const dependency = this.node(dep);
        if (dependency.state !== "accepted" || !dependency.acceptanceId)
          result.push(
            `Await acceptance: ${dependency.id} ${dependency.objective}`,
          );
      }
    }
    return [...new Set(result)];
  }
  private unsettled(id: string) {
    const ids = new Set(this.subtree(id).map((n) => n.id));
    return this.store
      .missionTasks(this.node(id).rootId)
      .some(
        (task) =>
          (task.goalId ? ids.has(task.goalId) : id === task.missionId) &&
          (!["completed", "failed", "cancelled", "interrupted"].includes(
            task.state,
          ) ||
            task.processState === "unknown"),
      );
  }
  private invalidate(id: string, reason: string) {
    const all = this.store.goals(this.node(id).rootId),
      ids = new Set([id]);
    let changed = true;
    while (changed) {
      changed = false;
      for (const node of all) {
        if (node.dependsOn.some((dep) => ids.has(dep))) {
          for (const descendant of this.subtree(node.id))
            if (!ids.has(descendant.id)) {
              ids.add(descendant.id);
              changed = true;
            }
        }
        if (
          !ids.has(node.id) &&
          all.some((child) => child.parentId === node.id && ids.has(child.id))
        ) {
          ids.add(node.id);
          changed = true;
        }
      }
    }
    if (
      this.store
        .missionTasks(this.node(id).rootId)
        .some(
          (task) =>
            ids.has(task.goalId ?? task.missionId) &&
            (!["completed", "failed", "cancelled", "interrupted"].includes(
              task.state,
            ) ||
              task.processState === "unknown"),
        )
    )
      throw new Error(
        "Settle affected dependent work before reopening its prerequisite",
      );
    for (const node of all)
      if (ids.has(node.id) && node.state === "accepted") {
        node.revision++;
        node.state = "planned";
        node.acceptanceId = undefined;
        node.reason = reason;
        node.updatedAt = this.now();
        this.store.putGoal(node);
        this.store.event("goal.acceptance-invalidated", node.id, {
          reason,
          revision: node.revision,
        });
      }
  }
  edit(
    id: string,
    patch: {
      objective?: string;
      criteria?: string[];
      dependsOn?: string[];
      state?: GoalState;
      reason?: string;
      nextStep?: string;
      estimateMs?: [number, number];
      scope?: GoalScope | null;
    },
    revision?: number,
    allowExclusion = false,
  ) {
    return this.store.transaction(() => {
      let goal = this.node(id);
      this.assertRevision(goal, revision);
      const nextRevision = goal.revision + 1;
      if (patch.state === "accepted")
        throw new Error("Use goal_accept with evidence");
      if (
        patch.state &&
        ![
          "planned",
          "active",
          "review",
          "blocked",
          "cancelled",
          "skipped",
        ].includes(patch.state)
      )
        throw new Error("Invalid goal state");
      if (
        (patch.state === "cancelled" || patch.state === "skipped") &&
        (!allowExclusion || !patch.reason?.trim())
      )
        throw new Error(
          "Excluding scope requires a user command and reason: /mission goals skip|cancel <id> <reason>",
        );
      const definitionChanged =
        patch.objective !== undefined ||
        patch.criteria !== undefined ||
        patch.dependsOn !== undefined ||
        patch.scope !== undefined ||
        patch.state === "planned" ||
        patch.state === "cancelled" ||
        patch.state === "skipped";
      if (definitionChanged && this.unsettled(id))
        throw new Error(
          "Settle assigned work and unknown processes before revising this goal",
        );
      if (goal.state === "accepted" && !definitionChanged)
        throw new Error(
          "Explicitly reopen an accepted goal with state:planned before more work",
        );
      if (definitionChanged) {
        this.invalidate(
          id,
          patch.reason ?? "Goal definition or acceptance changed",
        );
        goal = this.node(id);
      }
      goal = {
        ...goal,
        ...(patch.objective !== undefined
          ? { objective: text(patch.objective, "Objective", 8000) }
          : {}),
        ...(patch.criteria !== undefined
          ? { criteria: criteria(patch.criteria) }
          : {}),
        ...(patch.dependsOn !== undefined
          ? { dependsOn: [...new Set(patch.dependsOn)] }
          : {}),
        ...(patch.scope !== undefined ? { scope: scope(patch.scope) } : {}),
        ...(patch.state !== undefined
          ? { state: patch.state }
          : definitionChanged
            ? { state: "planned" as const }
            : {}),
        ...(patch.reason !== undefined
          ? { reason: cleanText(patch.reason, 2000) }
          : {}),
        ...(patch.nextStep !== undefined
          ? { nextStep: cleanText(patch.nextStep, 2000) }
          : {}),
        ...(patch.estimateMs !== undefined
          ? { estimateMs: estimate(patch.estimateMs) }
          : {}),
        revision: definitionChanged ? nextRevision : goal.revision,
        updatedAt: this.now(),
      };
      if (definitionChanged) goal.acceptanceId = undefined;
      this.assertGraph(
        this.store.goals().map((n) => (n.id === goal.id ? goal : n)),
      );
      this.store.putGoal(goal);
      if (excluded(goal))
        for (const descendant of this.subtree(id))
          if (descendant.id !== id) {
            descendant.state = goal.state;
            descendant.reason = goal.reason;
            descendant.revision++;
            descendant.acceptanceId = undefined;
            descendant.updatedAt = this.now();
            this.store.putGoal(descendant);
            this.store.event("goal.excluded", descendant.id, {
              ancestor: id,
              state: goal.state,
              reason: goal.reason,
            });
          }
      const saved = this.store.savedMission(goal.rootId);
      if (goal.depth === 1 && saved) {
        saved.objective = goal.objective;
        saved.criteria = goal.criteria;
        saved.revision = goal.revision;
        this.store.putMission(saved);
      }
      this.store.event("goal.updated", id, {
        revision: goal.revision,
        state: goal.state,
        reason: patch.reason,
      });
      return goal;
    });
  }
  focus(id: string, revision?: number) {
    const goal = this.node(id);
    this.assertRevision(goal, revision);
    if (goal.rootId !== this.store.mission()?.id)
      throw new Error("Activate this main goal before focusing a subgoal");
    if (goal.state === "accepted" || excluded(goal))
      throw new Error("Reopen the goal before assigning more work");
    if (this.children(id).some((n) => !excluded(n)))
      throw new Error(
        "Focus a leaf goal; parent goals aggregate their children",
      );
    const blocked = this.blockers(id);
    if (blocked.length) throw new Error(blocked.join("; "));
    goal.state = "active";
    goal.updatedAt = this.now();
    this.store.transaction(() => {
      this.store.putGoal(goal);
      this.store.set(`goalFocus:${goal.rootId}`, id);
      this.store.event("goal.focused", id, { revision: goal.revision });
    });
    return goal;
  }
  assignment(rootId: string, id?: string) {
    const root = this.node(rootId),
      children = this.children(rootId).filter((n) => !excluded(n));
    const target =
      id ??
      this.store.get<string>(`goalFocus:${rootId}`) ??
      (children.length ? undefined : root.id);
    if (!target)
      throw new Error(
        "Select a ready leaf goal with goal_focus before writing or dispatching planned work",
      );
    const goal = this.node(target);
    if (goal.rootId !== rootId)
      throw new Error("Task goal belongs to another main goal");
    if (goal.state === "accepted" || excluded(goal))
      throw new Error(
        "Goal is closed; explicitly reopen it before further work",
      );
    if (this.children(goal.id).some((n) => !excluded(n)))
      throw new Error("Assign work to a leaf goal");
    const blocked = this.blockers(goal.id);
    if (blocked.length) throw new Error(blocked.join("; "));
    return goal;
  }
  private fingerprint(file: string) {
    file = mappedPath(
      file,
      this.store.get<PathMapping[]>("pathMappings") ?? [],
      this.cwd,
    );
    const stat = fs.statSync(file);
    if (!stat.isFile()) throw new Error("Evidence must refer to a file");
    return {
      size: stat.size,
      mtimeMs: stat.mtimeMs,
      ...(stat.size <= 16 * 1024 * 1024
        ? {
            sha256: createHash("sha256")
              .update(fs.readFileSync(file))
              .digest("hex"),
          }
        : {}),
    };
  }
  private validateEvidence(
    goal: GoalNode,
    evidence: GoalEvidence[],
  ): GoalEvidence[] {
    if (!Array.isArray(evidence) || !evidence.length || evidence.length > 100)
      throw new Error("Supply 1..100 evidence entries");
    const subtree = new Set(this.subtree(goal.id).map((n) => n.id));
    const checked = evidence.map((item) => {
      if (
        !Number.isSafeInteger(item.criterion) ||
        item.criterion < 1 ||
        item.criterion > goal.criteria.length
      )
        throw new Error("Evidence criterion is outside this goal revision");
      const result: GoalEvidence = {
        criterion: item.criterion,
        summary: text(item.summary, "Evidence summary"),
        source: item.source,
      };
      if (result.summary.length < 8)
        throw new Error(
          "Evidence summary must describe the actual result (at least eight characters)",
        );
      if (item.source === "artifact") {
        if (!item.path) throw new Error("Artifact evidence requires path");
        result.path = path.resolve(this.cwd, item.path);
        result.fingerprint = this.fingerprint(result.path);
      } else if (item.source === "task") {
        const task = item.taskId ? this.store.task(item.taskId) : undefined;
        if (
          !task ||
          task.missionId !== goal.rootId ||
          !subtree.has(task.goalId ?? task.missionId) ||
          task.state !== "completed" ||
          task.processState !== "stopped" ||
          !task.resultPath ||
          !fs.existsSync(task.resultPath)
        )
          throw new Error(
            "Task evidence requires a completed, stopped task belonging to this goal subtree with a saved result",
          );
        if (
          (task.goalRevision ?? 0) !==
          this.node(task.goalId ?? task.missionId).revision
        )
          throw new Error(
            "Task result belongs to an older goal revision; inspect the artifact and verify the revised criteria",
          );
        result.taskId = task.id;
        result.path = task.resultPath;
        result.fingerprint = this.fingerprint(task.resultPath);
      } else if (item.source === "tool") {
        const receipt = item.receiptId
          ? this.store.goalReceipt(item.receiptId)
          : undefined;
        if (
          !receipt ||
          receipt.goalId !== goal.id ||
          receipt.revision !== goal.revision ||
          !receipt.finishedAt ||
          receipt.isError
        )
          throw new Error(
            "Tool evidence requires a successful saved receipt for this exact goal revision",
          );
        result.receiptId = receipt.id;
      } else if (item.source === "acceptance") {
        const acceptance = item.acceptanceId
          ? this.store.acceptance(item.acceptanceId)
          : undefined;
        const child = acceptance
          ? this.store.goal(acceptance.goalId)
          : undefined;
        if (
          !acceptance ||
          !child ||
          child.id === goal.id ||
          !subtree.has(child.id) ||
          child.state !== "accepted" ||
          child.acceptanceId !== acceptance.id ||
          child.revision !== acceptance.revision
        )
          throw new Error(
            "Reference a current accepted descendant's acceptance record",
          );
        result.acceptanceId = acceptance.id;
      } else if (item.source !== "statement")
        throw new Error("Unknown evidence source");
      return result;
    });
    if (
      goal.criteria.some((_, i) => !checked.some((e) => e.criterion === i + 1))
    )
      throw new Error("Evidence is required for every acceptance criterion");
    return checked;
  }
  private checkAcceptedArtifacts(id: string) {
    for (const node of this.subtree(id)) {
      if (!node.acceptanceId) continue;
      const acceptance = this.store.acceptance(node.acceptanceId);
      for (const item of acceptance?.evidence ?? [])
        if (item.path && item.fingerprint) {
          try {
            const stat = fs.statSync(
              mappedPath(
                item.path,
                this.store.get<PathMapping[]>("pathMappings") ?? [],
                this.cwd,
              ),
            );
            if (
              stat.isFile() &&
              stat.size === item.fingerprint.size &&
              stat.mtimeMs === item.fingerprint.mtimeMs
            )
              continue;
          } catch {
            throw new Error(
              `Evidence file missing: ${item.path}; reopen ${node.id} and update its acceptance`,
            );
          }
          let current: ReturnType<GoalLedger["fingerprint"]>;
          try {
            current = this.fingerprint(item.path);
          } catch {
            throw new Error(
              `Evidence file missing: ${item.path}; reopen ${node.id} and update its acceptance`,
            );
          }
          if (
            current.size !== item.fingerprint.size ||
            (item.fingerprint.sha256
              ? current.sha256 !== item.fingerprint.sha256
              : current.mtimeMs !== item.fingerprint.mtimeMs)
          )
            throw new Error(
              `Evidence file changed: ${item.path}; reopen ${node.id} and update its acceptance`,
            );
        }
    }
  }
  accept(id: string, evidence: GoalEvidence[], revision: number) {
    return this.store.transaction(() => {
      const goal = this.node(id);
      this.assertRevision(goal, revision);
      // Repeating an already committed acceptance is cheap and never reruns validation.
      if (goal.state === "accepted" && goal.acceptanceId)
        return this.store.acceptance(goal.acceptanceId)!;
      if (goal.rootId !== this.store.mission()?.id)
        throw new Error("Only the active main goal can be accepted");
      if (this.store.mission()?.status !== "active")
        throw new Error("Mission holds must be resolved before acceptance");
      const blocked = this.blockers(id);
      if (blocked.length) throw new Error(blocked.join("; "));
      if (this.unsettled(id))
        throw new Error(
          "Work or unknown processes remain in this goal subtree",
        );
      const children = this.children(id).filter((n) => !excluded(n));
      if (children.some((n) => n.state !== "accepted" || !n.acceptanceId))
        throw new Error(
          "Accept every required child before accepting its parent",
        );
      this.checkAcceptedArtifacts(id);
      const record: GoalAcceptance = {
        id: randomUUID(),
        goalId: id,
        revision,
        evidence: this.validateEvidence(goal, evidence),
        children: children.map((n) => ({
          goalId: n.id,
          acceptanceId: n.acceptanceId!,
        })),
        at: this.now(),
      };
      this.store.putAcceptance(record);
      goal.state = "accepted";
      goal.acceptanceId = record.id;
      goal.reason = undefined;
      goal.updatedAt = this.now();
      this.store.putGoal(goal);
      this.store.event("goal.accepted", id, {
        acceptanceId: record.id,
        revision,
      });
      return record;
    });
  }
  captureStart(id: string, tool: string, input: unknown) {
    const mission = this.store.mission();
    if (!mission || mission.status !== "active") return;
    const goal = this.assignment(mission.id);
    const receipt: GoalReceipt = {
      id,
      goalId: goal.id,
      revision: goal.revision,
      tool,
      input: cleanText(JSON.stringify(input), 2000),
      startedAt: this.now(),
    };
    this.store.putGoalReceipt(receipt);
  }
  captureEnd(id: string, output: string, isError: boolean) {
    const receipt = this.store.goalReceipt(id);
    if (!receipt) return;
    receipt.output = cleanText(output, 3000);
    receipt.isError = isError;
    receipt.finishedAt = this.now();
    this.store.putGoalReceipt(receipt);
  }
  summary(rootId = this.store.mission()?.id) {
    const nodes = rootId ? this.store.goals(rootId) : [],
      relevant = nodes.filter((n) => !excluded(n));
    const level = (depth: number) => {
      const at = relevant.filter((n) => n.depth === depth);
      return {
        total: at.length,
        completed: at.filter((n) => n.state === "accepted" && n.acceptanceId)
          .length,
        excluded: nodes.filter((n) => n.depth === depth && excluded(n)).length,
      };
    };
    const parents = new Set(relevant.map((n) => n.parentId).filter(Boolean));
    const leaves = relevant.filter(
      (n) => !parents.has(n.id) && n.state !== "accepted",
    );
    const effort = leaves.filter((n) => n.estimateMs);
    const focusedId = rootId
      ? this.store.get<string>(`goalFocus:${rootId}`)
      : undefined;
    const focused = nodes.find((n) => n.id === focusedId);
    const byId = new Map(nodes.map((n) => [n.id, n]));
    const ready = (goal: GoalNode) => {
      for (
        let node: GoalNode | undefined = goal;
        node;
        node = node.parentId ? byId.get(node.parentId) : undefined
      )
        if (
          excluded(node) ||
          node.state === "blocked" ||
          node.dependsOn.some((id) => {
            const dep = byId.get(id);
            return dep?.state !== "accepted" || !dep.acceptanceId;
          })
        )
          return false;
      return true;
    };
    return {
      rootId,
      maxDepth: this.maxDepth(),
      level2: level(2),
      level3: level(3),
      focus: focused
        ? {
            id: focused.id,
            objective: cleanText(focused.objective, 300),
            revision: focused.revision,
            state: focused.state,
            nextStep: focused.nextStep
              ? cleanText(focused.nextStep, 300)
              : undefined,
          }
        : undefined,
      remainingEffortMs: [
        effort.reduce((sum, n) => sum + n.estimateMs![0], 0),
        effort.reduce((sum, n) => sum + n.estimateMs![1], 0),
      ],
      unestimated: leaves.length - effort.length,
      ready: leaves
        .filter(ready)
        .slice(0, 10)
        .map((n) => ({
          id: n.id,
          objective: cleanText(n.objective, 200),
          revision: n.revision,
        })),
    };
  }
  snapshot(rootId?: string) {
    const nodes = this.store.goals(rootId);
    return {
      activeRootId: this.store.mission()?.id,
      maxDepth: this.maxDepth(),
      summary: this.summary(rootId),
      roots: this.store
        .goals()
        .filter((n) => n.depth === 1)
        .map((n) => ({
          ...n,
          selected: n.id === this.store.mission()?.id,
          runtimeStatus:
            n.id === this.store.mission()?.id
              ? this.store.savedMission(n.id)?.status
              : "inactive",
        })),
      nodes,
    };
  }
  detail(id: string) {
    const goal = this.node(id);
    return {
      goal,
      blockers: this.blockers(id),
      acceptance: goal.acceptanceId
        ? this.store.acceptance(goal.acceptanceId)
        : undefined,
      history: this.store.acceptances(id),
      receipts: this.store.goalReceipts(id),
      tasks: this.store
        .missionTasks(goal.rootId)
        .filter((t) => t.goalId === id || (!t.goalId && t.missionId === id)),
    };
  }
  export(destination: string, rootId?: string) {
    if (rootId && this.node(rootId).parentId)
      throw new Error("Export a main goal or omit rootId to export all goals");
    const target = path.resolve(this.cwd, destination);
    const value = this.store.transaction(() => {
      const snapshot = this.snapshot(rootId);
      return {
        format: "pi-mission-goals",
        version: 1,
        exportedAt: this.now(),
        ...snapshot,
        missions: snapshot.roots
          .filter((n) => !rootId || n.id === rootId)
          .map((n) => this.store.savedMission(n.id)),
        records: snapshot.nodes.map((n) => this.detail(n.id)),
      };
    });
    const fd = fs.openSync(target, "wx", 0o600);
    try {
      fs.writeFileSync(fd, JSON.stringify(value, null, 2));
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    return {
      destination: target,
      goals: value.nodes.length,
      artifactMode: "references; source artifacts are not embedded",
    };
  }
}
