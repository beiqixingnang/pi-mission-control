import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { MissionKernel } from "../../runtime/kernel.ts";
import { rebaseReviewHolds } from "../../runtime/team-policy.ts";

const flush = async () => {
  await new Promise(setImmediate);
  await new Promise(setImmediate);
};
async function harness(run) {
  const directory = fs.realpathSync.native(
    fs.mkdtempSync(path.join(os.tmpdir(), "mc-team-policy-")),
  );
  const workers = [];
  const kernel = new MissionKernel({
    directory,
    cwd: directory,
    sessionId: "team-policy",
    settings: { maxParallel: 2 },
    isLeadIdle: () => false,
    wake() {},
    workerFactory: async (assignment, signal) => {
      let resolve;
      const result = new Promise((r) => (resolve = r));
      const worker = {
        assignment,
        result,
        resolve,
        stop: async () =>
          resolve({ ok: false, text: "", processState: "stopped" }),
      };
      signal.addEventListener("abort", worker.stop, { once: true });
      workers.push(worker);
      return worker;
    },
  });
  kernel.start(false);
  const add = (name, allow = []) =>
    kernel.addMember({
      name,
      role: name,
      thinkingLevel: "off",
      temporary: false,
      workspace: {
        root: directory,
        access: "read-only",
        execution: "files",
        extraReadRoots: [],
      },
      allow,
    });
  try {
    await run({ directory, kernel, workers, add });
  } finally {
    await kernel.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

test("running capability revisions drain active operations then resume the same task with the desired revision", () =>
  harness(async (h) => {
    h.add("executor", ["peer"]);
    h.add("peer");
    const task = h.kernel.dispatch("executor", "Complete registered batch");
    await flush();
    const first = h.workers[0].assignment;
    const request = (id, op, data = {}) =>
      h.kernel.memberRequest(first.token, { id, op, ...data });
    request("ready", "ready", { tools: ["read"] });
    request("begin", "tool-begin", { callId: "command" });
    const desired = h.kernel.configureMember("executor", {
      tools: ["read", "find"],
      model: "fixture/new-model",
    });
    const view = h.kernel.memberCapabilities("executor")[0];
    assert.equal(view.desired.revision, 2);
    assert.equal(view.executions[0].active.revision, 1);
    assert.deepEqual(view.executions[0].active.actualTools, ["read"]);
    assert.equal(view.executions[0].pending, true);
    assert.equal(
      request("checkpoint", "checkpoint").action,
      "run",
      "current command drains",
    );
    assert.equal(
      request("blocked", "tool-begin", { callId: "new-write" }).denied,
      true,
    );
    assert.equal(
      request("end", "tool-end", { callId: "command" }).action,
      "settle",
    );
    h.workers[0].resolve({
      ok: false,
      text: "command receipt retained",
      cleanSettlement: true,
      processState: "stopped",
    });
    await flush();
    assert.equal(h.workers.length, 2);
    assert.equal(h.workers[1].assignment.task.id, task.id);
    assert.equal(h.workers[1].assignment.member.revision, desired.revision);
    assert.equal(
      h.workers[1].assignment.member.sessionId,
      first.member.sessionId,
    );
    assert.match(
      h.workers[1].assignment.prompt,
      /checkpoint receipt|Checkpoint receipt/,
    );
    assert.equal(
      h.kernel.store.deliveries("lead").length,
      0,
      "internal handoff is not batch completion",
    );
  }));

test("review snapshots wait for executor commands; reviewer failure stays held and explicit release resumes with findings", () =>
  harness(async (h) => {
    h.add("executor");
    h.add("reviewer");
    const file = path.join(h.directory, "source.ts");
    fs.writeFileSync(file, "before");
    const task = h.kernel.dispatch("executor", "Finish this source batch");
    await flush();
    const token = h.workers[0].assignment.token;
    h.kernel.memberRequest(token, {
      id: "begin",
      op: "tool-begin",
      callId: "long-command",
    });
    const hold = h.kernel.requestReview(
      "executor",
      "reviewer",
      "Inspect this batch",
      [file],
    );
    await h.kernel.tick();
    assert.equal(
      h.workers.length,
      1,
      "review must not overlap active executor",
    );
    fs.writeFileSync(file, "command finished");
    h.kernel.memberRequest(token, {
      id: "end",
      op: "tool-end",
      callId: "long-command",
    });
    h.workers[0].resolve({
      ok: false,
      text: "safe checkpoint",
      cleanSettlement: true,
      processState: "stopped",
    });
    await flush();
    assert.equal(h.workers.length, 2);
    assert.equal(h.workers[1].assignment.member.name, "reviewer");
    assert.equal(h.kernel.store.task(task.id).state, "queued");
    const context = h.kernel.reviewContext("executor");
    assert.equal(context.hold.state, "held");
    assert.match(fs.readFileSync(context.hold.snapshotPath, "utf8"), /sha256/);
    assert.throws(
      () => h.kernel.releaseReview("executor", "early"),
      /Finish or cancel/,
    );
    h.workers[1].resolve({
      ok: false,
      text: "counterexample",
      processState: "stopped",
    });
    await flush();
    assert.equal(
      h.workers.length,
      2,
      "failed review does not release execution",
    );
    assert.equal(h.kernel.reviewContext("executor").hold.id, hold.id);
    h.kernel.releaseReview(
      "executor",
      "Reviewed counterexample; executor will implement correction",
    );
    await h.kernel.tick();
    await flush();
    assert.equal(h.workers[2].assignment.task.id, task.id);
    assert.match(h.workers[2].assignment.prompt, /reread|Reread/);
  }));

test("a member requests paired review within communication authority and returns to its original task after success", () =>
  harness(async (h) => {
    h.add("executor", ["reviewer"]);
    h.add("reviewer", ["executor"]);
    const file = path.join(h.directory, "source.ts");
    fs.writeFileSync(file, "stable");
    const task = h.kernel.dispatch("executor", "Implement and review");
    await flush();
    const token = h.workers[0].assignment.token;
    const request = {
      id: "review",
      op: "review",
      reviewer: "reviewer",
      message: "Inspect stable file",
      files: [file],
    };
    const hold = h.kernel.memberRequest(token, request);
    assert.equal(h.kernel.memberRequest(token, request).id, hold.id);
    assert.equal(h.kernel.store.children(task.id).length, 1);
    h.kernel.memberRequest(token, { id: "checkpoint", op: "checkpoint" });
    h.workers[0].resolve({
      ok: false,
      text: "held",
      cleanSettlement: true,
      processState: "stopped",
    });
    await flush();
    h.workers[1].resolve({
      ok: true,
      text: "Reviewed stable batch",
      processState: "stopped",
    });
    await flush();
    assert.equal(h.kernel.reviewContext("executor").hold.state, "released");
    assert.equal(h.workers[2].assignment.task.id, task.id);
    assert.equal(h.kernel.store.mission().status, "active");
  }));

test("lead notes never create idle work; explicit assignments do", () =>
  harness(async (h) => {
    h.add("executor");
    const note = await h.kernel.messageMember(
      "executor",
      "Specification clarification",
      "note",
    );
    assert.equal(note.mode, "note");
    assert.equal(h.kernel.store.tasks().length, 0);
    const assigned = await h.kernel.messageMember(
      "executor",
      "Implement approved batch",
      "assign",
    );
    assert.equal(assigned.mode, "new-turn");
    await flush();
    assert.equal(h.kernel.store.tasks().length, 1);
    assert.match(h.workers[0].assignment.prompt, /Specification clarification/);
  }));

test("omitted member operation is a peer note; review pointers rebase without changing their state", () =>
  harness(async (h) => {
    h.add("executor", ["reviewer"]);
    const reviewer = h.add("reviewer");
    h.kernel.dispatch("executor", "Continue approved batch");
    await flush();
    h.kernel.memberRequest(h.workers[0].assignment.token, {
      id: "discussion",
      op: "message",
      to: "reviewer",
      message: "Targeted interpretation",
    });
    assert.equal(h.kernel.store.tasks().length, 1);
    assert.equal(
      h.kernel.store.deliveries("reviewer")[0].summary,
      "Targeted interpretation",
    );
    const key = "reviewHold:" + reviewer.id;
    h.kernel.store.set(key, {
      id: "retained",
      state: "held",
      files: [path.join(h.directory, "source.ts")],
      snapshotPath: path.join(h.directory, "snapshot.txt"),
    });
    const relocated = path.join(h.directory, "relocated");
    rebaseReviewHolds(h.kernel.store, (value) =>
      path.join(relocated, path.basename(value)),
    );
    assert.equal(h.kernel.store.get(key).state, "held");
    assert.equal(
      h.kernel.store.get(key).files[0],
      path.join(relocated, "source.ts"),
    );
    assert.equal(
      h.kernel.store.get(key).snapshotPath,
      path.join(relocated, "snapshot.txt"),
    );
  }));
