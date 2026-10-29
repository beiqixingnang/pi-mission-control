import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import type {
  Delivery,
  Member,
  Mission,
  Schedule,
  Task,
  ArchiveKind,
  GoalNode,
  GoalAcceptance,
  GoalReceipt,
  GoalSubmission,
} from "./types.ts";

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
    CREATE TABLE IF NOT EXISTS lifecycle_archive(kind TEXT NOT NULL,id TEXT NOT NULL,closed INTEGER NOT NULL,data TEXT NOT NULL,PRIMARY KEY(kind,id));
    CREATE TABLE IF NOT EXISTS events(sequence INTEGER PRIMARY KEY AUTOINCREMENT,at INTEGER NOT NULL,kind TEXT NOT NULL,entity TEXT,data TEXT NOT NULL);`);
      // Additive migration: existing v2 sessions remain reloadable in place.
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS goal_nodes(id TEXT PRIMARY KEY,root TEXT NOT NULL,parent TEXT,data TEXT NOT NULL);
        CREATE INDEX IF NOT EXISTS goal_root ON goal_nodes(root);
        CREATE TABLE IF NOT EXISTS goal_acceptances(id TEXT PRIMARY KEY,goal TEXT NOT NULL,data TEXT NOT NULL);
        CREATE INDEX IF NOT EXISTS goal_acceptance_goal ON goal_acceptances(goal);
        CREATE TABLE IF NOT EXISTS goal_receipts(id TEXT PRIMARY KEY,goal TEXT NOT NULL,data TEXT NOT NULL);
        CREATE INDEX IF NOT EXISTS goal_receipt_goal ON goal_receipts(goal);
        CREATE TABLE IF NOT EXISTS goal_submissions(id TEXT PRIMARY KEY,goal TEXT NOT NULL,data TEXT NOT NULL);
        CREATE INDEX IF NOT EXISTS goal_submission_goal ON goal_submissions(goal);
        CREATE TABLE IF NOT EXISTS goal_missions(id TEXT PRIMARY KEY,data TEXT NOT NULL);
      `);
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
    const write = () => {
      this.db
        .prepare(
          "INSERT INTO meta VALUES (?,?) ON CONFLICT(key) DO UPDATE SET data=excluded.data",
        )
        .run(key, JSON.stringify(value));
      if (key === "mission") this.putMission(value as Mission);
    };
    if (key === "mission") this.transaction(write);
    else write();
  }
  unset(key: string) {
    this.db.prepare("DELETE FROM meta WHERE key=?").run(key);
  }
  archiveMission(mission: Mission, at: number, reason: string) {
    return this.transaction(() => {
      const archived = this.archive("goal", mission, at, reason);
      this.putMission(archived);
      if (this.mission()?.id === mission.id) this.unset("mission");
      return archived;
    });
  }
  archive<T extends { id: string }>(
    kind: ArchiveKind,
    value: T,
    at: number,
    reason: string,
  ) {
    const archived = { ...value, archivedAt: at, archiveReason: reason };
    this.db
      .prepare(
        "INSERT INTO lifecycle_archive VALUES(?,?,?,?) ON CONFLICT(kind,id) DO UPDATE SET closed=excluded.closed,data=excluded.data",
      )
      .run(kind, value.id, at, JSON.stringify(archived));
    return archived;
  }
  archived<T>(kind: ArchiveKind, id: string): T | undefined {
    const row = this.db
      .prepare("SELECT data FROM lifecycle_archive WHERE kind=? AND id=?")
      .get(kind, id) as { data: string } | undefined;
    return row ? JSON.parse(row.data) : undefined;
  }
  archives<T>(kind: ArchiveKind, limit = 100): T[] {
    return (
      this.db
        .prepare(
          "SELECT data FROM lifecycle_archive WHERE kind=? ORDER BY closed DESC,id LIMIT ?",
        )
        .all(kind, Math.max(1, Math.min(1000, limit))) as { data: string }[]
    ).map((row) => JSON.parse(row.data));
  }
  archiveCounts() {
    return Object.fromEntries(
      (
        this.db
          .prepare(
            "SELECT kind,COUNT(*) AS count FROM lifecycle_archive GROUP BY kind",
          )
          .all() as { kind: string; count: number }[]
      ).map((row) => [row.kind, row.count]),
    );
  }
  mission() {
    return this.get<Mission>("mission");
  }
  putMission(mission: Mission) {
    this.db
      .prepare(
        "INSERT INTO goal_missions VALUES(?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data",
      )
      .run(mission.id, JSON.stringify(mission));
  }
  savedMission(id: string): Mission | undefined {
    const row = this.db
      .prepare("SELECT data FROM goal_missions WHERE id=?")
      .get(id) as { data: string } | undefined;
    return row ? JSON.parse(row.data) : undefined;
  }
  putGoal(goal: GoalNode) {
    this.db
      .prepare(
        "INSERT INTO goal_nodes VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET root=excluded.root,parent=excluded.parent,data=excluded.data",
      )
      .run(goal.id, goal.rootId, goal.parentId ?? null, JSON.stringify(goal));
  }
  goal(id: string): GoalNode | undefined {
    const row = this.db
      .prepare("SELECT data FROM goal_nodes WHERE id=?")
      .get(id) as { data: string } | undefined;
    return row ? JSON.parse(row.data) : undefined;
  }
  goals(rootId?: string): GoalNode[] {
    const rows = (
      rootId
        ? this.db
            .prepare("SELECT data FROM goal_nodes WHERE root=? ORDER BY rowid")
            .all(rootId)
        : this.db.prepare("SELECT data FROM goal_nodes ORDER BY rowid").all()
    ) as { data: string }[];
    return rows.map((row) => JSON.parse(row.data));
  }
  putAcceptance(record: GoalAcceptance) {
    this.db
      .prepare("INSERT INTO goal_acceptances VALUES(?,?,?)")
      .run(record.id, record.goalId, JSON.stringify(record));
  }
  acceptance(id: string): GoalAcceptance | undefined {
    const row = this.db
      .prepare("SELECT data FROM goal_acceptances WHERE id=?")
      .get(id) as { data: string } | undefined;
    return row ? JSON.parse(row.data) : undefined;
  }
  acceptances(goalId: string): GoalAcceptance[] {
    return (
      this.db
        .prepare(
          "SELECT data FROM goal_acceptances WHERE goal=? ORDER BY rowid",
        )
        .all(goalId) as { data: string }[]
    ).map((row) => JSON.parse(row.data));
  }
  putGoalReceipt(receipt: GoalReceipt) {
    this.db
      .prepare(
        "INSERT INTO goal_receipts VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data",
      )
      .run(receipt.id, receipt.goalId, JSON.stringify(receipt));
  }
  goalReceipt(id: string): GoalReceipt | undefined {
    const row = this.db
      .prepare("SELECT data FROM goal_receipts WHERE id=?")
      .get(id) as { data: string } | undefined;
    return row ? JSON.parse(row.data) : undefined;
  }
  goalReceipts(goalId: string, limit = 20): GoalReceipt[] {
    return (
      this.db
        .prepare(
          "SELECT data FROM goal_receipts WHERE goal=? ORDER BY rowid DESC LIMIT ?",
        )
        .all(goalId, Math.max(1, Math.min(100, limit))) as { data: string }[]
    ).map((row) => JSON.parse(row.data));
  }
  putGoalSubmission(submission: GoalSubmission) {
    this.db
      .prepare(
        "INSERT INTO goal_submissions VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data",
      )
      .run(submission.id, submission.goalId, JSON.stringify(submission));
  }
  goalSubmission(id: string): GoalSubmission | undefined {
    const row = this.db
      .prepare("SELECT data FROM goal_submissions WHERE id=?")
      .get(id) as { data: string } | undefined;
    return row ? JSON.parse(row.data) : undefined;
  }
  goalSubmissions(goalId: string, limit = 50): GoalSubmission[] {
    return (
      this.db
        .prepare(
          "SELECT data FROM goal_submissions WHERE goal=? ORDER BY rowid DESC LIMIT ?",
        )
        .all(goalId, Math.max(1, Math.min(200, limit))) as { data: string }[]
    ).map((row) => JSON.parse(row.data));
  }
  putMember(m: Member) {
    this.db
      .prepare(
        "INSERT INTO members VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,data=excluded.data",
      )
      .run(m.id, m.name, JSON.stringify(m));
  }
  members(includeArchived = false): Member[] {
    const active = (
      this.db.prepare("SELECT data FROM members ORDER BY name").all() as {
        data: string;
      }[]
    ).map((x) => JSON.parse(x.data));
    return includeArchived
      ? [
          ...new Map(
            [...this.archives<Member>("member", 1000), ...active].map(
              (member) => [member.id, member],
            ),
          ).values(),
        ]
      : active;
  }
  member(name: string, includeArchived = false): Member | undefined {
    const r = this.db
      .prepare("SELECT data FROM members WHERE name=? OR id=?")
      .get(name, name) as { data: string } | undefined;
    return r
      ? JSON.parse(r.data)
      : includeArchived
        ? (this.archived<Member>("member", name) ??
          (this.archives<Member>("member", 1000).find(
            (member) => member.name === name,
          ) as Member | undefined))
        : undefined;
  }
  removeMember(id: string) {
    this.db.prepare("DELETE FROM members WHERE id=?").run(id);
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
  tasks(activeOnly = false, includeArchived = false): Task[] {
    return (
      this.db
        .prepare(
          activeOnly
            ? "SELECT data FROM tasks WHERE state IN ('queued','running','waiting') ORDER BY created"
            : `SELECT data FROM tasks ${includeArchived ? "" : "WHERE json_extract(data,'$.archivedAt') IS NULL"} ORDER BY created DESC LIMIT 1000`,
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
  unknownProcesses(limit = 100): { total: number; tasks: Task[] } {
    const total = this.db
      .prepare(
        "SELECT COUNT(*) AS n FROM tasks WHERE json_extract(data,'$.processState')='unknown'",
      )
      .get() as { n: number };
    const rows = this.db
      .prepare(
        "SELECT data FROM tasks WHERE json_extract(data,'$.processState')='unknown' ORDER BY created,id LIMIT ?",
      )
      .all(Math.max(1, Math.min(100, limit))) as { data: string }[];
    return { total: total.n, tasks: rows.map((row) => JSON.parse(row.data)) };
  }
  missionTasks(id: string): Task[] {
    return (
      this.db
        .prepare(
          "SELECT data FROM tasks WHERE json_extract(data,'$.missionId')=? ORDER BY created",
        )
        .all(id) as { data: string }[]
    ).map((row) => JSON.parse(row.data));
  }
  memberTasks(id: string): Task[] {
    return (
      this.db
        .prepare("SELECT data FROM tasks WHERE member=? ORDER BY created DESC")
        .all(id) as { data: string }[]
    ).map((row) => JSON.parse(row.data));
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
        `SELECT data FROM deliveries WHERE ${condition}state NOT IN ('observed','cancelled','superseded') ORDER BY created LIMIT 2000`,
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
    if (s.state === "ended") {
      this.archive(
        "schedule",
        s,
        s.archivedAt ?? s.updatedAt ?? Date.now(),
        s.archiveReason ?? "ended",
      );
      this.db.prepare("DELETE FROM schedules WHERE id=?").run(s.id);
      return;
    }
    this.db
      .prepare(
        "INSERT INTO schedules VALUES (?,?,?,?) ON CONFLICT(id) DO UPDATE SET state=excluded.state,due=excluded.due,data=excluded.data",
      )
      .run(s.id, s.state, s.nextAt, JSON.stringify(s));
  }
  schedule(id: string, includeArchived = false): Schedule | undefined {
    const row = this.db
      .prepare("SELECT data FROM schedules WHERE id=?")
      .get(id) as { data: string } | undefined;
    return row
      ? JSON.parse(row.data)
      : includeArchived
        ? this.archived<Schedule>("schedule", id)
        : undefined;
  }
  schedules(includeArchived = false): Schedule[] {
    const active = (
      this.db.prepare("SELECT data FROM schedules ORDER BY due").all() as {
        data: string;
      }[]
    ).map((x) => JSON.parse(x.data));
    return includeArchived
      ? [
          ...new Map(
            [...this.archives<Schedule>("schedule", 1000), ...active].map(
              (schedule) => [schedule.id, schedule],
            ),
          ).values(),
        ]
      : active;
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
