# Security policy

Mission Control v2 is trusted local automation inside Pi, not a separate user account or universal sandbox.

Message timelines use Pi's public custom UI, public events and bounded read-only log pages. The plugin does not patch Pi program files or native component prototypes. The withdrawn 2.0.7 adapter retains only explicit, checksum-guarded restoration of its own recorded changes; installation is disabled. See docs/design/mission-control-v2/TIMESTAMPS.md.

- Member file tools always enforce workspace checks, including host mode. Trusted extensions and host shell commands can bypass application file-tool rules.
- `host` intentionally grants the host user's command authority. Read-only host workers are rejected. Windows native PowerShell is separate from bash/WSL.
- `sandbox` requires an explicitly configured local Podman image, without image pull or host fallback. Snapshot inputs, no network, resource limits and validated output export constrain container commands; the engine, image and host kernel remain trusted.
- RPC worker environments use an allowlist, including known provider credential variables and explicit user additions. Worker Pi still resolves its model credentials through Pi; this is not per-provider credential isolation.
- The bridge binds127.0.0.1, requires a random capability token, and checks task/epoch. Sender identity is server-derived. An arbitrary same-user host command can still interfere with local files/processes.
- `web_fetch` rejects private/local addresses and URL credentials, rechecks redirects, pins validated DNS addresses and bounds response size/duration. Configured SearXNG services may be local by explicit user choice.
- Model tools cannot disable maintenance or delete reminders. `/mission` user commands own pause/resume/stop/reminder removal. Verified mission completion and concrete decision requests remain model operations.
- Delivery states distinguish pending, leased, admitted and observed successful response; they do not guarantee exactly-once side effects or correct model understanding.
- Interrupted commands never automatically replay after restart. Unknown termination remains unknown; reconcile before retry. Unclean member histories are retained but retired from subsequent execution attempts.
- Workspace changes stop managed work and preserve paused continuation state. Rename rebases only paths inside the renamed root; switching projects does not broaden member permissions. Model changes require exact, expiring user grants. Recovery backups preserve the full original log and must remain private.
- Provider reconnect accepts custom errors, uses finite fixed waits and counts observed native failures. It does not certify exactly-once model actions or alter native global retry settings. User abort cancels waits; context overflow stays with compaction.
- Pi export, input, footer, clipboard and Escape are not replaced. Native HTML exports may contain private history; filtered public export uses bounded excerpts and is not a lossless backup.
- This session-local runtime does not install a daemon, OS scheduler, Windows token sandbox or universal network policy. Closing Pi stops maintenance.

Use private vulnerability reporting. Include commit, Pi/Node/OS version, minimal configuration and reproducible steps. Remove credentials, transcripts and private project contents.

Run`npm run check`, `npm run typecheck`, `npm test`. Podman tests require an explicit local image. Offline tests do not certify every platform or actual provider.
