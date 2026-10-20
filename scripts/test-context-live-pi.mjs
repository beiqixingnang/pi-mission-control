/** Opt-in live Pi test, synthetic source only. Reuses the dedicated WSL test conversation.
 * PI_CODING_AGENT_DIR=TEST_HOME/agent node --experimental-strip-types scripts/test-context-live-pi.mjs
 * --models FILE --auth FILE --test-home DIR --output DIR
 * Credentials are read by Pi directly from the supplied configuration, never copied or logged.
 */
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { hostDir } from "./host.mjs";
import { estimateSummaryTokens } from "../runtime/summarize.ts";
const args = Object.fromEntries(
  process.argv
    .slice(2)
    .reduce(
      (all, arg, i, rest) =>
        arg.startsWith("--") ? [...all, [arg.slice(2), rest[i + 1]]] : all,
      [],
    ),
);
for (const key of ["models", "auth", "test-home", "output"])
  if (!args[key]) throw Error("Missing --" + key);
const home = path.resolve(args["test-home"]),
  agentDir = path.join(home, "agent"),
  cwd = path.join(home, "workspace"),
  output = path.resolve(args.output);
if (path.resolve(process.env.PI_CODING_AGENT_DIR ?? "") !== agentDir)
  throw Error("Run only with the dedicated test agent directory");
const identity = JSON.parse(
  fs.readFileSync(path.join(home, "test-session.json"), "utf8"),
);
if (!path.resolve(identity.sessionFile).startsWith(agentDir + path.sep))
  throw Error("Unexpected test session path");
fs.mkdirSync(output, { recursive: true });
const lock = path.join(home, "live-context-test.lock");
const {
  ModelRuntime,
  createAgentSession,
  DefaultResourceLoader,
  SessionManager,
  SettingsManager,
} = await import(pathToFileURL(path.join(hostDir, "dist/index.js")));
const { Type } = await import(
  pathToFileURL(path.join(hostDir, "node_modules/typebox/build/index.mjs"))
);
const lockFd = fs.openSync(lock, "wx");
fs.writeFileSync(lockFd, String(process.pid));
const started = Date.now(),
  report = {
    startedAt: new Date().toISOString(),
    model: "gptcodex/gpt-6-luna",
    sessionId: identity.id,
    requests: [],
    tools: [],
    phases: [],
    files: [],
    checks: {},
  };
const save = () =>
  fs.writeFileSync(
    path.join(output, "results.json"),
    JSON.stringify(report, null, 2) + "\n",
  );
const source = path.join(cwd, "context-live-source");
fs.mkdirSync(source, { recursive: true });
let seed = 76123;
const rand = () => {
  seed = (Math.imul(seed, 1664525) + 1013904223) | 0;
  return seed >>> 0;
};
const facts = [];
for (let index = 0; index < 16; index++) {
  const ticket = `LIVE-${index}-${rand().toString(16)}`,
    constant = rand() % 100000;
  const lines = [
    `// Synthetic review ${index}. Ticket ${ticket}. All findings remain unaccepted.`,
    `// Read this complete file, report initial_result and the off-by-one guard.`,
    `export const audit_ticket = "${ticket}";`,
    `export function decode(values: number[], index: number, mode: number) {`,
    `  let initial_result = ${constant};`,
    `  if (index <= values.length) initial_result ^= values[index]; // BUG: upper boundary includes length`,
  ];
  for (let k = 0; k < 570; k++)
    lines.push(
      `  if(mode===${rand() % 65536})initial_result^=(${rand() % 65536}+(index>>>${rand() % 31})); // branch ${index}_${k}`,
    );
  lines.push("  return initial_result;", "}");
  const file = path.join(
      source,
      `decoder_${String(index).padStart(2, "0")}.ts`,
    ),
    text = lines.join("\n");
  fs.writeFileSync(file, text + "\n");
  facts.push({ file, ticket, constant });
  report.files.push({
    file,
    bytes: Buffer.byteLength(text),
    estimatedTokens: estimateSummaryTokens(text),
  });
}
let session,
  next = 0,
  verified = false,
  phaseEnd = 8;
const readFiles = new Set();
const settingsFile = path.join(agentDir, "settings.json"),
  originalSettings = fs.readFileSync(settingsFile, "utf8");
const settingsJson = JSON.parse(originalSettings);
settingsJson.compaction = {
  ...(settingsJson.compaction ?? {}),
  enabled: true,
  keepRecentTokens: 2048,
};
fs.writeFileSync(settingsFile, JSON.stringify(settingsJson, null, 2));
const toolResult = (value) => ({
  content: [{ type: "text", text: JSON.stringify(value) }],
  details: undefined,
});
const tools = [
  {
    name: "record_review",
    executionMode: "sequential",
    label: "Record synthetic file review",
    description:
      "Record the next file's exact ticket, initial_result constant and whether its upper index boundary is wrong. Must read that file first. Returns the next file, never historical answers.",
    parameters: Type.Object({
      file: Type.String(),
      ticket: Type.String(),
      initial_result: Type.Integer(),
      off_by_one: Type.Boolean(),
    }),
    async execute(_id, value) {
      const fact = facts[next];
      if (
        !fact ||
        next >= phaseEnd ||
        !readFiles.has(fact.file) ||
        path.resolve(cwd, value.file) !== fact.file ||
        value.ticket !== fact.ticket ||
        value.initial_result !== fact.constant ||
        !value.off_by_one
      )
        throw Error(
          `Review mismatch: next expected file ${fact?.file ?? "none"}. Read it fully before recording; use its full path or a path relative to the test workspace and report exact source facts.`,
        );
      next++;
      return toolResult({
        recorded: true,
        reviewed: next,
        phaseComplete: next === phaseEnd,
        next: next < phaseEnd ? facts[next].file : null,
        accepted: false,
      });
    },
  },
  {
    name: "finish_review",
    executionMode: "sequential",
    label: "Check synthetic review recall",
    description:
      "After all 16 files, return the earliest file's facts, the corrected goal identifier, revision and acceptance status. Retrieve earlier history if needed.",
    parameters: Type.Object({
      first_ticket: Type.String(),
      first_initial_result: Type.Integer(),
      corrected_goal_id: Type.String(),
      revision: Type.Integer(),
      accepted: Type.Boolean(),
      next_file: Type.Union([Type.String(), Type.Null()]),
    }),
    async execute(_id, value) {
      report.checks = {
        ...report.checks,
        allFiles: next === 16,
        firstTicket: value.first_ticket === facts[0].ticket,
        firstConstant: value.first_initial_result === facts[0].constant,
        correctedGoal:
          value.corrected_goal_id === "e2dbb408-9ea9-469b-9832-b1a6b0e69339",
        revision: value.revision === 1,
        acceptance: value.accepted === false,
        next: value.next_file === null,
      };
      verified = Object.values(report.checks).every(Boolean);
      save();
      if (!verified)
        throw Error(
          `Final memory mismatch. Recorded ${next}/16 files; next expected file ${facts[next]?.file ?? "none"}. Read and record remaining files first; search/read current conversation history for incorrect recall fields.`,
        );
      return toolResult({ verified: true, accepted: false });
    },
  },
];
const correctionProbe = args.probe === "correction";
if (correctionProbe)
  tools.push({
    name: "verify_correction",
    executionMode: "sequential",
    label: "Verify user correction",
    description:
      "Record the identifier and revision explicitly corrected by the actual user; working notes may be wrong.",
    parameters: Type.Object({
      identifier: Type.String(),
      revision: Type.Integer(),
    }),
    async execute(_id, value) {
      verified =
        value.identifier === "e2dbb408-9ea9-469b-9832-b1a6b0e69339" &&
        value.revision === 7;
      report.checks.probeCorrection = verified;
      if (!verified)
        throw Error(
          "The working note conflicts with the actual user correction; consult recent user source or context_history role=user",
        );
      return toolResult({ verified: true });
    },
  });
try {
  const runtime = await ModelRuntime.create({
    modelsPath: path.resolve(args.models),
    authPath: path.resolve(args.auth),
    modelsStorePath: path.join(output, "models-store.json"),
    refreshOnCreate: false,
    allowModelNetwork: false,
  });
  const route = runtime.getModel("gptcodex", "gpt-6-luna");
  if (!route) throw Error("Configured 6luna route unavailable");
  const settings = SettingsManager.create(cwd, agentDir);
  const resources = new DefaultResourceLoader({
    cwd,
    agentDir,
    settingsManager: settings,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noContextFiles: true,
    noThemes: true,
    additionalExtensionPaths: [
      path.resolve("extensions/mission-control/compaction.ts"),
    ],
  });
  await resources.reload();
  ({ session } = await createAgentSession({
    cwd,
    agentDir,
    modelRuntime: runtime,
    model: { ...route, maxTokens: 16384 },
    thinkingLevel: "low",
    settingsManager: settings,
    resourceLoader: resources,
    sessionManager: SessionManager.open(identity.sessionFile),
    customTools: tools,
    tools: [
      "read",
      ...tools.map((t) => t.name),
      "context_mode",
      "context_note",
      "context_history",
      "context_rollover",
    ],
  }));
  await session.bindExtensions({
    mode: "rpc",
    onError: (error) => {
      (report.extensionErrors ??= []).push(error);
      save();
    },
  });
  session.setActiveToolsByName([
    "read",
    ...tools.map((t) => t.name),
    "context_mode",
    "context_note",
    "context_history",
    "context_rollover",
  ]);
  const direct = (name, value) =>
    session.agent.state.tools
      .find((t) => t.name === name)
      .execute(
        "test-" + crypto.randomUUID(),
        value,
        new AbortController().signal,
      );
  await direct("context_mode", { mode: "notes", inputLimitTokens: 64000 });
  const beforeWindows = new Set(
    session.sessionManager
      .getBranch()
      .filter((e) => e.type === "compaction")
      .map((e) => e.id),
  );
  let requestStart, streamStart;
  const calls = new Map();
  session.subscribe((event) => {
    if (event.type === "turn_start") requestStart = Date.now();
    if (event.type === "message_start" && event.message.role === "assistant")
      streamStart = Date.now();
    if (event.type === "message_end" && event.message.role === "assistant") {
      const m = event.message;
      report.requests.push({
        elapsedMs: Date.now() - (requestStart ?? Date.now()),
        streamElapsedMs: Date.now() - (streamStart ?? Date.now()),
        usage: m.usage,
        stopReason: m.stopReason,
        error: m.errorMessage,
      });
      console.log(
        JSON.stringify({
          event: "response",
          requests: report.requests.length,
          reviewed: next,
          stopReason: m.stopReason,
          error: m.errorMessage,
        }),
      );
      save();
    }
    if (event.type === "tool_execution_start")
      calls.set(event.toolCallId, event.args);
    if (event.type === "tool_execution_end") {
      const toolArgs = calls.get(event.toolCallId);
      if (event.toolName === "read" && !event.isError && toolArgs?.path)
        readFiles.add(path.resolve(cwd, toolArgs.path));
      report.tools.push({
        name: event.toolName,
        args: toolArgs,
        isError: event.isError,
      });
      calls.delete(event.toolCallId);
      save();
    }
    if (event.type === "agent_settled")
      report.phases.push({
        event: "settled",
        aborted: event.aborted,
        reviewed: next,
      });
  });
  const deadline = setTimeout(() => void session.abort(), 900000);
  try {
    if (correctionProbe) {
      report.probe = "correction";
      const correction =
        "Synthetic correction probe: the corrected identifier is e2dbb408-9ea9-469b-9832-b1a6b0e69339, revision 7. This overrides earlier values. Only acknowledge now; do not call any tools.";
      await session.prompt(correction);
      const correctionEntry = session.sessionManager
        .getBranch()
        .findLast(
          (e) =>
            e.type === "message" &&
            e.message.role === "user" &&
            JSON.stringify(e.message.content).includes(
              "Synthetic correction probe:",
            ),
        );
      await session.prompt(
        `Only read ${facts[15].file} in full and acknowledge completion. Do not record a review, update notes, or finish the earlier task. This read supplies a long recent tail for the isolated memory test.`,
      );
      await direct("context_note", {
        action: "write",
        name: "index",
        text: "Synthetic correction probe; working notes deliberately contain a fault. No goal accepted.",
      });
      await direct("context_note", {
        action: "write",
        name: "handoff",
        text: "FAULT INJECTION for the synthetic test: identifier e2dbb408-9ea9-4698-9832-b1a6b0e69339 revision 1. These are untrusted model working notes; recover the actual latest user correction.",
      });
      const compact = await session.compact();
      const entries = session.sessionManager.getBranch();
      report.checks.userSourcePinned =
        compact.summary.includes("RECENT USER SOURCE") &&
        compact.summary.includes("revision 7");
      report.checks.userCorrectionOutsideRetainedTail =
        entries.findIndex((e) => e.id === compact.firstKeptEntryId) >
        entries.findIndex((e) => e.id === correctionEntry.id);
      await session.reload();
      session.setActiveToolsByName([
        "read",
        ...tools.map((t) => t.name),
        "context_mode",
        "context_note",
        "context_history",
        "context_rollover",
      ]);
      report.checks.reloadPreservedMode =
        JSON.parse((await direct("context_mode", {})).content[0].text).mode ===
        "notes";
      await session.prompt(
        "Call verify_correction with the most recent identifier and revision explicitly corrected by the actual user. Prefer actual user source over working notes; use context_history role=user if necessary. Do not change files or perform the earlier review.",
      );
    } else
      for (let phase = 0; phase < 2; phase++) {
        if (phase) {
          await session.reload();
          session.setActiveToolsByName([
            "read",
            ...tools.map((t) => t.name),
            "context_mode",
            "context_note",
            "context_history",
            "context_rollover",
          ]);
          report.checks.reloadPreservedMode =
            JSON.parse((await direct("context_mode", {})).content[0].text)
              .mode === "notes";
          phaseEnd = 16;
        }
        const prompt = `This is an isolated synthetic long source review in the dedicated WSL test conversation. Review the following complete list in order using read, then record_review for EACH file. Do not modify files. The loop continues across context windows; a rollover does not complete the phase. Preserve exact reading position, findings, unaccepted status and corrected identifiers in your own concise notes only when a context preparation reminder asks; use context_rollover to actually refresh. If a tool read is truncated, read the remainder. Do not read any path outside the listed source files; use context_history for older messages. Phase ${phase + 1}:\n${facts
          .slice(phase * 8, phase * 8 + 8)
          .map((f) => f.file)
          .join(
            "\n",
          )}\n${phase ? "USER CORRECTION: goal is e2dbb408-9ea9-469b-9832-b1a6b0e69339 revision 1; the earlier 4698 spelling was wrong. After all 16 records, call finish_review; it requires the first file's exact ticket/initial_result, corrected identifier, revision 1, accepted false, next_file null. Retrieve earlier facts if missing. No audit acceptance is granted." : "Initial goal e2dbb408-9ea9-4698-9832-b1a6b0e69339 revision 0. After eight records, stop with a concise phase report; wait for my next phase. No audit acceptance is granted."}`;
        await session.prompt(prompt);
        if (next !== phaseEnd)
          throw Error(
            `Phase ${phase + 1} settled early at ${next}/${phaseEnd}`,
          );
      }
  } finally {
    clearTimeout(deadline);
  }
  const windows = session.sessionManager
    .getBranch()
    .filter((e) => e.type === "compaction" && !beforeWindows.has(e.id));
  Object.assign(report, {
    elapsedMs: Date.now() - started,
    reviewed: next,
    windows: windows.map((e) => ({
      id: e.id,
      firstKeptEntryId: e.firstKeptEntryId,
      details: e.details,
      tokensBefore: e.tokensBefore,
    })),
    memoryStatus: JSON.parse(
      (await direct("context_mode", {})).content[0].text,
    ),
  });
  report.checks = {
    ...report.checks,
    verified,
    continuousWindows: windows.length >= (correctionProbe ? 1 : 3),
    sameSession: session.sessionManager.getSessionId() === identity.id,
    noOutsideRead: report.tools
      .filter((e) => e.name === "read")
      .every(
        (e) =>
          typeof e.args?.path === "string" &&
          facts.some((f) => f.file === path.resolve(cwd, e.args.path)),
      ),
    ...(correctionProbe
      ? {}
      : {
          allNativeFilesRead: facts.every((f) =>
            report.tools.some(
              (e) =>
                e.name === "read" &&
                e.args?.path &&
                path.resolve(cwd, e.args.path) === f.file,
            ),
          ),
        }),
    noExtensionErrors: !report.extensionErrors?.length,
  };
  report.success = Object.values(report.checks).every(Boolean);
  save();
  console.log(
    JSON.stringify({
      success: report.success,
      elapsedMs: report.elapsedMs,
      requests: report.requests.length,
      windows: windows.length,
      checks: report.checks,
    }),
  );
  if (!report.success) process.exitCode = 1;
} catch (error) {
  report.success = false;
  report.error = String(error.message);
  report.elapsedMs = Date.now() - started;
  save();
  console.error(report.error);
  process.exitCode = 1;
} finally {
  if (session) {
    await session.abort();
    await session.extensionRunner.emit({
      type: "session_shutdown",
      reason: "quit",
    });
    session.dispose();
  }
  fs.writeFileSync(settingsFile, originalSettings);
  fs.closeSync(lockFd);
  fs.unlinkSync(lock);
}
