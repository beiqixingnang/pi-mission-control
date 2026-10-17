# Contributing

Pi Mission Control is a small, session-local extension package for Pi. Contributions should preserve Pi's extension model and should not require a fork of Pi or changes to a user's global Pi configuration.

## Before opening a change

Run the offline checks with Node.js 24 or newer and a local Pi 1.3.0 installation:

```bash
npm run check
npm run typecheck
npm test
```

The default test suite uses temporary agent configuration and deterministic offline providers. Do not add a test that contacts a real model provider, consumes credentials, or writes to the user's real `~/.pi/agent` directory.

Live tests are opt-in and may consume model quota. Keep them out of the default `npm test` command.

## Change guidelines

- Keep extension entry points compatible with supported Pi releases.
- Use Pi semantic theme tokens instead of hardcoded terminal colors.
- Keep thinking blocks, signatures, credentials, and provider configuration out of widgets and test output.
- Preserve explicit member capability boundaries. File tools stay guarded in every mode; host shell is explicitly trusted, files mode has no shell, and container failure never falls back to host.
- Model tools must not disable runtime maintenance, user controls, or reminders. Do not couple completion delivery to an explicitly created Goal.
- Keep task/attempt/delivery state out of repeated full Pi session snapshots. Native export/input/footer/Escape remain available.
- Keep background work cancellable and prevent late callbacks from changing a new session or branch.
- Add a focused offline regression test for behavior that can regress.
- Update the relevant README or CHANGELOG entry when user-visible behavior changes.

## Pull requests

This project is maintained as time permits. A pull request may remain unreviewed for an extended period. Keep changes small, describe the user-visible behavior, and include the exact checks you ran. Do not include API keys, session files, personal paths, provider endpoints, or generated test output.
