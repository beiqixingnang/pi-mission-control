import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { pathToFileURL } from "node:url";
import { hostDir } from "../../scripts/host.mjs";
const { createJiti } = await import(
  pathToFileURL(path.join(hostDir, "node_modules/jiti/lib/jiti.mjs"))
);
const jiti = createJiti(import.meta.url, {
  alias: {
    "@earendil-works/pi-coding-agent": path.join(hostDir, "dist/index.js"),
    "@earendil-works/pi-tui": path.join(
      hostDir,
      "node_modules/@earendil-works/pi-tui/dist/index.js",
    ),
  },
});
const { RecoveryPicker } = await jiti.import(
  path.resolve("extensions/mission-control/recovery-ui.ts"),
);
const identity = await jiti.import(
  path.resolve("extensions/project/identity.ts"),
);
const { mappedPath } = await jiti.import(
  path.resolve("runtime/path-mapping.ts"),
);
const { SessionCatalog } = await jiti.import(
  path.resolve("runtime/session-catalog.ts"),
);
const { copySession } = await jiti.import(
  path.resolve("runtime/relocation.ts"),
);

test("catalog scans oversized records with bounded metadata, updates appended names and hides restored sources", async () => {
  const base = fs.realpathSync.native(
    fs.mkdtempSync(path.join(os.tmpdir(), "mc-recovery-catalog-")),
  );
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = base;
  let catalog;
  try {
    const logs = path.join(base, "sessions", "old-workspace");
    fs.mkdirSync(logs, { recursive: true });
    const file = path.join(logs, "original.jsonl"),
      destination = path.join(logs, "restored.jsonl");
    const header =
      JSON.stringify({
        type: "session",
        id: "original-id",
        cwd: path.join(base, "missing"),
        timestamp: new Date().toISOString(),
        version: 3,
      }) + "\n";
    const fd = fs.openSync(file, "wx");
    fs.writeSync(fd, header);
    fs.writeSync(
      fd,
      '{"type":"message","id":"huge","message":{"role":"toolResult","content":"',
    );
    const chunk = Buffer.alloc(1024 * 1024, 120);
    for (let i = 0; i < 68; i++) fs.writeSync(fd, chunk);
    fs.writeSync(
      fd,
      '"}}\n' +
        JSON.stringify({
          type: "session_info",
          id: "title",
          parentId: "huge",
          name: "超长对话\u2028标题",
        }) +
        "\n",
    );
    fs.closeSync(fd);
    catalog = new SessionCatalog();
    const info = await catalog.inspect(file);
    assert.equal(info.name, "超长对话\u2028标题");
    assert.equal(info.missing, true);
    const partial = JSON.stringify({
      type: "session_info",
      id: "next",
      name: "新标题",
    });
    fs.appendFileSync(file, partial.slice(0, 25));
    assert.equal((await catalog.inspect(file)).name, info.name);
    fs.appendFileSync(file, partial.slice(25) + "\n");
    assert.equal((await catalog.inspect(file)).name, "新标题");
    await copySession(file, destination, { id: "restored-id", cwd: base });
    assert.equal((await catalog.inspect(destination)).name, "新标题");
    const aliasDirectory = path.join(base, "configured-log-alias");
    fs.symlinkSync(
      logs,
      aliasDirectory,
      process.platform === "win32" ? "junction" : "dir",
    );
    catalog.bind(
      path.join(aliasDirectory, path.basename(file)),
      path.join(aliasDirectory, path.basename(destination)),
    );
    assert.equal(catalog.latest(file), destination);
    const list = await catalog.list(logs);
    assert.deepEqual(
      list.map((item) => item.id),
      ["restored-id"],
    );
    catalog.close();
    catalog = undefined;
    assert.ok(
      fs.statSync(path.join(base, "workspace-recovery/catalog.sqlite")).size <
        256000,
    );
  } finally {
    catalog?.close();
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test("recovery picker searches names and old paths, clips multiline metadata and permits cancellation", () => {
  const choices = [
    {
      id: "one",
      name: "旧对话\n标题\u2028尾部",
      cwd: "/gone/one",
      modified: 1,
      missing: true,
    },
    {
      id: "two",
      name: "另一个对话",
      cwd: "/project/two",
      modified: 2,
      missing: false,
    },
  ];
  let selected,
    redraws = 0;
  const picker = new RecoveryPicker(
    choices,
    "/new/workspace",
    () => redraws++,
    (value) => (selected = value),
    () => 20,
  );
  assert.ok(picker.render(60).every((line) => !/[\r\n\u2028]/.test(line)));
  picker.handleInput("/project/two");
  picker.handleInput("\r");
  assert.equal(selected.id, "two");
  assert.ok(redraws > 0);
  selected = "pending";
  const cancelled = new RecoveryPicker(
    choices,
    "/new/workspace",
    () => {},
    (value) => (selected = value),
    () => 20,
  );
  cancelled.handleInput("\x1b");
  assert.equal(selected, undefined);
});

test("explicit recovery can reuse a historical directory without rebinding another project's current root", () => {
  const base = fs.realpathSync.native(
      fs.mkdtempSync(path.join(os.tmpdir(), "mc-recovery-alias-")),
    ),
    previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = path.join(base, "agent");
  try {
    const a = path.join(base, "a"),
      b = path.join(base, "b");
    fs.mkdirSync(a);
    const old = identity.getProjectIdentity(a);
    fs.renameSync(a, b);
    identity.relocateProject(
      old.id,
      a,
      b,
      path.join(base, "agent/session.jsonl"),
    );
    fs.mkdirSync(a);
    assert.throws(() => identity.getProjectIdentity(a), /historical alias/);
    const target = identity.getRecoveryProjectIdentity(a);
    assert.notEqual(target.id, old.id);
    assert.equal(target.currentPath, a);
    assert.equal(identity.lookupProject(old.id).currentPath, b);
    assert.equal(identity.getProjectIdentity(b).id, old.id);
    assert.equal(identity.getProjectIdentity(a).id, target.id);
  } finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test("evidence mapping follows repeated moves and a return to the original folder", () => {
  const base = path.resolve(os.tmpdir(), "mc-mapping"),
    a = path.join(base, "a"),
    b = path.join(base, "b"),
    c = path.join(base, "c");
  const changes = [
    { source: a, target: b },
    { source: b, target: a },
    { source: a, target: c },
    { source: c, target: a },
  ];
  assert.equal(
    mappedPath(path.join(a, "proof.txt"), changes, a),
    path.join(a, "proof.txt"),
  );
  assert.equal(
    mappedPath(path.join(c, "proof.txt"), changes, a),
    path.join(a, "proof.txt"),
  );
  assert.equal(
    mappedPath(path.join(a, "proof.txt"), changes.slice(0, 3), c),
    path.join(c, "proof.txt"),
  );
  assert.equal(
    mappedPath(path.join(base, "external", "proof.txt"), changes, a),
    path.join(base, "external", "proof.txt"),
  );
});
