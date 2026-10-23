import fs from "node:fs";
import path from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { Store } from "./store.ts";
import { cleanText } from "./public.ts";
import { LeadRecovery } from "./recovery.ts";
import { contextLimitError } from "./reconnect.ts";
import { MissionActivityClock } from "./activity-clock.ts";
import { GoalLedger } from "./goals.ts";
import {
  workspaceResumeInstruction,
  isWorkspacePauseReason,
  releaseWorkspaceGoalBlocks,
} from "./workspace-control.ts";
import { taskTiming, executionDeadline } from "./task-policy.ts";
import {
  resolveSettings,
  terminal,
  type Assignment,
  type Delivery,
  type Member,
  type Mission,
  type Schedule,
  type Settings,
  type Task,
  type Wake,
  type WorkerFactory,
  type WorkerHandle,
  type WorkerOutcome,
  type PublicActivity,
  type GoalDefinition,
  type GoalEvidence,
  type GoalNode,
  type TaskTiming,
} from "./types.ts";

const noProgressReason =
  "Three autonomous turns made no task or goal progress. Inspect saved results and actual blockers, then use mission_control(action=resume) with the current goal identity to continue approved work.";

interface Live {
  epoch: number;
  controller: AbortController;
  worker?: WorkerHandle;
  done: Promise<void>;
  processState?: "stopped" | "unknown";
  delivering?: boolean;
  deliveryPromise?: Promise<void>;
}
export interface KernelOptions {
  directory: string;
  sessionId: string;
  cwd: string;
  settings?: Partial<Settings>;
  workerFactory: WorkerFactory;
  isLeadIdle: () => boolean;
  wake: (wake: Wake) => void;
  onChange?: () => void;
  notify?: (message: string) => void;
  compact?: () => void;
  now?: () => number;
}
/** Owns work independently of model-controlled Goal and reminder tools. */
export class MissionKernel {
  store: Store;
  goals: GoalLedger;
  settings: Settings;
  options: KernelOptions;
  bridgeUrl = "";
  generation = 1;
  private now: () => number;
  private timer?: ReturnType<typeof setTimeout>;
  private closing = false;
  private ticking = false;
  private live = new Map<string, Live>();
  private tokens = new Map<string, { taskId: string; epoch: number }>();
  private reservation?: Wake;
  private lastHuman = "";
  private userHold = false;
  private wakeIncluded = false;
  private turnActed = false;
  private leadFailed = false;
  private leadResponded = false;
  private automaticTurn = false;
  private runtimeAborted = false;
  private leadRequests = 0;
  private recovery: LeadRecovery;
  private activityClock: MissionActivityClock;
  private leadRunning = false;
  private compactionQueued = false;
  private decisionPolicyValue: "business-only" = "business-only";
  private collected = new Set<string>();
  private previews = new Map<string, Map<string, PublicActivity>>();
  private relocating = false;
  publicActivity(memberId: string): PublicActivity[] {
    return [...(this.previews.get(memberId)?.values() ?? [])];
  }
  constructor(options: KernelOptions) {
    this.options = options;
    this.now = options.now ?? Date.now;
    this.store = new Store(options.directory);
    try {
      this.settings = resolveSettings({
        ...options.settings,
        ...(this.store.get<number>("reportIntervalMs") !== undefined
          ? { progressIntervalMs: this.store.get<number>("reportIntervalMs") }
          : {}),
      });
      this.lastHuman = this.store.get<string>("lastHuman") ?? "";
      this.userHold = Boolean(
        this.store.get("relocationHold") || this.store.get("escapeHold"),
      );
      this.recovery = new LeadRecovery(
        this.store,
        () => this.settings,
        this.now,
      );
      this.activityClock = new MissionActivityClock(this.store, this.now);
      this.goals = new GoalLedger(this.store, options.cwd, this.now);
    } catch (error) {
      this.store.close();
      throw error;
    }
  }
  start(background = true) {
    this.store.transaction(() => {
      for (const task of new Map(
        [...this.store.tasks(true), ...this.store.tasks()].map((t) => [
          t.id,
          t,
        ]),
      ).values())
        if (["running", "waiting", "interrupted"].includes(task.state)) {
          if (task.state !== "interrupted") {
            task.state = "interrupted";
            task.processState = "unknown";
            task.error =
              "Previous runtime ended. Inspect artifacts and explicitly create a new attempt; commands were not replayed.";
            task.updatedAt = this.now();
            task.epoch++;
            this.store.putTask(task);
          }
          this.delivery({
            key: `recovery:${task.id}:${task.epoch}`,
            taskId: task.id,
            from: task.member,
            to: "lead",
            kind: "recovery",
            summary: task.error ?? "Interrupted work requires reconciliation",
          });
          if (!this.store.get(`retired-session:${task.id}:${task.epoch}`)) {
            const member = this.store.member(task.memberId);
            if (member) {
              member.sessionId = randomUUID();
              member.sessionFile = undefined;
              this.store.putMember(member);
            }
            this.store.set(`retired-session:${task.id}:${task.epoch}`, true);
          }
        }
      for (const d of this.store.deliveries())
        if (d.state === "leased" || d.state === "admitted") {
          d.state = "pending";
          d.batchId = undefined;
          d.leaseUntil = undefined;
          this.store.putDelivery(d);
        }
      this.migrateRecovery();
      this.recovery.restart();
      this.restoreBudgetHold();
    });
    if (background) this.loop();
    this.changed();
  }
  private changed() {
    this.syncActivity();
    try {
      this.options.onChange?.();
    } catch (error) {
      this.options.notify?.(`Mission UI error: ${String(error)}`);
    }
  }
  private syncActivity(force = false) {
    const m = this.store.mission();
    const fault = this.recovery.current();
    let state: import("./types.ts").ActivityClock["state"] = "idle",
      reason = "No work is currently executing";
    if (m && ["complete", "stopped"].includes(m.status)) {
      state = "ended";
      reason = "Goal closed";
    } else if (this.closing) {
      state = "offline";
      reason = "Runtime stopped";
    } else if (
      this.userHold ||
      m?.humanPaused ||
      this.store.get("relocationHold")
    ) {
      state = "paused";
      reason = "User or workspace hold";
    } else if (m?.status === "attention") {
      state = "stalled";
      reason = m.reason ?? "Goal needs attention";
    } else if (m?.status === "waiting_user") {
      state = "waiting";
      reason = "Waiting for a business decision";
    } else if (
      this.leadRunning ||
      this.store.tasks(true).some((t) => t.state === "running")
    ) {
      state = "running";
      reason = "Lead or teammate is executing";
    } else if (fault) {
      state = "stalled";
      reason = `Runtime recovery: ${fault.phase}`;
    } else if (
      m?.externalWait ||
      this.store
        .tasks(true)
        .some((t) => t.state === "waiting" || t.blockedReason)
    ) {
      state = "waiting";
      reason =
        m?.externalWait?.reason ?? "Waiting for a dependency or decision";
    }
    this.activityClock.observe(
      m,
      state,
      reason,
      this.settings.maxMissionMs,
      force,
    );
  }
  private budgetReasons(m: Mission): string[] {
    const activity = this.activityClock.snapshot(m);
    return [
      ...(this.settings.maxMissionMs > 0 &&
      (activity?.cycleActiveMs ?? 0) >= this.settings.maxMissionMs
        ? ["time"]
        : []),
      ...(this.settings.maxAutonomousTurns > 0 &&
      m.turns >= this.settings.maxAutonomousTurns
        ? ["turns"]
        : []),
      ...(this.settings.maxOutputTokens > 0 &&
      m.outputTokens >= this.settings.maxOutputTokens
        ? ["output"]
        : []),
    ];
  }
  private restoreBudgetHold() {
    const m = this.store.mission();
    this.syncActivity();
    if (
      !m ||
      m.status !== "attention" ||
      m.blocker?.kind !== "budget" ||
      m.humanPaused ||
      this.userHold ||
      this.store.get("relocationHold") ||
      this.budgetReasons(m).length
    )
      return;
    m.status = "active";
    m.reason = undefined;
    m.blocker = undefined;
    m.nextContinueAt = this.now() + 1000;
    this.store.set("mission", m);
    this.store.event("budget.hold-cleared", m.id, {
      reason: "No configured limit is exhausted; usage was retained",
    });
  }
  private loop() {
    if (this.closing) return;
    this.timer = setTimeout(() => {
      void this.tick()
        .catch((error) =>
          this.options.notify?.(`Mission maintenance failed: ${String(error)}`),
        )
        .finally(() => this.loop());
    }, 1000);
    this.timer.unref?.();
  }
  onHumanInput(text: string) {
    this.lastHuman = cleanText(text, 16000);
    this.store.set("lastHuman", this.lastHuman);
    const mission = this.store.mission();
    this.store.set(
      "humanVersion",
      (this.store.get<number>("humanVersion") ?? 0) + 1,
    );
    if (!mission?.humanPaused && !this.store.get("relocationHold")) {
      this.userHold = false;
      this.store.unset("escapeHold");
    }
    if (mission?.decision)
      this.store.event("decision.human-input", mission.decision.id);
    if (this.reservation) {
      this.generation++;
      for (const d of this.store.deliveries("lead")) {
        if (
          d.batchId !== this.reservation.batchId ||
          !["leased", "admitted"].includes(d.state)
        )
          continue;
        d.state = "pending";
        d.batchId = undefined;
        this.store.putDelivery(d);
      }
      this.reservation = undefined;
    }
  }
  decisionPolicy() {
    return this.decisionPolicyValue;
  }
  setDecisionPolicy(policy: "business-only") {
    if (policy !== "business-only")
      throw new Error("Supported autonomy policy: business-only");
    if (this.store.get("decisionPolicy") === policy) return { policy };
    this.decisionPolicyValue = policy;
    this.store.set("decisionPolicy", policy);
    this.store.event(
      "mission.decision-policy",
      this.store.mission()?.id ?? this.options.sessionId,
      { policy },
    );
    this.changed();
    return { policy };
  }
  private checkBudget(m: Mission): boolean {
    if (["complete", "stopped", "paused"].includes(m.status) || m.humanPaused)
      return false;
    this.syncActivity();
    const limits = this.budgetReasons(m);
    if (!limits.length) return false;
    if (m.blocker?.kind !== "budget") {
      m.status = "attention";
      m.reason = `Configured mission budget reached (${limits.join(", ")}). Work/results are retained; /mission resume explicitly renews this budget cycle.`;
      m.blocker = { kind: "budget", reason: m.reason };
      this.store.set("mission", m);
      this.store.event("mission.blocked", m.id, { kind: "budget", limits });
      this.options.notify?.(m.reason);
    }
    return true;
  }
  private migrateRecovery() {
    const m = this.store.mission();
    if (
      m?.status === "attention" &&
      m.blocker?.kind === "no_progress" &&
      m.blocker.reason !== noProgressReason
    ) {
      const previousReason = m.blocker.reason;
      m.reason = noProgressReason;
      m.blocker.reason = noProgressReason;
      this.store.set("mission", m);
      this.store.event("recovery.guidance-updated", m.id, {
        kind: "no_progress",
        previousReason,
      });
    }
    if (!m || m.humanPaused || this.store.get("relocationHold") || m.blocker)
      return;
    if (
      m.status === "attention" &&
      m.reason?.startsWith("Automatic wake attempts failed.")
    ) {
      m.status = "active";
      m.reason = undefined;
      m.updatedAt = this.now();
      this.store.set("mission", m);
      this.store.event("recovery.legacy-migrated", m.id, {
        previous: "attention",
        cause: "delivery",
      });
      for (const d of this.store.deliveries("lead")) {
        if (
          d.missionId !== m.id ||
          d.state !== "pending" ||
          d.attempts < this.settings.maxWakeAttempts
        )
          continue;
        d.state =
          d.kind === "progress" || d.kind === "continue"
            ? "superseded"
            : "quarantined";
        d.reason =
          "Legacy failed delivery retained for inspection; delivery failure does not pause the mission.";
        this.store.putDelivery(d);
        this.store.event(`delivery.${d.state}`, d.id, {
          cause: "legacy-recovery",
        });
      }
      this.delivery({
        key: `legacy-recovery:${m.id}`,
        from: "maintenance",
        to: "lead",
        kind: "recovery",
        summary:
          "Delivery recovery restored the existing mission within its original budget. Inspect retained results and quarantined notifications before continuing approved work; do not repeat completed commands.",
      });
    } else if (m.status === "attention") {
      m.blocker = {
        kind: m.reason?.startsWith("Mission continuation budget reached.")
          ? "budget"
          : m.reason?.startsWith("Three autonomous turns")
            ? "no_progress"
            : "unknown",
        reason: m.reason ?? "Unclassified legacy hold",
      };
      if (m.blocker.kind === "no_progress")
        m.reason = m.blocker.reason = noProgressReason;
      this.store.set("mission", m);
    }
  }
  private ensureMission(input: string): Mission {
    let mission = this.store.mission();
    if (mission && !["complete", "stopped"].includes(mission.status))
      return mission;
    if (mission)
      this.store.archiveMission(
        mission,
        this.now(),
        mission.status === "complete"
          ? "replaced-by-new-objective"
          : "replaced",
      );
    const objective = cleanText(this.lastHuman || input, 8000),
      now = this.now();
    mission = {
      id: randomUUID(),
      objective,
      criteria: [objective],
      status: "active",
      createdAt: now,
      updatedAt: now,
      budgetStartedAt: now,
      turns: 0,
      outputTokens: 0,
      emptyTurns: 0,
      lastReportAt: now,
      nextContinueAt: now + 1500,
      humanPaused: false,
    };
    this.store.set("mission", mission);
    this.goals.enroll(mission);
    this.store.event("mission.created", mission.id, { automatic: true });
    return mission;
  }
  private cleanTemporaryMembers(reason: string) {
    for (const member of this.store.members()) {
      if (!member.temporary) continue;
      const tasks = this.store.memberTasks(member.id);
      if (
        tasks.some((task) => !terminal(task) || task.processState === "unknown")
      )
        continue;
      this.store.archive("member", member, this.now(), reason);
      this.store.removeMember(member.id);
      this.previews.delete(member.id);
      this.store.event("member.archived", member.id, { reason });
    }
  }
  private archiveMission(
    mission: Mission,
    reason: string,
    retainClosed = false,
  ) {
    mission.updatedAt = this.now();
    // Close the activity interval while the owning mission still exists.
    this.activityClock.observe(
      mission,
      "ended",
      mission.reason ?? `Goal ${reason}`,
      this.settings.maxMissionMs,
      true,
    );
    const archived = this.store.archiveMission(mission, this.now(), reason);
    if (retainClosed) this.store.set("mission", archived);
    this.cleanTemporaryMembers(reason);
    this.userHold = false;
    this.store.unset("escapeHold");
    this.changed();
    return archived;
  }
  setGoal(objective: string, criteria: string[] = []) {
    return this.store.transaction(() => {
      if (this.store.get("relocationHold"))
        throw new Error(workspaceResumeInstruction);
      if (!objective.trim()) throw new Error("Goal objective is required");
      const previous = this.store.mission();
      if (previous && !["complete", "stopped"].includes(previous.status))
        return this.updateGoal(objective, criteria, previous.id);
      let m = this.ensureMission(objective);
      if (m.humanPaused || m.status === "stopped")
        throw new Error(
          "The user paused this mission. Only /mission resume can restore execution.",
        );
      m.objective = cleanText(objective, 8000);
      m.criteria = (criteria.length ? criteria : [objective])
        .slice(0, 30)
        .map((x) => cleanText(x, 2000));
      m.updatedAt = this.now();
      this.store.set("mission", m);
      this.syncGoalDefinition(m);
      this.turnActed = true;
      this.changed();
      return m;
    });
  }
  updateGoal(
    objective: string,
    criteria: string[] = [],
    goalId?: string,
    revision?: number,
  ): Mission | GoalNode {
    return this.store.transaction(() => {
      if (!objective.trim()) throw new Error("Goal objective is required");
      if (goalId && this.store.goal(goalId)?.parentId) {
        if (revision === undefined)
          throw new Error("Use goal_edit with an exact revision for a subgoal");
        return this.editGoal(
          goalId,
          { objective, criteria: criteria.length ? criteria : [objective] },
          revision,
        );
      }
      const m = this.store.mission();
      if (!m || ["complete", "stopped"].includes(m.status))
        throw new Error("No unfinished goal to update");
      if (goalId && goalId !== m.id) throw new Error("Goal identity changed");
      if (revision !== undefined && revision !== (m.revision ?? 0))
        throw new Error("Goal revision changed");
      m.objective = cleanText(objective, 8000);
      m.criteria = (criteria.length ? criteria : [objective])
        .slice(0, 30)
        .map((x) => cleanText(x, 2000));
      m.revision = (m.revision ?? 0) + 1;
      if (m.decision) {
        const old = m.decision.id;
        m.decision = {
          ...m.decision,
          id: randomUUID(),
          revision: m.revision,
          humanVersion: this.store.get<number>("humanVersion") ?? 0,
        };
        for (const id of m.decision.taskIds) {
          const task = this.store.task(id);
          if (task?.blockedReason === `decision:${old}`) {
            task.blockedReason = `decision:${m.decision.id}`;
            this.store.putTask(task);
          }
        }
        this.store.event("decision.revised", old, {
          decisionId: m.decision.id,
          revision: m.revision,
        });
      }
      if (m.externalWait) {
        const old = m.externalWait.id;
        m.externalWait = {
          ...m.externalWait,
          id: randomUUID(),
          token: randomUUID(),
          revision: m.revision,
        };
        this.store.event("wait.revised", old, {
          waitId: m.externalWait.id,
          revision: m.revision,
        });
      }
      m.evidence = undefined;
      m.nextContinueAt = this.now() + 1000;
      m.updatedAt = this.now();
      // Editing an objective neither grants execution authority nor renews a budget.
      this.store.set("mission", m);
      this.syncGoalDefinition(m);
      this.store.event("mission.updated", m.id, { revision: m.revision });
      this.recovery.revise(m.revision);
      this.turnActed = true;
      this.changed();
      return m;
    });
  }
  private syncGoalDefinition(m: Mission) {
    const node = this.goals.enroll(m);
    node.objective = m.objective;
    node.criteria = m.criteria;
    node.revision = m.revision ?? 0;
    node.acceptanceId = undefined;
    node.state = "planned";
    delete node.workspaceBlock;
    node.updatedAt = this.now();
    this.store.putGoal(node);
  }
  planGoals(definitions: GoalDefinition[]) {
    return this.store.transaction(() => {
      const created = this.goals.plan(definitions);
      // Planning may coexist with a held mission; it never releases that hold.
      if (
        !this.store.mission() &&
        !this.userHold &&
        !this.store.get("relocationHold")
      ) {
        const root = created.find((node) => !node.parentId);
        if (root) this.activateGoal(root.id);
      }
      this.turnActed = true;
      this.changed();
      return created;
    });
  }
  activateGoal(id: string) {
    const root = this.goals.node(id);
    if (root.parentId)
      throw new Error(
        "Activate a main goal, then use goal_focus for its leaves",
      );
    const current = this.store.mission();
    if (current?.id === id) return current;
    if (
      this.userHold ||
      this.store.get("relocationHold") ||
      current?.humanPaused ||
      (current && !["active", "complete"].includes(current.status)) ||
      this.recovery.current()
    )
      throw new Error(
        "Resolve current user, workspace, decision, budget or recovery holds before switching main goals",
      );
    if (
      this.store.tasks(true).length ||
      this.live.size ||
      this.store.unknownProcesses().total
    )
      throw new Error(
        "Settle running work and unknown processes before switching main goals",
      );
    if (
      current &&
      this.store
        .deliveries("lead")
        .some(
          (d) =>
            d.missionId === current.id &&
            ["result", "failure", "decision", "recovery"].includes(d.kind) &&
            ["pending", "leased", "admitted", "quarantined"].includes(d.state),
        )
    )
      throw new Error("Observe retained results before switching main goals");
    if (["accepted", "cancelled", "skipped"].includes(root.state))
      throw new Error("Reopen the main goal before activation");
    const target = this.store.savedMission(id) ?? this.goals.newMission(root);
    if (target.status === "stopped")
      throw new Error(
        "Stopped goals retain their stop; create a new main goal",
      );
    this.syncActivity(true);
    this.store.transaction(() => {
      if (current) this.store.putMission(current);
      for (const d of this.store.deliveries("lead"))
        if (
          d.missionId === current?.id &&
          ["continue", "progress"].includes(d.kind) &&
          d.state !== "observed"
        ) {
          d.state = "superseded";
          d.reason = "Main goal deactivated; progress retained in goal ledger";
          this.store.putDelivery(d);
        }
      this.generation++;
      this.reservation = undefined;
      // No budget timestamps, usage or hold flags are reset by selection.
      this.store.set("mission", target);
      this.store.event("goal.activated", id, { previousRootId: current?.id });
    });
    this.turnActed = true;
    this.changed();
    return target;
  }
  editGoal(
    id: string,
    patch: Parameters<GoalLedger["edit"]>[1] & { blockedBy?: "workspace" },
    revision?: number,
    allowExclusion = false,
  ): Mission | GoalNode {
    return this.store.transaction(() => {
      const node = this.goals.node(id);
      const { blockedBy, ...goalPatch } = patch;
      const workspaceBlock =
        blockedBy === "workspace" ||
        (this.store.get("relocationHold") &&
          patch.state === "blocked" &&
          isWorkspacePauseReason(patch.reason));
      const relocation = this.store.get<{ id: string; sessionId: string }>(
        "relocation",
      );
      if (workspaceBlock) {
        if (
          !this.store.get("relocationHold") ||
          relocation?.sessionId !== this.options.sessionId ||
          patch.state !== "blocked" ||
          patch.objective !== undefined ||
          patch.criteria !== undefined ||
          patch.scope !== undefined ||
          patch.dependsOn !== undefined
        )
          throw new Error(
            "A workspace blocker requires this session's active relocation hold and a state-only goal update",
          );
        if (
          !["planned", "active", "review"].includes(node.state) &&
          !(
            node.state === "blocked" &&
            node.workspaceBlock?.relocationId === relocation.id
          )
        )
          throw new Error(
            "Preserve the existing business blocker; a workspace pause cannot replace it",
          );
      }
      if (
        !node.parentId &&
        (patch.objective !== undefined || patch.criteria !== undefined) &&
        id === this.store.mission()?.id &&
        !["complete", "stopped"].includes(this.store.mission()!.status)
      ) {
        if (patch.dependsOn !== undefined || patch.state !== undefined)
          throw new Error("Update root definition separately from its state");
        if (revision !== undefined && revision !== node.revision)
          throw new Error("Goal revision changed");
        const updated = this.updateGoal(
          patch.objective ?? node.objective,
          patch.criteria ?? node.criteria,
          id,
        );
        const { objective, criteria, ...metadata } = patch;
        if (Object.keys(metadata).length)
          this.goals.edit(id, metadata, this.goals.node(id).revision);
        return updated;
      }
      const result = this.goals.edit(id, goalPatch, revision, allowExclusion);
      if (workspaceBlock) {
        result.workspaceBlock = {
          ...(node.workspaceBlock ?? {
            previousState: node.state as "planned" | "active" | "review",
            previousReason: node.reason,
            previousNextStep: node.nextStep,
          }),
          relocationId: relocation!.id,
          revision: result.revision,
          reason: result.reason,
        };
        this.store.putGoal(result);
      } else if (
        result.workspaceBlock &&
        (patch.state !== undefined ||
          patch.reason !== undefined ||
          result.revision !== node.revision)
      ) {
        delete result.workspaceBlock;
        this.store.putGoal(result);
      }
      const root = this.goals.node(result.rootId),
        saved = this.store.savedMission(root.id);
      if (saved) {
        saved.objective = root.objective;
        saved.criteria = root.criteria;
        saved.revision = root.revision;
        if (root.state !== "accepted" && saved.status === "complete") {
          saved.status = "active";
          saved.evidence = undefined;
          saved.archivedAt = undefined;
          saved.archiveReason = undefined;
        }
        if (this.store.mission()?.id === root.id)
          this.store.set("mission", saved);
        else this.store.putMission(saved);
      }
      this.turnActed = true;
      this.changed();
      return result;
    });
  }
  focusGoal(id: string, revision?: number) {
    const mission = this.store.mission();
    if (
      !mission ||
      mission.status !== "active" ||
      mission.humanPaused ||
      this.userHold ||
      this.store.get("relocationHold")
    )
      throw new Error("Resolve mission holds before focusing work");
    const node = this.goals.focus(id, revision);
    this.turnActed = true;
    this.changed();
    return node;
  }
  acceptGoal(id: string, evidence: GoalEvidence[], revision: number) {
    return this.store.transaction(() => {
      const node = this.goals.node(id);
      if (node.revision !== revision) throw new Error("Goal revision changed");
      if (node.state === "accepted" && node.acceptanceId)
        return this.store.acceptance(node.acceptanceId)!;
      if (!node.parentId) {
        this.complete(
          evidence.map((e) => ({
            criterion: e.criterion,
            evidence: e.summary,
          })),
          evidence,
          revision,
          id,
        );
        return this.store.acceptance(this.goals.node(id).acceptanceId!)!;
      }
      if (this.userHold || this.store.get("relocationHold"))
        throw new Error("Resolve user or workspace holds before acceptance");
      const record = this.goals.accept(id, evidence, revision);
      this.turnActed = true;
      this.changed();
      return record;
    });
  }
  async stopGoal(goalId?: string, reason = "Stopped by the lead") {
    const m = this.store.mission();
    if (!m || ["complete", "stopped"].includes(m.status))
      throw new Error("No unfinished goal to stop");
    if (goalId && goalId !== m.id) throw new Error("Goal identity changed");
    m.status = "stopped";
    m.humanPaused = true;
    m.reason = cleanText(reason, 2000);
    m.updatedAt = this.now();
    const goal = this.store.goal(m.id);
    if (goal) {
      goal.state = "cancelled";
      goal.reason = m.reason;
      goal.updatedAt = m.updatedAt;
      this.store.putGoal(goal);
    }
    this.generation++;
    this.userHold = true;
    this.reservation = undefined;
    // Stop intent takes effect before asynchronous process cancellation; its
    // waiting interval is not productive execution and unknown receipts remain.
    this.store.set("mission", m);
    this.syncActivity(true);
    const roots = this.store
      .tasks(true)
      .filter((task) => !task.parentId && task.missionId === m.id);
    await Promise.all(roots.map((task) => this.cancelTask(task.id, m.reason)));
    for (const delivery of this.store.deliveries("lead"))
      if (delivery.missionId === m.id && delivery.state !== "observed") {
        delivery.state = "cancelled";
        this.store.putDelivery(delivery);
      }
    const archived = this.archiveMission(m, "stopped");
    this.turnActed = true;
    return archived;
  }
  complete(
    evidence: Array<{ criterion: number; evidence: string }>,
    structured?: GoalEvidence[],
    revision?: number,
    expectedGoalId?: string,
  ) {
    return this.store.transaction(() => {
      const m = this.store.mission();
      if (expectedGoalId !== undefined && m?.id !== expectedGoalId)
        throw new Error(
          "Goal identity changed; only the selected main goal can be completed",
        );
      if (!m || m.status !== "active")
        throw new Error("No active mission to complete");
      if (revision !== undefined && (m.revision ?? 0) !== revision)
        throw new Error("Goal revision changed");
      if (this.userHold || m.humanPaused || this.store.get("relocationHold"))
        throw new Error("Resolve user or workspace holds before completion");
      if (this.goals.children(m.id).length && revision === undefined)
        throw new Error(
          "Use goal_accept or supply the exact main-goal revision when completing a planned goal tree",
        );
      if (this.store.tasks(true).length || this.live.size)
        throw new Error(
          "Work is still running, queued, waiting or being stopped. Collect results before completion.",
        );
      if (
        this.store
          .missionTasks(m.id)
          .some((task) => task.processState === "unknown")
      )
        throw new Error(
          "A completed task still has unknown process state. Reconcile it before accepting completion.",
        );
      if (
        this.store
          .deliveries("lead")
          .some(
            (d) =>
              d.missionId === m.id &&
              ["result", "failure", "recovery", "decision"].includes(d.kind) &&
              ["pending", "leased", "quarantined"].includes(d.state),
          )
      )
        throw new Error(
          "Undelivered task results remain. Read the runtime updates before accepting completion.",
        );
      if (
        m.criteria.some(
          (_, i) =>
            !evidence.some(
              (e) => e.criterion === i + 1 && e.evidence.trim().length >= 8,
            ),
        )
      )
        throw new Error(
          "Verified evidence is required for every acceptance criterion.",
        );
      const root = this.goals.node(m.id);
      this.goals.accept(
        m.id,
        structured ??
          evidence.map((e) => ({
            criterion: e.criterion,
            source: "statement",
            summary: e.evidence,
          })),
        revision ?? root.revision,
      );
      m.status = "complete";
      m.evidence = evidence.map((e) => ({
        criterion: e.criterion,
        evidence: cleanText(e.evidence, 2000),
      }));
      m.updatedAt = this.now();
      this.store.event("mission.completed", m.id);
      const archived = this.archiveMission(m, "completed", true);
      this.turnActed = true;
      return archived;
    });
  }
  addMember(input: Omit<Member, "id" | "sessionId" | "createdAt">) {
    if (this.store.members().length >= 100)
      throw new Error(
        "Member identity limit reached (100). Reuse existing members instead of creating an unbounded team.",
      );
    if (
      !/^[a-z][a-z0-9-]{0,47}$/.test(input.name) ||
      ["lead", "all"].includes(input.name)
    )
      throw new Error(
        "Member name must be unique lowercase letters, digits or hyphens",
      );
    if (this.store.member(input.name))
      throw new Error(
        `Member ${input.name} already exists; use its existing identity`,
      );
    const member: Member = {
      ...input,
      id: randomUUID(),
      sessionId: randomUUID(),
      createdAt: this.now(),
      revision: 1,
    };
    this.store.putMember(member);
    this.turnActed = true;
    this.changed();
    return member;
  }
  configureMember(
    name: string,
    patch: Partial<
      Pick<
        Member,
        "model" | "thinkingLevel" | "allow" | "role" | "workspace" | "tools"
      >
    >,
  ) {
    const m = this.store.member(name);
    if (!m) throw new Error("Unknown member");
    if (this.store.tasks(true).some((t) => t.memberId === m.id))
      throw new Error(
        "Finish or cancel member work before changing its capabilities",
      );
    Object.assign(m, patch);
    m.revision = (m.revision ?? 0) + 1;
    this.store.putMember(m);
    this.turnActed = true;
    this.changed();
    return m;
  }
  async disbandMember(name: string, reason = "Disbanded by the lead") {
    if (name === "lead" || name === "all")
      throw new Error("The lead identity cannot be disbanded");
    const members =
      name === "*"
        ? this.store.members().filter((member) => !member.temporary)
        : [this.store.member(name)].filter((member): member is Member =>
            Boolean(member),
          );
    if (!members.length) throw new Error("Unknown member");
    const removed: string[] = [];
    for (const member of members) {
      const active = this.store
        .tasks(true)
        .filter((task) => task.memberId === member.id);
      await Promise.all(active.map((task) => this.cancelTask(task.id, reason)));
      if (
        this.store
          .memberTasks(member.id)
          .some((task) => task.processState === "unknown")
      )
        throw new Error(
          `Member ${member.name} has unknown process state; reconcile its task before archiving the identity`,
        );
      for (const delivery of this.store.deliveries())
        if (
          (delivery.from === member.name || delivery.to === member.name) &&
          delivery.state !== "observed"
        ) {
          delivery.state = "cancelled";
          this.store.putDelivery(delivery);
        }
      this.store.archive("member", member, this.now(), reason);
      this.store.removeMember(member.id);
      this.previews.delete(member.id);
      this.store.event("member.archived", member.id, { reason });
      removed.push(member.name);
    }
    this.turnActed = true;
    this.changed();
    return { removed };
  }
  dispatch(
    name: string,
    message: string,
    options: {
      parentId?: string;
      attemptOf?: string;
      dependsOn?: string;
      timeoutMs?: number;
      timeoutPolicy?: TaskTiming["timeoutPolicy"];
      queueTimeoutMs?: number;
      goalId?: string;
    } = {},
  ): Task {
    if (this.relocating)
      throw new Error("Workspace relocation is in progress; new work is held");
    const member = this.store.member(name);
    if (!member) throw new Error(`Unknown member: ${name}`);
    if (this.store.hasUnknownProcess(member.id))
      throw new Error(
        "A previous execution has unknown process state. Inspect artifacts and host processes, then call mission_reconcile with exact task epochs and stopped-process evidence (or /mission reconcile <taskId>) before a new attempt.",
      );
    if (this.store.tasks(true).length >= 512)
      throw new Error(
        "Active task limit reached (512). Finish or cancel existing work before dispatching more.",
      );
    if (!message.trim() || Buffer.byteLength(message) > 200_000)
      throw new Error("Task input must contain 1 to 200000 bytes");
    const parent = options.parentId
      ? this.store.task(options.parentId)
      : undefined;
    if (options.parentId && (!parent || terminal(parent)))
      throw new Error("Parent task is no longer active");
    for (
      let t = parent;
      t;
      t = t.parentId ? this.store.task(t.parentId) : undefined
    )
      if (t.memberId === member.id)
        throw new Error(
          "Task cycle denied. Send a note to an ancestor instead of assigning it work.",
        );
    const assignedGoalId = options.goalId ?? parent?.goalId;
    if (assignedGoalId) {
      const node = this.goals.node(assignedGoalId),
        selected = this.store.mission();
      if (
        !selected ||
        node.rootId !== selected.id ||
        ["complete", "stopped"].includes(selected.status)
      )
        throw new Error(
          "Activate the assigned main goal and reopen closed work before creating a task",
        );
    }
    const mission = this.ensureMission(message);
    this.checkBudget(mission);
    if (mission.humanPaused || mission.status !== "active")
      throw new Error(
        `Mission ${mission.status}: ${mission.reason ?? "resume through /mission resume"}`,
      );
    const goal = this.goals.assignment(
      mission.id,
      options.goalId ?? parent?.goalId,
    );
    const timing = taskTiming(options, this.settings.taskTimeoutMs);
    const id = randomUUID(),
      now = this.now();
    const t: Task = {
      id,
      missionId: mission.id,
      goalId: goal.id,
      goalRevision: goal.revision,
      memberId: member.id,
      member: member.name,
      parentId: parent?.id,
      rootId: parent?.rootId ?? id,
      attemptOf: options.attemptOf,
      dependsOn: options.dependsOn,
      state: "queued",
      epoch: 0,
      phase: "work",
      inputPath: this.store.artifact(id, "input", message),
      createdAt: now,
      updatedAt: now,
      ...timing,
      executionMs: 0,
      processState: "not-started",
      reviewDeliveryIds: [],
    };
    this.store.putTask(t);
    this.store.event("task.accepted", id, { member: name, parent: parent?.id });
    this.turnActed = true;
    this.changed();
    queueMicrotask(() => {
      if (!this.closing)
        void this.tick().catch((e) => this.options.notify?.(String(e)));
    });
    return t;
  }
  resumeTask(id: string) {
    const old = this.store.task(id);
    if (!old || (!terminal(old) && !old.blockedReason))
      throw new Error(
        "Only a terminal/interrupted/blocked task can be explicitly retried after reviewing its evidence",
      );
    if (old.blockedReason) {
      old.state = "cancelled";
      old.epoch++;
      this.store.putTask(old);
    }
    return this.dispatch(
      old.member,
      this.store.readArtifact(old.inputPath, 200_000),
      {
        attemptOf: old.id,
        timeoutMs: old.timeoutMs,
        timeoutPolicy: old.timeoutPolicy,
        queueTimeoutMs: old.queueTimeoutMs,
        goalId: old.goalId,
      },
    );
  }
  async cancelTask(id: string, reason = "Cancelled by coordinator") {
    const task = this.store.task(id);
    if (!task) throw new Error("Unknown task");
    const ids = new Set<string>();
    const visit = (t: Task) => {
      ids.add(t.id);
      for (const c of this.store.children(t.id)) visit(c);
    };
    visit(task);
    this.store.transaction(() => {
      for (const taskId of ids) {
        const t = this.store.task(taskId)!;
        if (!terminal(t)) {
          t.state = "cancelled";
          t.error = reason;
          t.updatedAt = this.now();
          t.finishedAt = this.now();
          t.epoch++;
          t.processState = this.live.has(t.id) ? "unknown" : "stopped";
          this.store.putTask(t);
        }
      }
      for (const d of this.store.deliveries())
        if (d.taskId && ids.has(d.taskId) && d.state !== "observed") {
          d.state = "cancelled";
          this.store.putDelivery(d);
        }
    });
    await Promise.allSettled(
      [...ids].map(async (taskId) => {
        const live = this.live.get(taskId);
        if (live) {
          live.controller.abort();
          await live.worker?.stop();
          await live.done;
        }
        const t = this.store.task(taskId);
        if (
          t &&
          t.state === "cancelled" &&
          (live || t.processState !== "unknown")
        ) {
          t.processState = live?.processState ?? (live ? "unknown" : "stopped");
          this.store.putTask(t);
        }
      }),
    );
    if (
      reason !== "User stopped the mission" &&
      (!task.parentId || !terminal(this.store.task(task.parentId)!))
    )
      this.delivery({
        key: `cancel:${id}`,
        taskId: id,
        from: task.member,
        to: task.parentId ? this.store.task(task.parentId)!.member : "lead",
        kind: "failure",
        summary: reason,
      });
    this.turnActed = true;
    this.changed();
  }
  /** User-facing member message: steer a live worker, or start a new tracked turn when idle. */
  async messageMember(name: string, message: string) {
    const member = this.store.member(name);
    if (!member) throw new Error(`Unknown member: ${name}`);
    if (!message.trim() || Buffer.byteLength(message) > 16000)
      throw new Error("Member message must contain 1 to 16000 bytes");
    const liveTask = this.store
      .tasks(true)
      .find((task) => task.memberId === member.id && task.state === "running");
    if (liveTask) {
      const live = this.live.get(liveTask.id);
      if (live?.worker?.deliver) {
        await live.worker.deliver(message);
        this.store.event("user.member-steer", liveTask.id, {
          member: name,
          bytes: Buffer.byteLength(message),
        });
        this.changed();
        return { mode: "steer" as const, taskId: liveTask.id };
      }
      throw new Error(
        "This member is settling; wait for its current turn to finish",
      );
    }
    const task = this.dispatch(name, message);
    return { mode: "new-turn" as const, taskId: task.id };
  }
  delivery(
    input: Pick<Delivery, "key" | "from" | "to" | "kind" | "summary"> &
      Partial<
        Pick<
          Delivery,
          "taskId" | "artifact" | "scheduleId" | "scheduleRevision"
        >
      >,
  ): Delivery {
    if (input.kind === "progress" && input.from !== "maintenance") {
      input = {
        ...input,
        key: `progress:${input.from}:${input.to}:${input.taskId ?? "none"}:${this.store.mission()?.lastReportAt ?? 0}`,
      };
      const old = this.store
        .deliveries(input.to)
        .find((d) => d.key === input.key && d.state === "pending");
      if (old) {
        old.summary = cleanText(input.summary, 2000);
        return this.store.putDelivery(old);
      }
    }
    if (
      input.to === "lead" &&
      ((input.kind === "progress" && input.from === "maintenance") ||
        (input.kind === "reminder" && input.scheduleId))
    ) {
      for (const old of this.store.deliveries("lead")) {
        if (
          old.key === input.key ||
          old.state !== "pending" ||
          old.kind !== input.kind ||
          old.from !== input.from ||
          (input.kind === "reminder" && old.scheduleId !== input.scheduleId) ||
          (input.kind === "progress" &&
            old.missionId !== this.store.mission()?.id)
        )
          continue;
        old.state = "superseded";
        old.reason =
          "Replaced by a newer occurrence; no model consumption is claimed.";
        this.store.putDelivery(old);
        this.store.event("delivery.superseded", old.id);
      }
    }
    return this.store.putDelivery({
      ...input,
      missionId:
        input.kind === "reminder"
          ? undefined
          : input.taskId
            ? this.store.task(input.taskId)?.missionId
            : this.store.mission()?.id,
      scheduleId: input.scheduleId,
      scheduleRevision: input.scheduleRevision,
      summary: cleanText(input.summary, 2000),
      id: randomUUID(),
      state: "pending",
      createdAt: this.now(),
      attempts: 0,
      nextAttemptAt: this.now(),
    });
  }
  addSchedule(
    title: string,
    prompt: string,
    nextAt: number,
    intervalMs?: number,
  ) {
    if (
      this.store.schedules().filter((s) => s.state === "active").length >= 100
    )
      throw new Error("Active reminder limit reached (100)");
    if (
      !title.trim() ||
      !prompt.trim() ||
      prompt.length > 8000 ||
      !Number.isSafeInteger(nextAt) ||
      nextAt <= this.now()
    )
      throw new Error("Reminder needs a title, prompt and future time");
    if (
      intervalMs !== undefined &&
      (!Number.isSafeInteger(intervalMs) ||
        intervalMs < 1000 ||
        intervalMs > 604_800_000)
    )
      throw new Error("Invalid recurrence interval");
    const s: Schedule = {
      id: randomUUID(),
      title: cleanText(title, 120),
      prompt: cleanText(prompt, 8000),
      nextAt,
      intervalMs,
      state: "active",
      createdAt: this.now(),
      updatedAt: this.now(),
      revision: 1,
      missionId: this.store.mission()?.id,
    };
    this.store.putSchedule(s);
    this.turnActed = true;
    this.changed();
    return s;
  }
  deleteSchedule(id: string) {
    const s = this.store.schedule(id);
    if (!s) throw new Error("Unknown reminder");
    s.state = "ended";
    s.updatedAt = this.now();
    s.archiveReason = "deleted";
    s.revision = (s.revision ?? 0) + 1;
    this.store.putSchedule(s);
    for (const delivery of this.store.deliveries("lead"))
      if (delivery.scheduleId === id && delivery.state !== "observed") {
        delivery.state = "cancelled";
        this.store.putDelivery(delivery);
      }
    this.turnActed = true;
    this.changed();
  }
  updateSchedule(
    id: string,
    patch: {
      title?: string;
      prompt?: string;
      nextAt?: number;
      intervalMs?: number;
      state?: "active" | "paused";
    },
  ) {
    const s = this.store.schedule(id);
    if (!s || s.state === "ended") throw new Error("Unknown active reminder");
    if (patch.title !== undefined) {
      if (!patch.title.trim()) throw new Error("Reminder title is required");
      s.title = cleanText(patch.title, 120);
    }
    if (patch.prompt !== undefined) {
      if (!patch.prompt.trim()) throw new Error("Reminder prompt is required");
      s.prompt = cleanText(patch.prompt, 8000);
    }
    if (patch.nextAt !== undefined) {
      if (!Number.isSafeInteger(patch.nextAt) || patch.nextAt <= this.now())
        throw new Error("Reminder time must be in the future");
      s.nextAt = patch.nextAt;
    }
    if (
      patch.intervalMs !== undefined &&
      (!Number.isSafeInteger(patch.intervalMs) ||
        patch.intervalMs < 1000 ||
        patch.intervalMs > 604_800_000)
    )
      throw new Error("Invalid recurrence interval");
    if (patch.intervalMs !== undefined) s.intervalMs = patch.intervalMs;
    if (patch.state) s.state = patch.state;
    s.revision = (s.revision ?? 0) + 1;
    s.updatedAt = this.now();
    this.store.putSchedule(s);
    for (const delivery of this.store.deliveries("lead"))
      if (
        delivery.scheduleId === id &&
        ["pending", "quarantined"].includes(delivery.state)
      ) {
        delivery.state = "cancelled";
        this.store.putDelivery(delivery);
      }
    this.turnActed = true;
    this.changed();
    return s;
  }
  lifecycleHistory(limit = 100) {
    return {
      goals: this.store.archives<Mission>("goal", limit),
      members: this.store.archives<Member>("member", limit),
      schedules: this.store.archives<Schedule>("schedule", limit),
      counts: this.store.archiveCounts(),
    };
  }
  setReportInterval(ms: number) {
    this.settings = resolveSettings({
      ...this.settings,
      progressIntervalMs: ms,
    });
    this.store.set("reportIntervalMs", ms);
    const m = this.store.mission();
    if (m) {
      m.lastReportAt = this.now();
      this.store.set("mission", m);
    }
    this.changed();
  }
  async userControl(action: "pause" | "resume" | "stop") {
    const m = this.store.mission();
    if (action === "resume" && this.store.get("relocationHold")) {
      const relocation = this.store.get<{ id: string; sessionId: string }>(
        "relocation",
      );
      if (relocation?.sessionId === this.options.sessionId)
        this.store.transaction(() =>
          releaseWorkspaceGoalBlocks(this.store, relocation.id, this.now()),
        );
    }
    if (!m) {
      if (action === "resume" && this.store.get("relocationHold")) {
        this.store.set("relocationHold", false);
        this.userHold = false;
        this.relocating = false;
        this.store.unset("escapeHold");
        this.recovery.succeeded();
        this.store.event("user.workspace-resumed", this.options.sessionId);
        this.changed();
        await this.tick();
        return;
      }
      throw new Error("No mission");
    }
    if (
      action === "resume" &&
      this.store.get("relocationHold") &&
      ["complete", "stopped"].includes(m.status)
    ) {
      // Confirm the recovered workspace without reopening an accepted/stopped
      // goal or resetting its usage and acceptance receipts.
      this.store.set("relocationHold", false);
      this.store.unset("escapeHold");
      this.userHold = false;
      this.relocating = false;
      this.recovery.succeeded();
      this.store.event("user.workspace-resumed", m.id, {
        retainedStatus: m.status,
      });
      this.changed();
      await this.tick();
      return;
    }
    if (action === "resume" && m.status === "complete")
      throw new Error(
        "This mission is complete. Start a new objective instead of replaying it.",
      );
    this.generation++;
    this.userHold = action !== "resume";
    this.reservation = undefined;
    for (const d of this.store.deliveries("lead"))
      if (d.state === "leased" || d.state === "admitted") {
        d.state = "pending";
        d.batchId = undefined;
        this.store.putDelivery(d);
      }
    m.humanPaused = action !== "resume";
    m.status =
      action === "resume" ? "active" : action === "stop" ? "stopped" : "paused";
    m.reason = action === "resume" ? undefined : `User ${action}`;
    m.updatedAt = this.now();
    if (action === "resume") {
      this.store.set("relocationHold", false);
      this.relocating = false;
      this.store.unset("escapeHold");
      this.recovery.succeeded();
      m.blocker = undefined;
      if (m.decision) {
        for (const id of m.decision.taskIds) {
          const task = this.store.task(id);
          if (task?.blockedReason === `decision:${m.decision.id}`) {
            task.blockedReason = undefined;
            this.store.putTask(task);
          }
        }
        this.store.event("decision.user-resumed", m.decision.id);
        m.decision = undefined;
      }
      for (const delivery of this.store.deliveries("lead")) {
        if (
          ["pending", "quarantined"].includes(delivery.state) &&
          (!delivery.missionId || delivery.missionId === m.id)
        ) {
          delivery.state = "pending";
          delivery.attempts = 0;
          delivery.nextAttemptAt = this.now();
          this.store.putDelivery(delivery);
        }
      }
      m.budgetStartedAt = this.now();
      m.turns = 0;
      m.outputTokens = 0;
      m.emptyTurns = 0;
      m.nextContinueAt = this.now() + 1000;
    }
    this.store.set("mission", m);
    this.store.event(`user.${action}`, m.id);
    const goal = this.store.goal(m.id);
    if (
      goal &&
      (action === "stop" || (action === "resume" && goal.state === "cancelled"))
    ) {
      goal.state = action === "stop" ? "cancelled" : "planned";
      goal.reason = m.reason;
      this.store.putGoal(goal);
    }
    if (action === "stop")
      await Promise.all(
        this.store
          .tasks(true)
          .filter((t) => !t.parentId)
          .map((t) => this.cancelTask(t.id, "User stopped the mission")),
      );
    this.changed();
    if (action === "resume") await this.tick();
  }
  requireDecision(
    reason: string,
    taskIds: string[] = [],
    kind: "business" | "execution" = "business",
  ) {
    const m = this.store.mission();
    if (!m) throw new Error("No mission");
    if (
      m.humanPaused ||
      m.status !== "active" ||
      this.store.get("relocationHold")
    )
      throw new Error(
        "Mission control is held; a business decision cannot replace the existing hold.",
      );
    if (this.recovery.current())
      throw new Error(
        "RUNTIME_RECOVERY_REQUIRED: runtime faults are handled by automatic recovery and mission_recover, not mission_decision. Inspect mission_status.recovery.",
      );
    if (!reason.trim()) throw new Error("A concrete user question is required");
    if (kind === "execution")
      throw new Error(
        "Execution choices stay within the approved scope. Choose the implementation, retry, file, command or member arrangement yourself; use mission_decision only for a concrete business boundary.",
      );
    if (
      this.decisionPolicyValue === "business-only" &&
      /implementation|implement|retry|command|file|member|assignment|script|architecture|format|refactor|实现|重试|命令|文件|成员|分工|脚本|架构|格式|重构/i.test(
        reason,
      ) &&
      !/scope|acceptance|budget|permission|deadline|release|publish|delete|irreversible|target|用户|范围|验收|预算|权限|截止|发布|删除|不可逆|目标/i.test(
        reason,
      )
    )
      throw new Error(
        "This looks like an execution choice, not a business decision. Continue within the approved scope; ask the user only for scope, acceptance, permission, budget, deadline, release or irreversible-risk choices.",
      );
    if (m.decision)
      throw new Error(`Decision ${m.decision.id} is still pending`);
    for (const id of taskIds) {
      const task = this.store.task(id);
      if (!task || terminal(task) || task.missionId !== m.id)
        throw new Error(
          "Decision task must be unfinished and belong to the current mission",
        );
      if (task.blockedReason)
        throw new Error("This task already has an unresolved blocker");
    }
    m.decision = {
      id: randomUUID(),
      question: cleanText(reason, 2000),
      taskIds: [...new Set(taskIds)],
      revision: m.revision ?? 0,
      humanVersion: this.store.get<number>("humanVersion") ?? 0,
      createdAt: this.now(),
    };
    if (!taskIds.length) m.status = "waiting_user";
    for (const id of taskIds) {
      const task = this.store.task(id)!;
      task.blockedReason = `decision:${m.decision.id}`;
      this.store.putTask(task);
    }
    m.reason = cleanText(reason, 2000);
    m.updatedAt = this.now();
    this.store.set("mission", m);
    this.store.event("decision.opened", m.decision.id, {
      missionId: m.id,
      taskIds,
    });
    this.options.notify?.(`需要用户裁决：${m.reason}`);
    this.turnActed = true;
    this.changed();
    return m;
  }
  resolveDecision(id: string, answer: string) {
    const m = this.store.mission(),
      decision = m?.decision;
    if (
      !m ||
      !decision ||
      decision.id !== id ||
      decision.revision !== (m.revision ?? 0)
    )
      throw new Error("Decision identity or goal revision changed");
    if (
      m.humanPaused ||
      this.userHold ||
      this.store.get("relocationHold") ||
      this.checkBudget(m) ||
      !["active", "waiting_user"].includes(m.status)
    )
      throw new Error(
        "User or runtime hold cannot be cleared by answering a decision",
      );
    if (
      (this.store.get<number>("humanVersion") ?? 0) <= decision.humanVersion ||
      !answer.trim() ||
      !this.lastHuman.includes(answer.trim())
    )
      throw new Error(
        "A new direct human reply quoting this decision's answer is required; status questions do not automatically resolve decisions.",
      );
    for (const taskId of decision.taskIds) {
      const task = this.store.task(taskId);
      if (task?.blockedReason === `decision:${id}`) {
        task.blockedReason = undefined;
        this.store.putTask(task);
      }
    }
    m.decision = undefined;
    m.status = "active";
    m.reason = undefined;
    m.emptyTurns = 0;
    m.updatedAt = this.now();
    this.store.set("mission", m);
    this.store.event("decision.resolved", id, {
      humanVersion: this.store.get("humanVersion"),
    });
    this.turnActed = true;
    this.changed();
    return m;
  }
  waitExternal(reason: string, deadline: number) {
    const m = this.store.mission();
    if (
      !m ||
      m.status !== "active" ||
      m.humanPaused ||
      this.userHold ||
      this.store.get("relocationHold") ||
      this.checkBudget(m)
    )
      throw new Error("An active authorized mission is required");
    if (
      !reason.trim() ||
      !Number.isSafeInteger(deadline) ||
      deadline <= this.now() ||
      deadline - this.now() > 604_800_000
    )
      throw new Error(
        "External wait needs a reason and a deadline within seven days",
      );
    if (m.externalWait) throw new Error("An external wait is already pending");
    m.externalWait = {
      id: randomUUID(),
      token: randomUUID(),
      reason: cleanText(reason, 2000),
      deadline,
      revision: m.revision ?? 0,
    };
    this.store.set("mission", m);
    this.store.event("wait.opened", m.externalWait.id, { deadline });
    this.turnActed = true;
    this.changed();
    return m.externalWait;
  }
  signalExternal(id: string, token: string) {
    const m = this.store.mission(),
      wait = m?.externalWait;
    if (
      !m ||
      !wait ||
      wait.id !== id ||
      wait.token !== token ||
      wait.revision !== (m.revision ?? 0)
    )
      throw new Error("External wait identity, token or revision changed");
    m.externalWait = undefined;
    m.nextContinueAt = this.now();
    this.store.set("mission", m);
    this.store.event("wait.signalled", id);
    this.delivery({
      key: `wait:${id}`,
      from: "external-wait",
      to: "lead",
      kind: "reminder",
      summary: `External wait signalled: ${wait.reason}. Inspect the actual result before continuing.`,
    });
    this.changed();
    return { signalled: true };
  }
  requestRecovery(faultId: string, revision: number) {
    const fault = this.recovery.current(),
      m = this.store.mission();
    if (
      !fault ||
      fault.id !== faultId ||
      (m?.revision ?? 0) !== revision ||
      fault.revision !== revision
    )
      throw new Error("Fault identity or goal revision changed");
    if (
      this.userHold ||
      m?.humanPaused ||
      this.store.get("relocationHold") ||
      (m && (m.status !== "active" || this.checkBudget(m)))
    )
      throw new Error(
        "Recovery cannot override a user hold, decision, goal state or budget",
      );
    return {
      eligible: this.recovery.ready(),
      recovery: this.recovery.current(),
      note: "Recovery preserves goal budgets and retained tool results. Context errors require successful compaction. Exhausted failure bursts retry after the persisted cooldown; external account/configuration errors require repair. No extra human continue is needed after a healthy response.",
    };
  }
  claimRecoveryCompaction() {
    const m = this.store.mission();
    if (
      this.closing ||
      this.userHold ||
      m?.humanPaused ||
      this.store.get("relocationHold") ||
      !this.options.isLeadIdle() ||
      (m && (m.status !== "active" || this.checkBudget(m)))
    )
      return false;
    return this.recovery.claimCompaction();
  }
  compactionSettled(id?: string, error = "Compaction failed or was cancelled") {
    if (id) {
      if (this.recovery.compacted(id)) {
        for (const d of this.store.deliveries("lead")) {
          if (
            d.state !== "pending" ||
            (d.missionId && d.missionId !== this.store.mission()?.id)
          )
            continue;
          d.nextAttemptAt = this.now();
          this.store.putDelivery(d);
        }
      }
    } else this.recovery.compactionFailed(error);
    this.changed();
  }
  compactionStarted() {
    this.recovery.compactionStarted();
    this.changed();
  }
  admitLeadRequest() {
    if (this.recovery.admit(this.automaticTurn || this.leadRequests > 0)) {
      this.leadRequests++;
      this.leadRunning = true;
      this.syncActivity();
      return true;
    }
    this.leadRunning = false;
    this.runtimeAborted = true;
    this.changed();
    return false;
  }
  rejectStaleWake() {
    this.runtimeAborted = true;
  }
  canRetryLeadRequest() {
    return (
      !this.closing &&
      !this.userHold &&
      !this.store.mission()?.humanPaused &&
      !this.store.get("relocationHold") &&
      this.recovery.retryAllowed()
    );
  }
  leadStarted(wake?: Wake) {
    this.leadRunning = true;
    if (!wake && this.reservation) {
      this.generation++;
      for (const d of this.store.deliveries("lead")) {
        if (
          d.batchId !== this.reservation.batchId ||
          !["leased", "admitted"].includes(d.state)
        )
          continue;
        d.state = "pending";
        d.batchId = undefined;
        this.store.putDelivery(d);
      }
      this.reservation = undefined;
    }
    this.leadFailed = false;
    this.leadResponded = false;
    this.runtimeAborted = false;
    this.leadRequests = 0;
    this.automaticTurn = Boolean(wake);
    this.turnActed = false;
    this.wakeIncluded = false;
    this.collected.clear();
    if (
      wake &&
      this.reservation?.batchId === wake.batchId &&
      wake.generation === this.generation
    ) {
      for (const d of this.store.deliveries("lead"))
        if (d.batchId === wake.batchId && d.state === "leased") {
          d.state = "admitted";
          this.store.putDelivery(d);
        }
    }
    this.syncActivity();
  }
  includeWake(batchId: string) {
    if (this.reservation?.batchId === batchId) this.wakeIncluded = true;
  }
  includeCollected(ids: string[]) {
    for (const d of this.store.deliveries("lead"))
      if (
        ids.includes(d.id) &&
        d.state !== "cancelled" &&
        d.state !== "superseded" &&
        d.state !== "observed"
      ) {
        d.state = "admitted";
        d.batchId = "collection";
        this.store.putDelivery(d);
        this.collected.add(d.id);
      }
  }
  leadMessage(
    error: boolean,
    outputTokens = 0,
    errorText = "Provider request failed",
    cancelled = false,
  ) {
    // A provider may report the locally aborted request as an error. It was not admitted.
    if (this.runtimeAborted) {
      this.leadFailed = true;
      this.leadRunning = false;
      this.syncActivity();
      return;
    }
    this.leadFailed = error;
    this.leadResponded = !cancelled;
    this.leadRunning = !error && !cancelled;
    if (error)
      this.recovery.fail(
        contextLimitError(errorText) ? "context" : "provider",
        errorText,
      );
    else if (!cancelled) this.recovery.succeeded();
    const m = this.store.mission();
    if (m && !["complete", "stopped"].includes(m.status)) {
      m.outputTokens += outputTokens;
      this.store.set("mission", m);
    }
    this.syncActivity();
  }
  leadActed() {
    this.turnActed = true;
  }
  leadSettled(aborted = false) {
    this.leadRunning = false;
    const reserved = this.reservation;
    this.reservation = undefined;
    if (aborted && !this.runtimeAborted) {
      this.userHold = true;
      this.store.set("escapeHold", true);
    }
    const expectsProgress =
      reserved?.deliveryIds.some((id) =>
        this.store
          .deliveries("lead")
          .some((d) => d.id === id && d.kind === "continue"),
      ) ?? false;
    if (
      reserved &&
      !aborted &&
      !this.leadFailed &&
      (!this.leadResponded || !this.wakeIncluded)
    ) {
      this.leadFailed = true;
      this.recovery.fail(
        "delivery",
        "Wake was not admitted into a successful model request; results remain durable.",
      );
    }
    if (reserved) {
      for (const d of this.store.deliveries("lead"))
        if (
          d.batchId === reserved.batchId &&
          ["leased", "admitted"].includes(d.state)
        ) {
          if (
            !aborted &&
            !this.leadFailed &&
            this.leadResponded &&
            this.wakeIncluded
          ) {
            d.state = "observed";
            d.reason =
              "Successful lead response observed; not a claim of exactly-once business consumption";
          } else {
            d.state = "pending";
            d.nextAttemptAt =
              this.now() +
              this.settings.retryBaseMs * 2 ** Math.min(d.attempts, 6);
            d.batchId = undefined;
          }
          this.store.putDelivery(d);
        }
    }
    for (const d of this.store.deliveries("lead"))
      if (this.collected.has(d.id) && d.state === "admitted") {
        d.state =
          !aborted && !this.leadFailed && this.leadResponded
            ? "observed"
            : "pending";
        d.batchId = undefined;
        d.nextAttemptAt = this.now() + this.settings.retryBaseMs;
        this.store.putDelivery(d);
      }
    this.collected.clear();
    if (!aborted && !this.leadFailed && this.leadResponded) {
      this.recovery.succeeded();
      for (const delivery of this.store.deliveries("lead")) {
        if (
          delivery.state !== "quarantined" ||
          (delivery.missionId &&
            delivery.missionId !== this.store.mission()?.id)
        )
          continue;
        delivery.state = "pending";
        delivery.nextAttemptAt = this.now();
        this.store.putDelivery(delivery);
        this.store.event("delivery.retry-ready", delivery.id);
      }
    } else if (this.leadFailed || this.runtimeAborted)
      this.recovery.settledFailure();
    const m = this.store.mission();
    if (m && m.status === "active") {
      if (reserved) m.turns++;
      if (this.turnActed) m.emptyTurns = 0;
      else if (
        expectsProgress &&
        !aborted &&
        !this.leadFailed &&
        this.leadResponded &&
        !this.store.tasks(true).length &&
        !m.externalWait
      )
        m.emptyTurns++;
      m.nextContinueAt = this.now() + 1500;
      m.updatedAt = this.now();
      if (m.emptyTurns >= 3) {
        m.status = "attention";
        m.reason = noProgressReason;
        m.blocker = { kind: "no_progress", reason: m.reason };
        this.store.event("mission.blocked", m.id, { kind: "no_progress" });
        this.options.notify?.(m.reason);
      }
      this.store.set("mission", m);
    }
    this.runtimeAborted = false;
    this.changed();
  }
  recoveryPlan(limit = 100) {
    const m = this.store.mission();
    const unknown = this.store.unknownProcesses(limit);
    const goal = m
      ? { goalId: m.id, expectedRevision: m.revision ?? 0 }
      : undefined;
    const base = {
      goal,
      unknownProcessCount: unknown.total,
      ...(m?.decision?.taskIds.length
        ? {
            taskDecision: {
              id: m.decision.id,
              taskIds: m.decision.taskIds,
              instruction:
                "Only the named tasks are decision-blocked; unrelated approved work may proceed.",
            },
          }
        : {}),
    };
    if (this.store.get("relocationHold"))
      return {
        ...base,
        state: "user_control_required",
        control: "workspace",
        userCommand: "/mission resume",
        instruction:
          workspaceResumeInstruction +
          " Ordinary chat, goal edits, project_recover and runtime recovery do not release it. Do not create another business blocker for this pause.",
      };
    if (this.userHold || m?.humanPaused)
      return {
        ...base,
        state: "user_control_required",
        instruction:
          "User/Escape/workspace hold remains authoritative. Inspect its exact control; recovery tools do not release it.",
      };
    if (m && ["complete", "stopped"].includes(m.status))
      return {
        ...base,
        state: "closed",
        instruction:
          "This goal is closed. Inspect retained results before accepting a new authorized objective.",
      };
    if (m && (m.blocker?.kind === "budget" || this.budgetReasons(m).length))
      return {
        ...base,
        state: "budget_renewal_required",
        instruction:
          "Configured budget requires explicit user renewal through /mission resume. Usage is retained.",
      };
    if (
      m?.decision &&
      (m.status === "waiting_user" ||
        m.blocker?.kind === "no_progress" ||
        !m.decision.taskIds.length)
    )
      return {
        ...base,
        state: "business_decision_required",
        decisionId: m.decision.id,
        instruction:
          "Obtain a new direct human answer for this decision; resolve its exact identity with mission_decision. Do not replace it with runtime recovery.",
      };
    if (m?.status === "attention" && m.blocker?.kind !== "no_progress")
      return {
        ...base,
        state: "unclassified_hold",
        instruction:
          "Inspect the unclassified hold; the model resume tool cannot release it.",
      };
    const progressResume =
      m?.status === "attention" && m.blocker?.kind === "no_progress"
        ? {
            tool: "mission_control",
            arguments: { action: "resume", ...goal },
            requiredArgument:
              "reason: explain the inspected blocker and next approved step; do not invent evidence",
          }
        : undefined;
    if (unknown.tasks.some((t) => this.live.has(t.id)))
      return {
        ...base,
        state: "executions_stopping",
        instruction:
          "Managed executions are still stopping. Wait for their termination receipts before reconciling; never attest a live execution as stopped.",
      };
    if (unknown.total)
      return {
        ...base,
        state: "process_inspection_required",
        instruction:
          "mission_reconcile is a directly callable model tool. Reload preserves unknown executions; it does not confirm that processes stopped. Inspect saved artifacts and actual host processes, then call this tool yourself with concrete evidence. Do not delegate a slash command to the user merely because old history says it was user-only.",
        nextCall: {
          tool: "mission_reconcile",
          arguments: {
            tasks: unknown.tasks.map((t) => ({
              taskId: t.id,
              expectedEpoch: t.epoch,
            })),
          },
          requiredArgument:
            "evidence: actual stopped-process and artifact inspection, not this status query or an assumption",
        },
        executions: unknown.tasks.map((t) => ({
          taskId: t.id,
          member: t.member,
          state: t.state,
          inputPath: t.inputPath,
          resultPath: t.resultPath,
          live: this.live.has(t.id),
        })),
        remainingUnknown: unknown.total - unknown.tasks.length,
        afterReconcile: (unknown.total <= unknown.tasks.length
          ? progressResume
          : undefined) ?? {
          tool: "mission_status",
          instruction:
            "Read the next current step; explicitly create a new attempt only when existing results justify it.",
        },
      };
    if (progressResume)
      return {
        ...base,
        state: "progress_review_required",
        instruction:
          "Inspect saved results and the actual blocker, then invoke mission_control yourself with this exact goal identity and revision. This resumes only no_progress and preserves usage. A status query alone is not a recovery attempt.",
        nextCall: progressResume,
      };
    const recovery = this.recovery.current();
    if (recovery?.phase === "compaction_failed")
      return {
        ...base,
        state: "compaction_failed",
        reason: recovery.reason,
        nextCall: {
          tool: "compaction_model",
          arguments: { action: "status", target: "lead" },
        },
        instruction:
          recovery.nextAt !== undefined
            ? `Transient summary failure; cached compaction will retry automatically after ${new Date(recovery.nextAt).toISOString()}. Do not start a duplicate or change the configured summary route.`
            : "Inspect the exact summary route and failure. Cancellation or an external configuration/account error requires repair before resuming cached work with mission_compact or /compact. Never silently fall back to the inference model.",
      };
    if (recovery?.phase === "compacting")
      return {
        ...base,
        state: "compacting",
        instruction:
          "Summary requests are running with bounded retries and retained chunk caches. Inspect compaction_model diagnostics for progress; do not start a second compaction.",
      };
    if (recovery)
      return {
        ...base,
        state:
          recovery.phase === "blocked"
            ? "external_repair_required"
            : "runtime_recovery",
        nextAt: recovery.nextAt,
        nextCall: {
          tool: "mission_recover",
          arguments: {
            faultId: recovery.id,
            expectedRevision: recovery.revision,
          },
        },
        instruction:
          recovery.phase === "blocked"
            ? "Repair the reported account, permission or model configuration. A new successful request clears this fault; do not repeat an unchanged invalid request. User holds and budgets remain authoritative."
            : "The runtime owns automatic retries and cooldown probes. A healthy model response clears the fault immediately; continue approved work without requesting another human continue. Inspect retained results before repeating commands. User holds and budgets remain authoritative.",
      };
    if (m?.externalWait)
      return {
        ...base,
        state: "external_wait",
        instruction:
          "Wait for the declared producer signal or deadline; do not repeatedly poll or report unchanged state.",
      };
    return {
      ...base,
      state: "ready",
      instruction:
        "Continue the existing approved work, inspect retained results and use explicit new attempts when necessary.",
    };
  }
  snapshot() {
    const m = this.store.mission();
    return {
      recoveryPlan: this.recoveryPlan(),
      decisionPolicy: this.decisionPolicyValue,
      mission: m,
      goals: this.goals.summary(m?.id),
      recovery: this.recovery.current(),
      activity: this.activityClock.snapshot(m),
      budgets: {
        timeMs: this.settings.maxMissionMs || null,
        turns: this.settings.maxAutonomousTurns || null,
        outputTokens: this.settings.maxOutputTokens || null,
      },
      compactionQueued: this.compactionQueued,
      members: this.store.members(),
      tasks: this.store.tasks(),
      deliveries: this.store
        .deliveries("lead")
        .filter((d) => !["cancelled", "superseded"].includes(d.state)),
      schedules: this.store.schedules(),
      lifecycle: this.store.archiveCounts(),
      maintenance: !this.closing,
      held: this.userHold,
      workspaceHeld: Boolean(this.store.get("relocationHold")),
      nextReportAt: m
        ? m.lastReportAt + this.settings.progressIntervalMs
        : undefined,
    };
  }
  context() {
    const s = this.snapshot(),
      m = s.mission;
    if (!m) return "";
    return [
      `Current Mission Control recovery plan: ${JSON.stringify(this.recoveryPlan(5))}. Follow this current plan before repeating old recovery advice. Tools named here are callable by the lead model; do not claim that recovery failed unless an actual recovery tool returned an error.`,
      `Autonomy policy: ${this.decisionPolicyValue}. Choose implementation, retry, command, file, member and formatting details yourself inside the approved scope. Use mission_decision only for a concrete business boundary such as scope, acceptance, permission, budget, deadline, release or irreversible risk.`,
      "Decision answers do not require A/B/C tokens. A new direct human answer may delegate an in-scope choice to the lead. Quote that actual answer when resolving the exact decisionId and explain the selected next step; do not request another confirmation merely to obtain a letter. A policy change alone does not answer an existing decision or expand workspace or action authorization.",
      `Mission ${m.id}: ${m.status}. ${cleanText(m.objective, 1200)}`,
      `Acceptance (${m.criteria.length} items; goal_tree has details): ${m.criteria
        .slice(0, 6)
        .map((x, i) => `${i + 1}. ${cleanText(x, 200)}`)
        .join(" | ")}`,
      `Goal ledger progress: ${JSON.stringify(s.goals)}. goal_tree reads the durable plan and evidence. For complex work, register stages and leaf deliverables with goal_plan before implementation; use dependencies to preserve batch order. Focus a ready leaf with goal_focus before commands or delegation. goal_accept records evidence once for each goal; completed member turns never accept goals. Use goal_edit to record blockers, next steps or explicit reopening. Tool receipts and task results can be referenced; statements are labelled model claims. Reuse accepted evidence unless requirements or relevant artifacts change. Multiple main goals coexist; goal_activate selects only one and never clears holds or renews budgets.`,
      `Tasks: ${
        s.tasks
          .filter((t) => !terminal(t))
          .map(
            (t) =>
              `${t.member}: ${t.state}${t.blockedReason ? ` (${t.blockedReason})` : ""}`,
          )
          .join("; ") || "none"
      }`,
      "Task completion and maintenance are automatic, independent of Goal/reminder tools. Delegate approved work, let teammates review each other, then call mission_wait alone. Only the user can pause or stop the mission. Use mission_complete with evidence after verification; use mission_decision only for a concrete user decision. Inspect saved result paths rather than repeat completed commands.",
      "Mission Control tools are declared directly from the host registry. mission_capabilities lists their active visibility and exact schemas. Inspect unknown executions and host processes before mission_reconcile; it records your stopped-process evidence and never replays work.",
      s.recovery
        ? `Runtime recovery: ${JSON.stringify(s.recovery)}. Recovery preserves the approved goal and budget. Never turn a runtime fault into a user decision or edit the goal to bypass a hold; inspect mission_recover.`
        : "",
      m.blocker
        ? `Execution hold: ${JSON.stringify(m.blocker)}. ${m.blocker.kind === "no_progress" ? "Inspect saved results and the blocker, then use mission_control with this exact goal identity/revision and the next approved step; usage is preserved." : "This hold cannot be removed by editing the objective or runtime recovery."}`
        : "",
      m.decision
        ? `Pending business decision: ${JSON.stringify(m.decision)}. A status question does not answer it. Resolve only this decision after a new direct human answer.`
        : "",
      m.externalWait
        ? `Waiting for external event ${m.externalWait.id} until ${new Date(m.externalWait.deadline).toISOString()}: ${m.externalWait.reason}. No repeated polling or unchanged reports.`
        : "",
      this.store.get("pathMappings")
        ? `Explicit workspace rename history: ${JSON.stringify(this.store.get("pathMappings"))}. Historical paths are unchanged; use project_resolve and current authorized roots before execution.`
        : "",
    ]
      .join("\n")
      .slice(0, 10000);
  }
  async tick() {
    if (this.closing || this.ticking) return;
    this.ticking = true;
    try {
      const now = this.now();
      this.store.transaction(() => {
        for (const s of this.userHold ||
        this.store.mission()?.humanPaused ||
        this.store.get("relocationHold")
          ? []
          : this.store.schedules())
          if (s.state === "active" && s.nextAt <= now) {
            const occurrence = s.intervalMs
              ? s.nextAt +
                Math.floor((now - s.nextAt) / s.intervalMs) * s.intervalMs
              : s.nextAt;
            this.delivery({
              key: `schedule:${s.id}:${occurrence}`,
              from: "schedule",
              to: "lead",
              kind: "reminder",
              summary: `${s.title}: ${s.prompt}`,
              scheduleId: s.id,
              scheduleRevision: s.revision ?? 1,
            });
            if (s.intervalMs) s.nextAt = occurrence + s.intervalMs;
            else s.state = "ended";
            s.updatedAt = this.now();
            if (s.state === "ended") s.archiveReason = "one-shot-fired";
            this.store.putSchedule(s);
          }
      });
      let mission = this.store.mission();
      if (mission?.status === "active") this.checkBudget(mission);
      if (mission?.externalWait && mission.externalWait.deadline <= now) {
        const wait = mission.externalWait;
        mission.externalWait = undefined;
        this.store.set("mission", mission);
        this.store.event("wait.expired", wait.id);
        this.delivery({
          key: `wait:${wait.id}`,
          from: "external-wait",
          to: "lead",
          kind: "reminder",
          summary: `External wait deadline reached: ${wait.reason}. Inspect the producer's current state before retrying any work.`,
        });
      }
      if (
        mission?.status === "active" &&
        !mission.humanPaused &&
        !this.userHold &&
        !this.store.get("relocationHold")
      ) {
        for (const task of this.store.tasks(true))
          if (
            task.state === "waiting" &&
            !task.blockedReason &&
            !this.live.has(task.id) &&
            this.store.children(task.id).every(terminal)
          )
            this.review(task);
        for (const task of this.store
          .tasks(true)
          .filter((t) => t.state === "running")) {
          const live = this.live.get(task.id);
          if (!live?.worker?.deliver || live.delivering) continue;
          const notes = this.store
            .deliveries(task.member)
            .filter(
              (d) =>
                d.state === "pending" &&
                !task.reviewDeliveryIds.includes(d.id) &&
                d.nextAttemptAt <= now &&
                d.attempts < this.settings.maxWakeAttempts,
            )
            .slice(0, 4);
          if (!notes.length) continue;
          live.delivering = true;
          for (const note of notes) {
            note.state = "leased";
            note.attempts++;
            this.store.putDelivery(note);
          }
          const message =
            "New messages from permitted teammates. Treat each delivery identity once; continue only approved work.\n" +
            notes
              .map((d) => `${d.id} from ${d.from} (${d.kind}): ${d.summary}`)
              .join("\n\n");
          live.deliveryPromise = live.worker
            .deliver(message)
            .then(
              () => {
                if (this.closing) return;
                const current = this.store.task(task.id);
                if (
                  !current ||
                  terminal(current) ||
                  current.epoch !== task.epoch
                )
                  return;
                current.reviewDeliveryIds.push(...notes.map((d) => d.id));
                this.store.putTask(current);
              },
              () => {
                if (this.closing) return;
                for (const note of notes) {
                  const current = this.store
                    .deliveries(note.to)
                    .find((d) => d.id === note.id);
                  if (!current || current.state !== "leased") continue;
                  current.state = "pending";
                  current.nextAttemptAt =
                    this.now() + this.settings.retryBaseMs;
                  this.store.putDelivery(current);
                }
              },
            )
            .finally(() => {
              live.delivering = false;
            })
            .catch((error) =>
              this.options.notify?.(
                `Peer message delivery failed: ${String(error)}`,
              ),
            );
        }
        for (const task of this.store
          .tasks(true)
          .filter((t) => t.state === "queued")) {
          if (task.missionId !== mission?.id) continue;
          if (task.goalId && this.goals.blockers(task.goalId).length) continue;
          if (task.blockedReason) continue;
          if (
            task.phase === "work" &&
            task.queueTimeoutMs &&
            now - task.createdAt >= task.queueTimeoutMs
          ) {
            this.finishWithoutWorker(
              task,
              "Queue deadline exceeded; no member process was started",
            );
            continue;
          }
          if (this.live.size >= this.settings.maxParallel) continue;
          if (
            [...this.live.keys()].some(
              (id) => this.store.task(id)?.memberId === task.memberId,
            )
          )
            continue;
          if (task.dependsOn) {
            const dep = this.store.task(task.dependsOn);
            if (!dep || !terminal(dep)) continue;
            if (dep.state !== "completed") {
              this.finishWithoutWorker(
                task,
                "Dependency failed; chain work was not started",
              );
              continue;
            }
          }
          this.launch(task);
        }
        if (
          !mission.externalWait &&
          now - mission.lastReportAt >= this.settings.progressIntervalMs
        ) {
          this.delivery({
            key: `report:${mission.id}:${mission.lastReportAt}`,
            from: "maintenance",
            to: "lead",
            kind: "progress",
            summary:
              "Scheduled progress review. Collect task results, address genuine blockers, and report progress without restarting unchanged work.",
          });
          mission.lastReportAt = now;
          this.store.set("mission", mission);
        }
        if (
          !this.store.tasks(true).length &&
          !mission.externalWait &&
          now >= mission.nextContinueAt &&
          !this.reservation
        ) {
          const pending = this.store
            .deliveries("lead")
            .some(
              (d) =>
                d.state === "pending" &&
                (d.kind !== "progress" || d.from === "maintenance") &&
                (!d.missionId || d.missionId === mission!.id),
            );
          if (!pending)
            this.delivery({
              key: `continue:${mission.id}:${mission.turns}:${mission.nextContinueAt}`,
              from: "maintenance",
              to: "lead",
              kind: "continue",
              summary:
                "The approved mission remains unfinished and has no active tasks. Continue the next approved step or complete the mission with verified evidence.",
            });
        }
      }
      if (this.reservation) {
        const ds = this.store
          .deliveries("lead")
          .filter((d) => d.batchId === this.reservation!.batchId);
        if (
          ds.length &&
          ds.every((d) => (d.leaseUntil ?? 0) < now) &&
          this.options.isLeadIdle()
        )
          this.leadSettled(false);
      }
      for (const d of this.store.deliveries("lead")) {
        if (
          d.state !== "pending" ||
          (d.missionId && d.missionId !== mission?.id) ||
          d.attempts < this.settings.maxWakeAttempts
        )
          continue;
        if (d.kind === "progress" || d.kind === "continue") {
          d.state = "superseded";
          d.reason =
            "Automatic notification attempts exhausted; original work and results remain intact.";
        } else if (this.recovery.current()?.phase === "exhausted") {
          d.state = "quarantined";
          d.reason =
            "Recovery failure burst is cooling down; notification remains unread and will retry after a healthy response, or can be explicitly collected.";
        } else continue;
        this.store.putDelivery(d);
        this.store.event(`delivery.${d.state}`, d.id);
      }
      const requestedCompaction =
        this.compactionQueued &&
        !this.userHold &&
        !this.store.mission()?.humanPaused &&
        !this.store.get("relocationHold") &&
        this.options.isLeadIdle();
      if (
        this.options.compact &&
        (requestedCompaction || this.claimRecoveryCompaction())
      ) {
        if (requestedCompaction) {
          this.compactionQueued = false;
          this.recovery.claimCompaction();
        }
        try {
          this.options.compact();
        } catch (error) {
          this.compactionSettled(undefined, String(error));
        }
      }
      this.pump();
    } finally {
      this.ticking = false;
      this.changed();
    }
  }
  private pump() {
    const m = this.store.mission();
    if (
      this.closing ||
      this.userHold ||
      m?.humanPaused ||
      this.store.get("relocationHold") ||
      this.reservation ||
      !this.options.isLeadIdle() ||
      !this.recovery.ready()
    )
      return;
    const fault = this.recovery.current();
    if (
      fault?.phase === "ready" &&
      (!m || m.status === "active") &&
      !m?.externalWait &&
      !this.store
        .deliveries("lead")
        .some(
          (d) =>
            d.state === "pending" &&
            d.nextAttemptAt <= this.now() &&
            (!d.missionId || d.missionId === m?.id),
        )
    ) {
      this.delivery({
        key: `probe:${fault.id}:${fault.probes}`,
        from: "maintenance",
        to: "lead",
        kind: "recovery",
        summary:
          "Runtime recovery probe. Inspect retained results and continue only the existing approved objective; do not repeat completed commands.",
      });
    }
    const pending = this.store
      .deliveries("lead")
      .filter(
        (d) =>
          d.state === "pending" &&
          (!d.missionId || d.missionId === m?.id) &&
          d.nextAttemptAt <= this.now() &&
          (m?.status !== "attention" ||
            (d.kind === "reminder" && !d.missionId)) &&
          (m?.status === "active" ||
            ["failure", "decision", "recovery", "reminder", "result"].includes(
              d.kind,
            )),
      );
    const trigger = (d: Delivery) =>
      d.kind !== "progress" || d.from === "maintenance";
    if (!pending.some(trigger)) return;
    const priority = (d: Delivery) =>
      d.kind === "decision" ? 0 : d.kind === "failure" ? 1 : trigger(d) ? 2 : 3;
    const eligible = pending
      .sort((a, b) => priority(a) - priority(b) || a.createdAt - b.createdAt)
      .slice(0, 8);
    if (!eligible.length) return;
    const batchId = randomUUID();
    this.store.transaction(() => {
      for (const d of eligible) {
        d.state = "leased";
        d.batchId = batchId;
        d.attempts++;
        d.leaseUntil = this.now() + 15000;
        this.store.putDelivery(d);
      }
    });
    const content =
      "Mission Control updates. Handle these identities once; inspect artifacts when needed.\n\n" +
      eligible
        .map(
          (d) =>
            `[${d.id}] ${d.from}: ${d.kind}\n${d.summary}${d.artifact ? `\nResult file: ${d.artifact}` : ""}`,
        )
        .join("\n\n");
    this.reservation = {
      batchId,
      generation: this.generation,
      deliveryIds: eligible.map((d) => d.id),
      content,
    };
    this.recovery.probe();
    this.wakeIncluded = false;
    try {
      this.options.wake(this.reservation);
    } catch (error) {
      this.leadFailed = true;
      this.recovery.fail(
        "delivery",
        `Wake submission failed: ${String(error)}`,
      );
      this.leadSettled(false);
      this.options.notify?.(
        `Wake submission failed; retained for retry: ${String(error)}`,
      );
    }
  }
  private assignedGoalContext(
    task: Task,
    section = "summary",
    offset = 0,
    limit = 5,
  ) {
    if (!task.goalId) return { goalId: null, note: "No goal bound" };
    if (
      !["summary", "criteria", "scope"].includes(section) ||
      !Number.isSafeInteger(offset) ||
      offset < 0 ||
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > 5
    )
      throw new Error(
        "goal_context needs summary|criteria|scope, offset >= 0 and limit 1..5",
      );
    const goal = this.goals.node(task.goalId);
    const page = (entries: string[]) => ({
      total: entries.length,
      offset,
      nextOffset: offset + limit < entries.length ? offset + limit : undefined,
      entries: entries
        .slice(offset, offset + limit)
        .map((text, index) => ({ index: offset + index + 1, text })),
    });
    if (section === "criteria")
      return {
        goalId: goal.id,
        revision: goal.revision,
        ...page(goal.criteria),
      };
    if (section === "scope") {
      const entries = [
        ...(goal.scope?.items.map((item) => "item: " + item) ?? []),
        ...(goal.scope?.files?.map((file) => "file: " + file) ?? []),
      ];
      return {
        goalId: goal.id,
        revision: goal.revision,
        unitKind: goal.scope?.unitKind,
        ...page(entries),
      };
    }
    const path: GoalNode[] = [];
    for (
      let node: GoalNode | undefined = goal;
      node;
      node = node.parentId ? this.store.goal(node.parentId) : undefined
    )
      path.unshift(node);
    const dependencies = path.flatMap((node) =>
      node.dependsOn.map((id) => {
        const dependency = this.goals.node(id);
        return {
          stage: node.id,
          id,
          revision: dependency.revision,
          state: dependency.state,
          accepted:
            dependency.state === "accepted" && !!dependency.acceptanceId,
          acceptanceId: dependency.acceptanceId,
        };
      }),
    );
    const acceptance = goal.acceptanceId
      ? this.store.acceptance(goal.acceptanceId)
      : undefined;
    return {
      goalId: goal.id,
      assignedRevision: task.goalRevision,
      currentRevision: goal.revision,
      objective: cleanText(goal.objective, 2000),
      parentPath: path.slice(0, -1).map((node) => ({
        id: node.id,
        revision: node.revision,
        objective: cleanText(node.objective, 300),
      })),
      scope: goal.scope
        ? {
            unitKind: goal.scope.unitKind,
            complete:
              goal.scope.items.length <= 5 &&
              (goal.scope.files?.length ?? 0) <= 5 &&
              [...goal.scope.items, ...(goal.scope.files ?? [])].every(
                (value) => value.length <= 200,
              ),
            total: goal.scope.items.length,
            items: goal.scope.items
              .slice(0, 5)
              .map((value) => cleanText(value, 200)),
            files: goal.scope.files
              ?.slice(0, 5)
              .map((value) => cleanText(value, 200)),
            full: "goal_context(section:scope)",
          }
        : undefined,
      criteria: {
        total: goal.criteria.length,
        complete:
          goal.criteria.length <= 3 &&
          goal.criteria.every((value) => value.length <= 400),
        preview: goal.criteria.slice(0, 3).map((value, index) => ({
          criterion: index + 1,
          text: cleanText(value, 400),
        })),
        full:
          goal.criteria.length <= 3 &&
          goal.criteria.every((value) => value.length <= 400)
            ? "All criteria are shown; no duplicate lookup is needed."
            : "Retrieve the missing full criteria using goal_context(section:criteria) before claiming delivery.",
      },
      dependencyCount: dependencies.length,
      dependencies: dependencies.slice(0, 10),
      dependenciesSatisfied: dependencies.every((d) => d.accepted),
      focusId: this.store.get<string>(`goalFocus:${goal.rootId}`),
      nextStep: goal.nextStep,
      acceptance: acceptance
        ? { id: acceptance.id, revision: acceptance.revision }
        : undefined,
      lastTaskResults: this.store
        .missionTasks(goal.rootId)
        .filter((t) => t.goalId === goal.id && t.resultPath)
        .slice(0, 3)
        .map((t) => ({ id: t.id, state: t.state, resultPath: t.resultPath })),
      evidenceWrites: task.memberId
        ? {
            root: this.store.member(task.memberId)?.workspace.root,
            access: this.store.member(task.memberId)?.workspace.access,
            note: "Use existing authorized output paths. No new evidence directory is required.",
          }
        : undefined,
      acceptanceRule:
        "Task completion is not goal acceptance. Report concrete results and uncovered criteria; the lead records acceptance once.",
    };
  }
  private launch(task: Task) {
    const member = this.store.member(task.memberId)!;
    this.previews.delete(member.id);
    task.state = "running";
    task.epoch++;
    task.startedAt = this.now();
    task.updatedAt = this.now();
    task.processState = "running";
    this.store.putTask(task);
    const token = randomUUID() + randomUUID();
    this.tokens.set(token, { taskId: task.id, epoch: task.epoch });
    const controller = new AbortController();
    let finish!: () => void;
    const done = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const live: Live = { epoch: task.epoch, controller, done };
    this.live.set(task.id, live);
    const incoming = this.store
      .deliveries(member.name)
      .filter((d) => d.state === "pending");
    task.reviewDeliveryIds = incoming.map((d) => d.id);
    this.store.putTask(task);
    const original = this.store.readArtifact(task.inputPath, 200_000),
      dependency = task.dependsOn ? this.store.task(task.dependsOn) : undefined;
    const prompt = [
      `Assigned task ${task.id}; phase ${task.phase}. Follow the existing user authorization.`,
      original,
      task.goalId
        ? "Assigned goal context (bounded previews; goal_context retrieves full criteria and scope):\n" +
          JSON.stringify(this.assignedGoalContext(task))
        : "",
      `Execution policy: ${JSON.stringify({
        timeoutPolicy:
          task.timeoutPolicy ?? (task.timeoutMs ? "fixed" : "none"),
        timeoutMs: task.timeoutMs,
        queueTimeoutMs: task.queueTimeoutMs ?? 0,
      })}. No total deadline does not disable cancellation, process ownership or per-command/API timeouts.`,
      this.store.get("pathMappings")
        ? `Workspace rename mappings: ${JSON.stringify(this.store.get("pathMappings"))}. Resolve old references against the current assigned root before executing commands; do not rewrite evidence.`
        : "",
      dependency?.resultPath
        ? `Previous chain result: ${dependency.resultPath}\n${dependency.summary ?? ""}`
        : "",
      incoming.length
        ? "New teammate deliveries (inspect files; do not re-run their completed work):\n" +
          incoming
            .map(
              (d) =>
                `${d.id}: ${d.from} ${d.kind}: ${d.summary}${d.artifact ? `\nArtifact: ${d.artifact}` : ""}`,
            )
            .join("\n\n")
        : "",
      "Use team_message to assign approved downstream work to permitted teammates. After dispatch call team_wait ALONE to end this turn; the runtime resumes this same session for review. Routine updates stay within the team; send decision/failure only when coordination is required.",
    ]
      .filter(Boolean)
      .join("\n\n");
    const assignment: Assignment = {
      member,
      task,
      prompt,
      directory: this.store.directory,
      bridgeUrl: this.bridgeUrl,
      token,
      settings: {
        ...this.settings,
        reconnect: {
          ...this.settings.reconnect,
          ...this.store.get<import("./reconnect.ts").ReconnectOptions>(
            "reconnect",
          ),
        },
      },
    };
    const cancelDeadline = executionDeadline(
      task.timeoutMs
        ? Math.max(1, task.timeoutMs - (task.executionMs ?? 0))
        : 0,
      () =>
        controller.abort(
          new Error(`Task execution deadline exceeded (${task.timeoutMs}ms)`),
        ),
    );
    void (async () => {
      try {
        live.worker = await this.options.workerFactory(
          assignment,
          controller.signal,
          (event) => {
            if (this.closing) return;
            const current = this.store.task(task.id);
            if (!current || current.epoch !== task.epoch) return;
            if (event.type === "session" && event.sessionFile) {
              const expected = path.join(
                this.store.directory,
                "sessions",
                member.id,
              );
              if (path.dirname(path.resolve(event.sessionFile)) === expected) {
                current.sessionFile = event.sessionFile;
                this.store.putTask(current);
                const latest = this.store.member(member.id)!;
                latest.sessionFile = event.sessionFile;
                this.store.putMember(latest);
              }
              this.changed();
              return;
            }
            if (event.type === "public") {
              const previews =
                this.previews.get(member.id) ??
                new Map<string, PublicActivity>();
              if (event.clearPreview) previews.delete(event.clearPreview);
              if (event.preview) {
                previews.set(event.preview.id, event.preview);
                while (previews.size > 16)
                  previews.delete(previews.keys().next().value!);
              }
              this.previews.set(member.id, previews);
              this.changed();
              return;
            }
            this.store.set(`activity:${member.id}`, {
              ...event,
              text: event.text ? cleanText(event.text, 800) : undefined,
              at: this.now(),
            });
            this.changed();
          },
        );
        if (controller.signal.aborted) await live.worker.stop();
        const result = await live.worker.result;
        live.processState = result.processState;
        await live.deliveryPromise;
        await this.acceptOutcome(task, result);
      } catch (error) {
        live.processState = "unknown";
        await this.acceptOutcome(task, {
          ok: false,
          text: "",
          error: controller.signal.aborted
            ? "Task cancelled or exceeded its execution deadline"
            : String(error),
          processState: "unknown",
        });
      } finally {
        cancelDeadline();
        this.previews.delete(member.id);
        this.tokens.delete(token);
        if (this.live.get(task.id) === live) this.live.delete(task.id);
        finish();
        if (!this.closing)
          void this.tick().catch((e) => this.options.notify?.(String(e)));
      }
    })();
  }
  private async acceptOutcome(started: Task, outcome: WorkerOutcome) {
    const task = this.store.task(started.id);
    if (!task) return;
    const member = this.store.member(task.memberId)!;
    if (outcome.cleanSettlement === false) {
      member.sessionId = randomUUID();
      member.sessionFile = undefined;
      this.store.putMember(member);
      this.store.event("member.session-retired", member.id, {
        taskId: task.id,
        reason:
          "No clean tool/result settlement; old history retained, next attempt uses a fresh session",
      });
    } else if (outcome.sessionFile) {
      member.sessionFile = outcome.sessionFile;
      this.store.putMember(member);
    }
    if (task.epoch !== started.epoch || terminal(task)) return;
    task.executionMs =
      (started.executionMs ?? 0) + Math.max(0, this.now() - started.startedAt!);
    task.processState = outcome.processState;
    if (outcome.sessionFile) task.sessionFile = outcome.sessionFile;
    task.updatedAt = this.now();
    if (outcome.ok) {
      for (const d of this.store.deliveries(task.member))
        if (task.reviewDeliveryIds.includes(d.id)) {
          d.state = "observed";
          this.store.putDelivery(d);
        }
    } else
      for (const delivery of this.store.deliveries(task.member))
        if (
          task.reviewDeliveryIds.includes(delivery.id) &&
          delivery.state === "leased"
        ) {
          delivery.state = "pending";
          delivery.nextAttemptAt = this.now() + this.settings.retryBaseMs;
          this.store.putDelivery(delivery);
        }
    if (outcome.ok && task.state === "waiting") {
      this.store.putTask(task);
      return;
    }
    const children = this.store.children(task.id);
    const unseen = this.store
      .deliveries(task.member)
      .some(
        (d) =>
          d.state === "pending" &&
          d.taskId &&
          children.some((t) => t.id === d.taskId),
      );
    if (
      outcome.ok &&
      (children.some((t) => !terminal(t)) ||
        (children.length && task.phase === "work") ||
        unseen)
    ) {
      task.state = "waiting";
      this.store.putTask(task);
      return;
    }
    task.state = outcome.ok ? "completed" : "failed";
    task.finishedAt = this.now();
    task.error = outcome.error;
    task.protocolDiagnostic = outcome.protocolDiagnostic;
    task.summary = cleanText(
      outcome.text || outcome.error || "(no public response)",
      2000,
    );
    task.resultPath = this.store.artifact(
      `${task.id}-${task.epoch}`,
      "result",
      outcome.text || outcome.error || "(no public response)",
    );
    this.store.transaction(() => {
      this.store.putTask(task);
      this.delivery({
        key: `result:${task.id}:${task.epoch}`,
        taskId: task.id,
        from: task.member,
        to: task.parentId
          ? (this.store.task(task.parentId)?.member ?? "lead")
          : "lead",
        kind: outcome.ok ? "result" : "failure",
        summary: task.summary!,
        artifact: task.resultPath,
      });
      this.store.event("task.finished", task.id, { state: task.state });
    });
    this.cleanTemporaryMembers(
      task.state === "completed" ? "task-completed" : "task-failed",
    );
    if (!outcome.ok) {
      for (const child of this.store.children(task.id))
        if (!terminal(child))
          await this.cancelTask(
            child.id,
            "Ancestor failed; downstream work cancelled",
          );
    }
  }
  private review(task: Task) {
    task.state = "queued";
    task.phase = "review";
    task.updatedAt = this.now();
    this.store.putTask(task);
  }
  private finishWithoutWorker(task: Task, reason: string) {
    task.state = "failed";
    task.error = reason;
    task.finishedAt = this.now();
    task.processState = "not-started";
    this.store.putTask(task);
    this.delivery({
      key: `dependency:${task.id}`,
      taskId: task.id,
      from: task.member,
      to: "lead",
      kind: "failure",
      summary: reason,
    });
  }
  memberRequest(token: string, request: any) {
    const identity = this.tokens.get(token);
    const task = identity ? this.store.task(identity.taskId) : undefined;
    if (!identity || !task || terminal(task) || task.epoch !== identity.epoch)
      throw new Error("Stale or unauthorized member execution");
    const member = this.store.member(task.memberId)!;
    if (request.op === "ping") return { ok: true };
    if (typeof request.id !== "string" || request.id.length > 160)
      throw new Error("A bounded request identity is required");
    const key = `request:${task.id}:${task.epoch}:${request.id}`,
      hash = createHash("sha256").update(JSON.stringify(request)).digest("hex"),
      previous = this.store.get<{ hash: string; result: unknown }>(key);
    if (previous) {
      if (previous.hash !== hash)
        throw new Error("Request identity reused with different content");
      return previous.result;
    }
    return this.store.transaction(() => {
      let result: unknown;
      if (request.op === "goal-context") {
        result = this.assignedGoalContext(
          task,
          request.section,
          request.offset,
          request.limit,
        );
      } else if (request.op === "collect") {
        const target = this.store.task(request.taskId);
        if (!target || (target.parentId !== task.id && target.id !== task.id))
          throw new Error(
            "Only this task and its direct descendants can be collected",
          );
        result = {
          task: target,
          result: target.resultPath
            ? this.store.readArtifact(target.resultPath)
            : undefined,
        };
      } else if (request.op === "wait") {
        const children = this.store.children(task.id);
        const unseen = this.store
          .deliveries(task.member)
          .some(
            (d) =>
              d.state === "pending" &&
              d.taskId &&
              children.some((child) => child.id === d.taskId),
          );
        if (!children.some((child) => !terminal(child)) && !unseen)
          throw new Error(
            "No unfinished or unreviewed downstream work remains. Finish the task or assign new approved work instead of waiting again.",
          );
        task.state = "waiting";
        task.updatedAt = this.now();
        this.store.putTask(task);
        result = { waiting: true, taskId: task.id };
      } else if (request.op === "message") {
        const to = request.to;
        if (
          typeof to !== "string" ||
          typeof request.message !== "string" ||
          request.message.length > 16000
        )
          throw new Error("Invalid teammate message");
        if (to !== "lead" && !member.allow.includes(to))
          throw new Error(`Communication denied: ${member.name} -> ${to}`);
        if (to === "lead" || request.operation === "note") {
          const kind = ["decision", "failure", "progress"].includes(
            request.kind,
          )
            ? request.kind
            : "progress";
          result = this.delivery({
            key: `note:${task.id}:${task.epoch}:${request.id}`,
            taskId: task.id,
            from: member.name,
            to,
            kind,
            summary: request.message,
          });
        } else
          result = this.dispatch(to, request.message, {
            parentId: task.id,
            timeoutMs: request.timeoutMs,
            timeoutPolicy: request.timeoutPolicy,
            queueTimeoutMs: request.queueTimeoutMs,
          });
      } else if (request.op === "decision") {
        task.state = "waiting";
        task.blockedReason = cleanText(String(request.reason ?? ""), 2000);
        if (!task.blockedReason.trim())
          throw new Error("Decision reason required");
        this.store.putTask(task);
        result = this.delivery({
          key: `decision:${task.id}:${task.epoch}:${request.id}`,
          taskId: task.id,
          from: member.name,
          to: "lead",
          kind: "decision",
          summary: task.blockedReason,
        });
      } else throw new Error("Unsupported member operation");
      this.store.set(key, { hash, result });
      this.changed();
      return result;
    });
  }
  validWake(batchId: string, generation: number) {
    return (
      generation === this.generation &&
      this.reservation?.batchId === batchId &&
      this.store
        .deliveries("lead")
        .some(
          (d) =>
            d.batchId === batchId && ["leased", "admitted"].includes(d.state),
        )
    );
  }
  acknowledgeProcess(taskId: string) {
    const task = this.store.task(taskId);
    if (!task) throw new Error("Unknown task");
    return this.reconcileProcesses(
      [{ taskId, expectedEpoch: task.epoch }],
      "Explicit user confirmation through /mission reconcile",
      "user",
    );
  }
  reconcileProcesses(
    requests: Array<{ taskId: string; expectedEpoch: number }>,
    evidence: string,
    actor: "lead" | "user" = "lead",
  ) {
    if (
      !requests.length ||
      requests.length > 100 ||
      new Set(requests.map((r) => r.taskId)).size !== requests.length
    )
      throw new Error("Provide 1..100 distinct task identities");
    const receipt = cleanText(evidence, 2000).trim();
    if (receipt.length < 8)
      throw new Error(
        "Record concrete stopped-process evidence after inspecting host processes and saved artifacts",
      );
    const result = this.store.transaction(() => {
      const tasks = requests.map((request) => {
        const task = this.store.task(request.taskId);
        if (!task || task.epoch !== request.expectedEpoch)
          throw new Error(`Task identity or epoch changed: ${request.taskId}`);
        if (!terminal(task) || this.live.has(task.id))
          throw new Error(`Execution is still active or stopping: ${task.id}`);
        if (!["unknown", "stopped", "not-started"].includes(task.processState))
          throw new Error(`Process state is not reconcilable: ${task.id}`);
        return task;
      });
      return tasks.map((task) => {
        const alreadyStopped = task.processState !== "unknown";
        if (!alreadyStopped) {
          task.processState = "stopped";
          task.updatedAt = this.now();
          this.store.putTask(task);
          this.store.event(`${actor}.process-reconciled`, task.id, {
            epoch: task.epoch,
            evidence: receipt,
            verification: "caller-attested",
          });
        }
        return {
          taskId: task.id,
          epoch: task.epoch,
          processState: task.processState,
          alreadyStopped,
        };
      });
    });
    this.turnActed = true;
    this.changed();
    return {
      reconciled: result,
      note: "Process reconciliation records the caller's inspection evidence. It neither kills processes nor replays commands; explicitly create a new attempt when appropriate.",
    };
  }
  resumeProgress(goalId: string, expectedRevision: number, reason: string) {
    const m = this.store.mission();
    if (!m || m.id !== goalId || (m.revision ?? 0) !== expectedRevision)
      throw new Error("Goal identity or revision changed");
    if (
      m.humanPaused ||
      this.userHold ||
      this.store.get("relocationHold") ||
      m.decision ||
      m.blocker?.kind === "budget" ||
      this.checkBudget(m)
    )
      throw new Error(
        "User pause, workspace hold, business decision or budget renewal requires its own authorized control",
      );
    if (m.status === "active") return m;
    if (m.status !== "attention" || m.blocker?.kind !== "no_progress")
      throw new Error(
        "Only runtime no-progress attention can be resumed by this model tool",
      );
    if (reason.trim().length < 8)
      throw new Error(
        "Explain the inspected blocker and the next approved step",
      );
    m.status = "active";
    m.blocker = undefined;
    m.reason = undefined;
    m.emptyTurns = 0;
    m.nextContinueAt = this.now() + 1000;
    m.updatedAt = this.now();
    this.store.set("mission", m);
    this.store.event("lead.progress-resumed", m.id, {
      revision: expectedRevision,
      reason: cleanText(reason, 2000),
    });
    this.turnActed = true;
    this.changed();
    return m;
  }
  queueCompaction() {
    const m = this.store.mission();
    if (
      !this.options.compact ||
      this.closing ||
      this.userHold ||
      m?.humanPaused ||
      this.store.get("relocationHold")
    )
      throw new Error(
        "Compaction cannot be queued under a user/workspace hold or without an attached host",
      );
    if (!this.compactionQueued)
      this.store.event(
        "lead.compaction-requested",
        m?.id ?? this.options.sessionId,
      );
    this.compactionQueued = true;
    this.changed();
    return {
      queued: true,
      note: "This lead run ends; the host compacts after settlement and idle. Original history is retained if compaction fails.",
    };
  }
  async pauseForRelocation() {
    this.relocating = true;
    this.userHold = true;
    this.generation++;
    this.reservation = undefined;
    this.store.set("relocationHold", true);
    const mission = this.store.mission();
    if (mission && !["complete", "stopped"].includes(mission.status))
      await this.userControl("pause");
    await Promise.all(
      this.store
        .tasks(true)
        .filter((t) => !t.parentId)
        .map((t) =>
          this.cancelTask(
            t.id,
            "Workspace relocation stopped this execution; inspect evidence before a new attempt",
          ),
        ),
    );
    if (this.store.members().some((m) => this.store.hasUnknownProcess(m.id)))
      throw new Error(
        "Some process termination is unknown. Inspect leftovers and /mission reconcile before changing workspace.",
      );
  }
  finishRelocation() {
    this.relocating = false;
  }
  async close() {
    if (this.closing) return;
    this.closing = true;
    this.syncActivity(true);
    this.generation++;
    if (this.timer) clearTimeout(this.timer);
    this.reservation = undefined;
    const interrupted = this.store
      .tasks(true)
      .filter((t) => t.state === "running" || t.state === "waiting");
    for (const task of interrupted) {
      task.state = "interrupted";
      task.epoch++;
      task.error = "Runtime closed; reconcile before a new attempt";
      task.processState = "unknown";
      this.store.putTask(task);
    }
    const executions = new Map(this.live);
    for (const live of executions.values()) live.controller.abort();
    await Promise.allSettled(
      [...executions.values()].map(async (live) => {
        await live.worker?.stop();
        await live.done;
        await live.deliveryPromise;
      }),
    );
    for (const task of interrupted) {
      task.processState =
        executions.get(task.id)?.processState ??
        (executions.has(task.id) ? "unknown" : "stopped");
      this.store.putTask(task);
    }
    this.store.close();
  }
}
