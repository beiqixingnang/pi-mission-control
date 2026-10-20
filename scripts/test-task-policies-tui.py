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
    lifecycle_trace = reports / ("tui-lifecycle-" + uuid.uuid4().hex[:8] + ".jsonl")
    environment.update(PI_CODING_AGENT_DIR=str(agent), PI_OFFLINE="1", TERM="xterm-256color", COLUMNS="140", LINES="42",
        MC_FIXTURE_LIFECYCLE_TRACE=str(lifecycle_trace))
    process = subprocess.Popen([shutil.which("pi"), "--offline", "--no-mcp", "--no-skills", "--no-context-files", "--no-prompt-templates",
        "--tools", "*",
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

    def reload(label):
        # TUI redraws can repeat an old "Reloaded" notice before a new reload
        # actually happens. Wait for a fresh session_start from the fixture.
        previous = len(lifecycle_trace.read_text().splitlines()) if lifecycle_trace.exists() else 0
        line("/reload")
        wait(lambda: lifecycle_trace.exists() and len(lifecycle_trace.read_text().splitlines()) > previous, label)
        end = time.monotonic() + .4
        while time.monotonic() < end:
            drain()

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
        reload("candidate loaded through literal /reload in the same Pi process")
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
        reload("second /reload preserved test goal, scope and acceptance")
        retained = next(n for n in query("goal_nodes") if n["id"] == leaf["id"])
        assert retained["state"] == "accepted" and retained["scope"] == leaf["scope"]
        # Real TUI fault injection uses only this offline provider and test workspace.
        (agent / "mission-control.json").write_text(json.dumps({"workerExtensions": [str(fixture)],
            "progressIntervalMs": 3600000, "recoveryMaxRequests": 3, "recoveryCooldownMs": 1000,
            "reconnect": {"enabled": True, "delayMs": 0}}))
        reload("fault-test settings loaded through /reload while paused")
        fault_dir = workspace / ("recovery-" + uuid.uuid4().hex[:8])
        fault_dir.mkdir()
        line("/mission resume")
        wait(lambda: not mission()["humanPaused"], "test mission resumed for automatic recovery fault injection")
        existing_nodes = {node["id"] for node in query("goal_nodes")}
        tool("goal_plan", {"goals": [{"parentId": leaf["parentId"], "objective": "Exercise isolated recovery evidence writes",
            "criteria": ["24 evidence writes survive a transient failure"],
            "scope": {"unitKind": "batch", "items": [str(fault_dir)]}}]})
        wait(lambda: any(n["id"] not in existing_nodes for n in query("goal_nodes")), "separate unaccepted goal registered for fault-injection evidence")
        fault_leaf = next(n for n in query("goal_nodes") if n["id"] not in existing_nodes)

        def recovery():
            values = query("meta", "key='leadRecovery'")
            return values[0] if values else None

        def attempts(file):
            return [json.loads(row) for row in file.read_text().splitlines()] if file.exists() else []

        def quiet(seconds):
            end = time.monotonic() + seconds
            while time.monotonic() < end:
                drain()

        def assistant_said(prefix):
            session_file = next(sessions.glob("*_" + config["id"] + ".jsonl"))
            with session_file.open("rb") as source:
                source.seek(max(0, session_file.stat().st_size - 1024 * 1024))
                lines = source.read().splitlines()
            for row in lines:
                try:
                    message = json.loads(row).get("message", {})
                except (ValueError, UnicodeError):
                    continue
                if message.get("role") == "assistant" and any(block.get("type") == "text" and
                    block.get("text", "").startswith(prefix) for block in message.get("content", [])):
                    return True
            return False

        tool("goal_focus", {"goalId": fault_leaf["id"], "revision": 0})
        wait(lambda: any(n["id"] == fault_leaf["id"] and n["state"] == "active" for n in query("goal_nodes")), "fault injection bound to the unaccepted file batch")
        burst_trace = fault_dir / "burst.jsonl"
        tool("schedule", {"action": "create", "title": "Injected upstream outage", "afterSeconds": 1,
            "prompt": "V2_TEST:" + json.dumps({"op": "flaky", "key": uuid.uuid4().hex,
                "failures": 5, "error": "502 Upstream service temporarily unavailable", "traceFile": str(burst_trace)}, separators=(",", ":"))})
        wait(lambda: recovery() and recovery()["phase"] == "exhausted", "injected upstream outage exhausted one bounded failure burst")
        saved_fault = recovery().copy()
        assert saved_fault["burstFailures"] == 3 and saved_fault["requests"] == 3
        assert saved_fault["nextAt"] > int(time.time() * 1000)
        reload("literal /reload retained the outage in the same Pi process")
        if recovery():
            assert recovery()["id"] == saved_fault["id"] and recovery()["requests"] >= 3
        wait(lambda: len(attempts(burst_trace)) >= 6 and not recovery(), "upstream outage recovered automatically after cooldown and reload without a human continue")
        burst = attempts(burst_trace)
        assert len(burst) == 6 and sum(row["failed"] for row in burst) == 5
        assert mission()["id"] == original["id"] and not mission()["humanPaused"]

        abort_trace = fault_dir / "provider-abort.jsonl"
        tool("schedule", {"action": "create", "title": "Injected provider abort", "afterSeconds": 1,
            "prompt": "V2_TEST:" + json.dumps({"op": "flaky", "key": uuid.uuid4().hex,
                "failures": 1, "transportAbort": True, "error": "This operation was aborted", "traceFile": str(abort_trace)}, separators=(",", ":"))})
        wait(lambda: len(attempts(abort_trace)) == 2 and not recovery(), "provider-side aborted response reconnected without becoming a user Escape hold")
        assert not query("meta", "key='escapeHold'") or not query("meta", "key='escapeHold'")[0]

        chain_dir = fault_dir / "chain"
        chain_dir.mkdir()
        chain_key = uuid.uuid4().hex
        tool("schedule", {"action": "create", "title": "Injected abort during source work", "afterSeconds": 1,
            "prompt": "V2_TEST:" + json.dumps({"op": "recovery-chain", "key": chain_key,
                "directory": str(chain_dir), "steps": 24}, separators=(",", ":"))})
        wait(lambda: len(list(chain_dir.glob("step-*.txt"))) == 24 and assistant_said("RECOVERY_CHAIN_COMPLETE " + chain_key),
            "24 real tool calls continued after one aborted request without exhausting the failure allowance")
        assert not recovery()

        pause_trace, pause_control = fault_dir / "pause.jsonl", fault_dir / "pause-control.json"
        pause_control.write_text(json.dumps({"failures": 100}))
        tool("schedule", {"action": "create", "title": "User pause during outage", "afterSeconds": 1,
            "prompt": "V2_TEST:" + json.dumps({"op": "flaky", "key": uuid.uuid4().hex,
                "controlFile": str(pause_control), "traceFile": str(pause_trace), "error": "This operation was aborted"}, separators=(",", ":"))})
        wait(lambda: recovery() and recovery()["phase"] == "exhausted", "second injected outage reached persisted cooldown")
        line("/mission pause")
        wait(lambda: mission()["humanPaused"], "user pause remained authoritative during an outage")
        paused_attempts = len(attempts(pause_trace))
        quiet(2)
        assert len(attempts(pause_trace)) == paused_attempts
        reload("paused recovery and accepted evidence survived literal /reload")
        quiet(2)
        assert len(attempts(pause_trace)) == paused_attempts and mission()["humanPaused"]
        checks.append("cooldown retries did not bypass a user pause, including after reload")
        pause_control.write_text(json.dumps({"failures": 0}))
        line("/mission resume")
        wait(lambda: len(attempts(pause_trace)) > paused_attempts and not recovery(), "explicit user resume continued the retained task after the provider was repaired")
        line("/mission pause")
        wait(lambda: mission()["humanPaused"], "test mission paused after fault regressions")
        (reports / "recovery-fault-injection.json").write_text(json.dumps({"passed": True,
            "sameProcess": process.poll() is None, "sessionId": config["id"], "outage": burst,
            "providerAbort": attempts(abort_trace), "chainWrites": 24, "pauseAttempts": attempts(pause_trace)}, indent=2))
        previous_tasks = {task["id"] for task in query("tasks")}
        line("/mission resume")
        wait(lambda: not mission()["humanPaused"], "test mission resumed for a long RPC lifecycle")
        tool("subagent", {"task": 'V2_TEST:{"op":"large-rpc-run","windows":4,"readsPerWindow":40}', "timeoutPolicy": "none"})
        wait(lambda: any(t["id"] not in previous_tasks and t["state"] == "completed" for t in query("tasks")),
            "real TUI member completed four notes windows, 160 source reads and a stream retry despite an oversized cumulative RPC snapshot", timeout=50)
        big_task = next(t for t in query("tasks") if t["id"] not in previous_tasks and t["state"] == "completed")
        assert "BIG_RPC_RECOVERED_WITHOUT_REPLAY" in Path(big_task["resultPath"]).read_text()
        big_rows = [json.loads(row) for row in Path(big_task["sessionFile"]).read_text().splitlines()]
        assert sum(len(json.dumps(row.get("message", {})).encode()) for row in big_rows) > 8 * 1024 * 1024
        assert sum(row.get("type") == "compaction" for row in big_rows) == 4
        line("/mission pause")
        wait(lambda: mission()["humanPaused"], "long RPC regression paused without changing prior acceptance")
        memory_file = agent / "context-memory" / config["id"] / "memory.sqlite"

        def memory_rows(sql, args=()):
            if not memory_file.exists():
                return []
            with sqlite3.connect(f"file:{memory_file}?mode=ro", uri=True) as db:
                return db.execute(sql, args).fetchall()

        def compactions():
            session_file = next(sessions.glob("*_" + config["id"] + ".jsonl"))
            return [row for row in map(json.loads, session_file.read_text().splitlines()) if row.get("type") == "compaction"]

        line("/context mode notes")
        wait(lambda: memory_rows("SELECT value FROM settings WHERE key='mode'") == [("notes",)], "notes mode selected in the existing Pi conversation")
        def local_budget():
            return [json.loads(row[0]).get("inputLimitTokens") for row in memory_rows("SELECT value FROM settings WHERE key LIKE 'context-budget:%'")]

        line("/context budget 40000")
        wait(lambda: 40000 in local_budget(), "model-specific conservative input budget selected through the TUI command")
        note_marker = "resume-decoder-" + uuid.uuid4().hex[:8]
        tool("context_note", {"action": "write", "name": "index", "text": "Dedicated context-memory regression; exact continuation in handoff."})
        wait(lambda: bool(memory_rows("SELECT name FROM notes WHERE name='index'")), "short memory index saved")
        tool("context_note", {"action": "write", "name": "handoff", "text": note_marker + ": inspect decoder.py line 120 next; this note does not accept any goal."})
        wait(lambda: any(note_marker in row[0] for row in memory_rows("SELECT text FROM notes WHERE name='handoff'")), "fresh handoff saved by a real model tool call")
        tool("context_note", {"action": "write", "notes": [
            {"name": "index", "text": "Atomic notes regression; exact next file/line in handoff."},
            {"name": "handoff", "text": note_marker + ": decoder.py line 173; still unaccepted."}]})
        wait(lambda: any("line 173; still unaccepted" in row[0] for row in memory_rows("SELECT text FROM notes WHERE name='handoff'")), "index and handoff saved in one atomic model tool call")
        versions = memory_rows("SELECT name,revision FROM notes WHERE name IN ('index','handoff') ORDER BY name")
        tool("context_note", {"action": "write", "notes": [
            {"name": "index", "text": "Atomic notes regression; exact next file/line in handoff."},
            {"name": "handoff", "text": note_marker + ": decoder.py line 173; still unaccepted."}]})
        quiet(.6)
        assert memory_rows("SELECT name,revision FROM notes WHERE name IN ('index','handoff') ORDER BY name") == versions
        checks.append("unchanged note batches retained their versions")
        before_windows = len(compactions())
        line("/context rollover")
        wait(lambda: len(compactions()) > before_windows, "notes rollover installed a new context without a summary-model request")
        assert note_marker in compactions()[-1]["summary"]
        assert compactions()[-1].get("details", {}).get("contextMode") == "notes"
        tool("context_note", {"action": "write", "name": "handoff", "text": note_marker + ": latest tool-boundary handoff; continue decoder.py line 173; unaccepted."})
        before_windows = len(compactions())
        tool("context_rollover", {})
        wait(lambda: len(compactions()) > before_windows and compactions()[-1].get("details", {}).get("boundary"), "model tool rollover committed at the current boundary and continued in the same Pi process")
        reload("notes context survived literal /reload in the same Pi process")
        assert memory_rows("SELECT value FROM settings WHERE key='mode'") == [("notes",)]
        assert 40000 in local_budget()
        checks.append("reload preserved the model-specific input budget")
        tool("context_history", {"action": "search", "query": note_marker})
        wait(lambda: bool(memory_rows("SELECT id FROM history WHERE instr(text,?)>0", (note_marker,))), "earlier public history remains searchable after rollover and reload")
        tool("context_history", {"action": "batch", "requests": [
            {"action": "search", "query": note_marker, "role": "user", "limit": 3},
            {"action": "search", "query": "decoder", "limit": 3}], "budgetTokens": 1000})
        wait(lambda: assistant_said('{"isError":false,"text":"{\\"results\\":') or 'requestIndex' in visible[-20000:], "batched history lookup returned bounded results through the TUI")
        line("/context budget auto")
        wait(lambda: 40000 not in local_budget(), "explicit input override reset without changing Pi model settings")
        line("/model wide")
        quiet(.7)
        os.write(master, b"\r")
        quiet(.5)
        tool("context_mode", {"mode": "notes", "inputLimitTokens": 300000})
        wait(lambda: 300000 in local_budget(), "300k notes budget selected for the wide test model")
        before_windows = len(compactions())
        line('V2_TEST:' + json.dumps({"op": "notes-cycle", "windows": 2, "auto": True,
            "file": str(workspace / "decode-findings.txt"), "highUsageTokens": 290000}, separators=(",", ":")))
        wait(lambda: len(compactions()) == before_windows + 2, "a burst beyond the 300k window handoff reserve still produced two safe windows and continued")
        line("/model model")
        quiet(.6)
        os.write(master, b"\r")
        quiet(.5)
        line("/context mode summary")
        wait(lambda: memory_rows("SELECT value FROM settings WHERE key='mode'") == [("summary",)], "same conversation switched back to summary mode")
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
