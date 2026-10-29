# Prompt boundary validation — 2026-10-29

This change separates Mission Control's runtime contract from project workflow.

The plugin now injects only mechanism facts: goal and task identities, revisions
and epochs, permissions, evidence, holds, recovery state, workspace boundaries,
and the distinction between `goal_submit` and `goal_accept`. Tool descriptions
describe the operation, arguments, result, and safety checks. Software
development sequencing, delegation habits, review conventions, and reporting
preferences belong in external skills.

The default Pi regression harness remains isolated from production. Its
persistent WSL conversation is reused so literal `/reload`, recovery, export,
and migration are exercised in one conversation. Each run archives completed
test members through the public `team_disband("*")` operation before creating a
new bounded fixture batch; this avoids exhausting the runtime's 100-member
identity limit while preserving the same conversation and process lifecycle.

Validation for candidate 2.14.0:

- Windows: 408 tests, 404 passed, 4 skipped, 0 failed; typecheck and resource checks passed.
- WSL: 408 tests, 403 passed, 5 skipped, 0 failed; typecheck and resource checks passed.
- Persistent WSL TUI: passed in the same conversation and same Pi process, including literal `/reload`, member dispatch, optional plans, multi-goal submissions, notification policy, pauses/resumes, recovery, workspace restore, and portable transfer.

The production installation is updated only after these checks pass. The
hardware development Pi conversation is not used for this validation.
