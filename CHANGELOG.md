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
