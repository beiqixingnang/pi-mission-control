/** Opt-in live benchmark; never run by npm test. Only synthetic history is sent.
 * --models FILE --auth FILE --tokenizer FILE --output DIR [--phase capacity|summary|notes|reading|retrieval|all]
 * The tokenizer is an external gpt-tokenizer/esm/encoding/o200k_base.js installation.
 * Its counts are estimates for this custom model route; provider usage is recorded separately.
 */
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";
import { hostDir } from "./host.mjs";
import {
  summarizeChunks,
  summaryBudgets,
  SUMMARY_SYSTEM_PROMPT,
} from "../runtime/summarize.ts";
import { ContextMemory, historyText } from "../runtime/context-memory.ts";

const args = Object.fromEntries(
  process.argv
    .slice(2)
    .reduce(
      (pairs, arg, i, all) =>
        arg.startsWith("--") ? [...pairs, [arg.slice(2), all[i + 1]]] : pairs,
      [],
    ),
);
for (const key of ["models", "auth", "tokenizer", "output"])
  if (!args[key]) throw Error(`Missing --${key}`);
const output = path.resolve(args.output);
fs.mkdirSync(output, { recursive: true });
const { encode, decode } = await import(
  pathToFileURL(path.resolve(args.tokenizer))
);
const { ModelRuntime } = await import(
  pathToFileURL(path.join(hostDir, "dist/index.js"))
);
const runtime = await ModelRuntime.create({
  modelsPath: path.resolve(args.models),
  authPath: path.resolve(args.auth),
  modelsStorePath: path.join(output, "models-store.json"),
  refreshOnCreate: false,
  allowModelNetwork: false,
});
const model = runtime.getModel("gptcodex", "gpt-6-luna");
if (!model)
  throw Error("The configured gptcodex/gpt-6-luna route is unavailable");
const reportFile = path.join(output, "results.json");
const report = fs.existsSync(reportFile)
  ? JSON.parse(fs.readFileSync(reportFile, "utf8"))
  : {
      startedAt: new Date().toISOString(),
      model: "gptcodex/gpt-6-luna",
      platform: process.platform,
      contextWindowConfigured: model.contextWindow,
      tokenizer:
        "o200k_base estimate; actual provider usage stored per request",
      requests: [],
    };
const save = () =>
  fs.writeFileSync(reportFile, JSON.stringify(report, null, 2) + "\n");
const textOf = (m) =>
  m.content
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("\n");
async function request(label, messages, extra = {}) {
  const started = Date.now();
  console.log(
    JSON.stringify({
      event: "request",
      label,
      chars: messages.reduce((n, m) => n + JSON.stringify(m.content).length, 0),
    }),
  );
  const record = { label, startedAt: new Date().toISOString() };
  report.requests.push(record);
  save();
  try {
    const result = await runtime.complete(
      model,
      { messages, ...(extra.tools ? { tools: extra.tools } : {}) },
      {
        maxTokens: extra.maxTokens ?? 16384,
        reasoningEffort: "low",
        cacheRetention: "none",
        maxRetries: 0,
        signal: extra.signal ?? AbortSignal.timeout(300000),
      },
    );
    Object.assign(record, {
      elapsedMs: Date.now() - started,
      usage: result.usage,
      stopReason: result.stopReason,
      rawStopReason: result.rawStopReason,
      error: result.errorMessage,
      visibleChars: textOf(result).length,
    });
    save();
    console.log(JSON.stringify({ event: "response", label, ...record }));
    if (
      result.errorMessage ||
      ["error", "aborted", "length"].includes(result.stopReason)
    )
      throw Error(result.errorMessage ?? result.stopReason);
    return result;
  } catch (error) {
    Object.assign(record, {
      elapsedMs: Date.now() - started,
      error: String(error.message),
    });
    save();
    throw error;
  }
}
const user = (text) => ({
  role: "user",
  content: [{ type: "text", text }],
  timestamp: Date.now(),
});
const system = (text) => ({ role: "system", content: text, timestamp: 0 });

let parts, facts;
const corpusFile = path.join(output, "corpus.json");
if (fs.existsSync(corpusFile))
  ({ parts, facts } = JSON.parse(fs.readFileSync(corpusFile, "utf8")));
else {
  parts = [];
  facts = [];
  let seed = 17423;
  const rand = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) | 0;
    return seed >>> 0;
  };
  for (let batch = 0; batch < 8; batch++) {
    const ticket = `AUDIT-${batch}-${rand().toString(16)}`;
    facts.push(ticket);
    const header = `User's review objective: inspect every listed module. Preserve audit tickets, corrections, exact continuation and unverified status in memory. This is synthetic code-review history.\nBatch ${batch}; audit ticket ${ticket}; findings are not accepted yet.\n`;
    const modules = [];
    let tokens = encode(header).length,
      file = 0;
    while (tokens < 121000) {
      const name = `src/stage_${batch}/decoder_${file++}.ts`,
        n = (rand() % 300) + 7;
      const lines = [
        `// ${name}; reviewed range 1..90; audit ticket ${ticket}`,
        `export function decode_${batch}_${file}(values: number[], index: number, mode: number) {`,
        `  // Check: index === values.length is not a valid element.`,
        `  if (index <= values.length && mode === ${n % 5}) return values[index];`,
        `  let result = ${n};`,
      ];
      for (let k = 0; k < 75; k++) {
        const a = rand() % 65536,
          b = rand() % 999,
          c = rand() % 31;
        lines.push(
          `  if (mode === ${a}) result = (result + ${b}) ^ ((index >>> ${c}) & ${rand() % 255}); // branch ${batch}_${file}_${k}`,
        );
      }
      lines.push("  return result;", "}", "");
      const module = lines.join("\n");
      modules.push(module);
      tokens += encode(module).length;
    }
    let text = header + modules.join("\n");
    if (batch === 0)
      text += "\nInitial goal ID was e2dbb408-9ea9-4698-9832-b1a6b0e69339.\n";
    if (batch === 4)
      text +=
        "\nUSER CORRECTION: use e2dbb408-9ea9-469b-9832-b1a6b0e69339, revision 1; the earlier 4698 spelling was wrong.\n";
    if (batch === 7)
      text +=
        "\nCURRENT CONTINUATION: next inspect src/stage_7/decoder_7.ts at line 173. Do not run tests, reload or stop the production hardware Pi conversation. No audit acceptance has been granted.\n";
    parts.push(text);
  }
  fs.writeFileSync(corpusFile, JSON.stringify({ parts, facts }));
}
const corpus = parts.join("\n\n"),
  encoded = encode(corpus);
Object.assign(report, {
  corpusChars: corpus.length,
  corpusEstimatedTokens: encoded.length,
  batches: parts.map((p) => ({
    chars: p.length,
    estimatedTokens: encode(p).length,
  })),
});
save();
const questions =
  "Return JSON only with all eight audit tickets, the corrected goal ID and revision, exact next file and line, whether the audit has been accepted, and which production conversation must not be touched. Use context_history to retrieve details missing from your notes.";
function score(text) {
  const checks = {
    ...Object.fromEntries(
      facts.map((fact, i) => [`batch${i}`, text.includes(fact)]),
    ),
    correctedId:
      text.includes("e2dbb408-9ea9-469b-9832-b1a6b0e69339") &&
      !text.includes("e2dbb408-9ea9-4698-9832-b1a6b0e69339"),
    revision: /"[^"]*revision"\s*:\s*1\b/i.test(text),
    nextFile: text.includes("src/stage_7/decoder_7.ts"),
    nextLine: /\b173\b/.test(text),
    acceptance:
      /false|not accepted|not been accepted|unaccepted|未.*验收/i.test(text),
    production: /hardware|production|硬件/i.test(text),
  };
  return {
    passed: Object.values(checks).filter(Boolean).length,
    total: Object.keys(checks).length,
    checks,
  };
}
const phase = args.phase ?? "all";
if (phase === "reading" && report.readingComparison) {
  (report.readingAttempts ??= []).push(report.readingComparison);
  delete report.readingComparison;
  save();
}
for (const round of [report.summary ?? [], ...(report.summaryAttempts ?? [])])
  for (const result of round)
    if (result.answer) result.score = score(result.answer);
for (const result of [
  report.notes,
  report.readingComparison,
  ...(report.notesAttempts ?? []),
])
  if (result?.answer) result.score = score(result.answer);
if (args["retry-summary"] === "true" && report.summary) {
  (report.summaryAttempts ??= []).push(report.summary);
  delete report.summary;
  save();
}
if (args["retry-notes"] === "true" && report.notes) {
  (report.notesAttempts ??= []).push(report.notes);
  delete report.notes;
  save();
}
if (["all", "capacity"].includes(phase)) {
  report.capacity ??= [];
  for (const size of [128000, 512000, 768000, 900000, 950000, encoded.length]) {
    if (report.capacity.some((r) => r.estimatedTokens === size)) continue;
    try {
      const input = decode(encoded.slice(0, size));
      const result = await request(
        `capacity-${size}`,
        [
          system(
            "Read the supplied synthetic history. Return only CAPACITY_OK and the first and last visible audit tickets.",
          ),
          user(input),
        ],
        { maxTokens: 2048 },
      );
      report.capacity.push({
        estimatedTokens: size,
        success: true,
        text: textOf(result),
        usage: result.usage,
      });
      save();
    } catch (error) {
      report.capacity.push({
        estimatedTokens: size,
        success: false,
        error: error.message,
      });
      save();
      break;
    }
  }
}
if (["all", "summary"].includes(phase) && !report.summary) {
  report.summary = [];
  for (const inputTokens of [64000, 128000]) {
    const budgets = summaryBudgets(model, {
      maxInputTokens: inputTokens,
      intermediateOutputChars: 3000,
      maxOutputChars: 12000,
    });
    const started = Date.now(),
      before = report.requests.length;
    try {
      const summary = await summarizeChunks(parts, {
        ...budgets,
        model: report.model,
        directory: path.join(output, "summary-cache"),
        cacheIdentity: "low",
        requestTimeoutMs: 300000,
        retryBudget: { remaining: 1, used: 0 },
        complete: (prompt, signal, options) =>
          request(
            `summary-${inputTokens}-${options.phase}`,
            [system(SUMMARY_SYSTEM_PROMPT), user(prompt)],
            { signal, maxTokens: budgets.maxTokens },
          ),
      });
      fs.writeFileSync(
        path.join(output, `summary-${inputTokens}.txt`),
        summary,
      );
      const answer = textOf(
        await request(`summary-${inputTokens}-recall`, [
          system(
            "Answer from the factual checkpoint. Do not invent missing details.",
          ),
          user(summary + "\n\n" + questions),
        ]),
      );
      report.summary.push({
        inputTokens,
        budgets,
        success: score(answer).passed === score(answer).total,
        elapsedMs: Date.now() - started,
        requests: report.requests.length - before,
        summaryChars: summary.length,
        summaryEstimatedTokens: encode(summary).length,
        answer,
        score: score(answer),
      });
    } catch (error) {
      report.summary.push({
        inputTokens,
        success: false,
        elapsedMs: Date.now() - started,
        error: error.message,
      });
    }
    save();
  }
}
if (["all", "notes"].includes(phase) && !report.notes) {
  const m = new ContextMemory(
    path.join(output, `notes-memory-${report.notesAttempts?.length ?? 0}`),
    "synthetic-notes-benchmark",
  );
  const entries = [],
    events = [];
  let window = [],
    rollovers = 0;
  const append = (message) => {
    const item = { id: randomUUID(), type: "message", message };
    entries.push(item);
    window.push(message);
    return item;
  };
  const tools = [
    {
      name: "context_note",
      description:
        "Write or read a virtual working note; keep index under 1500 estimated tokens, handoff under 4000. Update existing notes rather than append. Writes return receipts. Put detail in topic notes.",
      parameters: {
        type: "object",
        properties: {
          action: { type: "string", enum: ["write", "read", "list"] },
          name: { type: "string" },
          text: { type: "string" },
        },
        required: ["action"],
      },
    },
    {
      name: "context_history",
      description:
        "Search/read original public history from earlier context windows. Use literal query search to find omitted audit records. Read a returned id to recover exact details.",
      parameters: {
        type: "object",
        properties: {
          action: { type: "string", enum: ["search", "read"] },
          query: { type: "string" },
          id: { type: "string" },
          offset: { type: "integer" },
        },
        required: ["action"],
      },
    },
    {
      name: "context_rollover",
      description:
        "Save virtual notes with the exact names index and handoff first, then call this tool to install a fresh context window. Topic notes alone are insufficient. Original public history remains searchable. A statement that you are ready does not roll the window.",
      parameters: { type: "object", properties: {} },
    },
  ];
  const instructions = system(
    "You are reviewing synthetic source code in a notes-based memory benchmark. Process each supplied batch. Record concrete findings and exact audit tickets with context_note. The active user correction overrides older records. No audit has been accepted. Use concise index (500-1000 tokens) and handoff (1500-3000 tokens only if needed); keep topic notes local and retrieve details using history. The exact required note names are index and handoff. Topic notes cannot replace them. Write your own notes; no prepared notes are supplied. When asked to roll over, save index and handoff and call context_rollover, rather than merely saying ready. After rollover continue the user's next batch. Do not repeatedly rewrite unchanged notes. Do not claim completion of an audit merely because a note was saved.",
  );
  async function run(label) {
    for (let step = 0; step < 14; step++) {
      const result = await request(
        `${label}-${step}`,
        [instructions, ...window],
        { tools, maxTokens: 10000 },
      );
      append(result);
      const calls = result.content.filter((b) => b.type === "toolCall");
      if (!calls.length) return textOf(result);
      let roll = false;
      const source = entries.at(-1).id;
      for (const call of calls) {
        let data,
          isError = false;
        try {
          const a = call.arguments;
          if (call.name === "context_note")
            data =
              a.action === "write"
                ? m.write(a.name, a.text, source)
                : a.action === "read"
                  ? m.read(a.name)
                  : m.list();
          else if (call.name === "context_history") {
            m.sync(entries);
            data =
              a.action === "search"
                ? m.search(a.query)
                : m.history(a.id, a.offset);
          } else if (call.name === "context_rollover") {
            if (!m.note("index") || !m.note("handoff"))
              throw Error(
                "Save the required index and handoff notes first; the original context is retained.",
              );
            roll = true;
            data = { queued: true };
          } else throw Error("Unknown tool");
        } catch (error) {
          isError = true;
          data = { error: error.message };
        }
        events.push({
          tool: call.name,
          args:
            call.name === "context_note"
              ? {
                  action: call.arguments.action,
                  name: call.arguments.name,
                  chars: call.arguments.text?.length,
                }
              : call.arguments,
          result: data,
        });
        append({
          role: "toolResult",
          toolCallId: call.id,
          toolName: call.name,
          content: [{ type: "text", text: JSON.stringify(data) }],
          isError,
          timestamp: Date.now(),
        });
      }
      if (roll) {
        const handoff = m.note("handoff");
        if (!handoff) continue;
        const sourceIndex = entries.findIndex((e) => e.id === handoff.source);
        // Keep the tool-call boundary intact; the live TUI separately tests Pi's native cut point.
        const prepared = m.prepare(entries, entries[sourceIndex].id);
        window = [
          user(prepared.summary),
          ...entries.slice(sourceIndex).map((e) => e.message),
        ];
        rollovers++;
        return "ROLLED_OVER";
      }
    }
    throw Error("Model exceeded the bounded per-batch tool loop");
  }
  const started = Date.now(),
    before = report.requests.length;
  try {
    m.setMode("notes");
    for (let i = 0; i < parts.length; i++) {
      append(
        user(
          parts[i] +
            (i % 2 === 1
              ? "\nReview this batch, update notes, then call context_rollover."
              : "\nReview this batch and update concise working notes. Reply briefly when ready for the next batch."),
        ),
      );
      await run(`notes-batch-${i}`);
      if (i % 2 === 1) {
        for (
          let reminder = 0;
          rollovers < Math.floor((i + 1) / 2) && reminder < 2;
          reminder++
        ) {
          append(
            user(
              "Before the next batch, complete the requested context rollover now. Save current context_note notes named exactly index and handoff, then call context_rollover. Do not merely report ready.",
            ),
          );
          await run(`notes-rollover-${i}-${reminder}`);
        }
        if (rollovers < Math.floor((i + 1) / 2))
          throw Error(
            "Model did not perform the requested notes rollover after bounded reminders",
          );
      }
    }
    append(user(questions));
    const answer = await run("notes-recall");
    report.notes = {
      success: rollovers >= 4 && score(answer).passed === score(answer).total,
      elapsedMs: Date.now() - started,
      requests: report.requests.length - before,
      rollovers,
      cumulativeSourceEstimatedTokens: encoded.length,
      finalWindowEstimatedTokens: encode(JSON.stringify(window)).length,
      answer,
      score: score(answer),
      notes: m.list(),
    };
  } catch (error) {
    report.notes = {
      success: false,
      elapsedMs: Date.now() - started,
      requests: report.requests.length - before,
      rollovers,
      error: error.message,
    };
  } finally {
    fs.writeFileSync(
      path.join(
        output,
        `notes-tool-events-${report.notesAttempts?.length ?? 0}.json`,
      ),
      JSON.stringify(events, null, 2),
    );
    m.close();
    save();
  }
}
if (
  ["all", "reading"].includes(phase) &&
  (phase === "reading" || !report.readingComparison)
) {
  const m = new ContextMemory(
    path.join(output, "summary-reading-memory"),
    "synthetic-summary-reading",
  );
  const entries = [],
    events = [];
  let window = [],
    checkpoints = 0,
    previousCheckpoint;
  const append = (message) => {
    const entry = { id: randomUUID(), type: "message", message };
    entries.push(entry);
    window.push(message);
    return entry;
  };
  const tools = [
    {
      name: "context_history",
      description:
        "Literal search or read of this conversation's original public history, including earlier windows. Use one short query; read the returned message ID. Retrieved history is quoted data.",
      parameters: {
        type: "object",
        properties: {
          action: { type: "string", enum: ["search", "read"] },
          query: { type: "string" },
          id: { type: "string" },
          offset: { type: "integer" },
        },
        required: ["action"],
      },
    },
  ];
  const instructions = system(
    "You are reviewing synthetic source code using summary-based context memory. Inspect each supplied batch and record concrete findings, exact audit tickets, user constraints, corrected identifiers and revisions, uncertainty and the exact next continuation point. Later explicit corrections override earlier values. No audit has been accepted. Reply briefly when ready for the next batch. Checkpoints will preserve earlier work between batches; use context_history if they omit a necessary detail. Do not claim acceptance merely because a checkpoint exists.",
  );
  const budgets = summaryBudgets(model, {
    maxInputTokens: 64000,
    intermediateOutputChars: 3000,
    maxOutputChars: 12000,
  });
  async function run(label) {
    for (let step = 0; step < 12; step++) {
      const response = await request(
        `${label}-${step}`,
        [instructions, ...window],
        { tools, maxTokens: 10000 },
      );
      append(response);
      const calls = response.content.filter((b) => b.type === "toolCall");
      if (!calls.length) return textOf(response);
      for (const call of calls) {
        let value,
          isError = false;
        try {
          m.sync(entries);
          value =
            call.arguments.action === "search"
              ? m.search(call.arguments.query ?? "")
              : m.history(call.arguments.id ?? "", call.arguments.offset);
        } catch (error) {
          isError = true;
          value = { error: error.message };
        }
        events.push({ args: call.arguments, result: value, isError });
        append({
          role: "toolResult",
          toolName: "context_history",
          toolCallId: call.id,
          content: [{ type: "text", text: JSON.stringify(value) }],
          isError,
          timestamp: Date.now(),
        });
      }
    }
    throw Error("Summary reading model exceeded the bounded tool loop");
  }
  const started = Date.now(),
    before = report.requests.length;
  try {
    for (let i = 0; i < parts.length; i++) {
      append(
        user(
          parts[i] +
            "\nReview this batch, retaining concrete findings and exact identifiers; reply briefly when ready for the next batch.",
        ),
      );
      await run(`reading-work-${i}`);
      if (i % 2 === 1) {
        const source = window
          .filter((_message, index) => !previousCheckpoint || index !== 0)
          .map(
            (message, j) =>
              `${message.role}: ${historyText({ id: String(j), type: "message", message }) ?? ""}\n\n`,
          );
        const summary = await summarizeChunks(source, {
          ...budgets,
          model: report.model,
          directory: path.join(output, "reading-summary-cache"),
          cacheIdentity: "low",
          previousSummary: previousCheckpoint,
          requestTimeoutMs: 300000,
          retryBudget: { remaining: 1, used: 0 },
          complete: (prompt, signal, options) =>
            request(
              `reading-summary-${i}-${options.phase}`,
              [system(SUMMARY_SYSTEM_PROMPT), user(prompt)],
              { signal, maxTokens: budgets.maxTokens },
            ),
        });
        previousCheckpoint = summary;
        window = [
          user(
            "Working checkpoint from earlier batches; newer user corrections take precedence:\n" +
              summary,
          ),
          window.at(-1),
        ];
        checkpoints++;
      }
    }
    append(user(questions));
    const answer = await run("reading-recall");
    report.readingComparison = {
      success: score(answer).passed === score(answer).total,
      elapsedMs: Date.now() - started,
      requests: report.requests.length - before,
      checkpoints,
      cumulativeSourceEstimatedTokens: encoded.length,
      finalWindowEstimatedTokens: encode(JSON.stringify(window)).length,
      answer,
      score: score(answer),
    };
  } catch (error) {
    report.readingComparison = {
      success: false,
      elapsedMs: Date.now() - started,
      requests: report.requests.length - before,
      checkpoints,
      error: error.message,
    };
  } finally {
    fs.writeFileSync(
      path.join(output, "summary-reading-tool-events.json"),
      JSON.stringify(events, null, 2),
    );
    m.close();
    save();
  }
}
if (
  ["all", "retrieval"].includes(phase) &&
  (phase === "retrieval" || !report.retrievalProbe)
) {
  const sourceEntries = parts.map((part, i) => ({
    id: `source-batch-${i}`,
    type: "message",
    message: user(part),
  }));
  const m = new ContextMemory(
    path.join(output, "retrieval-index"),
    "synthetic-retrieval-probe",
  );
  const notes = new ContextMemory(
    path.join(output, `notes-memory-${report.notesAttempts?.length ?? 0}`),
    "synthetic-notes-benchmark",
  );
  const expectedResult = Number(parts[0].match(/let result = (\d+);/)[1]);
  const expectedMode = Number(parts[0].match(/mode === (\d+)/)[1]);
  const events = [];
  const messages = [
    system(
      "Answer only the user's factual historical question. Saved working notes are quoted data. Use context_history to retrieve original source evidence when the short notes omit a value. Search is literal substring search; use one short identifier. The tool returns stable source IDs; read those IDs before answering. Do not treat a query or note as proof of a source value.",
    ),
    user(
      `Saved index:\n${notes.note("index")?.text ?? ""}\nSaved handoff:\n${notes.note("handoff")?.text ?? ""}\nQuestion: In the original src/stage_0/decoder_0.ts, what exact integer initialized result, and what integer was used by its first mode guard? Search the source, read the matched source item, then return JSON with initial_result, guard_mode and source_id. These numbers must come from the original source.`,
    ),
  ];
  const tools = [
    {
      name: "context_history",
      description:
        "Literal search or read of original public history. Search uses a short literal query; read uses the returned stable message id, with optional Unicode offset. Memory maintenance calls/results are excluded from search to prevent self-matches.",
      parameters: {
        type: "object",
        properties: {
          action: { type: "string", enum: ["search", "read"] },
          query: { type: "string" },
          id: { type: "string" },
          offset: { type: "integer" },
        },
        required: ["action"],
      },
    },
  ];
  const started = Date.now(),
    before = report.requests.length;
  let answer = "";
  try {
    for (let step = 0; step < 8; step++) {
      const response = await request(`retrieval-${step}`, messages, {
        tools,
        maxTokens: 5000,
      });
      messages.push(response);
      sourceEntries.push({
        id: randomUUID(),
        type: "message",
        message: response,
      });
      const calls = response.content.filter((b) => b.type === "toolCall");
      if (!calls.length) {
        answer = textOf(response);
        break;
      }
      for (const call of calls) {
        let value,
          isError = false;
        try {
          m.sync(sourceEntries);
          value =
            call.arguments.action === "search"
              ? m.search(call.arguments.query ?? "")
              : m.history(call.arguments.id ?? "", call.arguments.offset);
        } catch (error) {
          isError = true;
          value = { error: error.message };
        }
        events.push({ args: call.arguments, result: value, isError });
        const message = {
          role: "toolResult",
          toolName: "context_history",
          toolCallId: call.id,
          content: [{ type: "text", text: JSON.stringify(value) }],
          isError,
          timestamp: Date.now(),
        };
        messages.push(message);
        sourceEntries.push({ id: randomUUID(), type: "message", message });
      }
    }
    let parsed;
    try {
      parsed = JSON.parse(answer);
    } catch {}
    report.retrievalProbe = {
      success:
        parsed?.initial_result === expectedResult &&
        parsed?.guard_mode === expectedMode &&
        events.some(
          (e) => e.args.action === "read" && e.result.id === "source-batch-0",
        ),
      elapsedMs: Date.now() - started,
      requests: report.requests.length - before,
      expected: {
        initial_result: expectedResult,
        guard_mode: expectedMode,
        source_id: "source-batch-0",
      },
      answer,
      events,
    };
  } catch (error) {
    report.retrievalProbe = { success: false, error: error.message, events };
  } finally {
    m.close();
    notes.close();
    save();
  }
}
report.updatedAt = new Date().toISOString();
save();
console.log(
  JSON.stringify(
    {
      output: reportFile,
      capacity: report.capacity,
      summary: report.summary,
      notes: report.notes,
      readingComparison: report.readingComparison,
    },
    null,
    2,
  ),
);
