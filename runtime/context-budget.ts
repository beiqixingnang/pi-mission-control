import { createHash } from "node:crypto";

export interface ContextBudgetModel {
  provider?: string;
  id?: string;
  baseUrl?: string;
  contextWindow?: number;
  maxTokens?: number;
}
export interface ContextBudgetPolicy {
  inputLimitTokens?: number;
  learnedLimitTokens?: number;
  rejectedRequest?: string;
}
/** This is a conservative request budget, not a measurement of a provider's exact limit. */
export function contextBudget(
  model: ContextBudgetModel = {},
  policy: ContextBudgetPolicy = {},
) {
  const window = Math.max(0, Math.floor(model.contextWindow ?? 0));
  const outputReserve = Math.min(
    model.maxTokens ?? 16384,
    Math.floor(window / 4),
  );
  const safetyReserve = Math.min(
    32768,
    Math.max(512, Math.floor(window * 0.05)),
  );
  const configuredInputLimit = Math.max(
    0,
    window - outputReserve - safetyReserve,
  );
  const limits = [
    configuredInputLimit,
    policy.inputLimitTokens,
    policy.learnedLimitTokens,
  ].filter((n): n is number => Number.isSafeInteger(n) && n! > 0);
  const inputLimitTokens = configuredInputLimit > 0 ? Math.min(...limits) : 0;
  const handoffReserve = Math.min(
    32768,
    Math.max(512, Math.floor(inputLimitTokens * 0.08)),
  );
  return {
    model: `${model.provider ?? "unknown"}/${model.id ?? "unknown"}`,
    configuredWindowTokens: window,
    outputReserveTokens: outputReserve,
    safetyReserveTokens: safetyReserve,
    inputLimitTokens,
    prepareAtTokens: Math.floor(inputLimitTokens * 0.75),
    repairBelowTokens: Math.max(0, inputLimitTokens - handoffReserve),
    handoffReserveTokens: handoffReserve,
    policy,
    kind: "conservative budget; provider usage and limits may differ",
  };
}
export function contextBudgetKey(model: ContextBudgetModel = {}) {
  return (
    "context-budget:" +
    createHash("sha256")
      .update(JSON.stringify([model.provider, model.id, model.baseUrl]))
      .digest("hex")
      .slice(0, 24)
  );
}

/** Lower only this route's local budget after an actual context rejection; never on a 429. */
export function rejectedContextBudget(
  policy: ContextBudgetPolicy,
  tokens: number,
  request: string,
): ContextBudgetPolicy {
  if (
    !Number.isFinite(tokens) ||
    tokens < 1024 ||
    policy.rejectedRequest === request
  )
    return policy;
  const learned = Math.max(512, Math.floor(tokens * 0.85));
  return {
    ...policy,
    learnedLimitTokens: Math.min(policy.learnedLimitTokens ?? learned, learned),
    rejectedRequest: request,
  };
}
