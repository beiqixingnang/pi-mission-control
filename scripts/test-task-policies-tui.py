"""Persistent, isolated WSL Pi conversation for plugin upgrade regression.

Usage: python3 scripts/test-task-policies-tui.py BASELINE CANDIDATE TEST_HOME
The named conversation, test agent directory and reports are retained for reuse.
No real model credentials, production settings or production sessions are used.
"""
import codecs
import fcntl
import json
import os
from pathlib import Path
import pty
import select
import shutil
import signal
import sqlite3
import struct
import subprocess
import sys
import termios
import time
import uuid


def copy_package(source, destination):
    for name in ["runtime", "extensions/mission-control", "extensions/workspace", "extensions/project"]:
        shutil.copytree(source / name, destination / name, dirs_exist_ok=True)
    for name in ["package.json", "tests/v2/offline-provider.ts"]:
        target = destination / name
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(source / name, target)
    for library in ["stream-json", "stream-chain"]:
        shutil.copytree(source / "node_modules" / library, destination / "node_modules" / library, dirs_exist_ok=True)


def main():
    baseline, candidate, home = [Path(value).resolve() for value in sys.argv[1:4]]
    home.mkdir(parents=True, exist_ok=True)
    package, agent, workspace, reports = [home / name for name in ["package", "agent", "workspace", "reports"]]
    for directory in [package, agent, workspace, reports]:
        directory.mkdir(exist_ok=True)
    identity = home / "test-session.json"
    config = json.loads(identity.read_text()) if identity.exists() else {"id": str(uuid.uuid4()), "name": "插件回归测试（WSL）"}
    identity.write_text(json.dumps(config, ensure_ascii=False, indent=2))
    copy_package(baseline, package)
    fixture = package / "tests/v2/offline-provider.ts"
    (agent / "settings.json").write_text(json.dumps({"packages": [str(package)], "retry": {"enabled": False}, "cacheWarming": "off", "quietStartup": True}))
    (agent / "mission-control.json").write_text(json.dumps({"workerExtensions": [str(fixture)], "progressIntervalMs": 3600000}))
    sessions = agent / "sessions"
    sessions.mkdir(exist_ok=True)
    existing = list(sessions.glob("*_" + config["id"] + ".jsonl"))
    arguments = ["--session", str(existing[0])] if existing else ["--session-id", config["id"], "--session-dir", str(sessions)]
    # A previous failed test may have been SIGTERM'd. Check the dedicated test
    # owner before launch; WSL can recycle its PID across distro startups.
    lock = agent / "mission-control/v2" / config["id"] / "owner.lock"
    if lock.exists():
        owner_pid = json.loads(lock.read_text())["pid"]
        owner = Path("/proc") / str(owner_pid)
        try:
            owner_cwd = (owner / "cwd").resolve(strict=True)
            arguments_now = (owner / "cmdline").read_bytes().split(b"\0")
            if owner_cwd == workspace and any(Path(value.decode(errors="replace")).name in ["node", "pi"] for value in arguments_now[:2]):
                raise RuntimeError("Dedicated test Pi is already open; close that test instance before regression.")
        except FileNotFoundError:
            pass
        lock.unlink()
    master, slave = pty.openpty()
    fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 42, 140, 0, 0))
    environment = {key: value for key, value in os.environ.items() if not any(secret in key.upper() for secret in ["API_KEY", "AUTH_TOKEN", "ACCESS_TOKEN"])}
    environment.update(PI_CODING_AGENT_DIR=str(agent), PI_OFFLINE="1", TERM="xterm-256color", COLUMNS="140", LINES="42")
    process = subprocess.Popen([shutil.which("pi"), "--offline", "--no-mcp", "--no-skills", "--no-context-files", "--no-prompt-templates",
        "-e", str(fixture), "--provider", "mission-fixture", "--model", "model", "--thinking", "off", *arguments],
        cwd=workspace, env=environment, stdin=slave, stdout=slave, stderr=slave, start_new_session=True)
    os.close(slave)
    transcript = bytearray()
    visible = ""
    decoder = codecs.getincrementaldecoder("utf-8")("replace")
    checks = []
    database = agent / "mission-control/v2" / config["id"] / "state.sqlite"

    def drain():
        nonlocal visible
        if select.select([master], [], [], .1)[0]:
            try:
                data = os.read(master, 65536)
            except OSError:
                return
            transcript.extend(data)
            visible += decoder.decode(data)
            if b"\x1b[c" in data:
                os.write(master, b"\x1b[?1;2c")

    def wait(predicate, label, timeout=30):
        end = time.monotonic() + timeout
        while time.monotonic() < end:
            drain()
            if predicate():
                checks.append(label)
                return
            if process.poll() is not None:
                raise AssertionError("Pi exited: " + label)
        raise AssertionError("Timed out: " + label + "\n" + visible[-2500:])

    def line(value):
        drain()
        os.write(master, value.encode())
        drain()
        os.write(master, b"\r")

    def query(table, where="", values=()):
        if not database.exists():
            return []
        with sqlite3.connect(f"file:{database}?mode=ro", uri=True) as db:
            return [json.loads(row[0]) for row in db.execute("SELECT data FROM " + table + (" WHERE " + where if where else ""), values)]

    def mission():
        values = query("meta", "key='mission'")
        return values[0] if values else None

    def tool(name, args):
        line("V2_TEST:" + json.dumps({"op": "tool", "name": name, "args": args, "noRepeatWake": True}, separators=(",", ":")))

    try:
        wait(lambda: database.exists() and "↑" in visible and "model" in visible, "dedicated test conversation opened and TUI input is ready")
        line("/name " + config["name"])
        if mission() and mission()["status"] not in ["complete", "stopped"]:
            line("/mission stop")
            wait(lambda: mission()["status"] == "stopped", "previous isolated test goal explicitly stopped before a new regression")
        run_goal = "Plugin task policy regression " + uuid.uuid4().hex[:8]
        line("/mission start " + run_goal + " | Preserve the dedicated test conversation")
        wait(lambda: mission() and mission()["objective"] == run_goal, "baseline goal recorded")
        line("/mission pause")
        wait(lambda: mission()["humanPaused"], "baseline paused")
        original = mission().copy()
        copy_package(candidate, package)
        marker = len(visible)
        line("/reload")
        wait(lambda: "Reloaded keybindings" in visible[marker:], "candidate loaded through literal /reload in the same Pi process")
        assert mission()["id"] == original["id"] and mission()["humanPaused"]
        assert mission()["outputTokens"] == original["outputTokens"]
        line("/mission resume")
        wait(lambda: not mission()["humanPaused"], "same goal explicitly resumed")
        previous_goals = {node["id"] for node in query("goal_nodes")}
        tool("goal_plan", {"goals": [
            {"key": "stage", "parentId": original["id"], "objective": "Dedicated scope test stage", "criteria": ["File batch accepted"]},
            {"key": "leaf", "parentId": "stage", "objective": "Audit dedicated decode file batch",
             "scope": {"unitKind": "file", "items": ["decoder.py", "immediate.py"]}, "criteria": ["Exact decode findings saved"]}]})
        wait(lambda: any(n.get("scope") and n["id"] not in previous_goals for n in query("goal_nodes")), "scope registered through the real model tool")
        leaf = next(n for n in query("goal_nodes") if n.get("scope") and n["id"] not in previous_goals)
        tool("goal_focus", {"goalId": leaf["id"], "revision": 0})
        wait(lambda: any(n["id"] == leaf["id"] and n["state"] == "active" for n in query("goal_nodes")), "concrete leaf focused")
        member = "policy-reader-" + uuid.uuid4().hex[:6]
        tool("team_spawn", {"name": member, "role": "Long source inspection", "model": "mission-fixture/model"})
        wait(lambda: any(m["name"] == member for m in query("members")), "member created with task-appropriate default development capabilities")
        tool("team_send", {"to": member, "message": 'V2_TEST:{"op":"tool","name":"goal_context","args":{"section":"criteria"}}', "timeoutPolicy": "none"})
        wait(lambda: any(t["member"] == member and t["state"] == "completed" and t.get("resultPath") and
            t.get("processState") == "stopped" and Path(t["resultPath"]).exists() for t in query("tasks")),
            "unlimited managed task queried its exact acceptance criteria")
        task = next(t for t in query("tasks") if t["member"] == member and t.get("resultPath") and t["state"] == "completed")
        assert task["timeoutPolicy"] == "none" and task["timeoutMs"] == 0
        assert "Exact decode findings saved" in Path(task["resultPath"]).read_text()
        artifact = workspace / "decode-findings.txt"
        if artifact.exists():
            artifact.unlink()
        tool("write", {"path": str(artifact), "content": "Decoder and immediate mapping reviewed in isolated test.\n"})
        wait(artifact.exists, "isolated evidence artifact written")
        tool("goal_accept", {"goalId": leaf["id"], "revision": 0, "evidence": [
            {"criterion": 1, "source": "artifact", "path": str(artifact), "summary": "Decode file batch findings recorded in dedicated test workspace"}]})
        wait(lambda: any(n["id"] == leaf["id"] and n["state"] == "accepted" for n in query("goal_nodes")), "scope and evidence accepted once")
        line("/mission pause")
        wait(lambda: mission()["humanPaused"], "test goal paused for retention")
        marker = len(visible)
        line("/reload")
        wait(lambda: "Reloaded keybindings" in visible[marker:], "second /reload preserved test goal, scope and acceptance")
        retained = next(n for n in query("goal_nodes") if n["id"] == leaf["id"])
        assert retained["state"] == "accepted" and retained["scope"] == leaf["scope"]
        assert len(list(sessions.glob("*_" + config["id"] + ".jsonl"))) == 1
        assert not any(error in visible for error in ["UnhandledPromiseRejection", "Error loading extension"])
        config["sessionFile"] = str(next(sessions.glob("*_" + config["id"] + ".jsonl")))
        config["workspace"] = str(workspace)
        config["agentDir"] = str(agent)
        identity.write_text(json.dumps(config, ensure_ascii=False, indent=2))
        launcher = home / "open-test-session.sh"
        launcher.write_text("#!/bin/sh\nexport PI_CODING_AGENT_DIR='" + str(agent) + "'\ncd '" + str(workspace) + "'\nexec pi --offline --no-mcp --no-skills -e '" + str(fixture) + "' --provider mission-fixture --model model --thinking off --session '" + config["sessionFile"] + "'\n")
        launcher.chmod(0o700)
        report = {"passed": True, "sameProcess": process.poll() is None, "session": config, "checks": checks,
                  "candidateVersion": json.loads((candidate / "package.json").read_text())["version"]}
        (reports / "task-policies-tui.json").write_text(json.dumps(report, ensure_ascii=False, indent=2))
        print(json.dumps(report, ensure_ascii=False, indent=2))
    finally:
        if process.poll() is None:
            line("/quit")
            end = time.monotonic() + 5
            while process.poll() is None and time.monotonic() < end:
                drain()
            if process.poll() is None:
                os.killpg(process.pid, signal.SIGKILL)
                process.wait(timeout=5)
        (reports / "task-policies-tui.ansi").write_bytes(transcript)
        os.close(master)


if __name__ == "__main__":
    main()
