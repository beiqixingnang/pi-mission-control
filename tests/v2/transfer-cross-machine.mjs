// Manual two-host regression. Export on Windows, then import that exact bundle
// in WSL. All paths, settings and records belong to this isolated fixture.
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { hostDir } from "../../scripts/host.mjs";
import { MissionKernel } from "../../runtime/kernel.ts";
import { ContextMemory } from "../../runtime/context-memory.ts";
import { mappedPath } from "../../runtime/path-mapping.ts";
import assert from "node:assert/strict";
const [operation, requested] = process.argv.slice(2),
  root = fs.realpathSync.native(requested);
const agent = path.join(
  root,
  operation === "export" ? "windows-agent" : "wsl-agent",
);
fs.mkdirSync(agent, { recursive: true });
process.env.PI_CODING_AGENT_DIR = agent;
const { createJiti } = await import(
  pathToFileURL(path.join(hostDir, "node_modules/jiti/lib/jiti.mjs"))
);
const jiti = createJiti(import.meta.url, {
  alias: {
    "@earendil-works/pi-coding-agent": path.join(hostDir, "dist/index.js"),
  },
});
const { exportTransfer, prepareTransferImport } = await jiti.import(
  path.resolve("runtime/transfer/session.ts"),
);
const { SessionManager } = await import(
  pathToFileURL(path.join(hostDir, "dist/index.js"))
);
const bundle = path.join(root, "cross-bundle");
if (operation === "export") {
  const workspace = path.join(root, "windows-source");
  fs.mkdirSync(workspace);
  const manager = SessionManager.create(
    workspace,
    path.join(root, "windows-history"),
  );
  const id = manager.getSessionId();
  manager.appendMessage({
    role: "user",
    content: "Continue CROSS_CONTEXT_173 after the preserved checkpoint",
    timestamp: Date.now(),
  });
  const boundary = manager.getLeafId();
  manager.appendCompaction(
    "CROSS_NATIVE_CHECKPOINT_173",
    boundary,
    80000,
    { contextMode: "notes" },
    true,
  );
  const kernel = new MissionKernel({
    directory: path.join(agent, "mission-control/v2", id),
    sessionId: id,
    cwd: workspace,
    isLeadIdle: () => true,
    wake() {},
    workerFactory: async () => {
      throw Error("Offline");
    },
  });
  kernel.start(false);
  try {
    const goal = kernel.setGoal("Cross platform migration", [
      "Keep acceptance and evidence",
    ]);
    const proof = path.join(workspace, "proof.txt");
    fs.writeFileSync(proof, "CROSS_EVIDENCE_173");
    const acceptance = kernel.goals.accept(
      goal.id,
      [
        {
          criterion: 1,
          source: "artifact",
          path: proof,
          summary: "Known cross-platform evidence",
        },
      ],
      0,
    );
    const memory = new ContextMemory(
      path.join(agent, "context-memory", id),
      id,
    );
    memory.setMode("notes");
    memory.write("handoff", "Continue CROSS_CONTEXT_173", "cross-source");
    memory.close();
    await exportTransfer({
      destination: bundle,
      sessionFile: manager.getSessionFile(),
      sessionId: id,
      cwd: workspace,
      stateDirectory: kernel.store.directory,
      settings: kernel.settings,
    });
    fs.writeFileSync(
      path.join(root, "cross-expected.json"),
      JSON.stringify({
        sessionId: id,
        goalId: goal.id,
        acceptance,
        boundary,
        proof,
      }),
    );
    console.log(
      JSON.stringify({
        operation,
        passed: true,
        sourcePlatform: process.platform,
      }),
    );
  } finally {
    await kernel.close();
  }
} else if (operation === "import") {
  const target = path.join(root, "wsl-clone");
  fs.mkdirSync(target, { recursive: true });
  fs.writeFileSync(path.join(target, "clone.txt"), "DO_NOT_OVERWRITE");
  const expected = JSON.parse(
    fs.readFileSync(path.join(root, "cross-expected.json"), "utf8"),
  );
  const result = await prepareTransferImport(bundle, {
    cwd: target,
    sessionManager: { getSessionDir: () => path.join(agent, "sessions") },
  });
  const r = result.relocation,
    kernel = new MissionKernel({
      directory: r.stateDirectory,
      sessionId: r.sessionId,
      cwd: target,
      isLeadIdle: () => true,
      wake() {},
      workerFactory: async () => {
        throw Error("No replay");
      },
    });
  kernel.start(false);
  try {
    assert.equal(kernel.store.mission().id, expected.goalId);
    assert.deepEqual(
      kernel.store.acceptance(expected.acceptance.id),
      expected.acceptance,
    );
    assert.equal(kernel.store.get("relocationHold"), true);
    assert.equal(
      fs.readFileSync(
        mappedPath(expected.proof, kernel.store.get("pathMappings"), target),
        "utf8",
      ),
      "CROSS_EVIDENCE_173",
    );
    const checkpoint = SessionManager.open(r.sessionFile)
      .getBranch()
      .find((e) => e.type === "compaction");
    assert.equal(checkpoint.summary, "CROSS_NATIVE_CHECKPOINT_173");
    assert.equal(checkpoint.firstKeptEntryId, expected.boundary);
    const memory = new ContextMemory(
      path.join(agent, "context-memory", r.sessionId),
      r.sessionId,
    );
    assert.equal(memory.mode, "notes");
    assert.equal(memory.note("handoff").text, "Continue CROSS_CONTEXT_173");
    memory.close();
    assert.equal(
      fs.readFileSync(path.join(target, "clone.txt"), "utf8"),
      "DO_NOT_OVERWRITE",
    );
    const report = {
      passed: true,
      sourcePlatform: "win32",
      destinationPlatform: process.platform,
      separateAgentHomes: true,
      contextAndAcceptanceRetained: true,
      repositoryUnchanged: true,
      modelRequests: 0,
    };
    fs.writeFileSync(
      path.join(root, "cross-platform-report.json"),
      JSON.stringify(report, null, 2),
    );
    console.log(JSON.stringify(report));
  } finally {
    await kernel.close();
  }
} else throw Error("Use export|import FIXTURE_ROOT");
