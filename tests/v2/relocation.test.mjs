import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import { hostDir } from "../../scripts/host.mjs";
import { MissionKernel } from "../../runtime/kernel.ts";
const { createJiti } = await import(
  pathToFileURL(path.join(hostDir, "node_modules/jiti/lib/jiti.mjs"))
);
const jiti = createJiti(import.meta.url, {
  alias: {
    "@earendil-works/pi-coding-agent": path.join(hostDir, "dist/index.js"),
  },
});
const { copySession } = await jiti.import(
  path.resolve("runtime/relocation.ts"),
);
const hash = async (file, start) => {
  const h = createHash("sha256");
  for await (const chunk of fs.createReadStream(file, { start }))
    h.update(chunk);
  return h.digest("hex");
};
test("workspace continuation copies LF bodies unchanged and rewrites only its new header", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mc-v2-lf-copy-"));
  try {
    const source = path.join(dir, "source.jsonl"),
      target = path.join(dir, "target.jsonl");
    const original =
      JSON.stringify({ type: "session", id: "old", cwd: "/old" }) + "\n";
    const fd = fs.openSync(source, "wx");
    fs.writeSync(fd, original);
    for (let i = 0; i < 12; i++)
      fs.writeSync(
        fd,
        JSON.stringify({
          type: "custom",
          id: "record-" + i,
          data: { text: "中文\u2028不分行", payload: "x".repeat(256000) },
        }) + "\n",
      );
    fs.closeSync(fd);
    await copySession(source, target, { id: "new", cwd: "/new" });
    const expected =
      JSON.stringify({ type: "session", id: "new", cwd: "/new" }) + "\n";
    assert.equal(
      await hash(source, Buffer.byteLength(original)),
      await hash(target, Buffer.byteLength(expected)),
    );
    const prefix = Buffer.alloc(Buffer.byteLength(expected)),
      file = fs.openSync(target, "r");
    fs.readSync(file, prefix);
    fs.closeSync(file);
    assert.equal(prefix.toString(), expected);
    const broken = path.join(dir, "broken.jsonl");
    fs.writeFileSync(broken, original + '{"partial":');
    await assert.rejects(
      copySession(broken, path.join(dir, "not-created.jsonl"), {}),
      /incomplete LF/,
    );
    assert.equal(fs.existsSync(path.join(dir, "not-created.jsonl")), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
test("relocation hold survives restart and ordinary input; overdue reminders resume once without backlog", async () => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "mc-v2-relocation-hold-"),
  );
  let now = 100000;
  const wakes = [];
  const make = () =>
    new MissionKernel({
      directory,
      cwd: directory,
      sessionId: "hold",
      now: () => now,
      workerFactory: async () => {
        throw new Error("unused");
      },
      isLeadIdle: () => true,
      wake: (w) => wakes.push(w),
    });
  let kernel = make();
  try {
    kernel.start(false);
    kernel.addSchedule("review", "check", now + 1000, 1000);
    await kernel.pauseForRelocation();
    now += 100000;
    await kernel.tick();
    assert.equal(wakes.length, 0);
    assert.equal(kernel.store.deliveries().length, 0);
    await kernel.close();
    kernel = make();
    kernel.start(false);
    kernel.onHumanInput("Only asking for status");
    await kernel.tick();
    assert.equal(wakes.length, 0);
    await kernel.userControl("resume");
    assert.equal(wakes.length, 1);
    assert.equal(kernel.store.deliveries().length, 1);
    assert.ok(kernel.store.schedules()[0].nextAt > now);
  } finally {
    await kernel.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
