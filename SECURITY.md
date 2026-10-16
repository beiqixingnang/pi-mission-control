# Security policy

Pi Mission Control runs inside the user's Pi installation and can start model-driven workers, invoke configured tools, write files, and run configured verification commands. Treat it as trusted local automation, not as an operating-system sandbox.

## Supported versions

Security fixes target the latest `main` branch and the latest documented Pi release. Older tags may not receive fixes.

## Reporting a vulnerability

Please do not open a public issue for a security vulnerability. Use GitHub's private vulnerability reporting for this repository, or contact the repository maintainers through the private contact method shown in the repository settings.

Include:

- the affected commit or release;
- operating system, Node.js, and Pi versions;
- the smallest reproducible configuration or prompt;
- the observed impact and any logs with credentials removed.

Do not include API keys, auth files, session transcripts, or private project contents. If a credential was exposed during reproduction, revoke it immediately before reporting.

## Security boundaries

- `workspace` policies are extension-level file-tool checks. They are not an OS sandbox.
- `execution: "sandbox"` uses a preinstalled local Podman image when configured; without a working Podman backend or local image it is rejected and never silently becomes unrestricted host execution.
- `goal_finish` may run configured commands through the active `bash` tool.
- Workspace rename/switch is manual by default. `/project allow` creates one exact-target grant that expires in ten minutes; `project_apply` cannot grant itself permission. This does not sandbox unrestricted shell tools.
- Migration snapshots contain full private transcripts and are stored under `<agent-dir>/project-migrations/`. Treat them like ordinary session files; never upload them in a public report.
- Unrestricted members and subagents may use the tools granted by Pi and may modify files in their workspace.
- The supervisor can create additional model turns and therefore additional model usage.
- The extension does not provide a separate credential store or isolation layer for Pi providers.

Run the offline test suite before reporting a suspected regression:

```bash
npm run check
npm test
```
