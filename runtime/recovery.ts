import { randomUUID } from "node:crypto";
import type { Store } from "./store.ts";
import type { Recovery, Settings } from "./types.ts";
import { cleanText } from "./public.ts";
import { providerFailureKind } from "./reconnect.ts";

// Custom summary failures are reported separately from Pi's generic cancel
// receipt. Only an explicit compaction cancellation represents user intent.
const cancelledCompaction = (reason: string) =>
  /^Compaction (?:cancelled|canceled)(?: by\b.*)?$|^Compaction failed or was cancelled$/i.test(
    reason,
  );

/** Durable failure bursts; exhausted bursts cool down rather than abandoning approved work. */
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
        failures: value.failures,
        burstFailures: value.burstFailures,
        burstProbes: value.burstProbes,
        cooldowns: value.cooldowns,
        nextAt: value.nextAt,
        missionId: value.missionId,
        revision: value.revision,
      });
    return value;
  }
  private delay(value: Recovery) {
    const backoff = Math.min(
      this.settings().recoveryCooldownMs *
        2 ** Math.min(value.cooldowns ?? 0, 6),
      3_600_000,
    );
    const retryAfter = value.reason.match(
      /retry[- ]after\s*[:=]?\s*(\d+(?:\.\d+)?)\s*(ms|milliseconds?|s|seconds?)?/i,
    );
    return Math.max(
      backoff,
      retryAfter
        ? Number(retryAfter[1]) *
            (retryAfter[2]?.toLowerCase().startsWith("m") ? 1 : 1000)
        : 0,
    );
  }
  private exhausted(value: Recovery) {
    if (value.phase === "exhausted" && value.nextAt !== undefined) return;
    value.phase = "exhausted";
    value.nextAt = this.now() + this.delay(value);
    value.cooldowns = (value.cooldowns ?? 0) + 1;
    this.save(value, "exhausted");
  }
  retryAllowed(): boolean {
    const value = this.current();
    return (
      !value ||
      (value.kind !== "context" &&
        value.phase !== "blocked" &&
        value.phase !== "exhausted" &&
        (value.burstFailures ?? value.requests) <
          this.settings().recoveryMaxRequests)
    );
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
      version: 2,
      failures: 0,
      burstFailures: 0,
      burstProbes: 0,
      cooldowns: 0,
      openedAt: this.now(),
      updatedAt: this.now(),
    };
    if (this.admittedId !== value.id) value.requests++;
    this.admittedId = undefined;
    value.failures = (value.failures ?? 0) + 1;
    value.burstFailures = (value.burstFailures ?? 0) + 1;
    // An overflow requires a changed context, even if the episode began as a transport failure.
    if (kind === "context" || value.kind !== "context" || value.compactionId)
      value.kind = kind;
    value.reason = cleanText(reason, 1500);
    value.phase =
      value.kind === "context"
        ? "waiting_compaction"
        : providerFailureKind(reason) === "external"
          ? "blocked"
          : "cooldown";
    if (value.kind === "context" && value.compactionId)
      value.compactionAttempted = false;
    value.nextAt =
      value.phase === "blocked" ? undefined : this.now() + this.delay(value);
    return this.save(value, fresh ? "opened" : undefined);
  }
  /** Called for every context build, including native and extension retries. */
  admit(automatic: boolean): boolean {
    this.admittedId = undefined;
    const value = this.current();
    if (!value) return true;
    if (
      automatic &&
      (value.phase === "blocked" ||
        value.phase === "exhausted" ||
        (value.burstFailures ?? value.requests) >=
          this.settings().recoveryMaxRequests)
    ) {
      if (value.phase !== "blocked") this.exhausted(value);
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
      value.phase !== "blocked" &&
      ((value.burstFailures ?? value.requests) >=
        this.settings().recoveryMaxRequests ||
        (value.burstProbes ?? value.probes) >= this.settings().maxWakeAttempts)
    ) {
      this.exhausted(value);
    } else this.save(value, "deferred");
  }
  ready(): boolean {
    const value = this.current();
    if (!value) return true;
    if (
      (value.phase === "cooldown" || value.phase === "exhausted") &&
      (value.nextAt ?? Infinity) <= this.now()
    ) {
      if (value.phase === "exhausted") {
        value.burstFailures = 0;
        value.burstProbes = 0;
      }
      value.phase = "ready";
      this.save(value, "retry-ready");
    }
    return value.phase === "ready";
  }
  probe() {
    const value = this.current();
    if (!value) return;
    value.phase = "probing";
    value.probes++;
    value.burstProbes = (value.burstProbes ?? 0) + 1;
    this.save(value, "probe");
  }
  claimCompaction(): boolean {
    const value = this.current();
    if (
      value?.phase === "compaction_failed" &&
      value.nextAt !== undefined &&
      value.nextAt <= this.now()
    ) {
      value.phase = "waiting_compaction";
      value.compactionAttempted = false;
    }
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
    value.phase = "ready";
    value.burstFailures = 0;
    value.burstProbes = 0;
    value.nextAt = this.now();
    this.save(value, "context-repaired");
    return value.phase === "ready";
  }
  compactionFailed(reason: string) {
    const value = this.current();
    if (!value || value.kind !== "context") return;
    if (
      value.phase === "compaction_failed" &&
      /^Compaction (?:cancelled|failed|failed or was cancelled)$/i.test(reason)
    )
      return;
    value.reason = cleanText(reason, 1500);
    value.phase = "compaction_failed";
    value.nextAt =
      cancelledCompaction(reason) || providerFailureKind(reason) !== "transient"
        ? undefined
        : this.now() + this.delay(value);
    if (value.nextAt !== undefined)
      value.cooldowns = (value.cooldowns ?? 0) + 1;
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
    if (value && value.version !== 2) {
      value.version = 2;
      // Old requests included healthy continuations: do not relabel them as failures.
      value.legacyRequests = value.requests;
      value.failures = value.burstFailures = value.burstProbes = 0;
      value.cooldowns = 0;
      if (
        (value.phase === "exhausted" ||
          (value.phase === "compaction_failed" &&
            !cancelledCompaction(value.reason) &&
            providerFailureKind(value.reason) === "transient")) &&
        value.nextAt === undefined
      )
        value.nextAt = this.now() + this.delay(value);
      if (
        value.kind !== "context" &&
        providerFailureKind(value.reason) === "external"
      ) {
        value.phase = "blocked";
        value.nextAt = undefined;
      }
      this.save(value, "migrated");
    }
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
