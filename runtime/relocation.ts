import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { finished } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import {
  SessionManager,
  getAgentDir,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { lfLines } from "./jsonl.ts";
import { Store } from "./store.ts";
import { snapshotContextMemory } from "./context-memory.ts";
import type { MissionKernel } from "./kernel.ts";
import type { Member, Task, Delivery } from "./types.ts";
import {
  getProjectIdentity,
  lookupProject,
  associateProjectSession,
  registerProject,
  relocateProject,
} from "../extensions/project/identity.ts";

export interface RelocationPlan {
  action: "rename" | "switch";
  source: string;
  target: string;
}
export interface Relocation {
  id: string;
  plan: RelocationPlan;
  projectId: string;
  previousSessionId: string;
  sessionId: string;
  sessionFile: string;
  stateDirectory: string;
  backup: string;
  journal: string;
  processCwd: string;
  renamed: boolean;
  memoryDirectory?: string;
}
export function inside(root: string, value: string) {
  const relative = path.relative(root, value);
  return (
    !path.isAbsolute(relative) &&
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`)
  );
}
export function rebase(value: string, source: string, target: string) {
  return inside(source, value)
    ? path.join(target, path.relative(source, value))
    : value;
}
export function planRelocation(
  action: "rename" | "switch",
  target: string,
  cwd: string,
): RelocationPlan {
  if (!target.trim() || /[\x00-\x1f]/.test(target))
    throw new Error("Provide a workspace name or path");
  let source: string;
  try {
    source = fs.realpathSync.native(cwd);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      throw new Error(
        "Current workspace path no longer exists. If it was renamed outside Pi, restore its previous name first, then use /project rename <new-name> while the source still exists. /project switch does not recover externally renamed workspaces.",
      );
    throw error;
  }
  if (source === path.parse(source).root)
    throw new Error("A filesystem root cannot be a relocation source");
  const requested = path.resolve(
    action === "rename" ? path.dirname(source) : source,
    target,
  );
  let destination: string;
  if (action === "switch") {
    destination = fs.realpathSync.native(requested);
    if (!fs.statSync(destination).isDirectory())
      throw new Error("The switch target must be an existing directory");
  } else {
    if (fs.existsSync(requested))
      throw new Error(
        "Rename target already exists; nothing will be overwritten",
      );
    const parent = fs.realpathSync.native(path.dirname(requested)),
      name = path.basename(requested);
    if (
      process.platform === "win32" &&
      (/[<>:"|?*]/.test(name) ||
        /[. ]$/.test(name) ||
        /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name))
    )
      throw new Error("Invalid Windows directory name");
    destination = path.join(parent, name);
    if (inside(source, destination) || inside(destination, source))
      throw new Error("Rename target cannot contain or be inside the source");
    if (inside(source, fileURLToPath(import.meta.url)))
      throw new Error(
        "Install this plugin outside the workspace before renaming it",
      );
  }
  if (path.relative(source, destination) === "")
    throw new Error("Target is already the current workspace");
  if (inside(source, path.resolve(getAgentDir())))
    throw new Error("Pi agent storage must be outside the workspace");
  return { action, source, target: destination };
}
export async function writeRelocationJournal(
  r: Relocation,
  state: string,
  error?: string,
) {
  const tmp = r.journal + ".tmp";
  await fsp.writeFile(
    tmp,
    JSON.stringify(
      { version: 2, ...r, state, error, updatedAt: new Date().toISOString() },
      null,
      2,
    ) + "\n",
    { mode: 0o600 },
  );
  await fsp.rename(tmp, r.journal);
}
/** Copy opaque LF records; only the header is decoded. Never join a complete log. */
export async function copySession(
  source: string,
  destination: string,
  headerPatch: Record<string, unknown>,
) {
  const check = await fsp.open(source, "r");
  try {
    const stat = await check.stat(),
      tail = Buffer.alloc(1);
    if (!stat.size) throw new Error("Session log is empty");
    await check.read(tail, 0, 1, stat.size - 1);
    if (tail[0] !== 10)
      throw new Error(
        "Session has an incomplete LF tail; wait for it to settle before relocating",
      );
  } finally {
    await check.close();
  }
  await fsp.mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
  const input = fs.createReadStream(source),
    output = fs.createWriteStream(destination, { flags: "wx", mode: 0o600 });
  const completed = finished(output);
  void completed.catch(() => {});
  let first = true;
  try {
    for await (const line of lfLines(input)) {
      let text = line;
      if (first) {
        const header = JSON.parse(line);
        if (header.type !== "session")
          throw new Error("Session header missing");
        text = JSON.stringify({ ...header, ...headerPatch });
        first = false;
      }
      if (!output.write(text + "\n")) await once(output, "drain");
    }
    if (first) throw new Error("Session log is empty");
    output.end();
    await completed;
  } catch (error) {
    input.destroy();
    output.destroy();
    await completed.catch(() => {});
    throw error;
  }
}
async function copyTree(
  source: string,
  destination: string,
  logCwd?: (cwd: string) => string,
) {
  await fsp.mkdir(destination, { recursive: true, mode: 0o700 });
  for (const entry of await fsp.readdir(source, { withFileTypes: true })) {
    const from = path.join(source, entry.name),
      to = path.join(destination, entry.name);
    if (entry.isSymbolicLink())
      throw new Error("Runtime symlink cannot be relocated: " + from);
    if (entry.isDirectory()) await copyTree(from, to, logCwd);
    else if (entry.isFile()) {
      if (logCwd && entry.name.endsWith(".jsonl")) {
        const input = fs.createReadStream(from);
        let cwd: string | undefined;
        try {
          for await (const line of lfLines(input)) {
            cwd = JSON.parse(line).cwd;
            break;
          }
        } finally {
          input.destroy();
        }
        if (typeof cwd !== "string")
          throw new Error("Member session header has no workspace");
        await copySession(from, to, { cwd: logCwd(cwd) });
      } else await fsp.copyFile(from, to, fs.constants.COPYFILE_EXCL);
    } else throw new Error("Runtime contains a non-regular file: " + from);
  }
}
function rewriteState(source: Store, target: Store, r: Relocation) {
  const statePath = (value: string) =>
    rebase(value, source.directory, target.directory);
  const workspacePath = (value: string) =>
    r.plan.action === "rename"
      ? rebase(value, r.plan.source, r.plan.target)
      : value;
  target.transaction(() => {
    for (const row of target.db.prepare("SELECT data FROM members").iterate()) {
      const m = JSON.parse(String(row.data)) as Member;
      m.workspace.root = workspacePath(m.workspace.root);
      m.workspace.extraReadRoots =
        m.workspace.extraReadRoots.map(workspacePath);
      if (m.sessionFile) m.sessionFile = statePath(m.sessionFile);
      target.putMember(m);
    }
    for (const row of target.db.prepare("SELECT data FROM tasks").iterate()) {
      const t = JSON.parse(String(row.data)) as Task;
      t.inputPath = statePath(t.inputPath);
      if (t.resultPath) t.resultPath = statePath(t.resultPath);
      if (t.sessionFile) t.sessionFile = statePath(t.sessionFile);
      target.putTask(t);
    }
    for (const row of target.db
      .prepare("SELECT data FROM deliveries")
      .iterate()) {
      const d = JSON.parse(String(row.data)) as Delivery;
      if (d.artifact) d.artifact = statePath(d.artifact);
      if (["leased", "admitted"].includes(d.state)) {
        d.state = "pending";
        d.batchId = undefined;
      }
      target.putDelivery(d);
    }
    target.set("relocationHold", true);
    target.set("relocation", r);
    target.set("projectId", r.projectId);
    const mappings =
      target.get<Array<{ source: string; target: string }>>("pathMappings") ??
      [];
    if (r.plan.action === "rename")
      mappings.push({ source: r.plan.source, target: r.plan.target });
    target.set("pathMappings", mappings);
    target.event("project.relocated", r.id, r.plan);
  });
}
export async function prepareRelocation(
  plan: RelocationPlan,
  ctx: ExtensionContext,
  kernel: MissionKernel,
): Promise<Relocation> {
  const manager = ctx.sessionManager,
    sourceFile = manager.getSessionFile();
  if (!sourceFile)
    throw new Error(
      "A persistent conversation is required; --no-session cannot be relocated",
    );
  const project = getProjectIdentity(plan.source);
  const targetProject =
    plan.action === "switch" ? getProjectIdentity(plan.target) : project;
  const owner = lookupProject(plan.target);
  if (plan.action === "rename" && owner && owner.id !== project.id)
    throw new Error("The rename target belongs to another recorded project");
  associateProjectSession(project.id, sourceFile);
  const id = randomUUID(),
    sessionId = randomUUID();
  const storage = path.join(getAgentDir(), "project-migrations", id);
  await fsp.mkdir(storage, { recursive: true, mode: 0o700 });
  const previousDir = manager.getSessionDir(),
    defaultDir = SessionManager.create(plan.source).getSessionDir();
  const sessionDir =
    path.relative(previousDir, defaultDir) === ""
      ? SessionManager.create(plan.target).getSessionDir()
      : plan.action === "rename"
        ? rebase(previousDir, plan.source, plan.target)
        : previousDir;
  const r: Relocation = {
    id,
    plan,
    projectId: targetProject.id,
    previousSessionId: manager.getSessionId(),
    sessionId,
    sessionFile: path.join(
      sessionDir,
      `${new Date().toISOString().replace(/:/g, "-")}_${sessionId}.jsonl`,
    ),
    stateDirectory: path.join(
      getAgentDir(),
      "mission-control",
      "v2",
      sessionId,
    ),
    backup: path.join(storage, "original.jsonl"),
    journal: path.join(storage, "migration.json"),
    processCwd: process.cwd(),
    renamed: false,
  };
  if (fs.existsSync(sourceFile))
    await fsp.copyFile(sourceFile, r.backup, fs.constants.COPYFILE_EXCL);
  else {
    // A new persistent session may not have flushed its first assistant reply yet.
    const header = manager.getHeader();
    if (!header) throw new Error("Session header is unavailable");
    const out = fs.createWriteStream(r.backup, { flags: "wx", mode: 0o600 });
    const completed = finished(out);
    void completed.catch(() => {});
    try {
      if (!out.write(JSON.stringify(header) + "\n")) await once(out, "drain");
      for (const entry of manager.getEntries())
        if (!out.write(JSON.stringify(entry) + "\n")) await once(out, "drain");
      out.end();
      await completed;
    } catch (error) {
      out.destroy();
      await completed.catch(() => {});
      throw error;
    }
  }
  await writeRelocationJournal(r, "prepared");
  try {
    await fsp.mkdir(r.stateDirectory, { mode: 0o700 });
    kernel.store.db
      .prepare("VACUUM INTO ?")
      .run(path.join(r.stateDirectory, "state.sqlite"));
    await copyTree(
      path.join(kernel.store.directory, "artifacts"),
      path.join(r.stateDirectory, "artifacts"),
    );
    await copyTree(
      path.join(kernel.store.directory, "sessions"),
      path.join(r.stateDirectory, "sessions"),
      plan.action === "rename"
        ? (cwd) => rebase(cwd, plan.source, plan.target)
        : undefined,
    );
    // Compaction routes/caches belong to this same plugin package. Preserve
    // explicit lead/member routing so a continuation cannot fall back to inference.
    for (const name of [
      "compaction-summary.json",
      "member-compaction-summary.json",
      "compaction-diagnostics.json",
      "summary-cache",
    ]) {
      const from = path.join(kernel.store.directory, name);
      if (!fs.existsSync(from)) continue;
      const stat = await fsp.lstat(from),
        to = path.join(r.stateDirectory, name);
      if (stat.isSymbolicLink())
        throw new Error("Compaction state symlink cannot be relocated");
      if (stat.isDirectory()) await copyTree(from, to);
      else if (stat.isFile())
        await fsp.copyFile(from, to, fs.constants.COPYFILE_EXCL);
      else
        throw new Error("Compaction state must be a regular file or directory");
    }
    const memorySource = path.join(
      getAgentDir(),
      "context-memory",
      r.previousSessionId,
      "memory.sqlite",
    );
    if (fs.existsSync(memorySource)) {
      const destination = path.join(
        getAgentDir(),
        "context-memory",
        r.sessionId,
      );
      await fsp.mkdir(destination, { mode: 0o700 });
      r.memoryDirectory = destination;
      await writeRelocationJournal(r, "memory-preparing");
      snapshotContextMemory(
        memorySource,
        path.join(destination, "memory.sqlite"),
      );
    }
    const target = new Store(r.stateDirectory);
    try {
      rewriteState(kernel.store, target, r);
    } finally {
      target.close();
    }
    if (plan.action === "rename") {
      if (inside(plan.source, process.cwd()))
        process.chdir(path.dirname(plan.source));
      if (fs.existsSync(plan.target))
        throw new Error("Rename destination appeared; nothing was overwritten");
      await fsp.rename(plan.source, plan.target);
      r.renamed = true;
      await writeRelocationJournal(r, "renamed");
    }
    await copySession(r.backup, r.sessionFile, {
      id: sessionId,
      cwd: plan.target,
      parentSession: sourceFile,
    });
    const continuation = SessionManager.open(r.sessionFile);
    const leaf = manager.getLeafId();
    if (leaf) continuation.branch(leaf);
    continuation.appendCustomEntry("project-migration-v2", {
      ...r.plan,
      projectId: r.projectId,
      previousSessionId: r.previousSessionId,
      sessionId,
      journal: r.journal,
    });
    continuation.appendCustomMessageEntry(
      "project-location",
      `Workspace ${plan.action}: ${plan.source} -> ${plan.target}. Historical text is unchanged. Mission and reminders are held; review absolute paths and /mission resume. Member workspaces ${plan.action === "rename" ? "inside the renamed root were rebased" : "retain their existing permissions"}.`,
      true,
    );
    await writeRelocationJournal(r, "ready");
    return r;
  } catch (error) {
    await rollbackRelocation(r);
    throw error;
  }
}
export async function commitRelocation(r: Relocation) {
  if (r.plan.action === "rename")
    relocateProject(r.projectId, r.plan.source, r.plan.target, r.sessionFile);
  else registerProject(r.projectId, r.plan.target, r.sessionFile);
  await writeRelocationJournal(r, "completed");
}
export async function rollbackRelocation(r: Relocation) {
  // Only delete the UUID-named checkout/state and exact continuation created by this operation.
  const expected = path.resolve(
    getAgentDir(),
    "mission-control",
    "v2",
    r.sessionId,
  );
  if (
    path.resolve(r.stateDirectory) !== expected ||
    !/^[\da-f-]{36}$/.test(r.sessionId)
  )
    throw new Error("Unsafe rollback state path");
  if (fs.existsSync(path.join(expected, "owner.lock")))
    throw new Error(
      "Replacement runtime is already owned; keep recovery files",
    );
  if (
    r.memoryDirectory &&
    path.resolve(r.memoryDirectory) !==
      path.resolve(getAgentDir(), "context-memory", r.sessionId)
  )
    throw new Error("Unsafe rollback memory path");
  if (path.basename(r.sessionFile).endsWith(`_${r.sessionId}.jsonl`))
    await fsp.rm(r.sessionFile, { force: true });
  await fsp.rm(expected, { recursive: true, force: true });
  if (r.memoryDirectory)
    await fsp.rm(r.memoryDirectory, { recursive: true, force: true });
  if (r.renamed) {
    if (fs.existsSync(r.plan.source))
      throw new Error("Rollback source now exists; inspect " + r.journal);
    if (inside(r.plan.target, process.cwd()))
      process.chdir(path.dirname(r.plan.target));
    await fsp.rename(r.plan.target, r.plan.source);
    r.renamed = false;
  }
  if (fs.existsSync(r.processCwd)) process.chdir(r.processCwd);
  await writeRelocationJournal(r, "rolled-back");
}
