import type { Store } from "./store.ts";
import type { ActivityClock, Mission } from "./types.ts";

/** Accumulate runnable intervals; never charge a process-offline gap after restore. */
export class MissionActivityClock {
  private store: Store;
  private now: () => number;
  private value?: ActivityClock;
  private lastAt: number;
  private savedAt: number;
  private liveMissionId?: string;
  private restoredMissionId?: string;
  constructor(store: Store, now: () => number) {
    this.store = store;
    this.now = now;
    this.lastAt = this.savedAt = now();
    this.restoredMissionId = store.mission()?.id;
    const saved = store.get<ActivityClock>("missionActivityClock");
    if (saved?.state === "ended") this.value = { ...saved };
    else if (saved)
      this.value = {
        ...saved,
        state: "offline",
        reason: "Runtime restored; offline time is excluded",
        updatedAt: now(),
      };
  }
  observe(
    m: Mission | undefined,
    state: ActivityClock["state"],
    reason: string,
    configuredTimeLimit: number,
    force = false,
  ) {
    const at = this.now();
    if (!m) {
      this.liveMissionId = undefined;
      this.lastAt = at;
      return;
    }
    if (
      this.value?.missionId === m.id &&
      this.value.state === "ended" &&
      state === "ended"
    ) {
      this.liveMissionId = m.id;
      this.lastAt = at;
      return;
    }
    let changed = false;
    if (this.value?.missionId !== m.id) {
      if (this.value)
        this.store.set(`goalActivityClock:${this.value.missionId}`, this.value);
      const retained = this.store.get<ActivityClock>(
        `goalActivityClock:${m.id}`,
      );
      // For an explicitly configured pre-upgrade cap, retain its conservative old charge.
      // Without such a cap, old wall time is not invented as measured activity.
      const legacyEstimate =
        this.restoredMissionId === m.id &&
        configuredTimeLimit > 0 &&
        at > m.budgetStartedAt;
      const estimate = legacyEstimate ? Math.max(0, at - m.budgetStartedAt) : 0;
      this.value = {
        missionId: m.id,
        budgetStartedAt: m.budgetStartedAt,
        activeMs: estimate,
        cycleActiveMs: estimate,
        coverageStartedAt: at,
        legacyEstimate,
        ...retained,
        state,
        reason,
        updatedAt: at,
      };
      this.lastAt = at;
      changed = true;
    } else {
      if (this.liveMissionId === m.id && this.value.state === "running") {
        const delta = Math.max(0, at - this.lastAt);
        this.value.activeMs += delta;
        this.value.cycleActiveMs += delta;
      }
      if (this.value.budgetStartedAt !== m.budgetStartedAt) {
        this.value.budgetStartedAt = m.budgetStartedAt;
        this.value.cycleActiveMs = 0;
        changed = true;
      }
      changed ||= this.value.state !== state || this.value.reason !== reason;
      this.value.state = state;
      this.value.reason = reason;
      this.value.updatedAt = at;
    }
    this.liveMissionId = m.id;
    this.lastAt = at;
    if (changed || force || at - this.savedAt >= 15000) {
      this.store.set("missionActivityClock", this.value);
      this.store.set(`goalActivityClock:${m.id}`, this.value);
      this.savedAt = at;
    }
  }
  snapshot(m?: Mission): ActivityClock | undefined {
    return m && this.value?.missionId === m.id ? { ...this.value } : undefined;
  }
}
