# 2.5.3 — workspace continuations preserve notes and summary routing (2026-10-23)

- Preserve the standalone context-memory database, mode, note revisions, learned budgets and cursor keys when renaming or switching workspace. Snapshot SQLite consistently, including committed WAL pages, before attaching the continuation; keep the source data and remove only the new snapshot on rollback.
- Copy explicit lead/member summary settings, diagnostics and completed summary caches with the existing runtime migration. A workspace continuation no longer silently loses its summary route or resets notes mode.
- Explain that externally renaming the current directory must be undone before using /project rename; switch remains a change to another existing workspace and preserves member permissions.
- Add actual Pi regressions for quoted CJK names, goal/evidence retention, notes and summary routing, rollback and reload. Extend the dedicated WSL TUI test with rename and rename-back in the same process.

# 2.5.2 — optional history cursors and actionable excluded reads (2026-10-22)

- Treat omitted, null and blank history search cursors as the first page, including batch requests. Keep every nonempty cursor signed and branch/query/role scoped; invented values such as 0 remain invalid with explicit recovery guidance.
- Distinguish a known branch entry excluded from public history (such as a memory-tool receipt or hint) from an unknown/out-of-branch ID. Direct models to search the original user/assistant text instead of repeatedly reading the tool's own error receipt; keep those receipts out of the search index.
- Add real Pi regressions for filled optional argument placeholders, schema-valid null cursors, batch calls and same-session reload. Preserve existing databases and cursor keys without a migration or index rebuild.

# 2.5.1 — exact acceptance, closed clocks and resumable history (2026-10-21)

- Validate the requested root identity and revision in the acceptance transaction. Reject unselected roots before any writes; return the original receipt for an accepted revision.
- Settle activity at stop intent before awaiting process cancellation. Preserve unknown process receipts, root timestamps and ended clocks across archive, reload and subsequent goals.
- Keep search hit identities when excerpts exceed a history batch budget. Add signed, branch-bound search cursors and exact batch continuation through cursor/offset and startRequest.
- Retain bounded canonical RPC failure diagnostics in task receipts: event type, actual byte limit, observed lower bound and LF record index. Never include record bodies or arbitrary type names.
- Record injected note revisions and sources in both compaction paths. Suppress the duplicate index hint only when the exact version is already projected in the current checkpoint; preserve new revisions, first injection and legacy compatibility.
- Extend isolated Windows/WSL and same-process TUI reload coverage. See the review fix index and machine-readable receipt under docs/design/mission-control-v2.

# 2.5.0 — long RPC runs, bounded notes and cache-friendly context (2026-10-20)

- Drain duplicate agent_end/turn_end RPC snapshots without retaining their unbounded accumulated message arrays. Keep canonical records bounded, preserve LF framing and settle only on agent_settled; a transport retry no longer kills a long member merely because its accumulated snapshot exceeded 8 MiB.
- Start bounded handoff even when one large read jumps past the preparation reserve. Put mutable memory hints near the tail, preserving the stable history prefix and complete tool pairs instead of invalidating earlier prompt-cache content on each index/usage update.
- Add atomic note batches, unchanged-text version preservation and output-bounded history batches. Mark the full injected index/handoff and their revisions, and use precise topic/history references to reduce repeat reads.
- Add optional memberContext defaults for new member conversations without reading another plugin's data. Preserve explicit session choices and learned limits. Add exact-host HTTPS loopback accelerator compatibility and optional system trust for web_fetch; redirects, direct local URLs and arbitrary private targets remain checked.
- Correlate the supplied gateway screenshot with normalized Pi usage and report token-weighted cache totals separately by member. Add read-only audit-prompt-cache.mjs; no prompts or credentials are exported and no gateway cache hit rate is guaranteed.

# 2.4.0 — context modes and durable fault recovery (2026-10-20)

- Count actual consecutive provider failures separately from successful tool continuations; clear a recovery episode immediately on a healthy model response. Exhausted bursts retry after durable, increasing cooldowns instead of requiring another human continue.
- Reconnect provider-side aborted responses while preserving real cancellation, user holds and budgets. Classify external account/configuration faults, retry transient summary failures with retained caches, and migrate legacy exhausted recovery on /reload.
- Inject upstream failures, non-user aborts, long tool sequences and pause/reload scenarios into real Pi and the dedicated WSL TUI conversation.
- Add a standalone, per-conversation notes mode with bounded working notes, public-history lookup, persisted mode selection and safe rollover/resume through existing Pi compaction hooks.
- Separate summary input, intermediate and final budgets; retain explicit legacy character limits, completed chunk caches, failure recovery and strict summary routing. Preserve corrected identifiers and continuation details in summary prompts.
- Require a complete goal inventory before execution; discuss execution-time scope changes with the user, reserving rolling planning for approved exploratory work with unclear requirements.
- Extend Windows/WSL regression coverage and same-process TUI reload checks. Add an opt-in synthetic live-model benchmark and require isolated validation before installation.
- Refresh notes at Pi turn boundaries so managed members survive multiple windows before task settlement. Use native cut points and ignore mechanical memory-save receipts when checking handoff coverage.
- Add per-route conservative notes input budgets, bounded automatic handoff preparation and context-rejection learning. Preserve repair allowances across reload; do not treat 429 as a context limit or silently change summary routes.
- Exercise continuous standalone/member windows, cancellation and rate limits with real Pi; add an opt-in WSL 6luna test using native file reads in the dedicated test conversation.
- Preserve bounded literal recent-user excerpts across notes windows and support user-only history lookup, so explicit corrections remain available when a working note is wrong. Report exhausted preparation as a local failure to RPC hosts.
- Preserve user-required per-unit identifiers in summary inventories. Live benchmark success now requires every configured recall check, rather than merely finishing its API workflow.
- Fix rolling-summary forgetting: keep the previous checkpoint outside new source chunks, preserve it literally while the output budget permits, and consolidate only under actual size pressure. Verify successive native Pi compactions, cache reuse across checkpoint revisions, cancellation and bounded consolidation; replay live cached checkpoints without network access.

# 2.3.1 — canonical skill paths on Windows runners (2026-10-19)

- Canonicalize isolated test agent directories and the configured worker agent directory before resource discovery, so Windows 8.3 TEMP aliases such as RUNNER~1 do not leak into advertised skill paths.
- Keep arbitrary short aliases, out-of-workspace paths and configuration writes blocked by the existing file policy. Add a real alias regression and verify that member prompts advertise a canonical skill path.

# 2.3.0 — concrete goal scope and task-based member policies (2026-10-19)

- Guide code leaves toward explicit files/batches, with lightweight scope in the existing goal ledger, revision-aware edits, TUI details and bounded full-scope queries. Members receive goal/stage context and can page complete criteria through a read-only goal_context tool.
- Default new tasks to no execution deadline; support none/fixed timing and independent queue deadlines across every delegation entrypoint, including chains and downstream member tasks. Preserve explicit settings and stored task policies, cancellation, reload interruption and process reconciliation.
- Stop narrowing temporary members based only on role names. Provide permitted development/search tools, project context and skills, with optional explicit member tool allowlists; expose configured worker-extension tools through the member capability guard without granting global team controls.
- Add isolated real Pi regressions and a persistent dedicated WSL test conversation for candidate upgrades through /reload before production installation.

# 2.2.2 — remove browser operation prototype (2026-10-19)

- Remove the unpublished browser/HTTP operation prototype, its concept page and prototype tests.
- Keep TUI as the only task operation interface. Static archive reading remains available as a read-only snapshot viewer.

# 2.2.1 — self-contained archive reader (2026-10-19)

- Make exported archives directly readable from `index.html`: member, goal, task and message clicks load static data from the archive itself without a folder picker or access to a live Pi session.
- Generate nonce-compatible classic-script data volumes beside JSON volumes for `file://` reading, while retaining JSON volumes for HTTP preview, checksums and compatibility tools.
- Keep archive snapshots frozen and update the reader documentation and regression coverage accordingly.

# 2.2.0 — long-task conversation archives (2026-10-19)

- Add `/mission archive <new-directory>` and `mission_export` with `format=archive`. The exporter runs in a separate local process, reads Pi session files and Mission Control SQLite state without taking the runtime owner lock, and preserves the live conversation and budgets.
- Export full public text and tool arguments/results into bounded content-addressed chunks with per-file LF boundaries, SHA-256 checksums, explicit partial/missing-source notices, branch ancestry, member/task/goal/evidence associations, archived identities and optional image attachments.
- Add a light HTML reader with overview, goal and acceptance evidence, per-member task channels, target and branch paging, complete-text search, bounded body paging, self-contained offline reading and integrity diagnostics.
- Keep `/mission export <file.jsonl>` unchanged. Private reasoning, signatures and credential fields stay excluded from the public reading archive; raw runtime backup remains a separate operation.

# 2.1.1 — strict summary routes and bounded compaction recovery (2026-10-19)

- Fix member compaction inheriting the parent-scoped member summary model; budget overrides retain that route, and explicit scoped routes override legacy environment defaults. Missing/unavailable custom routes fail closed instead of sending summaries to the inference GPT.
- Share a small transient retry budget across a compaction, respect readable Retry-After hints without retrying early, cancel hung summary requests, and preserve user cancellation. Disable nested provider retries for explicit accounting.
- Preserve complete caches; when an input overflows or a transport failure persists, reduce only the failed block with bounded subdivision. Never cache incomplete stream output.
- Persist selected model, request duration/error, retries and chunk/merge/cache progress. Distinguish waiting, running and failed compaction, retain the actual summary error through Pi cancellation, and migrate old misleading waiting states on reload.
- Preserve explicit task deadlines and report their cause separately from provider disconnections. Add standalone, real Pi SDK and member RPC regressions on Windows and WSL.

# 2.1.0 — hierarchical goals and persistent acceptance ledger (2026-10-18)

- Add transactional SQLite goal trees, multiple main goals with one selected, explicit stage dependencies and a default maximum depth of three. Extra depth requires a user command and remains discouraged.
- Bind native lead execution receipts and delegated tasks to ready leaf goals and their revisions. Accept each goal against its criteria, retain immutable acceptance history, reference child acceptances and reopen affected parent/dependent acceptances when work changes.
- Show compact second/third-level acceptance counts in the existing widget; add `/mission goals` and an interactive goal tab with evidence, blockers, remaining effort, selection and reopening. Export the ledger only on demand.
- Directly expose seven new model tools through the existing host registry. Preserve old flat-goal tools, execution holds and per-main-goal usage/activity through in-place `/reload` migrations.
- Fix public-export duplicate-destination handling exposed by Linux testing: acquire the exclusive file descriptor before producers start streaming.

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
