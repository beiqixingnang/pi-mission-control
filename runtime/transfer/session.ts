import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import {
  getAgentDir,
  getPackageDir,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Store } from "../store.ts";
import { mappedPath, type PathMapping } from "../path-mapping.ts";
import {
  copySession,
  writeRelocationJournal,
  rollbackRelocation,
  type Relocation,
} from "../relocation.ts";
import { getRecoveryProjectIdentity } from "../../extensions/project/identity.ts";
import { rebindWorkspaceGoalBlocks } from "../workspace-control.ts";
import {
  digest,
  safeName,
  regularFile,
  snapshotDatabase,
  copyBounded,
  completeLogBytes,
  logHeader,
  walk,
  type TransferFile,
} from "./files.ts";
import type { Settings, Member, Task, Delivery } from "../types.ts";

const packageRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const uuid = /^[a-zA-Z0-9_-]{1,120}$/;
interface Manifest {
  format: "pi-mission-transfer";
  version: 1;
  id: string;
  createdAt: string;
  pluginVersion: string;
  piVersion: string;
  source: {
    sessionId: string;
    workspace: string;
    stateDirectory: string;
    agentDirectory: string;
    pluginDirectory: string;
    sessionFile: string;
    platform: string;
  };
  workspaceIncluded: boolean;
  model?: { provider: string; id: string };
  files: TransferFile[];
  evidence?: Array<{ source: string; entry: string }>;
}
interface ExportOptions {
  destination: string;
  sessionFile: string;
  sessionId: string;
  cwd: string;
  stateDirectory: string;
  settings: Settings;
  model?: { provider: string; id: string };
  signal?: AbortSignal;
  onProgress?: (text: string) => void;
}
const exists = async (file: string) =>
  fsp.lstat(file).then(
    () => true,
    (error) => {
      if (error.code === "ENOENT") return false;
      throw error;
    },
  );
async function copyStable(source: string, target: string, log = false) {
  const before = await fsp.stat(source);
  await copyBounded(
    source,
    target,
    log ? await completeLogBytes(source, before.size) : before.size,
  );
  const after = await fsp.stat(source);
  await fsp.utimes(target, before.atimeMs / 1000, before.mtimeMs / 1000);
  if (!log && (before.size !== after.size || before.mtimeMs !== after.mtimeMs))
    throw Error(
      "File changed during export; retry after it is saved: " + source,
    );
}

/** A self-contained directory snapshot: never serialize whole JSONL histories. */
export async function exportTransfer(options: ExportOptions) {
  const destination = path.resolve(options.destination);
  if (await exists(destination))
    throw Error("Export destination already exists; choose a new directory");
  if (!uuid.test(options.sessionId)) throw Error("Invalid session identity");
  const partial = destination + ".partial-" + randomUUID();
  await fsp.mkdir(partial, { mode: 0o700, recursive: false });
  try {
    options.signal?.throwIfAborted();
    options.onProgress?.("正在快照对话与目标账本…");
    await snapshotDatabase(
      path.join(options.stateDirectory, "state.sqlite"),
      path.join(partial, "state/state.sqlite"),
    );
    await copyStable(
      options.sessionFile,
      path.join(partial, "main.jsonl"),
      true,
    );
    const header = await logHeader(path.join(partial, "main.jsonl"));
    if (header.id !== options.sessionId)
      throw Error("Source session changed during export");
    const memories = new Set<string>([options.sessionId]);
    const evidence: Array<{ source: string; entry: string }> = [];
    const snapshot = new DatabaseSync(
      path.join(partial, "state/state.sqlite"),
      { readOnly: true },
    );
    try {
      for (const query of [
        "SELECT data FROM members",
        "SELECT data FROM lifecycle_archive WHERE kind='member'",
      ]) {
        for (const row of snapshot.prepare(query).iterate()) {
          const member = JSON.parse(String(row.data));
          if (uuid.test(member.sessionId ?? "")) memories.add(member.sessionId);
        }
      }
      const storedMappingsRow = snapshot
        .prepare("SELECT data FROM meta WHERE key='pathMappings'")
        .get();
      const storedMappings = storedMappingsRow
        ? JSON.parse(String(storedMappingsRow.data))
        : [];
      for (const row of snapshot
        .prepare("SELECT data FROM goal_acceptances")
        .iterate()) {
        const acceptance = JSON.parse(String(row.data));
        for (const item of acceptance.evidence ?? []) {
          if (
            typeof item.path !== "string" ||
            evidence.some((e) => e.source === item.path)
          )
            continue;
          const from = mappedPath(item.path, storedMappings, options.cwd),
            relative = path.relative(options.stateDirectory, from);
          if (
            relative !== ".." &&
            !relative.startsWith(".." + path.sep) &&
            !path.isAbsolute(relative)
          )
            continue;
          if (!(await exists(from))) continue;
          const stat = await fsp.lstat(from);
          if (!stat.isFile() || stat.isSymbolicLink())
            throw Error("Evidence must be a regular file: " + from);
          const entry = `evidence/${evidence.length}-${path.basename(from)}`;
          safeName(entry);
          await copyStable(from, path.join(partial, ...entry.split("/")));
          evidence.push({ source: item.path, entry });
        }
      }
    } finally {
      snapshot.close();
    }
    const runtimeFiles = (await walk(options.stateDirectory)).filter(
      (name) =>
        /^(artifacts\/|sessions\/|summary-cache\/)/.test(name) ||
        [
          "compaction-summary.json",
          "member-compaction-summary.json",
          "import-settings.json",
        ].includes(name),
    );
    for (const name of runtimeFiles) {
      options.signal?.throwIfAborted();
      const from = path.join(options.stateDirectory, ...name.split("/")),
        to = path.join(partial, "state", ...name.split("/"));
      if (name.endsWith(".jsonl")) {
        await copyStable(from, to, true);
        const h = await logHeader(to);
        if (uuid.test(h.id)) memories.add(h.id);
      } else await copyStable(from, to);
    }
    // Resolve inherited summary routes into the portable snapshot; no API keys
    // or model/auth configuration from the Pi agent directory are copied.
    const legacy = path.join(getAgentDir(), "compaction-summary.json");
    let inherited: any = {};
    if (await exists(legacy))
      inherited = JSON.parse(await fsp.readFile(legacy, "utf8"));
    if (process.env.PI_COMPACTION_SUMMARY_MODEL?.trim())
      inherited = {
        ...inherited,
        model: process.env.PI_COMPACTION_SUMMARY_MODEL.trim(),
        disabled: false,
      };
    for (const name of [
      "compaction-summary.json",
      "member-compaction-summary.json",
    ]) {
      const file = path.join(partial, "state", name);
      if (await exists(file)) {
        const own = JSON.parse(await fsp.readFile(file, "utf8"));
        await fsp.writeFile(
          file,
          JSON.stringify({ ...inherited, ...own }, null, 2) + "\n",
        );
      } else if (Object.keys(inherited).length)
        await fsp.writeFile(file, JSON.stringify(inherited, null, 2) + "\n");
    }
    for (const id of memories) {
      const from = path.join(
        getAgentDir(),
        "context-memory",
        id,
        "memory.sqlite",
      );
      if (await exists(from))
        await snapshotDatabase(
          from,
          path.join(partial, "memory", id, "memory.sqlite"),
        );
    }
    await fsp.mkdir(path.join(partial, "config"));
    await fsp.writeFile(
      path.join(partial, "config/mission-control.json"),
      JSON.stringify(options.settings, null, 2) + "\n",
      { mode: 0o600 },
    );
    const pkg = JSON.parse(
      await fsp.readFile(path.join(packageRoot, "package.json"), "utf8"),
    );
    await fsp.writeFile(
      path.join(partial, "README.txt"),
      'Pi Mission Control 对话迁移包\n\n在新电脑安装相同版本 Pi、克隆并安装插件、克隆工作区后，在工作区终端运行：\npi --import-session "本迁移包目录"\n\n已有 Pi 可 /reload 后执行 /project import "本迁移包目录"。\n核对源码、模型配置和旧电脑已停止工作后手动 /mission resume。\n\n本包仅含对话、目标与验收、成员记录、工作笔记和本会话运行配置；不含插件源码、工作区仓库或 API 密钥配置。未提交的工作区修改请自行复制。导入不重放旧命令。\n',
    );
    const files: TransferFile[] = [];
    for (const name of await walk(partial)) {
      options.signal?.throwIfAborted();
      const full = path.join(partial, ...name.split("/")),
        stat = await fsp.stat(full);
      files.push({
        path: name,
        size: stat.size,
        sha256: await digest(full),
        mode: stat.mode & 0o777,
        mtimeMs: stat.mtimeMs,
      });
    }
    const manifest: Manifest = {
      format: "pi-mission-transfer",
      version: 1,
      id: randomUUID(),
      createdAt: new Date().toISOString(),
      pluginVersion: pkg.version,
      piVersion: JSON.parse(
        await fsp.readFile(path.join(getPackageDir(), "package.json"), "utf8"),
      ).version,
      source: {
        sessionId: options.sessionId,
        workspace: options.cwd,
        stateDirectory: options.stateDirectory,
        agentDirectory: getAgentDir(),
        pluginDirectory: packageRoot,
        sessionFile: options.sessionFile,
        platform: process.platform,
      },
      workspaceIncluded: false,
      model: options.model,
      files,
      evidence,
    };
    await fsp.writeFile(
      path.join(partial, "transfer.json"),
      JSON.stringify(manifest, null, 2) + "\n",
      { flag: "wx", mode: 0o600 },
    );
    options.signal?.throwIfAborted();
    if (await exists(destination))
      throw Error("Export destination appeared; nothing was overwritten");
    await fsp.rename(partial, destination);
    return {
      destination,
      id: manifest.id,
      files: files.length,
      bytes: files.reduce((n, f) => n + f.size, 0),
      workspaceIncluded: manifest.workspaceIncluded,
      pluginVersion: pkg.version,
    };
  } catch (error) {
    await fsp.rm(partial, { recursive: true, force: true });
    throw error;
  }
}

export async function inspectTransfer(
  input: string,
  signal?: AbortSignal,
): Promise<{ root: string; manifest: Manifest }> {
  const root = await fsp.realpath(input),
    file = path.join(root, "transfer.json");
  if ((await fsp.stat(file)).size > 32 * 1024 * 1024)
    throw Error("Transfer manifest exceeds 32 MiB");
  const manifest = JSON.parse(
    await fsp.readFile(await regularFile(root, "transfer.json"), "utf8"),
  ) as Manifest;
  if (
    manifest.format !== "pi-mission-transfer" ||
    manifest.version !== 1 ||
    !uuid.test(manifest.source?.sessionId ?? "") ||
    !Array.isArray(manifest.files) ||
    manifest.files.length > 500000 ||
    !manifest.id
  )
    throw Error("Unsupported transfer manifest");
  const installedVersion = JSON.parse(
    await fsp.readFile(path.join(packageRoot, "package.json"), "utf8"),
  ).version;
  const hostVersion = JSON.parse(
    await fsp.readFile(path.join(getPackageDir(), "package.json"), "utf8"),
  ).version;
  if (
    manifest.pluginVersion !== installedVersion ||
    manifest.piVersion !== hostVersion
  )
    throw Error(
      `Migration requires matching versions: bundle Pi ${manifest.piVersion}, plugin ${manifest.pluginVersion}; installed Pi ${hostVersion}, plugin ${installedVersion}. Install the same versions before importing.`,
    );
  for (const key of [
    "workspace",
    "stateDirectory",
    "agentDirectory",
    "pluginDirectory",
  ] as const)
    if (
      typeof manifest.source[key] !== "string" ||
      !(
        path.posix.isAbsolute(manifest.source[key]) ||
        path.win32.isAbsolute(manifest.source[key])
      )
    )
      throw Error("Invalid transfer source path");
  const names = new Set<string>();
  for (const record of manifest.files) {
    signal?.throwIfAborted();
    safeName(record.path);
    const key =
      process.platform === "win32" ? record.path.toLowerCase() : record.path;
    if (
      names.has(key) ||
      !Number.isSafeInteger(record.size) ||
      record.size < 0 ||
      !Number.isSafeInteger(record.mode) ||
      !Number.isFinite(record.mtimeMs) ||
      record.mode < 0 ||
      record.mode > 0o777 ||
      !/^[\da-f]{64}$/.test(record.sha256) ||
      !(
        /^(state|memory|config|evidence)\//.test(record.path) ||
        ["main.jsonl", "README.txt"].includes(record.path)
      )
    )
      throw Error("Invalid/duplicate transfer entry");
    names.add(key);
    const source = await regularFile(root, record.path),
      stat = await fsp.stat(source);
    if (stat.size !== record.size || (await digest(source)) !== record.sha256)
      throw Error("Transfer checksum mismatch: " + record.path);
  }
  if (!names.has("main.jsonl") || !names.has("state/state.sqlite"))
    throw Error("Required transfer data missing");
  for (const item of manifest.evidence ?? [])
    if (
      typeof item.source !== "string" ||
      !item.entry?.startsWith("evidence/") ||
      !names.has(item.entry)
    )
      throw Error("Invalid evidence mapping");
  if (
    (await logHeader(path.join(root, "main.jsonl"))).id !==
    manifest.source.sessionId
  )
    throw Error("Transfer session identity mismatch");
  return { root, manifest };
}

/** Imported copies get new Pi identities. Goal/acceptance IDs and opaque history
 * bodies remain unchanged; only runtime locations and process state change. */
export async function prepareTransferImport(
  input: string,
  ctx: ExtensionContext,
  options: { signal?: AbortSignal } = {},
) {
  const { root, manifest } = await inspectTransfer(input, options.signal),
    target = fs.realpathSync.native(ctx.cwd);
  const id = randomUUID(),
    sessionId = randomUUID(),
    storage = path.join(getAgentDir(), "project-migrations", id);
  const r: Relocation = {
    id,
    plan: { action: "restore", source: manifest.source.workspace, target },
    projectId: getRecoveryProjectIdentity(target).id,
    previousSessionId: manifest.source.sessionId,
    sessionId,
    sessionFile: path.join(
      ctx.sessionManager.getSessionDir(),
      `${new Date().toISOString().replace(/:/g, "-")}_${sessionId}.jsonl`,
    ),
    stateDirectory: path.join(getAgentDir(), "mission-control/v2", sessionId),
    backup: path.join(storage, "original.jsonl"),
    journal: path.join(storage, "migration.json"),
    processCwd: process.cwd(),
    renamed: false,
  };
  const memoryIds = new Map<string, string>([
    [manifest.source.sessionId, sessionId],
  ]);
  for (const record of manifest.files) {
    const id = /^memory\/([\w-]+)\/memory\.sqlite$/.exec(record.path)?.[1];
    if (id && !memoryIds.has(id)) memoryIds.set(id, randomUUID());
  }
  const mappings: PathMapping[] = [
    { source: manifest.source.workspace, target },
    { source: manifest.source.stateDirectory, target: r.stateDirectory },
    { source: manifest.source.pluginDirectory, target: packageRoot },
  ];
  const mapped = (value: string) => mappedPath(value, mappings, target);
  for (const item of manifest.evidence ?? [])
    mappings.push({
      source: item.source,
      file: true,
      target: path.join(
        r.stateDirectory,
        "artifacts/transfer-evidence",
        path.basename(item.entry),
      ),
    });
  const newMemories: string[] = [];
  try {
    await fsp.mkdir(storage, { recursive: true });
    await fsp.mkdir(r.stateDirectory, { recursive: true });
    await copyBounded(path.join(root, "main.jsonl"), r.backup);
    await writeRelocationJournal(r, "import-preparing");
    for (const record of manifest.files) {
      options.signal?.throwIfAborted();
      if (record.path.startsWith("state/")) {
        const dest = path.join(
            r.stateDirectory,
            ...record.path.slice(6).split("/"),
          ),
          from = await regularFile(root, record.path);
        if (
          record.path.startsWith("state/sessions/") &&
          record.path.endsWith(".jsonl")
        ) {
          const header = await logHeader(from);
          if (!memoryIds.has(header.id)) memoryIds.set(header.id, randomUUID());
          await copySession(from, dest, {
            id: memoryIds.get(header.id),
            cwd: mapped(header.cwd),
          });
        } else await copyBounded(from, dest);
        await fsp.chmod(dest, record.mode & 0o777);
        await fsp.utimes(dest, record.mtimeMs / 1000, record.mtimeMs / 1000);
      }
      if (record.path.startsWith("evidence/")) {
        const dest = path.join(
          r.stateDirectory,
          "artifacts/transfer-evidence",
          path.basename(record.path),
        );
        await copyBounded(await regularFile(root, record.path), dest);
        await fsp.utimes(dest, record.mtimeMs / 1000, record.mtimeMs / 1000);
      }
    }
    for (const [oldId, newId] of memoryIds) {
      if (!uuid.test(oldId)) throw Error("Invalid member memory identity");
      const name = `memory/${oldId}/memory.sqlite`;
      if (!manifest.files.some((f) => f.path === name)) continue;
      const directory = path.join(getAgentDir(), "context-memory", newId);
      newMemories.push(directory);
      await copyBounded(
        await regularFile(root, name),
        path.join(directory, "memory.sqlite"),
      );
      if (oldId === manifest.source.sessionId) r.memoryDirectory = directory;
    }
    const configEntry = manifest.files.find(
      (f) => f.path === "config/mission-control.json",
    );
    if (configEntry) {
      const config = JSON.parse(
        await fsp.readFile(await regularFile(root, configEntry.path), "utf8"),
      );
      if (Array.isArray(config.workerExtensions))
        config.workerExtensions = config.workerExtensions.map(mapped);
      await fsp.writeFile(
        path.join(r.stateDirectory, "import-settings.json"),
        JSON.stringify(config, null, 2) + "\n",
      );
    }
    const store = new Store(r.stateDirectory);
    try {
      const oldRelocation = store.get<Relocation>("relocation");
      const rewriteMember = (member: Member) => {
        member.workspace.root = mapped(member.workspace.root);
        member.workspace.extraReadRoots =
          member.workspace.extraReadRoots.map(mapped);
        member.sessionId = memoryIds.get(member.sessionId) ?? member.sessionId;
        if (member.sessionFile) member.sessionFile = mapped(member.sessionFile);
        return member;
      };
      const rewriteTask = (task: Task) => {
        task.inputPath = mapped(task.inputPath);
        if (task.resultPath) task.resultPath = mapped(task.resultPath);
        if (task.sessionFile) task.sessionFile = mapped(task.sessionFile);
        if (
          ["running", "waiting", "queued"].includes(task.state) ||
          task.processState === "running" ||
          task.processState === "unknown"
        ) {
          const unknown =
            task.processState === "running" || task.processState === "unknown";
          task.state = "interrupted";
          task.processState = unknown ? "unknown" : "not-started";
          task.epoch++;
          task.error =
            "Imported snapshot from another computer. Old commands were not replayed; confirm the original machine has stopped before explicit recovery.";
          task.updatedAt = Date.now();
        }
        return task;
      };
      store.transaction(() => {
        for (const member of store.members())
          store.putMember(rewriteMember(member));
        for (const task of store.tasks()) store.putTask(rewriteTask(task));
        for (const row of store.db
          .prepare(
            "SELECT kind,id,data FROM lifecycle_archive WHERE kind IN ('member','task')",
          )
          .all()) {
          const value = JSON.parse(String(row.data));
          store.db
            .prepare(
              "UPDATE lifecycle_archive SET data=? WHERE kind=? AND id=?",
            )
            .run(
              JSON.stringify(
                row.kind === "member"
                  ? rewriteMember(value)
                  : rewriteTask(value),
              ),
              row.kind,
              row.id,
            );
        }
        for (const row of store.db
          .prepare("SELECT data FROM deliveries")
          .all()) {
          const d = JSON.parse(String(row.data)) as Delivery;
          if (d.artifact) d.artifact = mapped(d.artifact);
          if (["leased", "admitted"].includes(d.state)) {
            d.state = "pending";
            d.batchId = undefined;
          }
          store.putDelivery(d);
        }
        const mission = store.mission();
        if (mission && !["complete", "stopped"].includes(mission.status)) {
          mission.status = "paused";
          mission.humanPaused = true;
          mission.reason =
            "Workspace restored; review retained work before resuming";
          store.set("mission", mission);
        }
        if (oldRelocation && store.get("relocationHold"))
          rebindWorkspaceGoalBlocks(store, oldRelocation.id, id);
        store.set("relocationHold", true);
        store.set("relocation", r);
        store.set("projectId", r.projectId);
        store.set("pathMappings", [
          ...(store.get<PathMapping[]>("pathMappings") ?? []),
          ...mappings,
        ]);
        store.set("transferImport", {
          bundleId: manifest.id,
          createdAt: manifest.createdAt,
          source: manifest.source,
          importedAt: new Date().toISOString(),
        });
        store.unset("projectRelocationFailure");
        store.event("project.relocated", id, r.plan);
      });
    } finally {
      store.close();
    }
    await copySession(path.join(root, "main.jsonl"), r.sessionFile, {
      id: sessionId,
      cwd: target,
      parentSession: r.backup,
    });
    await writeRelocationJournal(r, "ready");
    return {
      relocation: r,
      manifest,
      workspaceIncluded: false,
      rollback: async () => {
        await rollbackRelocation(r);
        for (const directory of newMemories)
          if (directory !== r.memoryDirectory)
            await fsp.rm(directory, { recursive: true, force: true });
      },
    };
  } catch (error) {
    await rollbackRelocation(r);
    for (const directory of newMemories)
      if (directory !== r.memoryDirectory)
        await fsp.rm(directory, { recursive: true, force: true });
    throw error;
  }
}
