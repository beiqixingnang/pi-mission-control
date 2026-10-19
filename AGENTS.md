# Plugin development and installation

The user's hardware development Pi conversation may be running. Do not use it for
plugin tests, reload it, stop it, or send it test prompts.

Develop candidates in an isolated checkout. Run the appropriate regression suite
on Windows and WSL before updating the installed checkout.

Reuse the dedicated WSL Pi conversation named 插件回归测试（WSL） under
/home/lishuo/pi-mission-control-test. Its agent settings, offline fixture provider,
workspace and session history are separate from production. The launcher is
/home/lishuo/pi-mission-control-test/open-test-session.sh.

Use scripts/test-task-policies-tui.py with the installed baseline, candidate and
that test home for real TUI upgrade checks. Preserve the same test conversation
and verify literal /reload without restarting its Pi process. All plugin changes
must remain loadable in existing conversations through /reload.

After the required tests pass, update the production installation on disk. Let
the user reload their running development conversation when ready.
