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
    summary_control = reports / ("summary-control-" + uuid.uuid4().hex[:8] + ".json")
    summary_trace = reports / ("summary-requests-" + uuid.uuid4().hex[:8] + ".jsonl")
    environment.update(PI_CODING_AGENT_DIR=str(agent), PI_OFFLINE="1", TERM="xterm-256color", COLUMNS="140", LINES="42",
        MC_FIXTURE_LIFECYCLE_TRACE=str(lifecycle_trace), MC_FIXTURE_SUMMARY_CONTROL=str(summary_control), MC_FIXTURE_SUMMARY_TRACE=str(summary_trace))
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

    def editor_ready(label):
        nonce = uuid.uuid4().hex
        end = time.monotonic() + 20
        while time.monotonic() < end:
            line("/fixture-ready " + nonce)
            for _ in range(3):
                drain()
                if lifecycle_trace.exists():
                    for record in lifecycle_trace.read_text().splitlines():
                        try:
                            event = json.loads(record)
                        except json.JSONDecodeError:
                            continue
                        if event.get("event") == "fixture_ready" and event.get("nonce") == nonce and event.get("pid") == process.pid:
                            checks.append(label)
                            return
            if process.poll() is not None:
                raise AssertionError("Pi exited before editor readiness: " + label)
        raise AssertionError("Editor did not acknowledge a real command: " + label)

    def reload(label):
        # TUI redraws can repeat an old "Reloaded" notice before a new reload
        # actually happens. Wait for a fresh session_start from the fixture.
        previous = len(lifecycle_trace.read_text().splitlines()) if lifecycle_trace.exists() else 0
        line("/reload")
        wait(lambda: lifecycle_trace.exists() and len(lifecycle_trace.read_text().splitlines()) > previous, label)
        end = time.monotonic() + .4
        while time.monotonic() < end:
            drain()
        editor_ready("reloaded editor acknowledged a real command before further test input")

    try:
        wait(lambda: database.exists() and "↑" in visible and "model" in visible, "dedicated test conversation opened and TUI input is ready")
        editor_ready("startup editor acknowledged a real command before test setup")
        line("/name " + config["name"])
        if mission() and mission()["status"] not in ["complete", "stopped"]:
            line("/mission stop")
            wait(lambda: mission()["status"] == "stopped", "previous isolated test goal explicitly stopped before a new regression")
        if query("meta", "key='relocationHold'") == [True]:
            line("/mission resume")
            wait(lambda: query("meta", "key='relocationHold'") == [False], "a leftover dedicated-test migration pause was explicitly resumed before new setup")
        run_goal = "Plugin task policy regression " + uuid.uuid4().hex[:8]
        line("/mission start " + run_goal + " | Preserve the dedicated test conversation")
        wait(lambda: mission() and mission()["objective"] == run_goal, "baseline goal recorded")
        line("/mission pause")
        wait(lambda: mission()["humanPaused"], "baseline paused")
        legacy_workspace_block = query("meta", "key='relocationHold'") == [True]
        if legacy_workspace_block:
            tool("goal_edit", {"goalId": mission()["id"], "revision": mission().get("revision", 0), "state": "blocked",
                "reason": "实际配置与验证已完成；工作区迁移hold仍由用户控制，不能通过运行时no-progress恢复工具解除。"})
            wait(lambda: any(node["id"] == mission()["id"] and node["state"] == "blocked" for node in query("goal_nodes")),
                "installed baseline reproduced the legacy migration-only goal blocker")
            end = time.monotonic() + .5
            while time.monotonic() < end:
                drain()
        original = mission().copy()
        copy_package(candidate, package)
        reload("candidate loaded through literal /reload in the same Pi process")
        assert mission()["id"] == original["id"] and mission()["humanPaused"]
        assert mission()["outputTokens"] == original["outputTokens"]
        line("/mission resume")
        wait(lambda: not mission()["humanPaused"], "same goal explicitly resumed")
        if legacy_workspace_block:
            assert next(node for node in query("goal_nodes") if node["id"] == original["id"])["state"] != "blocked"
            assert query("meta", "key='relocationHold'") == [False]
            checks.append("one manual resume released the baseline legacy goal blocker after same-process reload")
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
        # Upgrade semantics must work through the same TUI and conversation.
        policy_dir = workspace / ("capabilities-" + uuid.uuid4().hex[:8])
        policy_dir.mkdir()
        executor = "executor-" + uuid.uuid4().hex[:6]
        reviewer = "reviewer-" + uuid.uuid4().hex[:6]
        for name in [executor, reviewer]:
            tool("team_spawn", {"name": name, "role": name, "model": "mission-fixture/model", "workspace": {"execution": "files"}})
            wait(lambda: any(m["name"] == name for m in query("members")), "same TUI created " + name + " with an independent model and capability profile")
        named_output = workspace / ".agents" / ("receipt-" + uuid.uuid4().hex[:6] + ".txt")
        tool("team_send", {"to": executor, "message": "V2_TEST:" + json.dumps({"op": "tool", "name": "write", "args": {"path": str(named_output), "content": "AUTHORIZED_NAMED_DIRECTORY"}})})
        wait(named_output.exists, "member wrote .agents under its authorized root without a directory-name blacklist")
        wait(lambda: not any(t["member"] == executor and t["state"] in ["running", "queued", "waiting"] for t in query("tasks")), "named-directory member task settled")
        command, denied_output = policy_dir / "command.txt", policy_dir / "denied-write.txt"
        tool("team_send", {"to": executor, "message": "V2_TEST:" + json.dumps({"op": "boundary-batch", "file": str(command), "output": str(denied_output), "delayMs": 3500})})
        wait(lambda: Path(str(command) + ".started").exists(), "finite member operation started before a running capability update")
        tool("team_configure", {"name": executor, "tools": ["read", "fixture_boundary_command"]})
        wait(lambda: next(m for m in query("members") if m["name"] == executor).get("revision", 0) == 2, "new desired capabilities were registered while the old operation was running")
        wait(lambda: any(t["member"] == executor and t.get("epoch") == 2 and t["state"] == "completed" for t in query("tasks")), "safe capability checkpoint resumed the same task under revision 2")
        assert command.read_text() == "COMMAND_FINISHED" and not denied_output.exists()
        checks.append("running operation drained completely; the new tool allowlist denied the next write")
        tool("team_configure", {"name": executor, "tools": None})
        wait(lambda: next(m for m in query("members") if m["name"] == executor).get("revision", 0) == 3, "full permitted tools restored without creating a task")
        batch, continued, review_receipt = policy_dir / "batch.txt", policy_dir / "continued.txt", policy_dir / "review.txt"
        batch.write_text("BEFORE_REVIEW")
        tool("team_send", {"to": executor, "message": "V2_TEST:" + json.dumps({"op": "boundary-batch", "file": str(batch), "output": str(continued), "delayMs": 3500})})
        wait(lambda: Path(str(batch) + ".started").exists(), "executor began the next concrete file batch")
        tool("team_review", {"action": "request", "executor": executor, "reviewer": reviewer, "files": [str(batch)],
            "message": "V2_TEST:" + json.dumps({"op": "tool", "name": "fixture_boundary_command", "args": {"file": str(review_receipt), "delayMs": 2500}})})
        wait(lambda: Path(str(review_receipt) + ".started").exists(), "reviewer started only after the executor reached its safe boundary")
        assert batch.read_text() == "COMMAND_FINISHED" and not continued.exists()
        wait(continued.exists, "executor continued its same batch after review completed")
        held_member = next(m for m in query("members") if m["name"] == executor)
        review = query("meta", "key=?", ("reviewHold:" + held_member["id"],))[0]
        assert review["state"] == "released" and Path(review["snapshotPath"]).exists() and Path(review["resultPath"]).exists()
        checks.append("review snapshot, held execution and release receipts persisted in the existing conversation")
        wait(lambda: not any(t["member"] == executor and t["state"] in ["running", "queued", "waiting"] for t in query("tasks")), "reviewed execution settled before acceptance")
        previous_tasks = len(query("tasks"))
        tool("team_message", {"to": reviewer, "operation": "note", "message": "Direct discussion only; no formal task"})
        wait(lambda: any(d["to"] == reviewer and "Direct discussion only" in d["summary"] for d in query("deliveries")), "idle note was retained without a new execution turn")
        assert len(query("tasks")) == previous_tasks
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
        assert compactions()[-1]["details"]["injectedNotes"]["index"]["revision"] == dict(versions)["index"]
        checks.append("native notes checkpoint retained the exact injected index revision")
        tool("context_note", {"action": "write", "name": "handoff", "text": note_marker + ": latest tool-boundary handoff; continue decoder.py line 173; unaccepted."})
        before_windows = len(compactions())
        tool("context_rollover", {})
        wait(lambda: len(compactions()) > before_windows and compactions()[-1].get("details", {}).get("boundary"), "model tool rollover committed at the current boundary and continued in the same Pi process")
        assert compactions()[-1]["details"]["injectedNotes"]["index"]["revision"] == dict(versions)["index"]
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
        def latest_tool(name):
            session_file = next(sessions.glob("*_" + config["id"] + ".jsonl"))
            for row in reversed(session_file.read_text().splitlines()):
                entry = json.loads(row)
                message = entry.get("message", {})
                if message.get("role") == "toolResult" and message.get("toolName") == name:
                    return entry

        def call_tool(name, args):
            previous = latest_tool(name)
            tool(name, args)
            wait(lambda: latest_tool(name) and latest_tool(name)["id"] != (previous or {}).get("id"), "model tool completed: " + name)
            quiet(.4)
            message = latest_tool(name)["message"]
            text = "".join(block.get("text", "") for block in message["content"])
            return message.get("isError", False), text

        failed, text = call_tool("context_mode", {"mode": "notes"})
        assert failed and "current user's authorization" in text
        checks.append("a real model cannot switch the summary conversation to notes without human authorization")
        failed, text = call_tool("context_note", {"action": "write", "name": "manual-mode-regression", "text": "Optional manual working note; do not switch context modes."})
        receipt = json.loads(text)
        assert not failed and receipt["mode"] == "summary" and receipt["noteUse"] == "manual-only"
        assert memory_rows("SELECT value FROM settings WHERE key='mode'") == [("summary",)]
        checks.append("summary mode note receipts explicitly identify manual storage without changing modes")
        reload("summary mode and manual notes survive literal /reload in the same Pi process")
        failed, text = call_tool("context_note", {"action": "read", "name": "manual-mode-regression"})
        assert not failed and json.loads(text)["noteUse"] == "manual-only"
        previous = latest_tool("context_mode")
        line("帮我把当前会话换成记笔记那套。V2_TEST:" + json.dumps({"op": "tool", "name": "context_mode", "args": {"mode": "notes"}, "noRepeatWake": True}, separators=(",", ":")))
        wait(lambda: latest_tool("context_mode") and latest_tool("context_mode")["id"] != previous["id"], "ordinary natural-language authorization allowed the real model mode change")
        assert not latest_tool("context_mode")["message"].get("isError", False)
        assert memory_rows("SELECT value FROM settings WHERE key='mode'") == [("notes",)]
        quiet(.4)
        line("/context mode summary")
        wait(lambda: memory_rows("SELECT value FROM settings WHERE key='mode'") == [("summary",)], "the user's direct mode command remains available")

        line("/mission resume")
        wait(lambda: not mission()["humanPaused"], "test mission resumed for root-identity regression")

        # Only the dedicated test agent's summary preferences are reset. This
        # reproduces an existing main conversation with no model override.
        for summary_config in [database.parent / "compaction-summary.json", agent / "compaction-summary.json"]:
            summary_config.unlink(missing_ok=True)
        summary_control.write_text(json.dumps({"mode": "success"}))
        failed, text = call_tool("compaction_model", {"action": "status", "target": "lead"})
        summary_status = json.loads(text)
        assert not failed and summary_status["engine"] == "chunked" and summary_status["modelSelection"] == "current-model"
        compaction_salt = uuid.uuid4().hex
        for batch in range(3):
            failed, text = call_tool("fixture_large_read", {"index": batch + 5000, "salt": compaction_salt})
            assert not failed
        summary_before = len(attempts(summary_trace))
        before_checkpoint = len(compactions())
        line("/compact")
        wait(lambda: len(compactions()) == before_checkpoint + 1, "an existing unconfigured conversation compacted through the default chunked path")
        requests = attempts(summary_trace)[summary_before:]
        assert len(requests) > 1 and all(request["inputChars"] <= summary_status["maxInputChars"] for request in requests)
        checks.append("default compaction sent multiple bounded requests without a summary-model configuration")
        quiet(.4)
        editor_ready("editor acknowledged input after default chunked compaction")
        for batch in range(3):
            failed, text = call_tool("fixture_large_read", {"index": batch + 6000, "salt": uuid.uuid4().hex})
            assert not failed
        before_checkpoint = len(compactions())
        summary_control.write_text(json.dumps({"mode": "wrapped-outage"}))
        overflow_trace = reports / ("summary-overflow-" + uuid.uuid4().hex[:8] + ".jsonl")
        line("V2_TEST:" + json.dumps({"op": "flaky", "key": uuid.uuid4().hex, "failures": 1,
            "traceFile": str(overflow_trace), "error": "Your input exceeds the context window of this model. Please adjust your input and try again."}, separators=(",", ":")))
        wait(lambda: recovery() and recovery()["phase"] == "compaction_failed" and "Context overflow recovery failed:" in recovery()["reason"],
            "the screenshot's exact wrapped upstream outage reached persistent compaction recovery")
        saved_summary_fault = recovery().copy()
        assert saved_summary_fault["nextAt"] > 0
        reload("wrapped compaction failure retained its automatic retry through literal /reload")
        summary_control.write_text(json.dumps({"mode": "success"}))
        wait(lambda: len(compactions()) > before_checkpoint and not recovery(), "healthy default compaction resumed automatically after the wrapped outage without a user continue", timeout=40)
        assert memory_rows("SELECT value FROM settings WHERE key='mode'") == [("summary",)]
        checks.append("compaction recovery preserved summary mode and existing goal acceptance")
        summary_control.unlink()
        selected = mission()["id"]
        marker = "Unselected root identity regression " + uuid.uuid4().hex[:8]
        failed, text = call_tool("goal_plan", {"goals": [{"objective": marker, "criteria": ["Evidence belongs to this exact root"]}]})
        assert not failed
        unselected = next(node for node in query("goal_nodes") if node["objective"] == marker)
        before_roots = [node for node in query("goal_nodes") if node["id"] in [selected, unselected["id"]]]
        failed, text = call_tool("goal_accept", {"goalId": unselected["id"], "revision": 0,
            "evidence": [{"criterion": 1, "source": "statement", "summary": "Evidence for the unselected fixture root only"}]})
        assert failed and "identity" in text.lower()
        assert mission()["id"] == selected
        assert [node for node in query("goal_nodes") if node["id"] in [selected, unselected["id"]]] == before_roots
        checks.append("unselected root acceptance was rejected without changing either root")

        # The tool fixture JSON escapes these characters, so its control prompt
        # cannot itself become another literal user-history search hit.
        search_marker = "检索游标" + uuid.uuid4().hex[:8]
        for i in range(5):
            line("V2_TEST:" + json.dumps({"op": "answer", "text": search_marker + "中文🙂" * 300}, ensure_ascii=False))
            quiet(.5)
        cursor, seen = None, []
        for page in range(10):
            request = {"action": "search", "query": search_marker, "role": "user", "limit": 2}
            if cursor:
                request["cursor"] = cursor
            failed, text = call_tool("context_history", {"action": "batch", "requests": [request], "budgetTokens": 256, "startRequest": 0})
            assert not failed, text
            result = json.loads(text)
            assert result["results"][0]["matches"]
            seen.extend(hit["id"] for hit in result["results"][0]["matches"])
            cursor = result["results"][0].get("nextCursor")
            if not cursor:
                break
            assert result["nextRequest"] == 0
            if page == 0:
                reload("search cursor survived literal /reload in the same Pi process")
        assert len(seen) == len(set(seen)) == 5
        checks.append("256-token Unicode search pages retained every user hit without duplicates")
        filled_search = {"action": "search", "budgetTokens": 1000, "cursor": "", "id": "", "limit": 3,
            "offset": 0, "query": search_marker, "requests": [{"action": "search", "cursor": "", "id": "", "limit": 3,
                "offset": 0, "query": search_marker, "role": "user"}], "role": "user", "startRequest": 0}
        failed, text = call_tool("context_history", filled_search)
        assert not failed, text
        original_history_id = json.loads(text)["matches"][0]["id"]
        checks.append("first history search accepts empty optional fields from a model tool call")
        failed, text = call_tool("context_history", {**filled_search, "cursor": "0"})
        assert failed and "omit cursor" in text
        excluded_receipt_id = latest_tool("context_history")["id"]
        failed, text = call_tool("context_history", {"action": "read", "id": excluded_receipt_id, "offset": 0, "limit": 1000})
        assert failed and "HISTORY_ITEM_EXCLUDED" in text and "Do not retry" in text
        checks.append("invented cursors and excluded memory receipts explain how to recover without exposing tool echoes")
        failed, text = call_tool("context_history", {"action": "read", "id": original_history_id, "offset": 0, "limit": 1000})
        assert not failed and search_marker in json.loads(text)["text"], text
        reload("history placeholder compatibility and original message IDs survived literal /reload")
        failed, text = call_tool("context_history", {**filled_search, "action": "batch", "cursor": None,
            "requests": [{**filled_search["requests"][0], "cursor": None}]})
        assert not failed and json.loads(text)["results"][0]["matches"], text
        checks.append("batched first-page searches accept null placeholders after reload")
        failed, _ = call_tool("goal_stop", {"goalId": selected, "reason": "Isolated review regression completed"})
        assert not failed and mission() is None
        clock = query("meta", "key=?", ("goalActivityClock:" + selected,))[0]
        assert clock["state"] == "ended"
        reload("stopped goal activity remained ended through literal /reload")
        assert query("meta", "key=?", ("goalActivityClock:" + selected,))[0] == clock
        checks.append("stopped activity clock retained its exact receipt after reload")
        unknown_tasks = [task for task in query("tasks") if task.get("processState") == "unknown"]
        if unknown_tasks:
            # Inspect actual Linux processes before invoking the normal epoch-
            # fenced reconciliation tool for leftovers from earlier test runs.
            unknown_ids = {task["id"] for task in unknown_tasks}
            for process_dir in Path("/proc").iterdir():
                if not process_dir.name.isdigit():
                    continue
                try:
                    if process_dir.stat().st_uid != os.getuid():
                        continue
                    if (process_dir / "comm").read_text().strip() not in ["node", "pi"]:
                        continue
                    for item in (process_dir / "environ").read_bytes().split(b"\0"):
                        if item.startswith(b"MC_V2_MEMBER="):
                            worker = json.loads(item.split(b"=", 1)[1])
                            assert worker.get("taskId") not in unknown_ids, "A prior dedicated test worker is still alive; do not reconcile it as stopped"
                except FileNotFoundError:
                    continue
            failed, text = call_tool("mission_reconcile", {"tasks": [
                {"taskId": task["id"], "expectedEpoch": task["epoch"]} for task in unknown_tasks],
                "evidence": "Inspected same-user Linux /proc node/pi environments for the exact old dedicated-test task IDs; no matching worker process remains."})
            assert not failed, text
            checks.append("old unknown test executions were reconciled only after actual /proc inspection")
        # Exercise the actual user's intended flow only in the dedicated test
        # workspace, then rename back. Each continuation keeps its ancestry.
        line("/context mode notes")
        wait(lambda: memory_rows("SELECT value FROM settings WHERE key='mode'") == [("notes",)], "user selected notes for the independent workspace migration regression")
        failed, _ = call_tool("context_mode", {"mode": "notes", "inputLimitTokens": 300000})
        assert not failed
        relocation_note = "RELOCATION_NOTE_" + uuid.uuid4().hex[:8]
        failed, _ = call_tool("context_note", {"action": "write", "notes": [
            {"name": "index", "text": relocation_note},
            {"name": "handoff", "text": "Next inspect decode-findings.txt line 173; unaccepted."}]})
        assert not failed
        failed, _ = call_tool("compaction_model", {"action": "set", "model": "mission-fixture/summary"})
        assert not failed
        original_workspace = workspace
        rename_ancestry = [config["id"]]
        for destination in [home / "workspace 中文 rename", original_workspace]:
            source_workspace, source_session_id = workspace, config["id"]
            line('请把当前本地工作区文件夹改名为“' + destination.name + '”，并保留当前对话。')

            def relocation_ready():
                if not lifecycle_trace.exists():
                    return False
                newest = json.loads(lifecycle_trace.read_text().splitlines()[-1])
                return newest["sessionId"] != source_session_id and destination.is_dir() and not source_workspace.exists()

            wait(relocation_ready, "natural-language request led the model to rename the isolated workspace after settlement in the same Pi process")
            quiet(.5)
            config["id"] = json.loads(lifecycle_trace.read_text().splitlines()[-1])["sessionId"]
            rename_ancestry.append(config["id"])
            workspace = destination
            database = agent / "mission-control/v2" / config["id"] / "state.sqlite"
            memory_file = agent / "context-memory" / config["id"] / "memory.sqlite"
            assert memory_rows("SELECT value FROM settings WHERE key='mode'") == [("notes",)]
            assert memory_rows("SELECT text FROM notes WHERE name='index'") == [(relocation_note,)]
            route = json.loads((database.parent / "compaction-summary.json").read_text())
            assert route["model"] == "mission-fixture/summary"
            retained = next(node for node in query("goal_nodes") if node["id"] == leaf["id"])
            assert retained["state"] == "accepted" and retained["scope"] == leaf["scope"]
            failed, text = call_tool("read", {"path": "decode-findings.txt"})
            assert not failed and "Decoder and immediate mapping" in text, text
            reload("renamed workspace retained notes, goals and summary routing through literal /reload")
            assert memory_rows("SELECT text FROM notes WHERE name='index'") == [(relocation_note,)]
            failed, text = call_tool("project_status", {"diagnose": True})
            project_status = json.loads(text)
            assert not failed and project_status["cwd"] == str(workspace), text
            assert project_status["locks"]["supported"] is False and project_status["locks"]["exhaustive"] is False
            checks.append("reloaded project_status accepts diagnose from the model and degrades explicitly on non-Windows")
            checks.append("workspace continuation preserved accepted goal, relative file tools and memory data")
            identity.write_text(json.dumps({**config, "workspace": str(workspace)}, ensure_ascii=False, indent=2))
        assert workspace == original_workspace and len(set(rename_ancestry)) == 3
        checks.append("natural-language CJK workspace rename and rename-back completed without user slash commands or restarting Pi")
        line("/context mode summary")
        wait(lambda: memory_rows("SELECT value FROM settings WHERE key='mode'") == [("summary",)], "user selected summary after the independent migration regression")
        failed, _ = call_tool("context_mode", {"mode": "summary"})
        assert not failed
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

    # The user exits Pi before moving the directory. Then one new CLI command
    # must recover the same dedicated conversation without any model request.
    manual_recovery_round_trip(home, config, checks, reports, environment, fixture, leaf["id"], relocation_note)
    portable_transfer_check(home, config, checks, reports, environment, candidate)


def manual_recovery_round_trip(home, config, checks, reports, environment, fixture, accepted_leaf, note):
    agent = home / "agent"
    sessions = agent / "sessions"
    destinations = [home / "workspace 用户移动", home / "workspace"] if Path(config["workspace"]) == home / "workspace" else [home / "workspace"]
    for cycle, destination in enumerate(destinations):
        source = Path(config["workspace"])
        assert source.is_dir() and not destination.exists()
        source.rename(destination)
        master, slave = pty.openpty()
        fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 42, 140, 0, 0))
        trace = reports / ("restore-lifecycle-" + uuid.uuid4().hex[:8] + ".jsonl")
        calls = reports / ("restore-model-calls-" + uuid.uuid4().hex[:8] + ".jsonl")
        env = {**environment, "MC_FIXTURE_LIFECYCLE_TRACE": str(trace), "MC_FIXTURE_CACHE_TRACE": str(calls)}
        process = subprocess.Popen([shutil.which("pi"), "--recover-here", "--offline", "--no-mcp", "--no-skills", "--no-context-files", "--no-prompt-templates", "--tools", "*", "-e", str(fixture), "--provider", "mission-fixture", "--model", "model", "--thinking", "off", "--session-dir", str(sessions)],
            cwd=destination, env=env, stdin=slave, stdout=slave, stderr=slave, start_new_session=True)
        os.close(slave)
        data, visible = bytearray(), ""
        decoder = codecs.getincrementaldecoder("utf-8")("replace")

        def drain():
            nonlocal visible
            if select.select([master], [], [], .1)[0]:
                try:
                    chunk = os.read(master, 65536)
                except OSError:
                    return
                data.extend(chunk)
                visible += decoder.decode(chunk)
                if b"\x1b[c" in chunk:
                    os.write(master, b"\x1b[?1;2c")

        def wait(predicate, label, timeout=60):
            end = time.monotonic() + timeout
            while time.monotonic() < end:
                drain()
                if predicate():
                    checks.append(label)
                    return
                assert process.poll() is None, "Recovery Pi exited: " + visible[-2000:]
            raise AssertionError(label + "\n" + visible[-3000:])

        def line(text):
            drain()
            os.write(master, text.encode())
            drain()
            os.write(master, b"\r")

        def events():
            return [json.loads(row) for row in trace.read_text().splitlines()] if trace.exists() else []

        old_id = config["id"]
        try:
            wait(lambda: "恢复对话到当前工作区" in visible, "one-command --recover-here opened its searchable selector without a prompt")
            assert not calls.exists(), "The recovery picker must not call a model"
            line(old_id)
            wait(lambda: any(e["reason"] == "resume" and e["cwd"] == str(destination) for e in events()), "selecting the old conversation restored it despite its missing original directory")
            assert not calls.exists(), "Restoring must not call a model"
            selected = next(e for e in reversed(events()) if e["reason"] == "resume")
            assert selected["pid"] == process.pid
            config.update(id=selected["sessionId"], sessionFile=selected["sessionFile"], workspace=str(destination))
            assert config["id"] != old_id
            database = agent / "mission-control/v2" / config["id"] / "state.sqlite"
            with sqlite3.connect(database) as db:
                relocation = json.loads(db.execute("SELECT data FROM meta WHERE key='relocation'").fetchone()[0])
                assert relocation["previousSessionId"] == old_id and relocation["plan"]["action"] == "restore"
                goal = json.loads(db.execute("SELECT data FROM goal_nodes WHERE id=?", (accepted_leaf,)).fetchone()[0])
                assert goal["state"] == "accepted"
            wait(lambda: json.loads(Path(relocation["journal"]).read_text())["state"] == "completed" and not (agent / "mission-control/v2" / old_id / "owner.lock").exists(), "native recovery completed and released the old ledger before the next command")
            with sqlite3.connect(agent / "context-memory" / config["id"] / "memory.sqlite") as db:
                assert db.execute("SELECT text FROM notes WHERE name='index'").fetchone() == (note,)
            assert json.loads((database.parent / "compaction-summary.json").read_text())["model"] == "mission-fixture/summary"
            checks.append("manual recovery retained accepted evidence, notes and explicit summary routing without replay")
            wait(lambda: "手动执行 /mission resume" in visible and "迁移后待恢复" in visible,
                "recovery completion explicitly showed the manual resume command and accurate held status")
            (home / "test-session.json").write_text(json.dumps(config, ensure_ascii=False, indent=2))
            previous = len(events())
            line("/reload")
            wait(lambda: len(events()) > previous and events()[-1]["reason"] == "reload", "literal /reload kept the restored conversation in the same Pi process")
            assert events()[-1]["sessionId"] == config["id"] and events()[-1]["pid"] == process.pid
            # session_start precedes Pi's final editor restoration. Use a
            # public test command to acknowledge input readiness, without a
            # model call or relying on a transient redraw notice.
            nonce = uuid.uuid4().hex
            end = time.monotonic() + 20
            ready = False
            while time.monotonic() < end and not ready:
                line("/fixture-ready " + nonce)
                quiet_until = time.monotonic() + .5
                while time.monotonic() < quiet_until:
                    drain()
                ready = any(e.get("event") == "fixture_ready" and e.get("nonce") == nonce for e in events())
            assert ready, "Reload did not restore its editor or reopened the startup selector"
            assert not calls.exists(), "UI readiness must not call a model"
            checks.append("restored editor acknowledged input after reload without a model request")
            line('V2_TEST:{"op":"tool","name":"read","args":{"path":"decode-findings.txt"},"noRepeatWake":true}')

            def read_finished():
                if not Path(config["sessionFile"]).exists():
                    return False
                for row in reversed(Path(config["sessionFile"]).read_text().splitlines()[-12:]):
                    message = json.loads(row).get("message", {})
                    if message.get("role") == "toolResult" and message.get("toolName") == "read":
                        return not message.get("isError") and "Decoder and immediate mapping" in json.dumps(message)
                return False

            wait(read_finished, "restored workspace accepted a model file read after reload instead of reopening the startup picker")

            def last_tool(name):
                for row in reversed(Path(config["sessionFile"]).read_text().splitlines()[-15:]):
                    message = json.loads(row).get("message", {})
                    if message.get("role") == "toolResult" and message.get("toolName") == name:
                        return message
                return None

            marker = "RESTORED_WRITE_" + uuid.uuid4().hex
            write_args = {"path": "resume-confirmation.txt", "content": marker}
            line("V2_TEST:" + json.dumps({"op": "tool", "name": "write", "args": write_args, "noRepeatWake": True}))
            wait(lambda: last_tool("write") and last_tool("write").get("isError") and "/mission resume" in json.dumps(last_tool("write")),
                "a real model write remained blocked by migration control before manual resume")
            assert not (destination / "resume-confirmation.txt").exists() or (destination / "resume-confirmation.txt").read_text() != marker
            with sqlite3.connect(database) as db:
                row = db.execute("SELECT data FROM meta WHERE key='mission'").fetchone()
                current_goal = json.loads(row[0]) if row else None
            if current_goal and current_goal["status"] not in ["complete", "stopped"]:
                line("V2_TEST:" + json.dumps({"op": "tool", "name": "goal_edit", "args": {
                    "goalId": current_goal["id"], "revision": current_goal.get("revision", 0), "state": "blocked",
                    "blockedBy": "workspace", "reason": "等待本次迁移确认"}, "noRepeatWake": True}))
                wait(lambda: last_tool("goal_edit") and not last_tool("goal_edit").get("isError"),
                    "workspace-only blocker was recorded through the real model schema")
            line("/mission resume")

            def resumed():
                with sqlite3.connect(f"file:{database}?mode=ro", uri=True) as db:
                    row = db.execute("SELECT data FROM meta WHERE key='relocationHold'").fetchone()
                    if row != ("false",):
                        return False
                    if not current_goal:
                        return True
                    row = db.execute("SELECT data FROM goal_nodes WHERE id=?", (current_goal["id"],)).fetchone()
                    return not row or json.loads(row[0])["state"] != "blocked"

            wait(resumed, "one literal user resume released the migration hold and its associated goal blocker")
            if not current_goal or current_goal["status"] in ["complete", "stopped"]:
                line("V2_TEST:" + json.dumps({"op": "tool", "name": "goal_start", "args": {
                    "objective": "Verify recovered workspace manual resume " + str(cycle), "criteria": ["README-style write succeeds"]}, "noRepeatWake": True}))
                wait(lambda: last_tool("goal_start") and not last_tool("goal_start").get("isError"),
                    "a new authorized goal could start after the manual workspace confirmation")
            line("V2_TEST:" + json.dumps({"op": "tool", "name": "write", "args": write_args, "noRepeatWake": True}))
            wait(lambda: (destination / "resume-confirmation.txt").exists() and (destination / "resume-confirmation.txt").read_text() == marker,
                "the same restored Pi could write an actual project file after one manual resume")
        finally:
            if process.poll() is None:
                line("/quit")
                end = time.monotonic() + 8
                while process.poll() is None and time.monotonic() < end:
                    drain()
                if process.poll() is None:
                    os.killpg(process.pid, signal.SIGKILL)
                    process.wait(timeout=5)
            (reports / ("manual-recovery-" + str(cycle) + ".ansi")).write_bytes(data)
            os.close(master)
    launcher = home / "open-test-session.sh"
    launcher.write_text("#!/bin/sh\nexport PI_CODING_AGENT_DIR='" + str(agent) + "'\ncd '" + config["workspace"] + "'\nexec pi --offline --no-mcp --no-skills -e '" + str(fixture) + "' --provider mission-fixture --model model --thinking off --session '" + config["sessionFile"] + "'\n")
    launcher.chmod(0o700)
    report_file = reports / "task-policies-tui.json"
    report = json.loads(report_file.read_text())
    report.update(session=config, checks=checks, manualRestoreRoundTrip=True, recoveryModelRequests=0)
    report_file.write_text(json.dumps(report, ensure_ascii=False, indent=2))
    print("MANUAL_RECOVERY_RESULT " + json.dumps({"passed": True, "checks": len(checks), "session": config, "modelRequestsDuringRecovery": 0}, ensure_ascii=False))


def portable_transfer_check(home, config, checks, reports, environment, candidate):
    """Use the same dedicated source conversation and a second, isolated agent
    home as the destination computer. Neither endpoint is a production session.
    """
    transfer_home = home / ("transfer-test-" + uuid.uuid4().hex[:8])
    transfer_home.mkdir()
    bundle = transfer_home / "conversation"
    target_agent, clone, package = [transfer_home / name for name in ["agent", "clone", "package"]]
    for directory in [target_agent, clone, package]:
        directory.mkdir()
    copy_package(candidate, package)
    fixture = package / "tests/v2/offline-provider.ts"
    (target_agent / "settings.json").write_text(json.dumps({"packages": [str(package)], "retry": {"enabled": False}, "cacheWarming": "off", "quietStartup": True}))
    (clone / "cloned-source.txt").write_text("CLONED_SOURCE_173")
    source_agent = home / "agent"
    source_config = json.loads((home / "test-session.json").read_text())
    source_file = Path(source_config["sessionFile"])
    source_state = source_agent / "mission-control/v2" / source_config["id"] / "state.sqlite"
    with sqlite3.connect(f"file:{source_state}?mode=ro", uri=True) as db:
        expected_acceptance = db.execute("SELECT id,data FROM goal_acceptances ORDER BY id").fetchall()
    with sqlite3.connect(f"file:{source_agent / 'context-memory' / source_config['id'] / 'memory.sqlite'}?mode=ro", uri=True) as db:
        expected_mode = db.execute("SELECT value FROM settings WHERE key='mode'").fetchone()
        expected_notes = db.execute("SELECT name,revision,text FROM notes ORDER BY name").fetchall()

    for importing in [False, True]:
        trace = transfer_home / ("import-lifecycle.jsonl" if importing else "export-lifecycle.jsonl")
        requests = transfer_home / ("import-requests.jsonl" if importing else "export-requests.jsonl")
        env = dict(environment, PI_CODING_AGENT_DIR=str(target_agent if importing else source_agent), MC_FIXTURE_LIFECYCLE_TRACE=str(trace), MC_FIXTURE_CACHE_TRACE=str(requests))
        args = ["--import-session", str(bundle)] if importing else ["--session", str(source_file)]
        active_fixture = fixture if importing else home / "package/tests/v2/offline-provider.ts"
        master, slave = pty.openpty()
        fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 42, 140, 0, 0))
        process = subprocess.Popen([shutil.which("pi"), "--offline", "--no-mcp", "--no-skills", "--no-context-files", "--no-prompt-templates", "--tools", "*", "-e", str(active_fixture), "--provider", "mission-fixture", "--model", "model", "--thinking", "off", *args], cwd=clone if importing else Path(source_config["workspace"]), env=env, stdin=slave, stdout=slave, stderr=slave, start_new_session=True)
        os.close(slave)
        data = bytearray()
        def drain():
            if select.select([master], [], [], .1)[0]:
                try: chunk = os.read(master, 65536)
                except OSError: return
                data.extend(chunk)
                if b"\x1b[c" in chunk: os.write(master, b"\x1b[?1;2c")
        def line(text):
            drain(); os.write(master, text.encode()); drain(); os.write(master, b"\r")
        def wait(predicate, label, timeout=45):
            end = time.monotonic() + timeout
            while time.monotonic() < end:
                drain()
                if predicate(): checks.append(label); return
                if process.poll() is not None: raise AssertionError("Transfer test Pi exited: " + label)
            raise AssertionError("Timed out: " + label + "\n" + data[-2000:].decode(errors="replace"))
        def events():
            result = []
            if trace.exists():
                for text in trace.read_text().splitlines():
                    try: result.append(json.loads(text))
                    except ValueError: pass
            return result
        def ready():
            nonce = uuid.uuid4().hex
            end = time.monotonic() + 20
            while time.monotonic() < end:
                line("/fixture-ready " + nonce)
                for _ in range(4): drain()
                if any(e.get("nonce") == nonce for e in events()): return
            raise AssertionError("Transfer editor was not ready")
        try:
            if not importing:
                wait(lambda: any(e.get("event") == "session_start" for e in events()), "the original dedicated conversation reopened for a portable export")
                ready()
                line("/mission pause")
                for _ in range(6): drain()
                line("/project export " + json.dumps(str(bundle)))
                wait(lambda: (bundle / "transfer.json").exists(), "the real TUI exported a portable conversation without a model request", timeout=90)
                assert not requests.exists() or not requests.read_text().strip()
                assert not (bundle / "workspace").exists() and not (bundle / "plugin").exists()
            else:
                wait(lambda: any(e.get("reason") == "resume" and e.get("cwd") == str(clone) for e in events()), "--import-session restored the exported conversation into a separate agent home", timeout=90)
                ready()
                current = [e for e in events() if e.get("event") == "session_start" and e.get("reason") == "resume"][-1]
                imported_file, imported_id = Path(current["sessionFile"]), current["sessionId"]
                assert imported_id != source_config["id"]
                state = target_agent / "mission-control/v2" / imported_id / "state.sqlite"
                with sqlite3.connect(f"file:{state}?mode=ro", uri=True) as db:
                    assert db.execute("SELECT id,data FROM goal_acceptances ORDER BY id").fetchall() == expected_acceptance
                    assert db.execute("SELECT data FROM meta WHERE key='relocationHold'").fetchone() == ("true",)
                with sqlite3.connect(f"file:{target_agent / 'context-memory' / imported_id / 'memory.sqlite'}?mode=ro", uri=True) as db:
                    assert db.execute("SELECT value FROM settings WHERE key='mode'").fetchone() == expected_mode
                    assert db.execute("SELECT name,revision,text FROM notes ORDER BY name").fetchall() == expected_notes
                assert not requests.exists() or not requests.read_text().strip()
                checks.append("portable import retained context mode, note revisions and acceptance evidence with zero model requests")
                previous = len(events())
                line("/reload")
                wait(lambda: len(events()) > previous and any(e.get("reason") == "reload" and e.get("sessionId") == imported_id and e.get("pid") == process.pid for e in events()[previous:]), "portable import survived literal /reload in the same destination Pi process")
                ready()
                line('V2_TEST:{"op":"tool","name":"read","args":{"path":"cloned-source.txt"},"noRepeatWake":true}')
                def read_finished():
                    for row in imported_file.read_text().splitlines()[-15:]:
                        m = json.loads(row).get("message", {})
                        if m.get("role") == "toolResult" and m.get("toolName") == "read" and "CLONED_SOURCE_173" in json.dumps(m): return True
                    return False
                wait(read_finished, "the imported model resumed with the cloned workspace and preserved history")
                assert (clone / "cloned-source.txt").read_text() == "CLONED_SOURCE_173"
        finally:
            if process.poll() is None:
                line("/quit")
                end = time.monotonic() + 8
                while process.poll() is None and time.monotonic() < end: drain()
                if process.poll() is None: os.killpg(process.pid, signal.SIGKILL); process.wait(timeout=5)
            (transfer_home / ("import.ansi" if importing else "export.ansi")).write_bytes(data)
            os.close(master)
    report_file = reports / "task-policies-tui.json"
    report = json.loads(report_file.read_text())
    report.update(checks=checks, portableTransfer=True, portableTransferModelRequests=0)
    report_file.write_text(json.dumps(report, ensure_ascii=False, indent=2))
    print("PORTABLE_TRANSFER_RESULT " + json.dumps({"passed": True, "checks": len(checks), "sourceConversationPreserved": True, "separateAgentHome": True}))


if __name__ == "__main__":
    main()
