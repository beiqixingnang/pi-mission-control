import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { randomUUID, createHmac, timingSafeEqual } from "node:crypto";
import { estimateSummaryTokens } from "./summarize.ts";
import { exportText } from "./public.ts";

export type ContextMode = "summary" | "notes";
export const NOTE_LIMITS = {
  index: 1500,
  handoff: 4000,
  topic: 8000,
  read: 2000,
  userRequests: 1500,
};
/** Keep mutable hints near the tail, without splitting the last assistant/tool-result group. */
export function appendContextHint(messages: any[], hint: any) {
  const clean = messages.filter((m) => m.customType !== "context-memory-hint");
  let at = clean.findLastIndex((m) => m.role === "assistant");
  if (at < 0) at = Math.max(0, clean.length - 1);
  return [...clean.slice(0, at), hint, ...clean.slice(at)];
}
/** Suppress only an exact version carried by the currently projected checkpoint. */
export function indexAlreadyIncluded(
  note: { revision: number; source: string },
  entries: any[],
  messages: any[],
) {
  const checkpoint = entries.findLast((e) => e.type === "compaction");
  const injected = checkpoint?.details?.injectedNotes?.index;
  return (
    checkpoint?.details?.contextMode === "notes" &&
    injected?.revision === note.revision &&
    injected?.source === note.source &&
    messages.some(
      (m) =>
        m.role === "compactionSummary" &&
        m.timestamp === new Date(checkpoint.timestamp).getTime() &&
        m.summary === checkpoint.summary,
    )
  );
}
const MEMORY_TOOLS = new Set([
  "context_mode",
  "context_note",
  "context_history",
  "context_rollover",
]);
function safeValue(value: any, depth = 0): any {
  if (depth > 20) return "[depth limit]";
  if (typeof value === "string") return exportText(value, value.length);
  if (Array.isArray(value)) return value.map((v) => safeValue(v, depth + 1));
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .filter(
          ([key]) =>
            !/thinking|reasoning|signature|system.?prompt|api.?key|secret|authorization|password|access.?token/i.test(
              key,
            ),
        )
        .map(([key, v]) => [key, safeValue(v, depth + 1)]),
    );
  return value;
}
/** Current conversation's public messages only. No access to other plugins' files/tables. */
export function historyText(entry: any): string | undefined {
  if (entry.type === "compaction")
    return exportText(entry.summary ?? "", entry.summary?.length ?? 0);
  const message =
    entry.type === "custom_message"
      ? entry
      : entry.type === "message"
        ? entry.message
        : undefined;
  if (
    !message ||
    (!["user", "assistant", "toolResult", "custom"].includes(message.role) &&
      entry.type !== "custom_message")
  )
    return;
  if (message.role === "toolResult" && MEMORY_TOOLS.has(message.toolName))
    return;
  if (
    entry.type === "custom_message" &&
    /^context-memory-/.test(entry.customType ?? "")
  )
    return;
  if (typeof message.content === "string")
    return exportText(message.content, message.content.length);
  return (message.content ?? [])
    .flatMap((block: any) => {
      if (block.type === "text")
        return [exportText(block.text ?? "", block.text?.length ?? 0)];
      if (block.type === "toolCall" && !MEMORY_TOOLS.has(block.name))
        return [
          JSON.stringify({
            tool: block.name,
            id: block.id,
            arguments: safeValue(block.arguments),
          }),
        ];
      return [];
    })
    .join("\n");
}
/** Pin a small amount of actual user text; a model-written handoff must not replace a correction. */
export function recentUserContext(entries: any[]) {
  const selected: string[] = [];
  let remaining = NOTE_LIMITS.userRequests;
  const take = (text: string, tokens: number, tail = false) => {
    let low = 0,
      high = text.length;
    while (low < high) {
      const mid = Math.ceil((low + high) / 2);
      if (
        estimateSummaryTokens(
          tail ? text.slice(text.length - mid) : text.slice(0, mid),
        ) <= tokens
      )
        low = mid;
      else high = mid - 1;
    }
    let result = tail ? text.slice(text.length - low) : text.slice(0, low);
    if (tail && /^[\uDC00-\uDFFF]/.test(result)) result = result.slice(1);
    if (!tail && /[\uD800-\uDBFF]$/.test(result)) result = result.slice(0, -1);
    return result;
  };
  const users = entries
    .filter((e) => e.type === "message" && e.message?.role === "user")
    .slice(-3);
  for (const entry of users.reverse()) {
    const text = historyText(entry) ?? "";
    const heading = `[User source ${entry.id}; use context_history read for the original]\n`;
    const available = remaining - estimateSummaryTokens(heading) - 16;
    if (available < 32) break;
    let body = text;
    if (estimateSummaryTokens(text) > available) {
      const marker = "\n[Excerpt: middle omitted; original history retained]\n";
      const allowance = available - estimateSummaryTokens(marker);
      body =
        take(text, Math.floor(allowance / 4)) +
        marker +
        take(text, Math.floor((allowance * 3) / 4), true);
    }
    const rendered = heading + body;
    selected.push(rendered);
    remaining -= estimateSummaryTokens(rendered + "\n\n");
  }
  return selected.reverse().join("\n\n");
}
export class ContextMemory {
  db: DatabaseSync;
  readonly directory: string;
  readonly sessionId: string;
  constructor(directory: string, sessionId: string) {
    this.directory = directory;
    this.sessionId = sessionId;
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path.join(directory, "memory.sqlite"));
    this.db.exec(
      "PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY,value TEXT NOT NULL); CREATE TABLE IF NOT EXISTS notes(name TEXT PRIMARY KEY,revision INTEGER,text TEXT,source TEXT,at INTEGER); CREATE TABLE IF NOT EXISTS note_versions(name TEXT,revision INTEGER,text TEXT,source TEXT,at INTEGER,PRIMARY KEY(name,revision)); CREATE TABLE IF NOT EXISTS history(id TEXT PRIMARY KEY,ordinal INTEGER,role TEXT,text TEXT); CREATE TABLE IF NOT EXISTS branch(id TEXT PRIMARY KEY);",
    );
    this.db.exec(
      "CREATE VIRTUAL TABLE IF NOT EXISTS history_search USING fts5(id UNINDEXED,text,tokenize='trigram');",
    );
    // Rebuild only our derived index after filtering changes; native history and notes remain authoritative.
    if (this.setting("history-index-version", "") !== "2") {
      this.db.exec("BEGIN IMMEDIATE");
      try {
        this.db.exec(
          "DELETE FROM history; DELETE FROM history_search; DELETE FROM branch;",
        );
        this.db
          .prepare(
            "INSERT OR REPLACE INTO settings VALUES('history-index-version','2')",
          )
          .run();
        this.db.exec("COMMIT");
      } catch (error) {
        this.db.exec("ROLLBACK");
        throw error;
      }
    }
  }
  close() {
    this.db.close();
  }
  setting(key: string, fallback: string) {
    return (
      (
        this.db
          .prepare("SELECT value FROM settings WHERE key=?")
          .get(key) as any
      )?.value ?? fallback
    );
  }
  setSetting(key: string, value: string) {
    this.db
      .prepare("INSERT OR REPLACE INTO settings VALUES(?,?)")
      .run(key, value);
  }
  get mode(): ContextMode {
    return this.setting("mode", "summary") as ContextMode;
  }
  setMode(mode: ContextMode) {
    if (!["summary", "notes"].includes(mode))
      throw Error("mode must be summary or notes");
    this.db
      .prepare("INSERT OR REPLACE INTO settings VALUES('mode',?)")
      .run(mode);
  }
  list() {
    return this.db
      .prepare(
        "SELECT name,revision,length(text) AS chars,source,at FROM notes ORDER BY name",
      )
      .all();
  }
  note(name: string) {
    return this.db.prepare("SELECT * FROM notes WHERE name=?").get(name) as
      | {
          name: string;
          revision: number;
          text: string;
          source: string;
          at: number;
        }
      | undefined;
  }
  write(name: string, text: string, source: string, expectedRevision?: number) {
    return this.writeMany([{ name, text, expectedRevision }], source)[0];
  }
  writeMany(
    notes: Array<{ name: string; text: string; expectedRevision?: number }>,
    source: string,
  ) {
    if (
      !notes.length ||
      notes.length > 12 ||
      new Set(notes.map((n) => n.name)).size !== notes.length
    )
      throw Error("Write 1..12 distinct virtual notes");
    const prepared = notes.map(({ name, text, expectedRevision }) => {
      if (
        !/^[a-zA-Z0-9][a-zA-Z0-9/_-]{0,95}$/.test(name) ||
        name.split("/").some((x) => !x)
      )
        throw Error("Use a virtual note name, not a filesystem path");
      if (typeof text !== "string" || !text.trim())
        throw Error("Note must be non-empty");
      const limit =
        name === "index"
          ? NOTE_LIMITS.index
          : name === "handoff"
            ? NOTE_LIMITS.handoff
            : NOTE_LIMITS.topic;
      const estimatedTokens = estimateSummaryTokens(text);
      if (estimatedTokens > limit)
        throw Error(
          `Note exceeds ${limit} estimated tokens; shorten it or move detail to a topic note. No text was truncated.`,
        );
      return { name, text, expectedRevision, estimatedTokens };
    });
    if (prepared.reduce((n, note) => n + note.estimatedTokens, 0) > 16000)
      throw Error("Note batch exceeds 16000 estimated tokens");
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const receipts = prepared.map(
        ({ name, text, expectedRevision, estimatedTokens }) => {
          const old = this.note(name);
          if (
            expectedRevision !== undefined &&
            expectedRevision !== (old?.revision ?? 0)
          )
            throw Error("Note revision changed");
          const unchanged = old?.text === text;
          const revision = (old?.revision ?? 0) + (unchanged ? 0 : 1),
            at = Date.now();
          this.db
            .prepare("INSERT OR REPLACE INTO notes VALUES(?,?,?,?,?)")
            .run(name, revision, text, source, at);
          if (!unchanged)
            this.db
              .prepare("INSERT INTO note_versions VALUES(?,?,?,?,?)")
              .run(name, revision, text, source, at);
          return {
            name,
            revision,
            estimatedTokens,
            source,
            saved: true,
            unchanged,
          };
        },
      );
      this.db.exec("COMMIT");
      return receipts;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  read(name: string, offset = 0, limit = 4000) {
    if (
      !Number.isSafeInteger(offset) ||
      offset < 0 ||
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > 6000
    )
      throw Error("Invalid note page");
    const note = this.note(name);
    if (!note) throw Error("Unknown note");
    let text = Array.from(note.text)
      .slice(offset, offset + limit)
      .join("");
    while (estimateSummaryTokens(text) > NOTE_LIMITS.read)
      text = Array.from(text)
        .slice(0, Math.floor(Array.from(text).length * 0.8))
        .join("");
    const count = Array.from(text).length,
      total = Array.from(note.text).length;
    return {
      name,
      revision: note.revision,
      text,
      offset,
      total,
      nextOffset: offset + count < total ? offset + count : undefined,
    };
  }
  sync(entries: any[]) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.exec("DELETE FROM branch");
      let ordinal = 0;
      for (const entry of entries) {
        const id = entry.id;
        if (!id) continue;
        this.db.prepare("INSERT OR IGNORE INTO branch VALUES(?)").run(id);
        if (this.db.prepare("SELECT id FROM history WHERE id=?").get(id)) {
          ordinal++;
          continue;
        }
        const text = historyText(entry);
        if (text !== undefined) {
          this.db
            .prepare("INSERT INTO history VALUES(?,?,?,?)")
            .run(id, ordinal, entry.message?.role ?? entry.type, text);
          this.db
            .prepare("INSERT INTO history_search VALUES(?,?)")
            .run(id, text);
        }
        ordinal++;
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  private cursorSignature(payload: string, query: string, role?: string) {
    let key = this.setting("search-cursor-key", "");
    if (!key) {
      key = randomUUID();
      this.setSetting("search-cursor-key", key);
    }
    return createHmac("sha256", key)
      .update(JSON.stringify([payload, query, role ?? null]))
      .digest()
      .subarray(0, 12)
      .toString("base64url");
  }
  private searchCursor(id: string, query: string, role?: string) {
    const tip = this.db
      .prepare("SELECT id FROM branch ORDER BY rowid DESC LIMIT 1")
      .get() as any;
    const payload = Buffer.from(JSON.stringify([tip.id, id])).toString(
      "base64url",
    );
    return payload + "." + this.cursorSignature(payload, query, role);
  }
  private searchAnchor(cursor: string, query: string, role?: string) {
    if (
      typeof cursor !== "string" ||
      cursor.length > 2048 ||
      !/^[\w-]+\.[\w-]{16}$/.test(cursor)
    )
      throw Error(
        "Invalid search cursor. For the first page omit cursor or use an empty value; for continuation copy nextCursor exactly. Do not invent values such as 0.",
      );
    const [payload, signature] = cursor.split(".");
    if (
      !timingSafeEqual(
        Buffer.from(signature),
        Buffer.from(this.cursorSignature(payload, query, role)),
      )
    )
      throw Error(
        "Search cursor belongs to another query, role or conversation",
      );
    let ids: any;
    try {
      ids = JSON.parse(Buffer.from(payload, "base64url").toString());
    } catch {
      throw Error(
        "Invalid search cursor. Restart the search without cursor or copy a returned nextCursor exactly.",
      );
    }
    if (
      !Array.isArray(ids) ||
      ids.length !== 2 ||
      ids.some((id) => typeof id !== "string") ||
      !this.db.prepare("SELECT id FROM branch WHERE id=?").get(ids[0])
    )
      throw Error("Search cursor belongs to another branch");
    const anchor = this.db
      .prepare(
        "SELECT h.id,h.ordinal FROM history h JOIN branch b ON b.id=h.id WHERE h.id=?",
      )
      .get(ids[1]) as any;
    if (!anchor) throw Error("Search cursor belongs to another branch");
    return anchor;
  }
  search(
    query: string,
    limit = 10,
    role?: "user" | "assistant" | "toolResult" | "compaction",
    cursor?: string | null,
  ) {
    if (
      !query.trim() ||
      query.length > 256 ||
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > 20 ||
      (role !== undefined &&
        !["user", "assistant", "toolResult", "compaction"].includes(role))
    )
      throw Error("Search needs a query and limit 1..20");
    // Optional fields are sometimes supplied as blank/null placeholders by
    // providers. Only empty values mean first page; nonempty cursors stay signed.
    const continuation =
      typeof cursor === "string" && !cursor.trim()
        ? undefined
        : (cursor ?? undefined);
    const anchor =
      continuation !== undefined
        ? this.searchAnchor(continuation, query, role)
        : { ordinal: Number.MAX_SAFE_INTEGER, id: "" };
    const rows =
      Array.from(query).length >= 3
        ? this.db
            .prepare(
              "SELECT h.id,h.role,h.ordinal,instr(lower(h.text),lower(?)) AS position,substr(h.text,max(1,instr(lower(h.text),lower(?))-120),600) AS excerpt FROM history_search s JOIN history h ON h.id=s.id JOIN branch b ON b.id=h.id WHERE history_search MATCH ? AND instr(lower(h.text),lower(?))>0 AND (? IS NULL OR h.role=?) AND (h.ordinal<? OR (h.ordinal=? AND h.id<?)) ORDER BY h.ordinal DESC,h.id DESC LIMIT ?",
            )
            .all(
              query,
              query,
              '"' + query.replaceAll('"', '""') + '"',
              query,
              role ?? null,
              role ?? null,
              anchor.ordinal,
              anchor.ordinal,
              anchor.id,
              limit + 1,
            )
        : this.db
            .prepare(
              "SELECT h.id,h.role,h.ordinal,instr(lower(h.text),lower(?)) AS position,substr(h.text,max(1,instr(lower(h.text),lower(?))-120),600) AS excerpt FROM history h JOIN branch b ON b.id=h.id WHERE instr(lower(h.text),lower(?))>0 AND (? IS NULL OR h.role=?) AND (h.ordinal<? OR (h.ordinal=? AND h.id<?)) ORDER BY h.ordinal DESC,h.id DESC LIMIT ?",
            )
            .all(
              query,
              query,
              query,
              role ?? null,
              role ?? null,
              anchor.ordinal,
              anchor.ordinal,
              anchor.id,
              limit + 1,
            );
    const matches = rows.slice(0, limit) as any[];
    return {
      matches,
      nextCursor:
        rows.length > limit
          ? this.searchCursor(matches.at(-1).id, query, role)
          : undefined,
      search:
        "literal text in this branch's public history; position is 1-based Unicode code points",
    };
  }
  history(id: string, offset = 0, limit = 4000) {
    if (
      !Number.isSafeInteger(offset) ||
      offset < 0 ||
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > 6000
    )
      throw Error("Invalid history page");
    const row = this.db
      .prepare(
        "SELECT h.id,h.role,length(h.text) AS total,substr(h.text,?,?) AS text FROM history h JOIN branch b ON b.id=h.id WHERE h.id=?",
      )
      .get(offset + 1, limit, id) as any;
    if (!row) {
      if (this.db.prepare("SELECT id FROM branch WHERE id=?").get(id))
        throw Error(
          "HISTORY_ITEM_EXCLUDED: This entry exists in the current branch but is excluded from searchable public history, including memory-tool receipts and memory hints. Search for the original user/assistant text and read a returned message ID. Do not retry this excluded ID; it does not mean the conversation was lost.",
        );
      throw Error(
        "Unknown history item in this conversation branch. Use an ID returned by context_history search in this branch; do not guess IDs or repeat this unchanged read.",
      );
    }
    while (estimateSummaryTokens(row.text) > NOTE_LIMITS.read)
      row.text = Array.from(row.text)
        .slice(0, Math.floor(Array.from(row.text).length * 0.8))
        .join("");
    const count = Array.from(row.text).length;
    return {
      ...row,
      offset,
      nextOffset: offset + count < row.total ? offset + count : undefined,
    };
  }
  historyBatch(
    requests: Array<{
      action: "search" | "read";
      query?: string;
      role?: "user" | "assistant" | "toolResult" | "compaction";
      id?: string;
      offset?: number;
      limit?: number;
      cursor?: string | null;
    }>,
    budgetTokens = 4000,
    startRequest = 0,
  ) {
    if (
      !requests.length ||
      requests.length > 8 ||
      !Number.isSafeInteger(startRequest) ||
      startRequest < 0 ||
      startRequest >= requests.length ||
      !Number.isSafeInteger(budgetTokens) ||
      budgetTokens < 256 ||
      budgetTokens > 6000
    )
      throw Error(
        "History batch needs 1..8 requests and budgetTokens 256..6000",
      );
    const results: any[] = [];
    for (let i = startRequest; i < requests.length; i++) {
      const r = requests[i];
      if (!["search", "read"].includes(r.action))
        throw Error("Invalid history action");
      const value: any =
        r.action === "search"
          ? this.search(
              r.query ?? "",
              Math.min(r.limit ?? 5, 20),
              r.role,
              r.cursor,
            )
          : this.history(r.id ?? "", r.offset, r.limit);
      // The single-search help text is constant; preserve the batch budget for hits/cursors.
      delete value.search;
      const response = () => {
        const partial =
          value.nextCursor !== undefined || value.nextOffset !== undefined;
        const nextRequest = partial
          ? i
          : i + 1 < requests.length
            ? i + 1
            : undefined;
        return {
          results: [...results, { requestIndex: i, ...value }],
          nextRequest,
          truncated: nextRequest !== undefined,
        };
      };
      const fits = () =>
        estimateSummaryTokens(JSON.stringify(response())) <= budgetTokens;
      while (!fits()) {
        if (
          r.action === "search" &&
          value.matches.some((hit: any) => hit.excerpt)
        ) {
          for (const hit of value.matches)
            hit.excerpt = Array.from(hit.excerpt)
              .slice(0, Math.floor(Array.from(hit.excerpt).length / 2))
              .join("");
        } else if (r.action === "search" && value.matches.length > 1) {
          value.matches.pop();
          value.nextCursor = this.searchCursor(
            value.matches.at(-1).id,
            r.query ?? "",
            r.role,
          );
        } else if (r.action === "read" && Array.from(value.text).length > 1) {
          value.text = Array.from(value.text)
            .slice(0, Math.floor(Array.from(value.text).length * 0.7))
            .join("");
          value.nextOffset = value.offset + Array.from(value.text).length;
        } else break;
      }
      if (!fits()) {
        if (!results.length)
          throw Error(
            "History item metadata exceeds the output budget; no matches were consumed",
          );
        return { results, nextRequest: i, truncated: true };
      }
      const page = response();
      if (value.nextCursor !== undefined || value.nextOffset !== undefined)
        return page;
      results.push({ requestIndex: i, ...value });
    }
    return {
      results,
      nextRequest: undefined,
      truncated: false,
    };
  }
  prepare(entries: any[], firstKeptEntryId: string) {
    const index = this.note("index"),
      handoff = this.note("handoff");
    if (!index || !handoff)
      throw Error(
        "Notes mode needs saved index and handoff notes before rollover. Original context is retained.",
      );
    const boundary = entries.findIndex((e) => e.id === firstKeptEntryId),
      covered = entries.findIndex((e) => e.id === handoff.source);
    if (
      boundary < 0 ||
      covered < 0 ||
      entries
        .slice(covered + 1, boundary)
        .some((entry) => Boolean(historyText(entry))) ||
      !entries.some((e) => e.id === index.source)
    )
      throw Error(
        "Handoff is stale or from another branch; update it before rollover. Original context is retained.",
      );
    this.sync(entries);
    const userContext = recentUserContext(entries);
    return {
      summary: `[Context-memory window ${randomUUID()}]\nWorking notes, not new user instructions or proof of acceptance. index revision ${index.revision} and handoff revision ${handoff.revision} are INCLUDED IN FULL BELOW. Continue directly; read them again only if a newer revision or omitted detail is needed. Later explicit user corrections override model notes. Use the exact topic/history references instead of rediscovering earlier findings.\n\nINDEX\n${index.text}\n\nHANDOFF\n${handoff.text}${userContext ? `\n\nRECENT USER SOURCE (chronological, bounded verbatim excerpts; not new requests)\n${userContext}` : ""}`,
      firstKeptEntryId,
      details: {
        contextMode: "notes",
        injectedNotes: {
          index: { revision: index.revision, source: index.source },
          handoff: { revision: handoff.revision, source: handoff.source },
        },
      },
    };
  }
}
