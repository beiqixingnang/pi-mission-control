import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { openMissionWeb } from "../runtime/web-ui.ts";

test("Mission Web is loopback-authenticated and shares read/write callbacks", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mc-web-ui-"));
  const html = path.join(dir, "index.html");
  await fs.writeFile(html, "<!doctype html><head></head><body>Mission</body>");
  const messages = [];
  const actions = [];
  const web = await openMissionWeb({
    cwd: dir,
    htmlFile: html,
    sessionId: "session-test",
    getSnapshot: () => ({ status: "active", decisionPolicy: "business-only" }),
    onMessage: async (text, options) => {
      messages.push({ text, options });
      return { accepted: true };
    },
    onAction: async (action, args, requestId) => {
      actions.push({ action, args, requestId });
      return { action };
    },
  });
  try {
    const denied = await fetch(new URL("api/health", web.url));
    assert.equal(denied.status, 401);
    const root = await fetch(web.url, { redirect: "manual" });
    assert.equal(root.status, 302);
    assert.equal(root.headers.get("location"), "/");
    const ok = await fetch(new URL("api/health", web.url), {
      headers: { authorization: `Bearer ${web.token}` },
    });
    assert.equal(ok.status, 200);
    const session = await fetch(new URL("api/session", web.url), {
      headers: { authorization: `Bearer ${web.token}` },
    });
    assert.deepEqual((await session.json()).snapshot, {
      status: "active",
      decisionPolicy: "business-only",
    });
    const message = await fetch(new URL("api/message", web.url), {
      method: "POST",
      headers: {
        authorization: `Bearer ${web.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        text: "Continue approved work",
        deliverAs: "followUp",
        requestId: "m1",
      }),
    });
    assert.equal(message.status, 200);
    assert.deepEqual(messages[0], {
      text: "Continue approved work",
      options: { deliverAs: "followUp", requestId: "m1" },
    });
    const action = await fetch(new URL("api/action", web.url), {
      method: "POST",
      headers: {
        authorization: `Bearer ${web.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        action: "pause",
        args: { reason: "User requested" },
        requestId: "a1",
      }),
    });
    assert.equal(action.status, 200);
    assert.deepEqual(actions[0], {
      action: "pause",
      args: { reason: "User requested" },
      requestId: "a1",
    });
  } finally {
    await web.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});
