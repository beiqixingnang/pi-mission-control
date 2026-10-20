/** Read-only Pi usage audit. No request bodies, credentials, reasoning or runtime instantiation. */
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { DatabaseSync } from "node:sqlite";

const args = Object.fromEntries(
  process.argv
    .slice(2)
    .reduce(
      (out, arg, i, all) =>
        arg.startsWith("--") ? [...out, [arg.slice(2), all[i + 1]]] : out,
      [],
    ),
);
for (const key of ["state-dir", "session-file", "since", "until", "output"])
  if (!args[key]) throw Error("Missing --" + key);
const since = Date.parse(args.since),
  until = Date.parse(args.until);
if (!Number.isFinite(since) || !Number.isFinite(until) || until <= since)
  throw Error("Invalid audit interval");
const state = path.resolve(args["state-dir"]),
  sources = new Map([[path.resolve(args["session-file"]), "lead"]]);
const db = new DatabaseSync(path.join(state, "state.sqlite"), {
  readOnly: true,
});
db.exec("PRAGMA query_only=ON;BEGIN");
const tasks = db
  .prepare("SELECT data FROM tasks")
  .all()
  .map((r) => JSON.parse(r.data));
db.exec("COMMIT");
db.close();
for (const t of tasks)
  if (
    t.sessionFile &&
    fs.existsSync(t.sessionFile) &&
    fs.statSync(t.sessionFile).mtimeMs >= since
  )
    sources.set(path.resolve(t.sessionFile), t.member);
const requests = [],
  seen = new Set(),
  groups = new Map();
for (const [file, member] of sources) {
  const bytes = fs.statSync(file).size;
  if (!bytes) continue;
  let window, latestMode;
  for await (const line of readline.createInterface({
    input: fs.createReadStream(file, { end: bytes - 1 }),
    crlfDelay: Infinity,
  })) {
    let e;
    try {
      e = JSON.parse(line);
    } catch {
      continue;
    }
    if (e.type === "compaction") {
      window = e.timestamp;
      latestMode = e.details?.contextMode ?? "summary";
      continue;
    }
    const m = e.message;
    if (e.type !== "message" || m?.role !== "assistant") continue;
    const at = Date.parse(e.timestamp);
    if (at < since || at > until) continue;
    const u = m.usage ?? {},
      input = u.input ?? 0,
      cache = u.cacheRead ?? 0,
      output = u.output ?? 0;
    if (!input && !cache && !output) continue;
    const key = JSON.stringify([
      e.id,
      m.timestamp,
      m.provider,
      m.model,
      input,
      cache,
      output,
    ]);
    if (seen.has(key)) continue;
    seen.add(key);
    const request = {
      at: e.timestamp,
      member,
      model: m.model,
      input,
      cache,
      output,
      hitPercent:
        input + cache
          ? Math.round((cache / (input + cache)) * 10000) / 100
          : undefined,
      lastWindow: window,
      windowMode: latestMode,
    };
    requests.push(request);
    const groupKey = member + "/" + m.model,
      g = groups.get(groupKey) ?? {
        member,
        model: m.model,
        requests: 0,
        input: 0,
        cache: 0,
        output: 0,
        largeColdRequests: 0,
        largeColdInput: 0,
      };
    g.requests++;
    g.input += input;
    g.cache += cache;
    g.output += output;
    if (input + cache >= 200000 && cache / (input + cache) < 0.05) {
      g.largeColdRequests++;
      g.largeColdInput += input;
    }
    groups.set(groupKey, g);
  }
}
requests.sort((a, b) => a.at.localeCompare(b.at));
const totals = [...groups.values()].reduce(
  (a, g) => ({
    requests: a.requests + g.requests,
    input: a.input + g.input,
    cache: a.cache + g.cache,
    output: a.output + g.output,
  }),
  { requests: 0, input: 0, cache: 0, output: 0 },
);
const result = {
  capturedAt: new Date().toISOString(),
  since: args.since,
  until: args.until,
  scope:
    "Only persisted Pi assistant usage in this session and its members; not the entire gateway account. input excludes cacheRead in Pi's normalized usage. Ratios are token-weighted, not averages of request percentages. No inference about gateway routing or billing beyond these receipts.",
  totals: {
    ...totals,
    hitPercent:
      Math.round((totals.cache / (totals.input + totals.cache)) * 10000) / 100,
  },
  groups: [...groups.values()].map((g) => ({
    ...g,
    hitPercent: Math.round((g.cache / (g.input + g.cache)) * 10000) / 100,
  })),
  screenshotMatches: requests.filter(
    (r) =>
      [869363, 872405, 4063, 19268, 15709, 21076, 7380].includes(r.input) &&
      r.at > "2026-10-20T09:03:00Z" &&
      r.at < "2026-10-20T09:06:00Z",
  ),
  requests,
};
fs.writeFileSync(args.output, JSON.stringify(result, null, 2) + "\n", {
  flag: "wx",
});
console.log(JSON.stringify({ ...result, requests: undefined }, null, 2));
