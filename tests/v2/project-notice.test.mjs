import test from "node:test";
import assert from "node:assert/strict";
import { projectNotice } from "../../runtime/project-notice.ts";

test("reload between a committed import's message and UI notice does not fail session replacement", async () => {
  const sent = [];
  const next = {
    async sendMessage(message) {
      sent.push(message);
    },
    ui: {
      notify() {
        throw new Error(
          "This extension ctx is stale after session replacement or reload. Do not use a captured pi or command ctx",
        );
      },
    },
  };
  assert.equal(
    await projectNotice(next, "Import completed", "Retained imported history"),
    false,
  );
  assert.equal(sent.length, 1);
  assert.equal(sent[0].content, "Retained imported history");
});

test("replacement notices still surface real errors and retain the normal notification", async () => {
  const notices = [];
  const next = {
    async sendMessage() {},
    ui: {
      notify(message) {
        notices.push(message);
      },
    },
  };
  assert.equal(await projectNotice(next, "Committed migration"), true);
  assert.deepEqual(notices, ["Committed migration"]);
  await assert.rejects(
    projectNotice(
      {
        ...next,
        async sendMessage() {
          throw new Error("Disk failure");
        },
      },
      "Uncommitted",
      "Body",
    ),
    /Disk failure/,
  );
});
