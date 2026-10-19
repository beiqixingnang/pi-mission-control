/** Treat optional null/empty placeholders as absent without granting capabilities. */
export const optionalText = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim() ? value.trim() : undefined;

export function workspaceInput(raw: any, defaults: any = {}) {
  if (raw != null && (typeof raw !== "object" || Array.isArray(raw)))
    throw new Error("workspace must be an object or null");
  const value = raw ?? {};
  const access = optionalText(value.access) ?? defaults.access;
  const execution = optionalText(value.execution) ?? defaults.execution;
  let sandbox =
    value.sandbox ??
    (execution === defaults.execution ? defaults.sandbox : undefined);
  if (sandbox != null) {
    if (typeof sandbox !== "object" || Array.isArray(sandbox))
      throw new Error("workspace.sandbox must be an object or null");
    // Strict providers can fill every optional object with an empty profile.
    // An explicit sandbox request must still fail without a real image.
    if (!optionalText(sandbox.image) && execution !== "sandbox")
      sandbox = undefined;
    else {
      sandbox = Object.fromEntries(
        Object.entries(sandbox).filter(([, v]) => v != null),
      );
    }
  }
  if (sandbox && execution !== "sandbox")
    throw new Error(
      `workspace.execution=${execution ?? "default"} conflicts with a non-empty sandbox profile. For file-only review use execution:"files" and omit sandbox; container commands require execution:"sandbox". No mode was changed.`,
    );
  return {
    ...defaults,
    ...value,
    root: optionalText(value.root) ?? defaults.root,
    access,
    execution,
    extraReadRoots: value.extraReadRoots ?? defaults.extraReadRoots ?? [],
    sandbox,
  };
}

export function delegationInput(args: any) {
  for (const field of ["tasks", "chain"])
    if (args[field] != null && !Array.isArray(args[field]))
      throw new Error(`${field} must be an array or null`);
  const task = optionalText(args.task);
  const tasks = args.tasks?.length ? args.tasks : undefined;
  const chain = args.chain?.length ? args.chain : undefined;
  const choices = [Boolean(task), Boolean(tasks), Boolean(chain)].filter(
    Boolean,
  ).length;
  if (choices !== 1)
    throw new Error(
      choices
        ? "Supply only one non-empty task, tasks or chain. Empty arrays/null are ignored. No tasks were started."
        : "Supply a non-empty task, tasks or chain. Empty arrays/null do not contain work. No tasks were started.",
    );
  const inputs = (tasks ?? chain ?? [args]).map((input: any) => {
    if (!input || !optionalText(input.task))
      throw new Error(
        "Every delegated item requires a non-empty task. No tasks were started.",
      );
    return {
      ...input,
      task: input.task,
      agent: optionalText(input.agent) ?? optionalText(args.agent) ?? "worker",
      model: optionalText(input.model) ?? optionalText(args.model),
      workspace: workspaceInput(
        input.workspace,
        workspaceInput(args.workspace, { access: "read-write" }),
      ),
      timeoutPolicy: input.timeoutPolicy ?? args.timeoutPolicy,
      timeoutMs: input.timeoutMs ?? args.timeoutMs,
      queueTimeoutMs: input.queueTimeoutMs ?? args.queueTimeoutMs,
      tools: input.tools ?? args.tools,
      goalId: input.goalId ?? args.goalId,
    };
  });
  return { inputs, chain: Boolean(chain) };
}
