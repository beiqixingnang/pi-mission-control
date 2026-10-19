import { randomUUID } from "node:crypto";
import type { Store } from "./store.ts";
import type { Recovery, Settings } from "./types.ts";
import { cleanText } from "./public.ts";

/** One durable failure episode shared by native retry, supplemental retry and outbox probes. */
export class LeadRecovery {
  private admittedId?: string;
  private store: Store;
  private settings: () => Settings;
  private now: () => number;
  constructor(store: Store, settings: () => Settings, now: () => number) {
    this.store = store;
    this.settings = settings;
    this.now = now;
  }
  current(): Recovery | undefined {
    const value = this.store.get<Recovery>("leadRecovery"),
      mission = this.store.mission();
    return value && value.missionId === mission?.id ? value : undefined;
  }
  private save(value: Recovery, event?: string) {
    const previousPhase = this.store.get<Recovery>("leadRecovery")?.phase;
    value.updatedAt = this.now();
    this.store.set("leadRecovery", value);
    if (event)
      this.store.event(`recovery.${event}`, value.id, {
        kind: value.kind,
        phase: value.phase,
        previousPhase,
        requests: value.requests,
        probes: value.probes,
        missionId: value.missionId,
        revision: value.revision,
      });
    return value;
  }
  revise(revision: number) {
    const value = this.current();
    if (value && value.revision !== revision) {
      value.revision = revision;
      this.save(value, "revision-updated");
    }
  }
  fail(kind: Recovery["kind"], reason: string) {
    let value = this.current();
    const fresh = !value;
    value ??= {
      id: randomUUID(),
      missionId: this.store.mission()?.id,
      revision: this.store.mission()?.revision ?? 0,
      kind,
      phase: "cooldown",
      reason: "",
      requests: 0,
      probes: 0,
      openedAt: this.now(),
      updatedAt: this.now(),
    };
    if (this.admittedId !== value.id) value.requests++;
    this.admittedId = undefined;
    // An overflow requires a changed context, even if the episode began as a transport failure.
    if (kind === "context" || value.kind !== "context" || value.compactionId)
      value.kind = kind;
    value.reason = cleanText(reason, 1500);
    value.phase = value.kind === "context" ? "waiting_compaction" : "cooldown";
    value.nextAt =
      this.now() +
      Math.min(
        this.settings().recoveryCooldownMs * 2 ** Math.min(value.probes, 5),
        3_600_000,
      );
    return this.save(value, fresh ? "opened" : undefined);
  }
  /** Called for every context build, including native and extension retries. */
  admit(automatic: boolean): boolean {
    this.admittedId = undefined;
    const value = this.current();
    if (!value) return true;
    if (automatic && value.requests >= this.settings().recoveryMaxRequests) {
      if (value.phase !== "exhausted") {
        value.phase = "exhausted";
        this.save(value, "exhausted");
      }
      return false;
    }
    value.requests++;
    this.admittedId = value.id;
    this.save(value);
    return true;
  }
  settledFailure() {
    const value = this.current();
    if (!value) return;
    if (
      value.kind !== "context" &&
      (value.requests >= this.settings().recoveryMaxRequests ||
        value.probes >= this.settings().maxWakeAttempts)
    ) {
      value.phase = "exhausted";
      value.nextAt = undefined;
      this.save(value, "exhausted");
    } else this.save(value, "deferred");
  }
  ready(): boolean {
    const value = this.current();
    if (!value) return true;
    if (
      value.phase === "cooldown" &&
      (value.nextAt ?? Infinity) <= this.now()
    ) {
      if (
        value.requests >= this.settings().recoveryMaxRequests ||
        value.probes >= this.settings().maxWakeAttempts
      ) {
        value.phase = "exhausted";
        this.save(value, "exhausted");
      } else {
        value.phase = "ready";
        this.save(value);
      }
    }
    return value.phase === "ready";
  }
  probe() {
    const value = this.current();
    if (!value) return;
    value.phase = "probing";
    value.probes++;
    this.save(value, "probe");
  }
  claimCompaction(): boolean {
    const value = this.current();
    if (
      !value ||
      value.kind !== "context" ||
      value.phase !== "waiting_compaction" ||
      value.compactionAttempted
    )
      return false;
    this.compactionStarted();
    return true;
  }
  compactionStarted() {
    const value = this.current();
    if (!value || value.kind !== "context") return;
    value.compactionAttempted = true;
    value.nextAt = undefined;
    value.phase = "compacting";
    this.save(value, "compaction-started");
  }
  compacted(id: string) {
    const value = this.current();
    if (!value || value.kind !== "context" || value.compactionId === id)
      return false;
    value.compactionId = id;
    value.phase =
      value.requests < this.settings().recoveryMaxRequests
        ? "ready"
        : "exhausted";
    value.nextAt = this.now();
    this.save(value, "context-repaired");
    return value.phase === "ready";
  }
  compactionFailed(reason: string) {
    const value = this.current();
    if (!value || value.kind !== "context") return;
    if (
      !(
        value.phase === "compaction_failed" &&
        /^Compaction (?:cancelled|failed|failed or was cancelled)$/i.test(
          reason,
        )
      )
    )
      value.reason = cleanText(reason, 1500);
    value.phase = "compaction_failed";
    value.nextAt = undefined;
    value.compactionAttempted = true;
    this.save(value, "compaction-failed");
  }
  succeeded() {
    const value = this.current();
    if (!value) return;
    this.save(value, "succeeded");
    this.store.unset("leadRecovery");
    this.admittedId = undefined;
  }
  restart() {
    const value = this.current();
    if (
      value?.kind === "context" &&
      (value.phase === "compacting" ||
        (value.phase === "waiting_compaction" && value.compactionAttempted))
    ) {
      value.phase = "compaction_failed";
      value.nextAt = undefined;
      value.reason =
        value.reason === "Compaction cancelled"
          ? "Previous compaction did not complete. Inspect compaction_model diagnostics and run /compact to resume cached work."
          : value.reason;
      this.save(value, "compaction-interrupted");
    }
    if (value?.phase === "probing") {
      value.phase = "cooldown";
      value.nextAt = Math.max(
        value.nextAt ?? 0,
        this.now() + this.settings().recoveryCooldownMs,
      );
      this.save(value, "deferred");
    }
  }
}
