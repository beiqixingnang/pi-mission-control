import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { MissionKernel } from "../../runtime/kernel.ts";

const flush = async () => {
  await new Promise(setImmediate);
  await new Promise(setImmediate);
};

async function using(run) {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "mc-goal-submissions-"),
  );
  let now = 100000;
  let kernel;
  const workers = [];
  const make = () => {
    const value = new MissionKernel({
      directory,
      cwd: directory,
      sessionId: "goal-submissions",
      now: () => now,
      isLeadIdle: () => true,
      wake: () => {
        throw new Error("A member submission must not wake the lead");
      },
      workerFactory: async (assignment, signal) => {
        let resolve;
        const result = new Promise((done) => (resolve = done));
        const worker = {
          assignment,
          signal,
          resolve,
          result,
          async stop() {
            resolve({ ok: false, text: "", processState: "stopped" });
          },
        };
        workers.push(worker);
        return worker;
      },
    });
    value.start(false);
    return value;
  };
  kernel = make();
  const add = (name = "builder") =>
    kernel.addMember({
      name,
      role: "Build the assigned goal",
      thinkingLevel: "off",
      temporary: false,
      allow: [],
      workspace: {
        root: directory,
        access: "read-write",
        execution: "files",
        extraReadRoots: [],
        extraWriteRoots: [],
      },
    });
  try {
    await run({
      get kernel() {
        return kernel;
      },
      workers,
      add,
      advance(ms) {
        now += ms;
      },
      async start(name, goalId) {
        kernel.dispatch(name, `Implement ${goalId}`, { goalId });
        await flush();
        return workers.at(-1);
      },
      request(worker, args) {
        return kernel.memberRequest(worker.assignment.token, {
          id: crypto.randomUUID(),
          ...args,
        });
      },
      async reload() {
        await kernel.close();
        kernel = make();
      },
    });
  } finally {
    await kernel.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

test("a member submits assigned completion evidence without accepting, waking or ending its task", () =>
  using(async (h) => {
    const root = h.kernel.setGoal("Long implementation", ["Verified output"]);
    const member = h.add();
    const artifact = path.join(h.kernel.options.cwd, "receipt.txt");
    fs.writeFileSync(artifact, "SUBMISSION_ARTIFACT");
    const worker = await h.start(member.name, root.id);
    const result = h.request(worker, {
      op: "goal-submit",
      submissions: [
        {
          goalId: root.id,
          revision: 0,
          summary:
            "Implemented the approved batch and saved its verification receipt.",
          evidence: [
            {
              criterion: 1,
              summary: "The saved receipt records the verified output.",
              path: artifact,
            },
          ],
        },
      ],
    });
    assert.equal(result.submitted.length, 1);
    assert.equal(result.continued, true);
    assert.equal(
      h.kernel.store.task(worker.assignment.task.id).state,
      "running",
    );
    assert.equal(h.kernel.goals.node(root.id).state, "review");
    assert.equal(h.kernel.goals.node(root.id).acceptanceId, undefined);
    assert.equal(h.kernel.store.deliveries("lead").length, 1);
    assert.equal(h.kernel.store.deliveries("lead")[0].goalEvent, "submitted");
    assert.equal(h.kernel.store.deliveries("lead")[0].state, "pending");
    const submission = h.kernel.store.goalSubmission(result.submitted[0].id);
    assert.equal(submission.state, "current");
    assert.equal(submission.taskId, worker.assignment.task.id);
    assert.equal(h.kernel.goals.detail(root.id).submissions.length, 1);
    assert.equal(h.kernel.store.mission().status, "active");
  }));

test("a batch can submit several assigned goals, and one current submission can be updated without changing goal revision", () =>
  using(async (h) => {
    const [, first, second] = h.kernel.planGoals([
      {
        key: "root",
        objective: "Batch root",
        criteria: ["Both sections verified"],
      },
      {
        parentId: "root",
        objective: "First section",
        criteria: ["First output"],
      },
      {
        parentId: "root",
        objective: "Second section",
        criteria: ["Second output"],
      },
    ]);
    const member = h.add();
    const task = h.kernel.dispatch(
      member.name,
      "Implement both sections in one long task",
      {
        goalIds: [first.id, second.id],
      },
    );
    await flush();
    const firstWorker = h.workers.at(-1);
    assert.deepEqual(task.goalIds, [first.id, second.id]);
    const batch = h.request(firstWorker, {
      op: "goal-submit",
      submissions: [
        {
          goalId: first.id,
          revision: 0,
          summary: "First section is implemented and its checks are complete.",
          evidence: [
            { criterion: 1, summary: "First section verification passed." },
          ],
        },
        {
          goalId: second.id,
          revision: 0,
          summary: "Second section is implemented and its checks are complete.",
          evidence: [
            { criterion: 1, summary: "Second section verification passed." },
          ],
        },
      ],
    });
    assert.equal(batch.submitted.length, 2);
    assert.equal(h.kernel.goals.node(first.id).state, "review");
    assert.equal(h.kernel.goals.node(second.id).state, "review");
    assert.equal(h.kernel.goals.node(first.id).revision, 0);
    const updated = h.request(firstWorker, {
      op: "goal-submit",
      submissions: [
        {
          goalId: second.id,
          revision: 0,
          summary:
            "Second section was refreshed after the final integration check.",
          evidence: [
            {
              criterion: 1,
              summary: "The refreshed integration check passed.",
            },
          ],
        },
      ],
    });
    assert.equal(updated.submitted.length, 1);
    const history = h.kernel.store.goalSubmissions(second.id);
    assert.equal(history.length, 2);
    assert.equal(history[0].state, "current");
    assert.equal(history[1].state, "superseded");
    assert.equal(h.kernel.goals.node(second.id).submissionId, history[0].id);
  }));

test("one long task can be formally associated with many leaf goals and submit every section it covers", () =>
  using(async (h) => {
    const [, first, second, third, outside] = h.kernel.planGoals([
      {
        key: "root",
        objective: "Software governance file",
        criteria: ["All assigned sections are verified"],
      },
      {
        key: "first",
        parentId: "root",
        objective: "Section 1",
        criteria: ["Section 1 is verified"],
      },
      {
        key: "second",
        parentId: "root",
        objective: "Section 2",
        criteria: ["Section 2 is verified"],
      },
      {
        key: "third",
        parentId: "root",
        objective: "Section 3",
        criteria: ["Section 3 is verified"],
      },
      {
        key: "outside",
        parentId: "root",
        objective: "Section outside this task",
        criteria: ["Outside section is verified"],
      },
    ]);
    const member = h.add();
    const task = h.kernel.dispatch(
      member.name,
      "Implement the complete file across sections 1, 2 and 3",
      {
        goalIds: [first.id, second.id, third.id],
      },
    );
    await flush();
    const worker = h.workers.at(-1);
    assert.deepEqual(task.goalIds, [first.id, second.id, third.id]);
    assert.deepEqual(task.goalRevisions, {
      [first.id]: 0,
      [second.id]: 0,
      [third.id]: 0,
    });
    const context = h.request(worker, {
      op: "goal-context",
      goalId: second.id,
      section: "criteria",
    });
    assert.equal(context.goalId, second.id);
    const result = h.request(worker, {
      op: "goal-submit",
      submissions: [first, second, third].map((goal, index) => ({
        goalId: goal.id,
        revision: 0,
        summary: `Section ${index + 1} is complete in the same long task.`,
        evidence: [
          {
            criterion: 1,
            summary: `Section ${index + 1} verification evidence is saved.`,
          },
        ],
      })),
    });
    assert.equal(result.submitted.length, 3);
    assert.equal(h.kernel.goals.node(first.id).state, "review");
    assert.equal(h.kernel.goals.node(second.id).state, "review");
    assert.equal(h.kernel.goals.node(third.id).state, "review");
    assert.equal(h.kernel.store.task(task.id).state, "running");
    assert.throws(
      () =>
        h.request(worker, {
          op: "goal-submit",
          submissions: [
            {
              goalId: outside.id,
              revision: 0,
              summary: "An unassociated sibling must remain outside this task.",
            },
          ],
        }),
      /assigned to their current execution/,
    );
  }));

test("a member can withdraw its current submission, then resubmit; stale, duplicate and unauthorized submissions are rejected", () =>
  using(async (h) => {
    const [, root, otherRoot] = h.kernel.planGoals([
      {
        key: "root",
        objective: "Withdrawable goal",
        criteria: ["Keep working"],
      },
      {
        key: "first",
        parentId: "root",
        objective: "First work",
        criteria: ["Keep working"],
      },
      {
        key: "other",
        parentId: "root",
        objective: "Other work",
        criteria: ["Other work"],
      },
    ]);
    const member = h.add();
    const other = h.add("other");
    const worker = await h.start(member.name, root.id);
    const submit = () =>
      h.request(worker, {
        op: "goal-submit",
        submissions: [
          {
            goalId: root.id,
            revision: 0,
            summary: "The current implementation is ready for review.",
          },
        ],
      });
    const first = submit();
    assert.equal(first.submitted[0].state, "current");
    const withdrawn = h.request(worker, {
      op: "goal-submit",
      submissions: [],
      withdrawGoalIds: [{ goalId: root.id, revision: 0 }],
    });
    assert.equal(withdrawn.withdrawn[0].state, "withdrawn");
    assert.equal(h.kernel.goals.node(root.id).state, "active");
    assert.equal(h.kernel.goals.node(root.id).submissionId, undefined);
    const second = submit();
    assert.equal(second.submitted[0].state, "current");
    assert.throws(
      () =>
        h.request(worker, {
          op: "goal-submit",
          submissions: [
            {
              goalId: root.id,
              revision: 1,
              summary: "This is a stale revision submission.",
            },
          ],
        }),
      /revision/,
    );
    assert.throws(
      () =>
        h.request(worker, {
          op: "goal-submit",
          submissions: [
            {
              goalId: root.id,
              revision: 0,
              summary: "Duplicate entries should be rejected.",
            },
            {
              goalId: root.id,
              revision: 0,
              summary: "Duplicate entries should be rejected.",
            },
          ],
        }),
      /only once/,
    );
    assert.throws(
      () =>
        h.request(worker, {
          op: "goal-submit",
          submissions: [
            {
              goalId: otherRoot.id,
              revision: 0,
              summary: "A member cannot submit an unassigned sibling goal.",
            },
          ],
        }),
      /assigned|another main goal/,
    );
  }));

test("lead accepts current submission evidence only after the member task settles, and old submissions cannot satisfy a new revision", () =>
  using(async (h) => {
    const root = h.kernel.setGoal("Accept submitted evidence", [
      "Receipt exists",
    ]);
    const member = h.add();
    const artifact = path.join(h.kernel.options.cwd, "accepted.txt");
    fs.writeFileSync(artifact, "ACCEPTED_SUBMISSION");
    const worker = await h.start(member.name, root.id);
    const submitted = h.request(worker, {
      op: "goal-submit",
      submissions: [
        {
          goalId: root.id,
          revision: 0,
          summary: "The implementation produced the required saved receipt.",
          evidence: [
            {
              criterion: 1,
              summary: "Receipt contains the verified output.",
              path: artifact,
            },
          ],
        },
      ],
    });
    assert.throws(
      () =>
        h.kernel.acceptGoal(
          root.id,
          [
            {
              criterion: 1,
              source: "submission",
              summary: "Receipt contains the verified output.",
              submissionId: submitted.submitted[0].id,
            },
          ],
          0,
        ),
      /Work is still running/,
    );
    worker.resolve({
      ok: true,
      text: "Long task continued and settled",
      processState: "stopped",
    });
    await flush();
    h.kernel.leadStarted();
    h.kernel.includeCollected(
      h.kernel.store.deliveries("lead").map((delivery) => delivery.id),
    );
    h.kernel.leadMessage(false);
    h.kernel.leadSettled();
    const acceptance = h.kernel.acceptGoal(
      root.id,
      [
        {
          criterion: 1,
          source: "submission",
          summary: "Receipt contains the verified output.",
          submissionId: submitted.submitted[0].id,
        },
      ],
      0,
    );
    assert.equal(acceptance.goalId, root.id);
    assert.equal(h.kernel.goals.node(root.id).state, "accepted");
    assert.equal(
      h.kernel.store.acceptance(acceptance.id).evidence[0].submissionId,
      submitted.submitted[0].id,
    );
    assert.equal(
      h.kernel.store
        .deliveries("lead")
        .find((delivery) => delivery.goalEvent === "submitted").state,
      "observed",
    );
  }));

test("submissions survive reload and are visible as paginated goal details without turning into acceptance", () =>
  using(async (h) => {
    const root = h.kernel.setGoal("Reloadable submitted goal", [
      "Retain pending evidence",
    ]);
    const member = h.add();
    const worker = await h.start(member.name, root.id);
    const result = h.request(worker, {
      op: "goal-submit",
      submissions: [
        {
          goalId: root.id,
          revision: 0,
          summary: "Saved before reload for lead review.",
        },
      ],
    });
    await h.reload();
    const detail = h.kernel.goals.detail(root.id);
    assert.equal(detail.submissions[0].id, result.submitted[0].id);
    assert.equal(detail.submissions[0].state, "current");
    assert.equal(h.kernel.goals.node(root.id).state, "review");
    assert.equal(h.kernel.goals.node(root.id).acceptanceId, undefined);
  }));
