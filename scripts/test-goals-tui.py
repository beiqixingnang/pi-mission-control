"""Linux/WSL real Pi TUI upgrade smoke test; all state and commands are temporary.

Usage: python3 scripts/test-goals-tui.py <old-package> <candidate-package> <artifact-dir>
"""
import codecs
import fcntl
import json
import os
from pathlib import Path
import pty
import re
import select
import shutil
import signal
import sqlite3
import struct
import subprocess
import sys
import tempfile
import termios
import time


def copy_package(source, destination):
    for name in ["runtime", "extensions/mission-control", "extensions/workspace", "extensions/project"]:
        shutil.copytree(source / name, destination / name, dirs_exist_ok=True)
    shutil.copy2(source / "package.json", destination / "package.json")
    for library in ["stream-json", "stream-chain"]:
        dependency = source / "node_modules" / library
        if dependency.is_dir():
            shutil.copytree(dependency, destination / "node_modules" / library, dirs_exist_ok=True)


def main():
    old, candidate, artifacts = map(lambda value: Path(value).resolve(), sys.argv[1:4])
    artifacts.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="mission-goals-tui-") as temporary:
        base = Path(temporary)
        package, agent, workspace = [base / name for name in ["package", "agent", "workspace"]]
        for folder in [package, agent, workspace]:
            folder.mkdir()
        copy_package(old, package)
        (agent / "settings.json").write_text(json.dumps({"packages": [str(package)], "retry": {"enabled": False}, "cacheWarming": "off", "quietStartup": True}))
        (agent / "mission-control.json").write_text(json.dumps({"progressIntervalMs": 3600000}))
        master, slave = pty.openpty()
        fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 40, 130, 0, 0))
        environment = dict(os.environ, PI_CODING_AGENT_DIR=str(agent), PI_OFFLINE="1", TERM="xterm-256color", COLUMNS="130", LINES="40")
        process = subprocess.Popen([shutil.which("pi"), "--offline", "--no-mcp", "--no-skills", "--no-context-files", "--no-prompt-templates", "-e", str(candidate / "tests/v2/offline-provider.ts"), "--provider", "mission-fixture", "--model", "model", "--thinking", "off"], cwd=workspace, env=environment, stdin=slave, stdout=slave, stderr=slave, start_new_session=True)
        os.close(slave)
        transcript = bytearray()
        decoder = codecs.getincrementaldecoder("utf-8")("replace")
        visible = ""
        checks = []

        def drain(seconds=0.1):
            nonlocal visible
            deadline = time.monotonic() + seconds
            while time.monotonic() < deadline:
                if select.select([master], [], [], min(0.05, max(0, deadline-time.monotonic())))[0]:
                    try:
                        chunk = os.read(master, 65536)
                    except OSError:
                        return
                    transcript.extend(chunk)
                    visible += decoder.decode(chunk)
                    # Answer terminal capability queries without claiming graphics support.
                    if b"\x1b[c" in chunk:
                        os.write(master, b"\x1b[?1;2c")

        def wait(predicate, label, timeout=15):
            deadline = time.monotonic() + timeout
            while time.monotonic() < deadline:
                drain()
                if predicate():
                    checks.append(label)
                    return
                if process.poll() is not None:
                    raise AssertionError(f"Pi exited early: {process.returncode}: {label}")
            raise AssertionError("Timed out: " + label)

        def send(value):
            drain(0.15)
            os.write(master, value.encode())

        def line(value):
            send(value + "\r")

        def databases():
            return list((agent / "mission-control/v2").glob("*/state.sqlite"))

        def query(sql, values=()):
            paths = databases()
            if not paths:
                return []
            with sqlite3.connect(f"file:{paths[0]}?mode=ro", uri=True) as database:
                return database.execute(sql, values).fetchall()

        def mission():
            rows = query("SELECT data FROM meta WHERE key='mission'")
            return json.loads(rows[0][0]) if rows else None

        def nodes():
            return [json.loads(row[0]) for row in query("SELECT data FROM goal_nodes")]

        def model_tool(name, arguments):
            line("V2_TEST:" + json.dumps({"op": "tool", "name": name, "args": arguments}, separators=(",", ":")))

        try:
            wait(lambda: bool(databases()), "old installed package opened in real WSL Pi")
            line("/mission start LEGACY_TUI_GOAL | Preserve accepted evidence")
            wait(lambda: mission() is not None, "legacy flat goal created")
            line('V2_TEST:{"op":"answer","text":"LEGACY_TUI_READY"}')
            wait(lambda: "LEGACY_TUI_READY" in visible, "offline model answered in the original TUI")
            line("/mission pause")
            wait(lambda: mission()["humanPaused"], "paused legacy goal before package replacement")
            original = mission()
            session_files = set((agent / "sessions").rglob("*.jsonl"))
            assert len(session_files) == 1
            copy_package(candidate, package)
            marker = len(visible)
            line("/reload")
            wait(lambda: "Reloaded keybindings" in visible[marker:], "literal /reload loaded the candidate without restarting Pi")
            assert mission()["id"] == original["id"]
            assert mission()["humanPaused"] is True
            assert mission()["turns"] == original["turns"]
            assert mission()["outputTokens"] == original["outputTokens"]
            assert set((agent / "sessions").rglob("*.jsonl")) == session_files
            wait(lambda: len(nodes()) == 1, "legacy goal migrated to the new SQLite ledger")
            line("/mission resume")
            wait(lambda: not mission()["humanPaused"], "explicit user resume retained the same goal")
            model_tool("goal_plan", {"goals": [{"key": "stage", "parentId": original["id"], "objective": "WSL implementation stage", "criteria": ["Module output accepted"]}, {"key": "leaf", "parentId": "stage", "objective": "WSL module A", "criteria": ["Artifact persists after reload"]}]})
            wait(lambda: len(nodes()) == 3, "new goal_plan tool ran after reload")
            leaf = next(node for node in nodes() if node["depth"] == 3)
            model_tool("goal_focus", {"goalId": leaf["id"], "revision": 0})
            wait(lambda: next(node for node in nodes() if node["id"] == leaf["id"])["state"] == "active", "leaf focus recorded")
            source = workspace / "module-a.py"
            model_tool("write", {"path": str(source), "content": "MODULE_A = 64\n"})
            wait(source.exists, "native TUI tool wrote a real isolated artifact")
            model_tool("goal_accept", {"goalId": leaf["id"], "revision": 0, "evidence": [{"criterion": 1, "source": "artifact", "path": str(source), "summary": "WSL artifact evidence saved for the exact leaf revision"}]})
            wait(lambda: next(node for node in nodes() if node["id"] == leaf["id"])["state"] == "accepted", "leaf acceptance and evidence persisted")
            marker = len(visible)
            line("/mission goals")
            wait(lambda: "目标 / GOALS" in visible[marker:], "real detailed goals TUI opened")
            send("\x1b[B\x1b[B\r")
            wait(lambda: "WSL artifact evidence" in visible[marker:], "keyboard navigation opened the leaf evidence")
            send("\x1b")
            drain(0.3)
            send("\x1b")
            marker = len(visible)
            line("/reload")
            wait(lambda: "Reloaded keybindings" in visible[marker:], "second /reload preserved accepted progress")
            assert next(node for node in nodes() if node["id"] == leaf["id"])["state"] == "accepted"
            assert set((agent / "sessions").rglob("*.jsonl")) == session_files
            exported = workspace / "goals.json"
            line("/mission goals export " + str(exported))
            wait(exported.exists, "user export command saved the ledger on demand")
            ledger = json.loads(exported.read_text())
            assert ledger["format"] == "pi-mission-goals"
            assert next(record for record in ledger["records"] if record["goal"]["id"] == leaf["id"])["acceptance"]["evidence"][0]["fingerprint"]["sha256"]
            archive = workspace / "conversation-archive"
            line("/mission archive " + str(archive))
            wait(lambda: (archive / "index.html").exists(), "archive command exported the same real TUI session after reload", 30)
            archive_manifest = json.loads((archive / "manifest.json").read_text())
            assert archive_manifest["status"] == "complete"
            assert archive_manifest["catalog"]["goal"]["count"] == 3
            assert mission()["id"] == original["id"]
            assert set((agent / "sessions").rglob("*.jsonl")) == session_files
            assert not re.search(r"UnhandledPromiseRejection|ERR_UNSUPPORTED|Error loading extension", visible)
            report = {"passed": True, "oldVersion": json.loads((old / "package.json").read_text())["version"], "candidateVersion": json.loads((candidate / "package.json").read_text())["version"], "checks": checks, "sameProcess": process.poll() is None, "sameSession": True}
            (artifacts / "wsl-goals-tui-report.json").write_text(json.dumps(report, ensure_ascii=False, indent=2))
            print(json.dumps(report, ensure_ascii=False, indent=2))
        finally:
            (artifacts / "wsl-goals-tui.ansi").write_bytes(transcript)
            if process.poll() is None:
                os.killpg(process.pid, signal.SIGTERM)
                try:
                    process.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    os.killpg(process.pid, signal.SIGKILL)
                    process.wait(timeout=5)
            os.close(master)


if __name__ == "__main__":
    main()
