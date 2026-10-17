import fs from "node:fs";
import path from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { Store } from "./store.ts";
import { cleanText } from "./public.ts";
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
} from "./types.ts";

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
  now?: () => number;
}
/** Owns work independently of model-controlled Goal and reminder tools. */
export class MissionKernel {
  store: Store;
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
      this.userHold = Boolean(this.store.get("relocationHold"));
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
    });
    if (background) this.loop();
    this.changed();
  }
  private changed() {
    try {
      this.options.onChange?.();
    } catch (error) {
      this.options.notify?.(`Mission UI error: ${String(error)}`);
    }
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
    if (!mission?.humanPaused && !this.store.get("relocationHold"))
      this.userHold = false;
    if (mission?.status === "waiting_user" && !mission.humanPaused) {
      mission.status = "active";
      mission.reason = undefined;
      mission.emptyTurns = 0;
      mission.updatedAt = this.now();
      this.store.set("mission", mission);
      this.store.event("decision.human-input", mission.id);
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
    const archived = this.store.archiveMission(mission, this.now(), reason);
    if (retainClosed) this.store.set("mission", archived);
    this.cleanTemporaryMembers(reason);
    this.userHold = false;
    this.changed();
    return archived;
  }
  setGoal(objective: string, criteria: string[] = []) {
    if (!objective.trim()) throw new Error("Goal objective is required");
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
    this.turnActed = true;
    this.changed();
    return m;
  }
  updateGoal(objective: string, criteria: string[] = [], goalId?: string) {
    if (!objective.trim()) throw new Error("Goal objective is required");
    const m = this.store.mission();
    if (!m || ["complete", "stopped"].includes(m.status))
      throw new Error("No unfinished goal to update");
    if (goalId && goalId !== m.id) throw new Error("Goal identity changed");
    m.objective = cleanText(objective, 8000);
    m.criteria = (criteria.length ? criteria : [objective])
      .slice(0, 30)
      .map((x) => cleanText(x, 2000));
    m.revision = (m.revision ?? 0) + 1;
    m.status = "active";
    m.humanPaused = false;
    m.reason = "Goal definition updated; prior evidence was cleared.";
    m.evidence = undefined;
    m.budgetStartedAt = this.now();
    m.turns = 0;
    m.outputTokens = 0;
    m.emptyTurns = 0;
    m.nextContinueAt = this.now() + 1000;
    m.updatedAt = this.now();
    this.userHold = false;
    this.store.set("relocationHold", false);
    this.store.set("mission", m);
    this.store.event("mission.updated", m.id, { revision: m.revision });
    this.turnActed = true;
    this.changed();
    return m;
  }
  async stopGoal(goalId?: string, reason = "Stopped by the lead") {
    const m = this.store.mission();
    if (!m || ["complete", "stopped"].includes(m.status))
      throw new Error("No unfinished goal to stop");
    if (goalId && goalId !== m.id) throw new Error("Goal identity changed");
    m.status = "stopped";
    m.humanPaused = true;
    m.reason = cleanText(reason, 2000);
    this.generation++;
    this.userHold = true;
    this.reservation = undefined;
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
  complete(evidence: Array<{ criterion: number; evidence: string }>) {
    const m = this.store.mission();
    if (!m || m.status !== "active")
      throw new Error("No active mission to complete");
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
            ["pending", "leased"].includes(d.state),
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
      Pick<Member, "model" | "thinkingLevel" | "allow" | "role" | "workspace">
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
    } = {},
  ): Task {
    if (this.relocating)
      throw new Error("Workspace relocation is in progress; new work is held");
    const member = this.store.member(name);
    if (!member) throw new Error(`Unknown member: ${name}`);
    if (this.store.hasUnknownProcess(member.id))
      throw new Error(
        "A previous execution has unknown process state. Inspect and stop any remaining processes, then use /mission reconcile <taskId> before a new attempt.",
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
    const mission = this.ensureMission(message);
    if (mission.humanPaused || mission.status !== "active")
      throw new Error(
        `Mission ${mission.status}: ${mission.reason ?? "resume through /mission resume"}`,
      );
    const timeout = options.timeoutMs ?? this.settings.taskTimeoutMs;
    if (!Number.isSafeInteger(timeout) || timeout < 1000 || timeout > 3_600_000)
      throw new Error("timeoutMs must be between 1000 and 3600000");
    const id = randomUUID(),
      now = this.now();
    const t: Task = {
      id,
      missionId: mission.id,
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
      timeoutMs: timeout,
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
      { attemptOf: old.id, timeoutMs: old.timeoutMs },
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
        if (t && t.state === "cancelled") {
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
      if (delivery.scheduleId === id && delivery.state === "pending") {
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
    if (!m) {
      if (action === "resume" && this.store.get("relocationHold")) {
        this.store.set("relocationHold", false);
        this.userHold = false;
        this.relocating = false;
        await this.tick();
        return;
      }
      throw new Error("No mission");
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
      for (const delivery of this.store.deliveries("lead")) {
        if (
          delivery.state === "pending" &&
          (!delivery.missionId || delivery.missionId === m.id)
        ) {
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
  requireDecision(reason: string) {
    const m = this.store.mission();
    if (!m) throw new Error("No mission");
    m.status = "waiting_user";
    m.reason = cleanText(reason, 2000);
    m.updatedAt = this.now();
    this.store.set("mission", m);
    this.options.notify?.(`需要用户裁决：${m.reason}`);
    this.turnActed = true;
    this.changed();
    return m;
  }
  leadStarted(wake?: Wake) {
    this.leadFailed = false;
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
  }
  includeWake(batchId: string) {
    if (this.reservation?.batchId === batchId) this.wakeIncluded = true;
  }
  includeCollected(ids: string[]) {
    for (const d of this.store.deliveries("lead"))
      if (
        ids.includes(d.id) &&
        d.state !== "cancelled" &&
        d.state !== "observed"
      ) {
        d.state = "admitted";
        d.batchId = "collection";
        this.store.putDelivery(d);
        this.collected.add(d.id);
      }
  }
  leadMessage(error: boolean, outputTokens = 0) {
    this.leadFailed = error;
    const m = this.store.mission();
    if (m && m.status === "active") {
      m.outputTokens += outputTokens;
      this.store.set("mission", m);
    }
  }
  leadActed() {
    this.turnActed = true;
  }
  leadSettled(aborted = false) {
    const reserved = this.reservation;
    this.reservation = undefined;
    if (aborted) this.userHold = true;
    if (reserved) {
      for (const d of this.store.deliveries("lead"))
        if (
          d.batchId === reserved.batchId &&
          ["leased", "admitted"].includes(d.state)
        ) {
          if (!aborted && !this.leadFailed && this.wakeIncluded) {
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
        d.state = !aborted && !this.leadFailed ? "observed" : "pending";
        d.batchId = undefined;
        d.nextAttemptAt = this.now() + this.settings.retryBaseMs;
        this.store.putDelivery(d);
      }
    this.collected.clear();
    const m = this.store.mission();
    if (m && m.status === "active") {
      if (reserved) m.turns++;
      m.emptyTurns =
        reserved && !this.turnActed && !this.store.tasks(true).length
          ? m.emptyTurns + 1
          : 0;
      m.nextContinueAt = this.now() + 1500;
      m.updatedAt = this.now();
      if (m.emptyTurns >= 3) {
        m.status = "attention";
        m.reason =
          "Three autonomous turns made no task or goal progress. Review /mission status and resume explicitly.";
        this.options.notify?.(m.reason);
      }
      this.store.set("mission", m);
    }
    this.changed();
  }
  snapshot() {
    const m = this.store.mission();
    return {
      mission: m,
      members: this.store.members(),
      tasks: this.store.tasks(),
      deliveries: this.store
        .deliveries("lead")
        .filter((d) => d.state !== "cancelled"),
      schedules: this.store.schedules(),
      lifecycle: this.store.archiveCounts(),
      maintenance: !this.closing,
      held: this.userHold,
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
      `Mission ${m.id}: ${m.status}. ${m.objective}`,
      `Acceptance: ${m.criteria.map((x, i) => `${i + 1}. ${x}`).join(" | ")}`,
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
      if (mission?.status === "active") {
        if (
          now - mission.budgetStartedAt >= this.settings.maxMissionMs ||
          mission.turns >= this.settings.maxAutonomousTurns ||
          mission.outputTokens >= this.settings.maxOutputTokens
        ) {
          mission.status = "attention";
          mission.reason =
            "Mission continuation budget reached. Work/results are retained; /mission resume grants a new budget.";
          this.store.set("mission", mission);
          this.options.notify?.(mission.reason);
        }
      }
      if (mission?.status === "active" && !mission.humanPaused) {
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
          if (task.phase === "work" && now - task.createdAt >= task.timeoutMs) {
            this.finishWithoutWorker(
              task,
              "Queue deadline exceeded; no member process was started",
            );
            continue;
          }
          if (this.live.size >= this.settings.maxParallel) break;
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
        if (now - mission.lastReportAt >= this.settings.progressIntervalMs) {
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
      if (
        mission?.status === "active" &&
        this.store
          .deliveries("lead")
          .some(
            (d) =>
              d.state === "pending" &&
              (!d.missionId || d.missionId === mission!.id) &&
              d.attempts >= this.settings.maxWakeAttempts,
          )
      ) {
        mission.status = "attention";
        mission.reason =
          "Automatic wake attempts failed. Results remain on disk; review /mission status and resume explicitly.";
        this.store.set("mission", mission);
        this.options.notify?.(mission.reason);
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
      m?.status === "attention" ||
      this.reservation ||
      !this.options.isLeadIdle()
    )
      return;
    const pending = this.store
      .deliveries("lead")
      .filter(
        (d) =>
          d.state === "pending" &&
          (!d.missionId || d.missionId === m?.id) &&
          d.nextAttemptAt <= this.now() &&
          d.attempts < this.settings.maxWakeAttempts &&
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
    this.wakeIncluded = false;
    try {
      this.options.wake(this.reservation);
    } catch (error) {
      this.leadFailed = true;
      this.leadSettled(false);
      this.options.notify?.(
        `Wake submission failed; retained for retry: ${String(error)}`,
      );
    }
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
    const timeout = setTimeout(
      () => controller.abort(new Error("Task execution timeout")),
      task.timeoutMs,
    );
    timeout.unref?.();
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
        clearTimeout(timeout);
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
      if (request.op === "collect") {
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
    if (!task || task.processState !== "unknown" || !terminal(task))
      throw new Error(
        "Only a terminal task with unknown process state can be reconciled",
      );
    task.processState = "stopped";
    this.store.putTask(task);
    this.store.event("user.process-reconciled", task.id);
    this.changed();
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
