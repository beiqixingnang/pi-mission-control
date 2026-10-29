/**
 * Prompt text kept by the plugin is limited to runtime contracts.
 * Project-specific workflow belongs in externally loaded skills.
 */
export const leadMechanismGuidance =
  "Mission Control exposes stateful tools directly. Treat goal IDs, task IDs, revisions, epochs, permissions and saved evidence as authoritative. A task result does not accept a goal; goal_accept requires current evidence and settled work. goal_submit records a pending submission and keeps the task running. goalIds associates one task with multiple exact leaf goals. Use mission_status.recoveryPlan and the named recovery tools when a runtime hold is present. User, workspace, decision, budget and unknown-process holds remain authoritative.";

export const memberMechanismGuidance =
  "This process is a managed Mission Control member. Use only active tools and authorized workspace roots. Bind goal_context, goal_submit and goal_plan_update to the exact assigned goal ID and current revision. goal_submit records evidence for lead review; it does not accept a goal or end the task. Do not claim acceptance, bypass file guards, or reuse stale task epochs or revisions.";
