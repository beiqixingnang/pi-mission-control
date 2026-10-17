import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import type { Delivery, Member, Mission, Schedule, Task } from "./types.ts";

/** One session owner, normalized transactional state, immutable large artifacts. */
export class Store {
  directory: string;
  db: DatabaseSync;
  owner = randomUUID();
  private lock: string;
  private closed = false;
  private inTransaction = false;
  constructor(directory: string) {
    this.directory = path.resolve(directory);
    fs.mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    this.lock = path.join(this.directory, "owner.lock");
    try {
      const fd = fs.openSync(this.lock, "wx", 0o600);
      fs.writeFileSync(
        fd,
        JSON.stringify({ pid: process.pid, owner: this.owner }),
      );
      fs.closeSync(fd);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const previous = JSON.parse(fs.readFileSync(this.lock, "utf8"));
      let alive = true;
      try {
        process.kill(previous.pid, 0);
      } catch (e) {
        alive = (e as NodeJS.ErrnoException).code !== "ESRCH";
      }
      if (alive)
        throw new Error(
          "This Pi session already has a Mission Control owner. Close the other session before attaching.",
        );
      fs.unlinkSync(this.lock);
      const fd = fs.openSync(this.lock, "wx", 0o600);
      fs.writeFileSync(
        fd,
        JSON.stringify({ pid: process.pid, owner: this.owner }),
      );
      fs.closeSync(fd);
    }
    let opened: DatabaseSync | undefined;
    try {
      this.db = opened = new DatabaseSync(
        path.join(this.directory, "state.sqlite"),
      );
      this.db
        .exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY,data TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS members(id TEXT PRIMARY KEY,name TEXT UNIQUE NOT NULL,data TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS tasks(id TEXT PRIMARY KEY,member TEXT NOT NULL,parent TEXT,state TEXT NOT NULL,created INTEGER NOT NULL,data TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS task_state ON tasks(state,created);
    CREATE TABLE IF NOT EXISTS deliveries(id TEXT PRIMARY KEY,key TEXT UNIQUE NOT NULL,recipient TEXT NOT NULL,state TEXT NOT NULL,created INTEGER NOT NULL,data TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS delivery_state ON deliveries(recipient,state,created);
    CREATE TABLE IF NOT EXISTS schedules(id TEXT PRIMARY KEY,state TEXT NOT NULL,due INTEGER NOT NULL,data TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS events(sequence INTEGER PRIMARY KEY AUTOINCREMENT,at INTEGER NOT NULL,kind TEXT NOT NULL,entity TEXT,data TEXT NOT NULL);`);
      const version = this.get<number>("schema");
      if (version !== undefined && version !== 2)
        throw new Error(`Unsupported Mission Control state schema: ${version}`);
      this.set("schema", 2);
      fs.mkdirSync(path.join(this.directory, "artifacts"), {
        recursive: true,
        mode: 0o700,
      });
      fs.mkdirSync(path.join(this.directory, "sessions"), {
        recursive: true,
        mode: 0o700,
      });
    } catch (error) {
      try {
        opened?.close();
      } finally {
        this.releaseLock();
      }
      throw error;
    }
  }
  transaction<T>(fn: () => T): T {
    if (this.inTransaction) return fn();
    this.db.exec("BEGIN IMMEDIATE");
    this.inTransaction = true;
    try {
      const value = fn();
      this.db.exec("COMMIT");
      return value;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    } finally {
      this.inTransaction = false;
    }
  }
  get<T>(key: string): T | undefined {
    const row = this.db
      .prepare("SELECT data FROM meta WHERE key=?")
      .get(key) as { data: string } | undefined;
    return row ? JSON.parse(row.data) : undefined;
  }
  set(key: string, value: unknown) {
    this.db
      .prepare(
        "INSERT INTO meta VALUES (?,?) ON CONFLICT(key) DO UPDATE SET data=excluded.data",
      )
      .run(key, JSON.stringify(value));
  }
  mission() {
    return this.get<Mission>("mission");
  }
  putMember(m: Member) {
    this.db
      .prepare(
        "INSERT INTO members VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,data=excluded.data",
      )
      .run(m.id, m.name, JSON.stringify(m));
  }
  members(): Member[] {
    return (
      this.db.prepare("SELECT data FROM members ORDER BY name").all() as {
        data: string;
      }[]
    ).map((x) => JSON.parse(x.data));
  }
  member(name: string): Member | undefined {
    const r = this.db
      .prepare("SELECT data FROM members WHERE name=? OR id=?")
      .get(name, name) as { data: string } | undefined;
    return r ? JSON.parse(r.data) : undefined;
  }
  putTask(t: Task) {
    this.db
      .prepare(
        "INSERT INTO tasks VALUES (?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET state=excluded.state,data=excluded.data",
      )
      .run(
        t.id,
        t.memberId,
        t.parentId ?? null,
        t.state,
        t.createdAt,
        JSON.stringify(t),
      );
  }
  task(id: string): Task | undefined {
    const r = this.db.prepare("SELECT data FROM tasks WHERE id=?").get(id) as
      | { data: string }
      | undefined;
    return r ? JSON.parse(r.data) : undefined;
  }
  tasks(activeOnly = false): Task[] {
    return (
      this.db
        .prepare(
          activeOnly
            ? "SELECT data FROM tasks WHERE state IN ('queued','running','waiting') ORDER BY created"
            : "SELECT data FROM tasks ORDER BY created DESC LIMIT 1000",
        )
        .all() as { data: string }[]
    ).map((r) => JSON.parse(r.data));
  }
  hasUnknownProcess(memberId: string): boolean {
    return Boolean(
      this.db
        .prepare(
          "SELECT 1 FROM tasks WHERE member=? AND json_extract(data,'$.processState')='unknown' LIMIT 1",
        )
        .get(memberId),
    );
  }
  children(id: string): Task[] {
    return (
      this.db
        .prepare("SELECT data FROM tasks WHERE parent=? ORDER BY created")
        .all(id) as { data: string }[]
    ).map((r) => JSON.parse(r.data));
  }
  putDelivery(d: Delivery): Delivery {
    const previous = this.db
      .prepare("SELECT data FROM deliveries WHERE key=?")
      .get(d.key) as { data: string } | undefined;
    if (previous && JSON.parse(previous.data).id !== d.id)
      return JSON.parse(previous.data);
    this.db
      .prepare(
        "INSERT INTO deliveries VALUES (?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET state=excluded.state,data=excluded.data",
      )
      .run(d.id, d.key, d.to, d.state, d.createdAt, JSON.stringify(d));
    return d;
  }
  deliveries(to?: string): Delivery[] {
    const condition = to ? "recipient=? AND " : "",
      args = to ? [to] : [];
    const pending = this.db
      .prepare(
        `SELECT data FROM deliveries WHERE ${condition}state NOT IN ('observed','cancelled') ORDER BY created LIMIT 2000`,
      )
      .all(...args) as { data: string }[];
    const recent = this.db
      .prepare(
        `SELECT data FROM deliveries ${to ? "WHERE recipient=?" : ""} ORDER BY created DESC LIMIT 1000`,
      )
      .all(...args) as { data: string }[];
    return [
      ...new Map(
        [...pending, ...recent].map((r) => {
          const d = JSON.parse(r.data);
          return [d.id, d] as [string, Delivery];
        }),
      ).values(),
    ];
  }
  putSchedule(s: Schedule) {
    this.db
      .prepare(
        "INSERT INTO schedules VALUES (?,?,?,?) ON CONFLICT(id) DO UPDATE SET state=excluded.state,due=excluded.due,data=excluded.data",
      )
      .run(s.id, s.state, s.nextAt, JSON.stringify(s));
  }
  schedules(): Schedule[] {
    return (
      this.db.prepare("SELECT data FROM schedules ORDER BY due").all() as {
        data: string;
      }[]
    ).map((x) => JSON.parse(x.data));
  }
  artifact(id: string, kind: string, body: string): string {
    if (!/^[\w-]+$/.test(id) || !/^[\w-]+$/.test(kind))
      throw new Error("Invalid artifact identity");
    const name = path.join(this.directory, "artifacts", `${id}.${kind}.txt`);
    const fd = fs.openSync(name, "wx", 0o600);
    try {
      fs.writeFileSync(fd, body, "utf8");
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    return name;
  }
  readArtifact(file: string, max = 64000): string {
    const target = path.resolve(file),
      base = path.join(this.directory, "artifacts");
    if (path.dirname(target) !== base)
      throw new Error("Artifact outside this session");
    const fd = fs.openSync(target, "r");
    try {
      const buf = Buffer.alloc(max);
      const bytes = fs.readSync(fd, buf, 0, max, 0);
      return (
        buf.subarray(0, bytes).toString("utf8") +
        (fs.fstatSync(fd).size > bytes
          ? "\n[excerpt; full artifact remains on disk]"
          : "")
      );
    } finally {
      fs.closeSync(fd);
    }
  }
  event(kind: string, entity: string, data: unknown = {}) {
    this.db
      .prepare("INSERT INTO events(at,kind,entity,data) VALUES(?,?,?,?)")
      .run(Date.now(), kind, entity, JSON.stringify(data).slice(0, 4000));
    this.db.exec(
      "DELETE FROM events WHERE sequence < (SELECT COALESCE(MAX(sequence),0)-10000 FROM events)",
    );
  }
  private releaseLock() {
    try {
      if (JSON.parse(fs.readFileSync(this.lock, "utf8")).owner === this.owner)
        fs.unlinkSync(this.lock);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    try {
      this.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
      this.db.close();
    } finally {
      this.releaseLock();
    }
  }
}
