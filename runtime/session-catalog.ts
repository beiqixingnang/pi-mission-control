/** Metadata-only, append-aware catalog. Never retains message bodies. */
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { projectSessionFiles } from "../extensions/project/identity.ts";

export interface RecoverySession {
  file: string;
  id: string;
  cwd: string;
  name: string;
  modified: number;
  missing: boolean;
  header: {
    type: "session";
    id: string;
    cwd: string;
    timestamp: string;
    version?: number;
    parentSession?: string;
  };
}
interface CachedSession {
  info: RecoverySession;
  size: number;
  mtime: number;
  ino: number;
  dev: number;
  head: string;
  offset: number;
}
const location = (file: string) => {
  const absolute = path.resolve(file);
  try {
    return fs.realpathSync.native(absolute);
  } catch {
    try {
      return path.join(
        fs.realpathSync.native(path.dirname(absolute)),
        path.basename(absolute),
      );
    } catch {
      return absolute;
    }
  }
};
const key = (file: string) =>
  process.platform === "win32" ? location(file).toLowerCase() : location(file);

/** Retain at most 64 KiB per LF record, even for a multi-gigabyte tool result. */
async function* prefixes(file: string, start: number, end: number) {
  if (start >= end) return;
  let parts: Buffer[] = [],
    length = 0,
    offset = start,
    truncated = false;
  for await (const chunk of fs.createReadStream(file, {
    start,
    end: end - 1,
    highWaterMark: 65536,
  })) {
    let at = 0;
    while (at < chunk.length) {
      const lf = chunk.indexOf(10, at),
        next = lf < 0 ? chunk.length : lf;
      const take = Math.min(next - at, 65536 - length);
      if (take) {
        parts.push(chunk.subarray(at, at + take));
        length += take;
      }
      if (take < next - at) truncated = true;
      offset += next - at + (lf < 0 ? 0 : 1);
      if (lf >= 0) {
        yield {
          text: Buffer.concat(parts, length).toString("utf8"),
          end: offset,
          truncated,
        };
        parts = [];
        length = 0;
        truncated = false;
      }
      at = next + 1;
    }
  }
}

export class SessionCatalog {
  private db: DatabaseSync;
  constructor() {
    const directory = path.join(getAgentDir(), "workspace-recovery");
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path.join(directory, "catalog.sqlite"));
    this.db.exec(
      "PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS sessions(file TEXT PRIMARY KEY,data TEXT NOT NULL); CREATE TABLE IF NOT EXISTS bindings(source TEXT PRIMARY KEY,target TEXT NOT NULL);",
    );
  }
  async inspect(
    file: string,
    force = false,
  ): Promise<RecoverySession | undefined> {
    const stat = await fsp.lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink())
      throw new Error("Select a regular session file, not a symbolic link");
    file = await fsp.realpath(file);
    const fd = await fsp.open(file, "r");
    let head: string;
    try {
      const buffer = Buffer.alloc(Math.min(4096, stat.size));
      await fd.read(buffer, 0, buffer.length, 0);
      head = createHash("sha256").update(buffer).digest("hex");
    } finally {
      await fd.close();
    }
    const row = this.db
      .prepare("SELECT data FROM sessions WHERE file=?")
      .get(key(file));
    const old = row
      ? (JSON.parse(String(row.data)) as CachedSession)
      : undefined;
    if (
      !force &&
      old &&
      old.size === stat.size &&
      old.mtime === stat.mtimeMs &&
      old.head === head &&
      old.ino === stat.ino &&
      old.dev === stat.dev
    )
      return { ...old.info, missing: !fs.existsSync(old.info.cwd) };
    const incremental =
      !force &&
      old &&
      old.size < stat.size &&
      old.head === head &&
      old.ino === stat.ino &&
      old.dev === stat.dev;
    let info = incremental ? { ...old.info } : undefined;
    let offset = incremental ? old.offset : 0;
    for await (const line of prefixes(file, offset, stat.size)) {
      if (offset === 0) line.text = line.text.replace(/^\uFEFF/, "");
      if (
        offset === 0 &&
        !line.text.startsWith('{"type":"session"') &&
        !/^\s*\{\s*"type"\s*:\s*"session"/.test(line.text)
      )
        return;
      if (
        !line.truncated &&
        /^\s*\{\s*"type"\s*:\s*"(?:session|session_info)"/.test(line.text)
      ) {
        let entry;
        try {
          entry = JSON.parse(line.text);
        } catch {
          if (!info) return;
          offset = line.end;
          continue;
        }
        if (entry.type === "session") {
          if (
            info ||
            typeof entry.id !== "string" ||
            !/^[a-zA-Z0-9_-]{1,120}$/.test(entry.id) ||
            typeof entry.cwd !== "string" ||
            !path.isAbsolute(entry.cwd)
          )
            return;
          const header = {
            type: "session" as const,
            id: entry.id,
            cwd: entry.cwd,
            timestamp: entry.timestamp,
            version: entry.version,
            parentSession: entry.parentSession,
          };
          info = {
            file,
            id: entry.id,
            cwd: entry.cwd,
            name: "",
            modified: stat.mtimeMs,
            missing: !fs.existsSync(entry.cwd),
            header,
          };
        } else if (info)
          info.name =
            typeof entry.name === "string" ? entry.name.slice(0, 2000) : "";
      }
      offset = line.end;
    }
    if (!info) return;
    info.modified = stat.mtimeMs;
    info.missing = !fs.existsSync(info.cwd);
    const after = await fsp.stat(file);
    if (
      after.size === stat.size &&
      after.mtimeMs === stat.mtimeMs &&
      after.ino === stat.ino
    )
      this.db.prepare("INSERT OR REPLACE INTO sessions VALUES(?,?)").run(
        key(file),
        JSON.stringify({
          info,
          size: stat.size,
          mtime: stat.mtimeMs,
          ino: stat.ino,
          dev: stat.dev,
          head,
          offset,
        } satisfies CachedSession),
      );
    return info;
  }
  async list(
    sessionDir: string,
    excludeId?: string,
  ): Promise<RecoverySession[]> {
    const candidates = new Set<string>(projectSessionFiles());
    const add = async (directory: string, nested: boolean) => {
      let entries;
      try {
        entries = await fsp.readdir(directory, { withFileTypes: true });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
        throw error;
      }
      for (const entry of entries) {
        const file = path.join(directory, entry.name);
        if (entry.isFile() && entry.name.endsWith(".jsonl"))
          candidates.add(file);
        else if (nested && entry.isDirectory()) await add(file, false);
      }
    };
    await add(path.join(getAgentDir(), "sessions"), true);
    await add(sessionDir, false);
    const hidden = new Set<string>();
    for (const row of this.db
      .prepare("SELECT source,target FROM bindings")
      .iterate())
      if (fs.existsSync(String(row.target))) hidden.add(String(row.source));
    const result = new Map<string, RecoverySession>();
    for (const file of candidates) {
      try {
        const info = await this.inspect(file);
        if (info && info.id !== excludeId && !hidden.has(key(info.file)))
          result.set(key(info.file), info);
      } catch (error) {
        if (
          !["ENOENT", "EACCES", "EPERM"].includes(
            (error as NodeJS.ErrnoException).code ?? "",
          )
        )
          throw error;
      }
    }
    return [...result.values()].sort(
      (a, b) => b.modified - a.modified || a.file.localeCompare(b.file),
    );
  }
  bind(source: string, target: string) {
    this.db
      .prepare("INSERT OR REPLACE INTO bindings VALUES(?,?)")
      .run(key(source), location(target));
  }
  latest(file: string): string {
    const seen = new Set<string>();
    for (let i = 0; i < 100; i++) {
      const current = key(file);
      if (seen.has(current))
        throw new Error(
          "Recovery binding cycle; inspect the recovery journals",
        );
      seen.add(current);
      const row = this.db
        .prepare("SELECT target FROM bindings WHERE source=?")
        .get(current);
      if (!row || !fs.existsSync(String(row.target))) return file;
      file = String(row.target);
    }
    throw new Error("Recovery binding chain exceeds its supported length");
  }
  close() {
    this.db.close();
  }
}
