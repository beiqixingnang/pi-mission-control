/** Test-only deterministic provider. Never contacts a model service. */
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import fs from "node:fs";
const textOf = (m: any) =>
  typeof m?.content === "string"
    ? m.content
    : (m?.content ?? [])
        .filter((b: any) => b.type === "text")
        .map((b: any) => b.text)
        .join("\n");
let summaryCalls = 0;
const requestAttempts = new Map<string, number>();
let notesCycle: any;
export default function (pi: ExtensionAPI) {
  pi.on("session_start", (_event, ctx) => {
    if (process.env.MC_FIXTURE_LIFECYCLE_TRACE)
      fs.appendFileSync(
        process.env.MC_FIXTURE_LIFECYCLE_TRACE,
        JSON.stringify({
          event: "session_start",
          pid: process.pid,
          sessionId: ctx.sessionManager.getSessionId(),
          at: Date.now(),
        }) + "\n",
      );
  });
  pi.registerProvider("mission-fixture", {
    baseUrl: "http://127.0.0.1/unused",
    api: "mission-fixture",
    apiKey: "fixture-only",
    models: [
      {
        id: "summary",
        name: "Independent offline summary fixture",
        reasoning: false,
        input: ["text"],
        contextWindow: 64000,
        maxTokens: 4096,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      },
      {
        id: "model",
        name: "Offline mission fixture",
        reasoning: false,
        input: ["text"],
        contextWindow: 64000,
        maxTokens: 4096,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      },
    ],
    streamSimple(model, context, options) {
      const stream = createAssistantMessageEventStream();
      queueMicrotask(() => {
        const message: any = {
          role: "assistant",
          api: model.api,
          provider: model.provider,
          model: model.id,
          timestamp: Date.now(),
          usage: {
            input: 1,
            output: 1,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 2,
            cost: {
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              total: 0,
            },
          },
          content: [],
          stopReason: "stop",
        };
        const tool = (name: string, args: any) => {
          message.content = [
            {
              type: "toolCall",
              id: "fixture-" + crypto.randomUUID(),
              name,
              arguments: args,
            },
          ];
          message.stopReason = "toolUse";
        };
        const answer = (value: unknown) => {
          message.content = [
            {
              type: "text",
              text: typeof value === "string" ? value : JSON.stringify(value),
            },
          ];
        };
        try {
          if (
            !notesCycle &&
            textOf(
              context.messages.filter((m: any) => m.role === "user").at(-1),
            ).startsWith("The notes context window has been refreshed.")
          ) {
            answer("CONTEXT_WINDOW_RESUMED");
            stream.push({ type: "start", partial: message });
            stream.push({ type: "done", reason: "stop", message });
            stream.end();
            return;
          }
          if (
            context.messages.at(-1)?.role === "user" &&
            textOf(context.messages.at(-1)).startsWith(
              "Summarize this coding-session excerpt",
            )
          ) {
            const summaryMode = process.env.MC_FIXTURE_SUMMARY;
            if (process.env.MC_FIXTURE_SUMMARY_TRACE)
              fs.appendFileSync(
                process.env.MC_FIXTURE_SUMMARY_TRACE,
                JSON.stringify({
                  provider: model.provider,
                  model: model.id,
                  mode: summaryMode,
                  inputChars: textOf(context.messages.at(-1)).length,
                  previousCheckpoint: textOf(context.messages.at(-1)).includes(
                    "PREVIOUS CHECKPOINT (carry required facts forward",
                  ),
                }) + "\n",
              );
            if (
              ![
                "success",
                "subdivide",
                "overlong",
                "stream-once",
                "stream-always",
                "rate-limit",
              ].includes(summaryMode ?? "")
            )
              throw new Error("Intentional summary-provider failure");
            summaryCalls++;
            const summaryKey = "summary:" + textOf(context.messages.at(-1));
            const summaryAttempt = (requestAttempts.get(summaryKey) ?? 0) + 1;
            requestAttempts.set(summaryKey, summaryAttempt);
            if (
              summaryMode === "stream-always" ||
              (summaryMode === "stream-once" && summaryAttempt === 1) ||
              summaryMode === "rate-limit"
            )
              throw new Error(
                summaryMode === "rate-limit"
                  ? "429 Too many requests retry-after: 0"
                  : "OpenAI Responses stream ended before a terminal response event",
              );
            if (
              summaryMode === "subdivide" &&
              textOf(context.messages.at(-1)).length > 2600
            ) {
              message.stopReason = "error";
              message.rawStopReason = "incomplete.length";
              message.errorMessage = "Response incomplete: length";
              answer("INCOMPLETE_SUMMARY_MUST_NOT_BE_SAVED");
              stream.push({ type: "start", partial: message });
              stream.push({ type: "error", reason: "error", error: message });
              stream.end();
              return;
            }
            answer(
              summaryMode === "overlong" &&
                !textOf(context.messages.at(-1)).includes("OVERLONG_CANDIDATE")
                ? "OVERLONG_CANDIDATE ".repeat(60) + "KEEP_FINAL_EVIDENCE"
                : "Summary retained: user objective, file paths, verified evidence and remaining tasks. KEEP_FINAL_EVIDENCE",
            );
            stream.push({ type: "start", partial: message });
            stream.push({ type: "done", reason: "stop", message });
            stream.end();
            return;
          }
          const marker =
            context.messages
              .filter((m: any) => m.role === "user")
              .map(textOf)
              .filter((t) => t.includes("V2_TEST:"))
              .at(-1) ?? "";
          const command =
            notesCycle ??
            JSON.parse(
              marker.slice(marker.indexOf("V2_TEST:") + 8).split("\n")[0],
            );
          if (command.op === "notes-cycle") {
            notesCycle ??= { ...command, step: 0 };
            const sequence: any[] = [
              { name: "context_mode", args: { mode: "notes" } },
            ];
            for (let cycle = 0; cycle < (command.windows ?? 2); cycle++) {
              if (command.auto)
                sequence.push({
                  name: "read",
                  args: { path: command.file },
                  highUsage: true,
                });
              sequence.push(
                {
                  name: "context_note",
                  args: {
                    action: "write",
                    name: "index",
                    text: `Synthetic review cycle ${cycle}; preserve corrected identifiers.`,
                  },
                },
                {
                  name: "context_note",
                  args: {
                    action: "write",
                    name: "handoff",
                    text: `Cycle ${cycle}; continue decoder.py line 173; not accepted. HISTORY_CYCLE_${cycle}`,
                  },
                },
                { name: "context_rollover", args: {} },
              );
            }
            const step = ++notesCycle.step;
            if (command.ignorePreparation && step >= 3) {
              if (command.ignorePreparation === "claim")
                answer("Ready, but I did not save notes or call rollover.");
              else tool("read", { path: command.file });
              stream.push({ type: "start", partial: message });
              stream.push({
                type: "done",
                reason: message.stopReason,
                message,
              });
              stream.end();
              return;
            }
            if (command.failAt === step) {
              notesCycle = undefined;
              message.stopReason = "error";
              message.errorMessage =
                "429 Too many requests; synthetic preparation failure";
              stream.push({ type: "start", partial: message });
              stream.push({ type: "error", reason: "error", error: message });
              stream.end();
              return;
            }
            if (command.hangAt === step) {
              stream.push({ type: "start", partial: message });
              const abort = () => {
                notesCycle = undefined;
                message.stopReason = "aborted";
                stream.push({
                  type: "error",
                  reason: "aborted",
                  error: message,
                });
                stream.end();
              };
              if (options?.signal?.aborted) abort();
              else
                options?.signal?.addEventListener("abort", abort, {
                  once: true,
                });
              return;
            }
            const current = sequence[step - 1];
            if (current) {
              tool(current.name, current.args);
              if (current.highUsage) {
                message.usage.input = 43000;
                message.usage.totalTokens = 43001;
              }
            } else {
              notesCycle = undefined;
              answer("NOTES_CYCLES_COMPLETE");
            }
            stream.push({ type: "start", partial: message });
            stream.push({ type: "done", reason: message.stopReason, message });
            stream.end();
            return;
          }
          const last = context.messages.at(-1),
            lastText = textOf(last),
            latestUser = context.messages
              .filter((m: any) => m.role === "user")
              .at(-1),
            userText = textOf(latestUser);
          if (
            command.noRepeatWake &&
            userText.startsWith("Mission Control updates.")
          ) {
            answer("FIXTURE_UPDATES_OBSERVED");
            stream.push({ type: "start", partial: message });
            stream.push({ type: "done", reason: "stop", message });
            stream.end();
            return;
          }
          if (command.op === "prompt-markers") {
            const input = JSON.stringify(
              context.messages.filter((m: any) => m.role === "system"),
            );
            answer({
              present: command.markers.map((marker: string) => ({
                marker,
                present: input.includes(marker),
              })),
            });
            stream.push({ type: "start", partial: message });
            stream.push({ type: "done", reason: "stop", message });
            stream.end();
            return;
          } else if (command.op === "tools") {
            const declared = new Map<string, any>();
            for (const message of context.messages) {
              if (message.role !== "system") continue;
              for (const tool of message.toolsRemoved ?? [])
                declared.delete(tool.name);
              for (const tool of message.toolsAdded ?? [])
                declared.set(tool.name, tool);
            }
            const tools = [...declared.values()];
            answer({
              names: tools.map((t: any) => t.name),
              schema: tools.find((t: any) => t.name === command.schemaFor)
                ?.parameters,
            });
            stream.push({ type: "start", partial: message });
            stream.push({ type: "done", reason: "stop", message });
            stream.end();
            return;
          }
          if (command.op === "recovery-chain") {
            const key = command.key;
            if (
              last?.role === "toolResult" &&
              last.isError &&
              last.toolCallId?.startsWith(`fixture-step-${key}-`)
            )
              throw new Error("Fixture evidence write rejected: " + lastText);
            const step = context.messages.filter(
              (m: any) =>
                m.role === "toolResult" &&
                m.toolCallId?.startsWith(`fixture-step-${key}-`),
            ).length;
            const failed = requestAttempts.get(key) ?? 0;
            if (
              step === (command.failAtStep ?? 1) &&
              failed < (command.failures ?? 1)
            ) {
              requestAttempts.set(key, failed + 1);
              throw new Error(command.error ?? "This operation was aborted");
            }
            if (step < (command.steps ?? 24)) {
              tool("write", {
                path: `${command.directory}/step-${step}.txt`,
                content: `Evidence ${key} ${step}\n`,
              });
              message.content[0].id = `fixture-step-${key}-${step}`;
            } else if (
              last?.role !== "toolResult" ||
              last.toolName !== "mission_status"
            ) {
              tool("mission_status", {});
            } else answer(`RECOVERY_CHAIN_COMPLETE ${key} ` + lastText);
            stream.push({ type: "start", partial: message });
            stream.push({ type: "done", reason: message.stopReason, message });
            stream.end();
            return;
          }
          if (command.op === "flaky") {
            const key = command.key ?? "default";
            const trace =
              command.traceFile && fs.existsSync(command.traceFile)
                ? fs
                    .readFileSync(command.traceFile, "utf8")
                    .trim()
                    .split("\n")
                    .filter(Boolean)
                : [];
            const attempt =
              (command.traceFile
                ? trace.length
                : (requestAttempts.get(key) ?? 0)) + 1;
            requestAttempts.set(key, attempt);
            const fault = command.controlFile
              ? {
                  ...command,
                  ...JSON.parse(fs.readFileSync(command.controlFile, "utf8")),
                }
              : command;
            if (command.traceFile)
              fs.appendFileSync(
                command.traceFile,
                JSON.stringify({
                  attempt,
                  at: Date.now(),
                  failed: attempt <= fault.failures,
                }) + "\n",
              );
            if (attempt <= fault.failures && fault.transportAbort) {
              message.stopReason = "aborted";
              message.errorMessage =
                fault.error ??
                "Fixture provider transport aborted without a user cancellation";
              stream.push({ type: "start", partial: message });
              stream.push({ type: "error", reason: "aborted", error: message });
              stream.end();
              return;
            }
            if (attempt <= fault.failures)
              throw new Error(
                fault.error ??
                  "custom station disconnected without a standard status code",
              );
            answer(`RECOVERED_REQUEST_${attempt}`);
            stream.push({ type: "start", partial: message });
            stream.push({ type: "done", reason: "stop", message });
            stream.end();
            return;
          }
          if (command.op === "recall") {
            answer(
              context.messages
                .filter((m: any) =>
                  ["user", "assistant", "toolResult"].includes(m.role),
                )
                .map(textOf)
                .join("\n"),
            );
            stream.push({ type: "start", partial: message });
            stream.push({ type: "done", reason: "stop", message });
            stream.end();
            return;
          }
          if (command.op === "hang") {
            stream.push({ type: "start", partial: message });
            const abort = () => {
              message.stopReason = "aborted";
              message.errorMessage = "Fixture cancelled";
              stream.push({ type: "error", reason: "aborted", error: message });
              stream.end();
            };
            if (options?.signal?.aborted) abort();
            else
              options?.signal?.addEventListener("abort", abort, { once: true });
            return;
          }
          if (command.op === "stream-read" && last?.role !== "toolResult") {
            message.content = [
              {
                type: "thinking",
                thinking: "PRIVATE_LIVE_REASONING",
                signature: "PRIVATE_LIVE_SIGNATURE",
              },
              { type: "text", text: "LIVE_PUBLIC_BEGIN" },
            ];
            stream.push({ type: "start", partial: message });
            stream.push({
              type: "text_delta",
              contentIndex: 1,
              delta: "LIVE_PUBLIC_BEGIN",
              partial: message,
            });
            const timer = setTimeout(() => {
              message.content.push({
                type: "toolCall",
                id: "live-read",
                name: "read",
                arguments: { path: command.file },
              });
              message.stopReason = "toolUse";
              stream.push({ type: "done", reason: "toolUse", message });
              stream.end();
            }, 1200);
            options?.signal?.addEventListener(
              "abort",
              () => {
                clearTimeout(timer);
                message.stopReason = "aborted";
                stream.push({
                  type: "error",
                  reason: "aborted",
                  error: message,
                });
                stream.end();
              },
              { once: true },
            );
            return;
          }
          if (command.op === "lead") {
            if (
              last?.role === "toolResult" &&
              last.toolName === "mission_complete"
            )
              answer("V2_WAKE_CONFIRMED");
            else if (userText.startsWith("Mission Control updates."))
              tool("mission_complete", {
                evidence: [
                  {
                    criterion: 1,
                    evidence:
                      "Actual child result was delivered automatically without enabling Goal or a supervisor",
                  },
                ],
              });
            else if (
              last?.role === "toolResult" &&
              last.toolName === "team_spawn"
            )
              tool("team_send", {
                to: "fixture-worker",
                message:
                  "V2_TEST:" +
                  JSON.stringify({ op: "read", file: command.file }),
                wait: false,
              });
            else if (
              last?.role === "toolResult" &&
              last.toolName === "team_send"
            )
              command.sync
                ? tool("mission_complete", {
                    evidence: [
                      {
                        criterion: 1,
                        evidence:
                          "The real child result was joined before one-shot Pi exits",
                      },
                    ],
                  })
                : tool("mission_wait", {});
            else if (
              last?.role === "toolResult" &&
              last.toolName === "mission_wait"
            )
              answer("Waiting was already settled; runtime owns completion");
            else
              tool("team_spawn", {
                name: "fixture-worker",
                role: "Read the fixture and report its marker",
                ...(command.placeholders
                  ? { model: null, thinkingLevel: null, communication: null }
                  : {}),
                workspace: {
                  root: command.cwd,
                  access: "read-only",
                  execution: "files",
                  ...(command.placeholders
                    ? {
                        extraReadRoots: null,
                        sandbox: {
                          engine: "podman",
                          image: "",
                          cpus: null,
                          memoryMb: null,
                          pidsLimit: null,
                          maxSeconds: null,
                        },
                      }
                    : {}),
                },
              });
          } else if (command.op === "delegate") {
            if (userText.includes("phase review")) {
              if (
                last?.role === "toolResult" &&
                last.toolName === "team_collect"
              )
                answer("REVIEWED_DESCENDANT " + lastText);
              else {
                const assignment = context.messages
                  .filter(
                    (m: any) =>
                      m.role === "toolResult" && m.toolName === "team_message",
                  )
                  .map(textOf)
                  .at(-1);
                const id = JSON.parse(assignment ?? "{}").id;
                tool("team_collect", { taskId: id });
              }
            } else if (
              last?.role === "toolResult" &&
              last.toolName === "team_message"
            )
              tool("team_wait", {});
            else if (
              last?.role === "toolResult" &&
              last.toolName === "team_wait"
            )
              answer("WAITING");
            else
              tool("team_message", {
                to: command.to,
                message: "V2_TEST:" + JSON.stringify(command.child),
                operation: "assign",
              });
          } else if (command.op === "read" || command.op === "stream-read") {
            if (last?.role === "toolResult" && last.toolName === "read")
              answer("READ_RESULT " + lastText);
            else tool("read", { path: command.file });
          } else if (command.op === "tool") {
            if (last?.role === "toolResult")
              answer(JSON.stringify({ isError: last.isError, text: lastText }));
            else tool(command.name, command.args);
          } else answer(command.text ?? "FIXTURE_OK");
          stream.push({ type: "start", partial: message });
          stream.push({ type: "done", reason: message.stopReason, message });
          stream.end();
        } catch (error) {
          message.stopReason = "error";
          message.errorMessage = String(error);
          stream.push({ type: "error", reason: "error", error: message });
          stream.end();
        }
      });
      return stream;
    },
  });
}
