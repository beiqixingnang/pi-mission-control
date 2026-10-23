/** Stable workspace identities. Only explicit, successful renames change a project's path.
 * Windows/POSIX records coexist; native bindings stay distinct without Windows/WSL drive mapping.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

export interface ProjectIdentity {
  id: string;
  currentPath: string;
  previousPaths: string[];
  sessions: string[];
}
interface Registry {
  version: 1;
  projects: ProjectIdentity[];
}
interface LockOwner {
  pid: number;
  token: string;
}
const lockWait = new Int32Array(new SharedArrayBuffer(4));
const uuid =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const nativePaths = process.platform === "win32" ? path.win32 : path.posix;
function pathSyntax(value: string): typeof path.win32 | undefined {
  if (path.posix.isAbsolute(value) && path.posix.resolve(value) === value)
    return path.posix;
  if (
    path.win32.isAbsolute(value) &&
    path.win32.parse(value).root.length > 1 &&
    path.win32.resolve(value) === value
  )
    return path.win32;
  return undefined;
}
const key = (value: string) =>
  pathSyntax(value) === path.win32
    ? `win32:${value.toLowerCase()}`
    : `posix:${value}`;
const samePath = (left: string, right: string) => key(left) === key(right);
function inside(root: string, candidate: string): boolean {
  const syntax = pathSyntax(root);
  if (!syntax || syntax !== pathSyntax(candidate)) return false;
  const relative = syntax.relative(root, candidate);
  return (
    !syntax.isAbsolute(relative) &&
    relative !== ".." &&
    !relative.startsWith(`..${syntax.sep}`)
  );
}
function validPath(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    !value.includes("\0") &&
    pathSyntax(value) !== undefined
  );
}
function requireId(id: string): void {
  if (typeof id !== "string" || !uuid.test(id))
    throw new Error("Invalid project ID; expected a registry-issued UUID.");
}
function requirePath(value: string): void {
  if (!validPath(value))
    throw new Error("Expected a normalized absolute path without traversal.");
}
/** Resolve existing ancestors too, so a missing old path can still be compared after a rename. */
function canonicalLocation(value: string): string {
  const suffix: string[] = [];
  let ancestor = value;
  for (;;) {
    try {
      return path.join(fs.realpathSync.native(ancestor), ...suffix.reverse());
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const parent = path.dirname(ancestor);
      if (parent === ancestor) throw error;
      suffix.push(path.basename(ancestor));
      ancestor = parent;
    }
  }
}
function canonicalAbsolute(value: string): string {
  requirePath(value);
  if (pathSyntax(value) !== nativePaths)
    throw new Error(
      "Expected a normalized native absolute path without traversal.",
    );
  return canonicalLocation(value);
}
function directory(value: string): string {
  if (typeof value !== "string" || !value.trim() || value.includes("\0"))
    throw new Error("Provide an existing workspace directory.");
  const result = fs.realpathSync.native(value);
  if (!fs.statSync(result).isDirectory())
    throw new Error("The workspace must be a directory.");
  return result;
}
function registryFile(): string {
  return path.join(
    canonicalLocation(path.resolve(getAgentDir(), "projects")),
    "registry.json",
  );
}
function externalStorage(file: string, workspace: string): void {
  if (inside(workspace, file))
    throw new Error("Pi's project registry must be outside the workspace.");
}
const copy = (project: ProjectIdentity): ProjectIdentity => ({
  ...project,
  previousPaths: [...project.previousPaths],
  sessions: [...project.sessions],
});
const aliases = (project: ProjectIdentity) => [
  project.currentPath,
  ...project.previousPaths,
];
function exactKeys(value: object, names: string[]): boolean {
  const keys = Object.keys(value);
  return (
    keys.length === names.length &&
    names.every((name) => Object.hasOwn(value, name))
  );
}
function validate(value: unknown): asserts value is Registry {
  if (
    !value ||
    typeof value !== "object" ||
    !exactKeys(value, ["version", "projects"])
  )
    throw new Error("Invalid registry structure.");
  const registry = value as Registry;
  if (registry.version !== 1 || !Array.isArray(registry.projects))
    throw new Error("Unsupported registry version or project list.");
  const ids = new Set<string>();
  const paths = new Set<string>();
  for (const project of registry.projects) {
    if (
      !project ||
      typeof project !== "object" ||
      !exactKeys(project, ["id", "currentPath", "previousPaths", "sessions"]) ||
      typeof project.id !== "string" ||
      !uuid.test(project.id) ||
      ids.has(project.id)
    )
      throw new Error("Invalid or duplicate project ID.");
    ids.add(project.id);
    if (
      !validPath(project.currentPath) ||
      !Array.isArray(project.previousPaths) ||
      !Array.isArray(project.sessions)
    )
      throw new Error("Invalid project paths or sessions.");
    for (const location of aliases(project)) {
      if (!validPath(location) || paths.has(key(location)))
        throw new Error("Invalid or duplicate project alias.");
      paths.add(key(location));
    }
    const sessions = new Set<string>();
    for (const session of project.sessions) {
      if (!validPath(session) || sessions.has(key(session)))
        throw new Error("Invalid or duplicate session path.");
      sessions.add(key(session));
    }
  }
}
function readRegistry(file: string): Registry {
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      return { version: 1, projects: [] };
    throw error;
  }
  try {
    if (!stat.isFile() || stat.isSymbolicLink())
      throw new Error("Registry must be a regular file.");
    const registry: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
    validate(registry);
    for (const project of registry.projects)
      externalStorage(file, project.currentPath);
    return registry;
  } catch (error) {
    throw new Error(
      `Invalid project registry at ${file}; left unchanged. ${(error as Error).message}`,
    );
  }
}
/** A missing owner can be an acquire in progress. Never reclaim another owner's lock. */
function readLockOwner(lock: string): LockOwner | undefined {
  try {
    const stat = fs.lstatSync(lock);
    if (!stat.isDirectory() || stat.isSymbolicLink())
      throw new Error("Lock must be a directory.");
    const ownerFile = path.join(lock, "owner.json");
    const ownerStat = fs.lstatSync(ownerFile);
    if (!ownerStat.isFile() || ownerStat.isSymbolicLink())
      throw new Error("Lock owner must be a regular file.");
    const owner: unknown = JSON.parse(fs.readFileSync(ownerFile, "utf8"));
    if (
      !owner ||
      typeof owner !== "object" ||
      !exactKeys(owner, ["pid", "token"])
    )
      throw new Error("Invalid owner metadata.");
    const value = owner as LockOwner;
    if (
      !Number.isSafeInteger(value.pid) ||
      value.pid <= 0 ||
      typeof value.token !== "string" ||
      !uuid.test(value.token)
    )
      throw new Error("Invalid owner PID or token.");
    return value;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new Error(
      `Invalid project registry lock at ${lock}; left unchanged. ${(error as Error).message}`,
    );
  }
}
function acquireRegistryLock(file: string): () => void {
  const lock = `${file}.lock`;
  const deadline = performance.now() + 2500;
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  for (;;) {
    if (performance.now() >= deadline)
      throw new Error(
        `Timed out waiting for project registry lock at ${lock}; left unchanged.`,
      );
    let acquired = false;
    try {
      fs.mkdirSync(lock, { mode: 0o700 });
      acquired = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    if (acquired) {
      const owner: LockOwner = { pid: process.pid, token: randomUUID() };
      const ownerFile = path.join(lock, "owner.json");
      const temporary = path.join(lock, `${owner.token}.tmp`);
      try {
        // Publish complete metadata; contenders may briefly see no owner during acquisition.
        fs.writeFileSync(temporary, JSON.stringify(owner) + "\n", {
          flag: "wx",
          mode: 0o600,
        });
        fs.renameSync(temporary, ownerFile);
      } catch (error) {
        try {
          fs.unlinkSync(temporary);
        } catch {
          /* An incomplete acquisition stays fail-safe. */
        }
        try {
          fs.rmdirSync(lock);
        } catch {
          /* Never recursively remove an unknown lock's contents. */
        }
        throw error;
      }
      return () => {
        const current = readLockOwner(lock);
        if (
          !current ||
          current.pid !== owner.pid ||
          current.token !== owner.token
        )
          throw new Error(
            `Project registry lock ownership changed at ${lock}; left unchanged.`,
          );
        fs.unlinkSync(ownerFile);
        fs.rmdirSync(lock);
      };
    }
    const owner = readLockOwner(lock);
    if (owner) {
      try {
        process.kill(owner.pid, 0);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === "ESRCH") {
          // The owner may have released and exited between our metadata read and PID probe.
          const current = readLockOwner(lock);
          if (
            !current ||
            current.pid !== owner.pid ||
            current.token !== owner.token
          )
            continue;
          throw new Error(
            `Abandoned project registry lock at ${lock}: owner PID ${owner.pid} is gone; left unchanged for recovery.`,
          );
        }
        if (code !== "EPERM" && code !== "EACCES")
          throw new Error(
            `Cannot verify project registry lock owner at ${lock}; left unchanged.`,
          );
      }
    }
    const remaining = deadline - performance.now();
    if (remaining > 0) Atomics.wait(lockWait, 0, 0, Math.min(25, remaining));
  }
}
function mutateRegistry<T>(file: string, mutate: (registry: Registry) => T): T {
  const release = acquireRegistryLock(file);
  try {
    return mutate(readRegistry(file));
  } finally {
    release();
  }
}
/** Mutations read under the cross-process lock, then atomically replace the registry. */
function writeRegistry(file: string, registry: Registry): void {
  validate(registry);
  for (const project of registry.projects)
    externalStorage(file, project.currentPath);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${randomUUID()}.tmp`;
  let fd: number | undefined;
  let created = false;
  try {
    fd = fs.openSync(temporary, "wx", 0o600);
    created = true;
    fs.writeFileSync(fd, JSON.stringify(registry, null, 2) + "\n", "utf8");
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    fs.renameSync(temporary, file);
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    if (created && fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
}
function projectById(registry: Registry, id: string): ProjectIdentity {
  const project = registry.projects.find((project) => project.id === id);
  if (!project) throw new Error(`Unknown project ID: ${id}`);
  return project;
}
function addSession(project: ProjectIdentity, sessionFile: string): boolean {
  if (project.sessions.some((session) => samePath(session, sessionFile)))
    return false;
  project.sessions.push(sessionFile);
  return true;
}

export function newProjectIdentityId(): string {
  return randomUUID();
}

export function registerProject(
  id: string,
  cwd: string,
  sessionFile: string,
): ProjectIdentity {
  requireId(id);
  const currentPath = directory(cwd);
  const session = canonicalAbsolute(sessionFile);
  const file = registryFile();
  externalStorage(file, currentPath);
  return mutateRegistry(file, (registry) => {
    const existing = registry.projects.find((project) => project.id === id);
    if (existing) {
      if (!samePath(existing.currentPath, currentPath))
        throw new Error("Project ID is already bound to another path.");
      addSession(existing, session);
      writeRegistry(file, registry);
      return copy(existing);
    }
    const owner = registry.projects.find((project) =>
      aliases(project).some((alias) => samePath(alias, currentPath)),
    );
    if (owner)
      throw new Error(
        "The project path is already registered to another project: " +
          owner.id,
      );
    const project = { id, currentPath, previousPaths: [], sessions: [session] };
    registry.projects.push(project);
    writeRegistry(file, registry);
    return copy(project);
  });
}

/** Existing directories get fresh IDs; historical aliases cannot silently claim a reused directory. */
export function getProjectIdentity(cwd: string): ProjectIdentity {
  const currentPath = directory(cwd);
  const file = registryFile();
  externalStorage(file, currentPath);
  return mutateRegistry(file, (registry) => {
    const project = registry.projects.find((project) =>
      samePath(project.currentPath, currentPath),
    );
    if (project) return copy(project);
    if (
      registry.projects.some((project) =>
        project.previousPaths.some((alias) => samePath(alias, currentPath)),
      )
    )
      throw new Error(
        "This directory is a historical alias of another project; its identity cannot be claimed implicitly.",
      );
    const created: ProjectIdentity = {
      id: randomUUID(),
      currentPath,
      previousPaths: [],
      sessions: [],
    };
    registry.projects.push(created);
    writeRegistry(file, registry);
    return copy(created);
  });
}

/** Explicit recovery may claim a reused historical directory as a fresh
 * workspace. Never change another project's current root or session records.
 */
export function getRecoveryProjectIdentity(cwd: string): ProjectIdentity {
  const currentPath = directory(cwd),
    file = registryFile();
  externalStorage(file, currentPath);
  return mutateRegistry(file, (registry) => {
    const existing = registry.projects.find((project) =>
      samePath(project.currentPath, currentPath),
    );
    if (existing) return copy(existing);
    for (const project of registry.projects)
      project.previousPaths = project.previousPaths.filter(
        (alias) => !samePath(alias, currentPath),
      );
    const created: ProjectIdentity = {
      id: randomUUID(),
      currentPath,
      previousPaths: [],
      sessions: [],
    };
    registry.projects.push(created);
    writeRegistry(file, registry);
    return copy(created);
  });
}

/** Commit only after the directory rename AND host session switch succeed. Preparation never calls this. */
export function relocateProject(
  id: string,
  source: string,
  target: string,
  sessionFile: string,
): ProjectIdentity {
  requireId(id);
  const oldPath = canonicalAbsolute(source);
  const currentPath = directory(target);
  const session = canonicalAbsolute(sessionFile);
  const file = registryFile();
  externalStorage(file, oldPath);
  externalStorage(file, currentPath);
  return mutateRegistry(file, (registry) => {
    const project = projectById(registry, id);
    const owner = registry.projects.find(
      (other) =>
        other.id !== id &&
        aliases(other).some((alias) => samePath(alias, currentPath)),
    );
    if (owner)
      throw new Error(
        `The rename target is already registered to another project: ${owner.id}`,
      );
    if (
      samePath(project.currentPath, currentPath) &&
      project.previousPaths.some((alias) => samePath(alias, oldPath))
    ) {
      if (addSession(project, session)) writeRegistry(file, registry);
      return copy(project); // Recovery may safely repeat a completed commit.
    }
    if (!samePath(project.currentPath, oldPath))
      throw new Error(
        "The rename source does not match the project's current path.",
      );
    if (samePath(oldPath, currentPath))
      throw new Error("The rename source and target must differ.");
    try {
      fs.lstatSync(oldPath);
      throw new Error(
        "The rename source still exists; commit only after a successful directory rename.",
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    project.previousPaths = project.previousPaths.filter(
      (alias) => !samePath(alias, currentPath),
    );
    if (!project.previousPaths.some((alias) => samePath(alias, oldPath)))
      project.previousPaths.push(project.currentPath);
    project.currentPath = currentPath;
    addSession(project, session);
    writeRegistry(file, registry);
    return copy(project);
  });
}

/** Session associations are metadata; session files and historical evidence are never rewritten. */
export function associateProjectSession(
  id: string,
  sessionFile: string,
): ProjectIdentity {
  requireId(id);
  const session = canonicalAbsolute(sessionFile);
  const file = registryFile();
  return mutateRegistry(file, (registry) => {
    const project = projectById(registry, id);
    if (addSession(project, session)) writeRegistry(file, registry);
    return copy(project);
  });
}

/** Historical prefixes map directly to the latest root, with a path-segment boundary. */
export function resolveProjectPath(id: string, oldPath: string): string {
  requireId(id);
  requirePath(oldPath);
  const project = projectById(readRegistry(registryFile()), id);
  if (inside(project.currentPath, oldPath)) return oldPath;
  const alias = [...project.previousPaths]
    .sort((left, right) => right.length - left.length)
    .find((alias) => inside(alias, oldPath));
  const syntax = pathSyntax(oldPath)!;
  return alias && syntax === pathSyntax(project.currentPath)
    ? syntax.join(project.currentPath, syntax.relative(alias, oldPath))
    : oldPath;
}

/** Look up a registry-issued UUID or an exact current/historical root; never creates an identity. */
export function lookupProject(
  query: string,
  recordedOnly = false,
): ProjectIdentity | undefined {
  const registry = readRegistry(registryFile());
  if (typeof query !== "string" || !query.trim() || query.includes("\0"))
    return undefined;
  if (uuid.test(query)) {
    const project = registry.projects.find((project) => project.id === query);
    return project ? copy(project) : undefined;
  }
  const location = validPath(query) ? query : path.resolve(query);
  let project = registry.projects.find((project) =>
    aliases(project).some((alias) => samePath(alias, location)),
  );
  if (!project && !recordedOnly && pathSyntax(location) === nativePaths) {
    const canonical = canonicalLocation(location);
    project = registry.projects.find((project) =>
      aliases(project).some((alias) => samePath(alias, canonical)),
    );
  }
  return project ? copy(project) : undefined;
}

/** Explicitly associated custom session locations, without walking workspaces. */
export function projectSessionFiles(): string[] {
  return [
    ...new Set(
      readRegistry(registryFile()).projects.flatMap(
        (project) => project.sessions,
      ),
    ),
  ];
}
