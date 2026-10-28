import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { pathToFileURL } from "node:url";
import { hostDir } from "../../scripts/host.mjs";
import { MissionKernel } from "../../runtime/kernel.ts";
import { ContextMemory } from "../../runtime/context-memory.ts";
import { mappedPath } from "../../runtime/path-mapping.ts";
const { createJiti } = await import(
  pathToFileURL(path.join(hostDir, "node_modules/jiti/lib/jiti.mjs"))
);
const jiti = createJiti(import.meta.url, {
  alias: {
    "@earendil-works/pi-coding-agent": path.join(hostDir, "dist/index.js"),
  },
});
const { exportTransfer, prepareTransferImport, inspectTransfer } =
  await jiti.import(path.resolve("runtime/transfer/session.ts"));
const { digest } = await jiti.import(path.resolve("runtime/transfer/files.ts"));

async function fixture(run) {
  const previous = process.env.PI_CODING_AGENT_DIR,
    base = fs.realpathSync.native(
      fs.mkdtempSync(path.join(os.tmpdir(), "pi-transfer-")),
    );
  const agentA = path.join(base, "agent-a"),
    agentB = path.join(base, "agent-b"),
    workspace = path.join(base, "source"),
    target = path.join(base, "clone"),
    bundle = path.join(base, "transfer"),
    id = crypto.randomUUID();
  for (const dir of [agentA, agentB, workspace, target]) fs.mkdirSync(dir);
  process.env.PI_CODING_AGENT_DIR = agentA;
  const kernel = new MissionKernel({
    directory: path.join(agentA, "mission-control/v2", id),
    cwd: workspace,
    sessionId: id,
    isLeadIdle: () => true,
    wake: () => {},
    workerFactory: async () => {
      throw Error("No live workers in offline migration test");
    },
  });
  kernel.start(false);
  kernel.setGoal("Continue the same source audit", [
    "Keep exact source evidence",
  ]);
  const session = path.join(base, "main.jsonl");
  fs.writeFileSync(
    session,
    JSON.stringify({ type: "session", version: 3, id, cwd: workspace }) +
      "\n" +
      JSON.stringify({
        type: "message",
        id: "public-message",
        message: {
          role: "user",
          content: "Continue decoder.ts at line 173; 中文\u2028记录",
        },
      }) +
      "\n",
  );
  fs.writeFileSync(
    path.join(workspace, "decoder.ts"),
    "export const value = 173;\n",
  );
  fs.writeFileSync(
    path.join(target, "decoder.ts"),
    "export const value = 173;\n",
  );
  const exportNow = () =>
    exportTransfer({
      destination: bundle,
      sessionFile: session,
      sessionId: id,
      cwd: workspace,
      stateDirectory: kernel.store.directory,
      settings: kernel.settings,
      model: { provider: "fixture", id: "model" },
    });
  const ctx = {
    cwd: target,
    sessionManager: { getSessionDir: () => path.join(agentB, "sessions") },
  };
  try {
    await run({
      base,
      agentA,
      agentB,
      workspace,
      target,
      bundle,
      id,
      kernel,
      session,
      exportNow,
      ctx,
    });
  } finally {
    await kernel.close();
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    fs.rmSync(base, { recursive: true, force: true });
  }
}

test("a different agent home imports goals, member history, notes and evidence without credentials or repository writes", () =>
  fixture(async (h) => {
    const artifact = path.join(h.workspace, "proof.txt");
    fs.writeFileSync(artifact, "EXACT_ACCEPTED_EVIDENCE");
    const receipt = h.kernel.goals.accept(
      h.kernel.store.mission().id,
      [
        {
          criterion: 1,
          source: "artifact",
          path: artifact,
          summary: "Exact artifact verified",
        },
      ],
      0,
    );
    const memory = new ContextMemory(
      path.join(h.agentA, "context-memory", h.id),
      h.id,
    );
    memory.setMode("summary");
    memory.write("handoff", "Continue decoder.ts line 173", "public-message");
    memory.close();
    const member = h.kernel.addMember({
      name: "reader",
      role: "Review source",
      model: "fixture/model",
      thinkingLevel: "high",
      temporary: false,
      allow: [],
      workspace: {
        root: h.workspace,
        access: "read-only",
        execution: "files",
        extraReadRoots: [],
      },
    });
    const memberLog = path.join(
      h.kernel.store.directory,
      "sessions",
      member.id,
      "reader.jsonl",
    );
    fs.mkdirSync(path.dirname(memberLog), { recursive: true });
    fs.writeFileSync(
      memberLog,
      JSON.stringify({
        type: "session",
        version: 3,
        id: member.sessionId,
        cwd: h.workspace,
      }) +
        "\n" +
        JSON.stringify({
          type: "message",
          id: "child-evidence",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "MEMBER_EVIDENCE_173" }],
          },
        }) +
        "\n",
    );
    member.sessionFile = memberLog;
    h.kernel.store.putMember(member);
    const memberMemory = new ContextMemory(
      path.join(h.agentA, "context-memory", member.sessionId),
      member.sessionId,
    );
    memberMemory.setMode("notes");
    memberMemory.write("index", "MEMBER_INDEX", "child-evidence");
    memberMemory.close();
    const busy = h.kernel.addMember({
      name: "busy",
      role: "Interrupted reader",
      thinkingLevel: "high",
      temporary: false,
      allow: [],
      workspace: {
        root: h.workspace,
        access: "read-only",
        execution: "files",
        extraReadRoots: [],
      },
    });
    h.kernel.store.putTask({
      id: "old-task",
      missionId: h.kernel.store.mission().id,
      memberId: busy.id,
      member: busy.name,
      rootId: "old-task",
      state: "running",
      epoch: 4,
      phase: "work",
      inputPath: h.kernel.store.artifact("old-task", "input", "task input"),
      createdAt: 1,
      updatedAt: 1,
      timeoutMs: 0,
      processState: "running",
      reviewDeliveryIds: [],
      sessionFile: memberLog,
    });
    fs.writeFileSync(path.join(h.agentA, "auth.json"), "DO_NOT_EXPORT_SECRET");
    fs.writeFileSync(
      path.join(h.agentA, "models.json"),
      "DO_NOT_EXPORT_MODEL_CONFIG",
    );
    fs.writeFileSync(
      path.join(h.kernel.store.directory, "compaction-summary.json"),
      JSON.stringify({ model: "fixture/summary", maxInputTokens: 64000 }),
    );
    const before = fs.readFileSync(h.session);
    const sourceDb = h.kernel.store.mission();
    await h.exportNow();
    assert.deepEqual(fs.readFileSync(h.session), before);
    assert.deepEqual(h.kernel.store.mission(), sourceDb);
    assert.ok(
      !fs.existsSync(path.join(h.bundle, "workspace")) &&
        !fs.existsSync(path.join(h.bundle, "plugin")) &&
        !fs.existsSync(path.join(h.bundle, "auth.json")),
    );
    process.env.PI_CODING_AGENT_DIR = h.agentB;
    const prepared = await prepareTransferImport(h.bundle, h.ctx);
    const r = prepared.relocation;
    const restored = new MissionKernel({
      directory: r.stateDirectory,
      cwd: h.target,
      sessionId: r.sessionId,
      isLeadIdle: () => true,
      wake: () => {},
      workerFactory: async () => {
        throw Error("Do not replay");
      },
    });
    restored.start(false);
    try {
      assert.notEqual(r.sessionId, h.id);
      assert.equal(restored.store.mission().id, sourceDb.id);
      assert.deepEqual(restored.store.acceptance(receipt.id), receipt);
      assert.equal(restored.store.get("relocationHold"), true);
      assert.equal(restored.store.task("old-task").state, "interrupted");
      assert.equal(restored.store.task("old-task").processState, "unknown");
      assert.equal(restored.store.task("old-task").epoch, 5);
      assert.equal(
        fs.readFileSync(path.join(h.target, "decoder.ts"), "utf8"),
        "export const value = 173;\n",
      );
      assert.equal(fs.existsSync(path.join(h.target, "proof.txt")), false);
      const retained = restored.store.member(member.id);
      assert.equal(retained.workspace.root, h.target);
      assert.equal(retained.workspace.access, "read-only");
      assert.notEqual(retained.sessionId, member.sessionId);
      assert.match(
        fs.readFileSync(retained.sessionFile, "utf8"),
        /MEMBER_EVIDENCE_173/,
      );
      const leadNotes = new ContextMemory(
        path.join(h.agentB, "context-memory", r.sessionId),
        r.sessionId,
      );
      assert.equal(leadNotes.mode, "summary");
      assert.equal(
        leadNotes.note("handoff").text,
        "Continue decoder.ts line 173",
      );
      leadNotes.close();
      const childNotes = new ContextMemory(
        path.join(h.agentB, "context-memory", retained.sessionId),
        retained.sessionId,
      );
      assert.equal(childNotes.mode, "notes");
      assert.equal(childNotes.note("index").text, "MEMBER_INDEX");
      childNotes.close();
      const evidence = mappedPath(
        artifact,
        restored.store.get("pathMappings"),
        h.target,
      );
      assert.equal(
        fs.readFileSync(evidence, "utf8"),
        "EXACT_ACCEPTED_EVIDENCE",
      );
      assert.equal(
        JSON.parse(
          fs.readFileSync(
            path.join(r.stateDirectory, "compaction-summary.json"),
            "utf8",
          ),
        ).model,
        "fixture/summary",
      );
      await restored.tick();
      assert.equal(restored.store.task("old-task").state, "interrupted");
    } finally {
      await restored.close();
    }
    await prepared.rollback();
    assert.equal(fs.existsSync(r.stateDirectory), false);
    assert.equal(
      fs.readFileSync(path.join(h.target, "decoder.ts"), "utf8"),
      "export const value = 173;\n",
    );
  }));

test("transfer rejects tampering, traversal and future formats before creating any new runtime", () =>
  fixture(async (h) => {
    await h.exportNow();
    process.env.PI_CODING_AGENT_DIR = h.agentB;
    const file = path.join(h.bundle, "main.jsonl"),
      original = fs.readFileSync(file);
    fs.appendFileSync(file, "tampered");
    await assert.rejects(
      prepareTransferImport(h.bundle, h.ctx),
      /checksum mismatch/,
    );
    fs.writeFileSync(file, original);
    const mf = path.join(h.bundle, "transfer.json"),
      originalManifest = fs.readFileSync(mf, "utf8"),
      manifest = JSON.parse(originalManifest);
    manifest.pluginVersion = "999.0.0";
    fs.writeFileSync(mf, JSON.stringify(manifest));
    await assert.rejects(
      prepareTransferImport(h.bundle, h.ctx),
      /matching versions/,
    );
    manifest.pluginVersion = JSON.parse(originalManifest).pluginVersion;
    manifest.files[0].path = "../escaped";
    fs.writeFileSync(mf, JSON.stringify(manifest));
    await assert.rejects(
      prepareTransferImport(h.bundle, h.ctx),
      /Invalid transfer entry/,
    );
    manifest.version = 999;
    fs.writeFileSync(mf, JSON.stringify(manifest));
    await assert.rejects(inspectTransfer(h.bundle), /Unsupported/);
    assert.equal(fs.existsSync(path.join(h.agentB, "mission-control")), false);
    assert.deepEqual(fs.readdirSync(h.target), ["decoder.ts"]);
  }));

test("very large LF records and an unfinished live tail export without truncating complete history", () =>
  fixture(async (h) => {
    const fd = fs.openSync(h.session, "a");
    fs.writeSync(fd, '{"type":"custom","id":"huge","data":"');
    for (let i = 0; i < 70; i++) fs.writeSync(fd, "x".repeat(1024 * 1024));
    fs.writeSync(fd, '"}\n');
    fs.closeSync(fd);
    const completeSize = fs.statSync(h.session).size;
    fs.appendFileSync(h.session, '{"partial":');
    await h.exportNow();
    assert.equal(
      fs.statSync(path.join(h.bundle, "main.jsonl")).size,
      completeSize,
    );
    assert.equal(fs.statSync(h.session).size, completeSize + 11);
    process.env.PI_CODING_AGENT_DIR = h.agentB;
    const restored = await prepareTransferImport(h.bundle, h.ctx);
    const bodyHash = async (f) => {
      const data = fs.createReadStream(f);
      let first = true;
      const { createHash } = await import("node:crypto");
      const hash = createHash("sha256");
      for await (let block of data) {
        if (first) {
          const end = block.indexOf(10);
          block = block.subarray(end + 1);
          first = false;
        }
        hash.update(block);
      }
      return hash.digest("hex");
    };
    assert.equal(
      await bodyHash(restored.relocation.sessionFile),
      await bodyHash(path.join(h.bundle, "main.jsonl")),
    );
    await restored.rollback();
  }));

test("foreign Windows and POSIX roots map only explicit prefixes into the cloned workspace", () => {
  const root = path.resolve("target");
  assert.equal(
    mappedPath(
      path.join(root, "proof.txt"),
      [
        {
          source: path.join(root, "proof.txt"),
          target: path.resolve("evidence/proof.txt"),
          file: true,
        },
      ],
      root,
    ),
    path.resolve("evidence/proof.txt"),
  );
  assert.equal(
    mappedPath(
      "D:\\Old Repo\\src\\decoder.ts",
      [{ source: "D:\\Old Repo", target: root }],
      root,
    ),
    path.join(root, "src/decoder.ts"),
  );
  assert.equal(
    mappedPath(
      "/home/other/repo/src/decoder.ts",
      [{ source: "/home/other/repo", target: root }],
      root,
    ),
    path.join(root, "src/decoder.ts"),
  );
  assert.equal(
    mappedPath(
      "D:\\Old Repo-other\\data",
      [{ source: "D:\\Old Repo", target: root }],
      root,
    ),
    "D:\\Old Repo-other\\data",
  );
});
