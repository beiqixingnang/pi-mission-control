# 2.0.20 — autonomous execution policy; Web kept experimental (2026-10-18)

- Default to business-only escalation: routine execution stays with the lead within approved scope. Expose idempotent mission_policy status/apply and the equivalent user command without clearing decisions, holds or budgets.
- Clarify that a fresh natural-language human delegation can resolve an exact pending decision; no A/B/C letter is required.
- Keep the browser UI, HTTP prototype and prototype tests under experiments/mission-web, outside the installed extension, published files and default suite.

# 2.0.19 — actionable recovery guidance on resumed conversations (2026-10-18)

- Verify the reported failure against the original conversation's public tool declarations: the new recovery tools were present, but the assistant only queried status and repeated obsolete user-only recovery advice.
- Put the current recovery plan before long objectives, histories and tool output. Return exact task epochs and goal revisions, loaded package version and recovery-tool visibility; preserve required real process inspection and all authoritative holds.
- Update known old no-progress guidance without changing its blocked state or usage. Report unknown executions independently of the ordinary task history limit and require another status query before resuming a partial reconciliation batch.
- Keep oversized status responses valid structured JSON by excerpting large fields and lists. Add three kernel regressions and strengthen the real Pi four-execution flow with obsolete history and oversized acceptance criteria.
- Local full suite: 158 passed, four opt-in container skips, zero failures; 28 source files typechecked and all 43 tools loaded successfully.

# 2.0.18 — unified lead tool registry and model-accessible recovery (2026-10-18)

- Collect Mission Control tools from Pi's host registry across both package entrypoints and refresh active names and schemas at session start and before model runs. Expose all 43 lead tools directly, with an optional `mission_capabilities` catalog.
- Add atomic, epoch-fenced `mission_reconcile` with caller-attested stopped-process evidence, plus `mission_control` for inspected no-progress recovery. Preserve task history, existing budget use and user/workspace/decision holds; create new attempts explicitly.
- Expose member messages, report intervals, queued idle compaction, public history/export, scoped summary models, reconnect settings and recovery of an existing relocation journal through model tools sharing command implementations.
- Preserve unknown process state when cancellation has no live termination receipt. Keep exports streaming, sanitized and exclusive-create; keep compaction after model settlement.
- Add four kernel and four real Pi regressions. Local full suite: 155 passed, four opt-in container skips, zero failures. Verify the four screenshot interruptions against an isolated database backup without modifying the original session or starting workers.

# 2.0.17 — optional budgets, member roster and safe conversation views (2026-10-18)

- Disable hidden goal time/turn/output deadlines by default; retain explicit positive limits and independent bounded failure recovery. Record active execution time separately from cooldown, waits, pauses and offline intervals.
- Migrate expired legacy default-budget holds without clearing existing usage. Keep explicit exhausted limits and user/workspace holds, and preserve lifetime activity when the user renews a budget cycle.
- Show one current row per member instead of a task history tree. Exclude retired identities, retain stable selection and keep per-member conversation history.
- Handle missing/archived members and asynchronous navigation failures inside the workbench instead of terminating Pi. Separate goal, schedules and member states into a bounded table, with a stacked layout on narrow terminals.
- Add activity-clock, stale-identity and real Pi regression coverage; verify all four actual conversation projections using a read-only state backup and refresh the terminal previews.

# 2.0.16 — runtime recovery without clearing user holds (2026-10-18)

- Separate durable context/provider/delivery recovery from user pauses, business decisions, no-progress review and mission budget exhaustion. Recover the known legacy wake-failure state without renewing the goal budget.
- Automatically request one bounded compaction after overflow, wait for a saved checkpoint and an idle host, then admit a single recovery batch. Preserve failed summaries and unread result identities.
- Share a persistent request allowance across native retries, supplemental retries and outbox probes; preserve cooldown and usage across reload. Supersede stale progress and recurring reminder occurrences; retain unconsumed critical notifications.
- Keep goal editing from clearing user/Escape/workspace holds or renewing budgets. Count only successful continuation turns without actual progress toward the no-progress guard.
- Add exact, scoped business decisions with authenticated fresh human replies, external event waits with deadlines and tokens, visible recovery reasons and audited state transitions.
- Add 21 kernel regressions and five real Pi lifecycle regressions for legacy migration, automatic compaction, native retry admission, decision authority and provider-side cancellation.

# 2.0.15 — recover complete overlong and reasoning-only summaries (2026-10-18)

- Condense a complete summary that exceeds its character limit instead of immediately cancelling compaction. Use a shorter prompt target while preserving the original acceptance limit and the full ending.
- Retry empty visible output with a bounded limit; when reasoning exhausts a default token cap without an answer, allow one larger request up to 32768 tokens. Preserve explicit user caps.
- Add visible-output character counts to metadata diagnostics and distinguish terminal empty and overlong errors.
- Add a dedicated summary system instruction and version the cache request format. Save a small per-session diagnostic record even when verbose debug logging is disabled.
- Add four regressions, including a real Pi compaction checkpoint followed by a working next request. Local suite: 106 passed, four opt-in container skips, zero failures.

# 2.0.14 — reasoning summary budgets and overflow recovery (2026-10-18)

- Reproduce the failed summary through the configured gateway: a 4096-token cap is consumed by reasoning and visible output, while the same excerpt completes with a 16384-token cap.
- Default reasoning summaries to 16384 tokens, constrain the requested summary length to leave reasoning room, and preserve explicit output limits.
- Subdivide truncated chunks with a bounded depth, including gateways reporting `incomplete.length`; cache only complete summaries and retain the original transcript on failure.
- Recognize `input exceeds the context window` before supplemental reconnect so the same oversized request is not repeatedly sent as a network retry. Record metadata-only summary diagnostics.
- Add five regressions; local suite: 102 passed, four opt-in container skips, zero failures.

# 2.0.13 — tolerate placeholder reminder parameters (2026-10-17)

- Ignore empty `at`/`id` placeholders emitted by models when creating reminders.
- Resolve the common `afterSeconds=<meaningful>, everySeconds=1` placeholder shape as a one-shot reminder instead of repeatedly rejecting the call.
- Add a real Pi regression for the screenshot failure pattern.

# 2.0.12 — scoped compaction models for leads and members (2026-10-17)

- Add scoped `/compaction-model lead ...` and `/compaction-model member ...` settings. The lead setting is stored per current Mission Control session; the member setting is inherited by future subagent sessions.
- Keep per-member overrides available inside member conversations, preserve the legacy global config as a fallback, and keep custom summaries isolated by scope/cache directory.
- Add regression coverage for writing the member default and lead session configuration independently.

# 2.0.11 — refresh the tool loadout before every model request (2026-10-17)

- Reapply the current Mission Control tool registry in `before_agent_start`, closing the startup timing gap where a resumed session could still send its historical tool snapshot to the first model request.
- Refresh existing tool schemas as well as newly added tool names, including the expanded `schedule` action union.

# 2.0.10 — reactivate tools on resumed sessions (2026-10-17)

- Re-add Mission Control's registered tools to Pi's active tool set during `session_start`, so resumed sessions see tools introduced after their original transcript was created.
- Preserve the old session ID and Mission Control state while refreshing the model-facing tool declaration; no new conversation is required just to pick up a plugin tool addition.
- Add a real Pi regression covering an old active-tool set and update the local version to 2.0.10.

# 2.0.9 — lifecycle closure and archive records (2026-10-17)

- Add explicit `goal_update` and `goal_stop` tools with revisioned goal records and durable lifecycle history.
- Add `team_disband`; persistent identities can be stopped and archived, while temporary `subagent` members leave the active roster after their task settles.
- Extend `schedule` with update, pause, resume and delete actions. One-shot schedules and stale reminder deliveries are archived or cancelled together.
- Keep completed goals inspectable while removing closed objects from active member/reminder views. Add lifecycle regression coverage; local suite now reports 95 passed and 4 opt-in container skips.

# 2.0.8 — plugin-owned main timeline, withdraw native patch (2026-10-17)

- Restore native Pi files and remove the timestamp renderer bridge, prototype decoration and patch generator. Keep only checksum-guarded recovery for installations that used 2.0.7; reject `apply`.
- Add `/mission time` and `/mission timeline`, plus the workbench `t` shortcut, for a plugin-owned public main-conversation timeline with saved timestamps, tool durations, bounded LF paging and live public previews.
- Preserve member times, Markdown/tool backgrounds and logical copy. The native main transcript and editor stay under Pi's control; `m` returns to its input, Escape returns to the team and `q` exits the workbench.
- Verify actual Pi streaming/tool results, private-block filtering, native-file hashes before/after viewing and refusal of the withdrawn installer. Update previews and compatibility documentation.

# 2.0.7 — message timestamps and tool timing (2026-10-17)

- Show saved local timestamps on member messages, with date changes, stable streaming times and actual recorded tool durations. Retain full logical copy text.
- Add a display-only native Pi timestamp bridge for user, assistant, tool and custom-message components. Preserve original Markdown, tool rendering and model/session content.
- Ship an explicit Pi1.3.0 adapter with AST shape checks, per-installation backups, checksums, atomic file replacement and guarded restore. Applying the adapter requires restarting Pi; extension reload alone is insufficient.
- Add `/mission time` diagnostics and nine timing/native-renderer regressions. Verify both actual standalone and CLI user-message routing for repeated text and inspect native-component previews.

# 2.0.6 — strict tool types and CI portability (2026-10-17)

- Preserve tool parameter, result-detail and renderer-state generics through member registration and file guards; include explicit result details and type prepared delegation batches.
- Track an opened SQLite handle separately during constructor cleanup.
- Run strict typechecking through the TypeScript compiler API, verify required source selection and report the checked file count. Confirm injected invalid API calls and primitive assignments fail the check.
- Canonicalize sandbox test temporary directories before applying path rules so Windows runner short-name aliases do not obscure the intended assertions. Keep alias rejection in the runtime.
- Record the initial Ubuntu test success, CI failures and focused fixes without treating local verification as complete provider or overnight validation.

# 2.0.5 — horizontal task board and native action panels (2026-10-17)

- Place a persistent full-width task board directly above Pi's editor, with the objective, progress report time, next reminder and one row per visible member.
- Bound board height to 4–10 rows according to terminal height; hide it while the full-screen workbench is open and restore it on return.
- Use Pi's native backgrounds for user tasks, pending tools, successful tools and errors. Keep assistant prose on the normal background.
- Display command text and edit diffs directly; preserve complete logical arguments for copying. Add no vertical borders to either surface.
- Validate actual dark/light/system themes, width/height limits, copy fidelity and workbench transitions. Generate isolated Pi TUI frames and inspect their rasterized previews.

# 2.0.4 — prevent member-view theme crashes (2026-10-17)

- Fix invalid `mdItalic` and `mdBullet` colors in the Markdown adapter. Use Pi's typed `ThemeColor` tokens and its italic/underline/strikethrough style methods.
- Catch custom-panel render failures inside the workbench and keep Escape navigation available instead of terminating Pi.
- Test the member view with the installed Pi dark, light and system themes, including user quotes, emphasis, lists, links, tables and tool blocks. Replace the permissive preview theme with Pi's real theme.
- Keep completed members marked completed in their conversation header; hide expired progress-check countdowns after mission completion.

# 2.0.3 — full-screen agent workbench (2026-10-17)

- Replace the sparse member viewer with a full-screen team workbench and stable `AGENTS / TEAM STATUS` entry point.
- Render member conversations with Pi Markdown and semantic user, assistant, tool-call, tool-result and error blocks.
- Add `/agents [member]`; preserve `/mission` and `/mission view` as compatible entry points.
- Add explicit `m` member messaging through Pi's native editor: steer a live turn or create a new tracked member turn when idle.
- Add explicit `c` logical-message copy through Pi's clipboard API, excluding borders, side panels and status chrome.
- Remove the permanent right-side layout from the member viewer so terminal selection cannot include a divider or adjacent conversation.
- Add real UI snapshot preview at `docs/ui-preview-mission-panel.txt` and semantic Markdown/message/copy regressions.

# 2.0.2 — workspace continuation and provider recovery (2026-10-17)

- Restore workspace rename/switch, stable project identity, exact one-use model grants, old-path resolution and explicit recovery.
- Copy LF histories and SQLite/member artifacts into paused continuations; rebuild Pi's cwd runtime and preserve original logs, member identity and permission boundaries.
- Restore main/member provider recovery for custom gateway errors: default ten retries with fixed five-second plugin waits, cancellation and native-attempt accounting.
- Preserve custom compaction config/environment, propagate summary settings to workers, validate budgets and retain metadata-only debug traces.
- Restore explicit `/stop` while retaining native Escape; hold reminders during workspace relocation and require explicit resume.
- Add real Pi retry, cancellation, migration, rollback, restart, member-memory and file-tool scope regressions.

# 2.0.1 — delegation compatibility and live member viewer (2026-10-17)

- Ignore empty/null task selectors without hiding real chain/parallel work; reject ambiguous modes before starting any member.
- Accept empty optional workspace/container placeholders without changing execution authority; keep meaningful capability conflicts rejected and preserve idle member settings on empty updates.
- Add a selectable team task tree, objective/reminder pages and `/mission view <member>`.
- Show live public replies, tool progress, arguments, results and errors; support expansion, history paging, follow pause and retired session selection.
- Read member logs through bounded LF pages; handle Pi1.3 snapshot-free RPC text deltas without retaining thinking/signatures.
- Keep viewing separate from task execution and delivery acknowledgements; add real Pi command/keyboard and placeholder regressions.

# 2.0.0 — runtime rewrite (2026-10-17)

- Replace ten coordination entry points with one persistent Mission Control runtime and bounded compaction.
- Enroll every dispatched task in automatic maintenance and completion wakeups, independent of Goal/supervisor setup.
- Add SQLite task/attempt/delivery/schedule state, immutable artifacts, directed teammate messaging and descendant review.
- Preserve Pi export/input/clipboard/footer/Escape; stream filtered public exports without repeated state snapshots.
- Keep host file checks, add native Windows PowerShell, bound worker environments, retain explicit Podman isolation without fallback.
- Add a public-widget dashboard, user-owned controls, cached chunked summaries, search/fetch and finite wake recovery.
- Require Node24+. Old v1 extensions are inactive; interrupted v1 work is not auto-migrated or replayed.

# Changelog

## 1.4.0

- Added stable workspace identities and historical path resolution without rewriting session messages or evidence.
- Added an opt-in Podman sandbox backend for restricted members with immutable local images, no network, bounded resources, receipts, logs, cancellation, timeouts, and guarded artifact export.
- Added `team_configure` to enable the sandbox backend for an idle restricted member without replacing its identity or conversation.
- Added a persistent parent/child task graph with Goal propagation, task batches, delivery IDs, input hashes, artifact paths, ordered deduplication, downstream waiting, scheduled reports, blockers, explicit resume, and cascading cancellation.
- Added separate queue, message, member, and process timeout reporting, plus retained recovery state after reload.
- Added an explicit trusted `host` execution profile for fully trusted members, enabled by the lead model through `team_spawn` or `team_configure`; host mode is clearly documented as non-sandboxed.
- Changed ordinary team notifications to immediate display-only messages, while Goal wakeups remain separate and freshness-checked.

## 1.3.0

- Added `/project rename` and `/project switch` to keep conversation history while rebuilding Pi's runtime for the new directory. Continued sessions are discoverable from the target directory on restart.
- Added manual-only defaults and exact-target, single-use, ten-minute AI grants via `/project allow`, `project_status`, and `project_apply`.
- Preserved the current branch and historical message bodies, added durable backups/recovery journals, and migrated persistent member paths and saved conversations on rename.
- Workspace changes stop current work and leave Goal/Supervisor paused. Existing destinations, ephemeral sessions and renaming the installed plugin directory are rejected.
- Added isolated offline runtime/process regressions for rename, switch, restart, authorization, member history, custom session storage and rollback.

## 1.2.0 - 2026-10-16

- Added global stop, targeted team and subagent cancellation, and held-input handling.
- Added adaptive compact/sidebar agent monitoring with read-only member history.
- Added `goal_update` and `goal_stop` model tools so an active Goal can be revised or stopped from the lead conversation.
- Added `supervisor_control` for session-only supervisor status, enable/disable, and interval changes.
- Added persistent teams, ACL-checked member messaging, workspace policies, Goal continuation, retry recovery, and Pi 1.3.0 compatibility coverage.
- Added offline regression coverage for the public control tools and UI behavior.

## Earlier development

The repository history contains the earlier 1.0.x and 1.1.x implementation and verification changes. Those historical notes may refer to the local development environment used at the time; current support is documented in the root README.
