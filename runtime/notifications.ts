import type { Delivery } from "./types.ts";

export interface NotificationPolicy {
  taskSuccess: boolean;
  taskFailure: boolean;
  goalReadyLevels: number[];
  goalAcceptedLevels: number[];
}
export function resolveNotificationPolicy(
  raw: Partial<NotificationPolicy> = {},
): NotificationPolicy {
  const policy = {
    taskSuccess: true,
    taskFailure: true,
    goalReadyLevels: [],
    goalAcceptedLevels: [],
    ...raw,
  };
  for (const key of ["taskSuccess", "taskFailure"] as const)
    if (typeof policy[key] !== "boolean")
      throw new Error(`${key} must be a boolean`);
  for (const key of ["goalReadyLevels", "goalAcceptedLevels"] as const) {
    const levels = policy[key];
    if (
      !Array.isArray(levels) ||
      levels.length > 12 ||
      levels.some(
        (level) => !Number.isInteger(level) || level < 1 || level > 12,
      )
    )
      throw new Error(
        `${key} must contain goal levels 1..12; level 1 is the main goal`,
      );
    policy[key] = [...new Set(levels)].sort((a, b) => a - b);
  }
  return policy;
}
export function triggersLead(delivery: Delivery, policy: NotificationPolicy) {
  if (delivery.to !== "lead") return true;
  if (delivery.kind === "result" && delivery.taskId) return policy.taskSuccess;
  if (delivery.kind === "failure" && delivery.taskId) return policy.taskFailure;
  if (delivery.kind === "goal" && delivery.goalEvent === "submitted")
    return false;
  if (delivery.kind === "goal")
    return (
      delivery.goalEvent === "ready"
        ? policy.goalReadyLevels
        : policy.goalAcceptedLevels
    ).includes(delivery.goalDepth ?? 0);
  return delivery.kind !== "progress" || delivery.from === "maintenance";
}
