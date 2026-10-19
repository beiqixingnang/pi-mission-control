export const goalPlanningGuidance =
  "Use level 1 for the outcome and level 2 for execution stages or acceptance batches. " +
  "For code work, level 3 and deeper leaf goals must name concrete files or an explicitly listed file/module batch, " +
  "the specific change or check, its deliverable and acceptance criteria. 'Read all code' or 'rewrite the whole subsystem' " +
  "is too broad for a leaf. Register a lightweight scope with explicit items/files when known; first inventory an unknown " +
  "directory before planning its bounded batches. Group related files sensibly; do not create a goal for every function " +
  "or add arbitrary batch-size caps. Existing unscoped goals remain usable; refine them when replanning. " +
  "Record concise criterion-specific evidence once and reuse it while valid; file counts or changed-line counts alone " +
  "do not prove completion. Do not repeatedly recheck accepted evidence without a relevant change.";

export const delegationGuidance =
  "Choose member tools, workspace and deadlines from the actual task and existing user authorization. " +
  "Role names such as scout/reviewer do not imply file-only execution. Provide all capabilities needed for the approved " +
  "work; apply restrictions only for a concrete task requirement. Long code reviews, implementation and verification " +
  "normally need no total deadline (timeoutPolicy:none); use fixed with timeoutMs for a task that actually needs a limit. " +
  "Queue limits and individual command/API timeouts are separate. Respect explicit user limits. " +
  "Silence, heartbeat or the absence of a new file does not establish business progress or a stalled worker. " +
  "Let members choose routine methods within scope; avoid needless permission requests, rigid report formats and repeated checks.";
