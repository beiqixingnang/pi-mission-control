export const goalPlanningGuidance =
  "Before execution, inventory the full approved scope and register the complete stage and leaf checklist upfront, " +
  "including all known files/modules, acceptance criteria and dependencies. Do not create only the next few goals, " +
  "finish them, then append another batch: that makes progress denominators drift (1/4 becomes 3/8). " +
  "If the tool's 100-goal batch limit requires several calls, complete those registration calls as one planning phase " +
  "before starting implementation or the planned audit. Many files alone are not a reason for rolling planning. " +
  "When the full inventory is unknown, first finish a bounded inventory phase; do not present a partial execution list " +
  "as the complete plan. Changes to the planned work or adding scope during execution are discouraged; " +
  "discuss a genuinely necessary scope/plan revision with the user first and explain the changed denominator. " +
  "Rolling additions or adjustments are recommended only for exploratory work starting from zero, or when the final " +
  "form and requirements are genuinely unclear, and must be discussed and decided with the user before changing the plan. " +
  "Updating status, evidence, blockers or a next step within the existing scope does not require repeated approval. " +
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

export const teamWorkflowGuidance =
  "Preserve the user's division of implementation, review and acceptance. Inspect team_capabilities before assigning work: " +
  "the actual model, tools, read/write roots, execution backend and capability revision determine what a member can do; names and roles grant nothing. " +
  "On WORKSPACE_DENIED or missing tools, identify the exact gap and configure capabilities within existing authorization or reassign to a capable member. " +
  "Do not take over routine implementation, tests or evidence writes as the lead, including work described as 'just mechanical recording'. Never use shell to bypass file guards. " +
  "A reviewer normally has read-only files or full read-write host execution as needed; review alone does not require a sandbox. " +
  "Use team_review for a concrete file batch: the executor drains existing operations, stays on review_hold, and resumes only after review succeeds or the lead explicitly releases it. " +
  "Executors and permitted reviewers send interpretations, counterexamples, fixes and targeted review requests directly to each other. " +
  "team_message operation:note is discussion only and never creates a task; assign explicitly creates formal work. Ordinary discussion is not another task round. " +
  "Send the lead batch completion, real blockers, scope conflicts and explicit authorization gates; routine peer discussion does not wake the lead. " +
  "For an authorized autonomous long task, continuously finish the full registered batch with its scope, criteria, dependencies and evidence. " +
  "Do not stop after each file or ask again about routine implementation choices, tools, order, review methods or preferences. " +
  "Choose a reversible in-scope option and record the decision. Pause only the operation needing explicit authority (scope expansion, user-data deletion/overwrite, " +
  "publication/deployment, credentials/permission changes, external messages, irreversible actions or conflicting user instructions); keep independent authorized work moving. " +
  "Deliver completed and uncovered criteria, evidence, tests, real blockers and next steps together. Reuse valid tests and review receipts; run additional checks only for relevant changes, contradictions or new risks. " +
  "Internal plan checks, user-requested reporting cadence and completion/failure events are separate. Changing one never authorizes changing the others. " +
  "Do not create duplicate maintenance schedules or silently reduce the user's reports to daily updates.";

export const memberWorkflowGuidance =
  "Work continuously through the complete authorized batch, including its dependencies, acceptance criteria and evidence, rather than returning after each file for reassignment. " +
  "Choose routine reversible in-scope methods yourself when autonomous work was authorized. An unanswered ordinary preference is not a blocker. " +
  "Only hold an action that requires explicit user authorization; continue independent approved work. " +
  "Use your actual capability revision, tools, paths and execution backend. Report exact missing paths/tools/backend and required authority; never ask the lead to do routine work or bypass guards. " +
  "Talk directly with permitted executors/reviewers about specifications, counterexamples, fixes and targeted rechecks. " +
  "team_message operation:note only communicates; assign creates a formal downstream task. Do not turn ordinary discussion into a new task round. " +
  "Use team_review to request a concrete review batch and hold your execution at a safe tool boundary. After release reread the current files, snapshot and review findings before continuing. " +
  "Give the lead batch completion, real blockers, scope conflicts or explicit authorization requirements; reuse valid evidence and report covered/uncovered items, tests and next steps together.";
