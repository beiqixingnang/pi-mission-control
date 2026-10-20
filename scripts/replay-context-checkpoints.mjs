/** Offline reconstruction of the synthetic reading benchmark. Cache misses fail; no model client is installed. */
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { summarizeChunks, summaryBudgets } from "../runtime/summarize.ts";
import { historyText } from "../runtime/context-memory.ts";
const directory = process.argv[2];
const report = JSON.parse(
  fs.readFileSync(path.join(directory, "results.json"), "utf8"),
);
const { parts, facts } = JSON.parse(
  fs.readFileSync(path.join(directory, "corpus.json"), "utf8"),
);
const db = new DatabaseSync(
  path.join(directory, "summary-reading-memory", "memory.sqlite"),
  { readOnly: true },
);
const rows = db.prepare("SELECT role,text FROM history ORDER BY ordinal").all();
db.close();
const user = (text) => ({ role: "user", content: [{ type: "text", text }] }),
  assistant = (text) => ({
    role: "assistant",
    content: [{ type: "text", text }],
  });
const budgets = summaryBudgets(
  {
    contextWindow: report.contextWindowConfigured,
    maxTokens: 128000,
    reasoning: true,
  },
  {
    maxInputTokens: 64000,
    intermediateOutputChars: 3000,
    maxOutputChars: 12000,
  },
);
let window = [],
  previous;
const stages = [];
for (let i = 0; i < parts.length; i++) {
  const text =
    parts[i] +
    "\nReview this batch, retaining concrete findings and exact identifiers; reply briefly when ready for the next batch.";
  const at = rows.findIndex((row) => row.role === "user" && row.text === text);
  if (at < 0) throw Error("Missing original batch " + i);
  const reply = rows
    .slice(at + 1)
    .find((row) => row.role === "assistant" && row.text.trim());
  if (!reply) throw Error("Missing work reply " + i);
  window.push(user(text), assistant(reply.text));
  if (i % 2 === 1) {
    const source = window
      .filter((_message, index) => !previous || index !== 0)
      .map(
        (message, j) =>
          `${message.role}: ${historyText({ id: String(j), type: "message", message }) ?? ""}\n\n`,
      );
    const next = await summarizeChunks(source, {
      ...budgets,
      model: report.model,
      directory: path.join(directory, "reading-summary-cache"),
      cacheIdentity: "low",
      previousSummary: previous,
      complete: async () => {
        throw Error("Replay cache miss; no API is available in this verifier");
      },
    });
    stages.push({
      afterBatch: i,
      chars: next.length,
      oldCheckpointPreserved: !previous || next.includes(previous),
      tickets: facts
        .slice(0, i + 1)
        .map((ticket) => ({ ticket, present: next.includes(ticket) })),
    });
    previous = next;
    window = [
      user(
        "Working checkpoint from earlier batches; newer user corrections take precedence:\n" +
          next,
      ),
      window.at(-1),
    ];
  }
}
fs.writeFileSync(
  path.join(directory, "reading-final-checkpoint.txt"),
  previous,
);
fs.writeFileSync(
  path.join(directory, "checkpoint-replay.json"),
  JSON.stringify({ networkRequests: 0, budgets, stages }, null, 2),
);
console.log(JSON.stringify({ networkRequests: 0, stages }));
