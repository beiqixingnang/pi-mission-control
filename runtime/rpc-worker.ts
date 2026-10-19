import fs from "node:fs";
import path from "node:path";
import { spawn, execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { cleanText, textOf, publicEntry, exportText } from "./public.ts";
import type {
  Assignment,
  WorkerEvent,
  WorkerFactory,
  WorkerOutcome,
} from "./types.ts";
import { lfLines } from "./jsonl.ts";
import { readTime } from "./time.ts";

const ENV_ALLOW = [
  "PATH",
  "Path",
  "SystemRoot",
  "WINDIR",
  "COMSPEC",
  "PATHEXT",
  "HOME",
  "USERPROFILE",
  "APPDATA",
  "LOCALAPPDATA",
  "TEMP",
  "TMP",
  "TMPDIR",
  "LANG",
  "LC_ALL",
  "TERM",
  "PI_CODING_AGENT_DIR",
  "PI_PACKAGE_DIR",
  "PI_COMPACTION_SUMMARY_MODEL",
  "PI_COMPACTION_DEBUG",
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
  "DEEPSEEK_API_KEY",
  "GEMINI_API_KEY",
  "GOOGLE_API_KEY",
  "OPENROUTER_API_KEY",
  "AZURE_OPENAI_API_KEY",
  "BRAVE_API_KEY",
];
/** A structural public projection; reasoning/signatures/system bodies never enter UI state. */
export function workerPreview(event: any): WorkerEvent | undefined {
  const at = Date.now();
  if (event.message?.role === "assistant") {
    const id = `assistant:${event.message.timestamp ?? "current"}`;
    if (event.type === "message_end")
      return { type: "public", clearPreview: id };
    if (
      event.type === "message_update" &&
      !String(event.assistantMessageEvent?.type ?? "").startsWith("thinking")
    ) {
      const text = exportText(textOf(event.message));
      if (text)
        return {
          type: "public",
          preview: {
            id,
            kind: "assistant",
            title: "成员正在回复",
            text,
            at,
            timestamp: readTime(event.message.timestamp),
          },
        };
    }
  }
  if (event.type === "tool_execution_end")
    return { type: "public", clearPreview: `tool:${event.toolCallId}` };
  if (
    event.type === "tool_execution_start" ||
    event.type === "tool_execution_update"
  ) {
    const projected = publicEntry({
      type: "message",
      message: {
        role: "assistant",
        content: [
          { type: "toolCall", name: event.toolName, arguments: event.args },
        ],
      },
    });
    const args = JSON.stringify(projected?.content ?? [], null, 2);
    return {
      type: "public",
      preview: {
        id: `tool:${event.toolCallId}`,
        kind: "tool",
        title: `执行中 · ${cleanText(event.toolName ?? "tool", 80)}`,
        text: exportText(
          `参数：\n${args}\n${event.type === "tool_execution_update" ? "已上报输出：\n" + textOf(event.partialResult) : "等待工具返回"}`,
        ),
        at,
        timestamp: readTime(event.startedAt),
        startedAt: readTime(event.startedAt),
      },
    };
  }
}
/** Pi 1.3 RPC sends deltas without cumulative message/partial snapshots. */
export class WorkerPublicStream {
  private timestamp?: number;
  private text = new Map<number, string>();
  private toolStarts = new Map<string, number>();
  accept(event: any): WorkerEvent | undefined {
    if (
      ["tool_execution_start", "tool_execution_update"].includes(event.type)
    ) {
      if (!this.toolStarts.has(event.toolCallId)) {
        this.toolStarts.set(event.toolCallId, Date.now());
        if (this.toolStarts.size > 128)
          this.toolStarts.delete(this.toolStarts.keys().next().value!);
      }
      return workerPreview({
        ...event,
        startedAt: this.toolStarts.get(event.toolCallId),
      });
    }
    if (event.type === "tool_execution_end")
      this.toolStarts.delete(event.toolCallId);
    if (event.type === "message_start" && event.message?.role === "assistant") {
      this.timestamp = event.message.timestamp;
      this.text.clear();
      return;
    }
    if (event.type === "message_update" && !event.message) {
      const delta = event.assistantMessageEvent;
      if (
        !delta ||
        !["text_start", "text_delta", "text_end"].includes(delta.type)
      )
        return;
      const index = Number(delta.contentIndex ?? 0);
      if (!Number.isSafeInteger(index) || index < 0 || index > 128) return;
      if (!this.text.has(index) && this.text.size >= 16) return;
      const previous = this.text.get(index) ?? "";
      const next =
        delta.type === "text_start"
          ? ""
          : delta.type === "text_end"
            ? String(delta.content ?? previous).slice(0, 32000)
            : (previous + String(delta.delta ?? "")).slice(0, 32000);
      this.text.set(index, next);
      return workerPreview({
        ...event,
        message: {
          role: "assistant",
          timestamp: this.timestamp,
          content: [...this.text.entries()]
            .sort((a, b) => a[0] - b[0])
            .map(([, text]) => ({ type: "text", text })),
        },
      });
    }
    if (event.type === "message_end") this.text.clear();
    return workerPreview(event);
  }
}
export function workerEnvironment(assignment: Assignment) {
  const env: Record<string, string> = {};
  for (const key of new Set([...ENV_ALLOW, ...assignment.settings.inheritEnv]))
    if (process.env[key] !== undefined) env[key] = process.env[key]!;
  env.MC_V2_MEMBER = JSON.stringify({
    member: assignment.member,
    taskId: assignment.task.id,
    epoch: assignment.task.epoch,
    directory: assignment.directory,
  });
  env.MC_V2_BRIDGE = assignment.bridgeUrl;
  env.MC_V2_TOKEN = assignment.token;
  env.MC_V2_PARENT_PID = String(process.pid);
  env.MC_V2_WORKER_EXTENSIONS = JSON.stringify(
    assignment.settings.workerExtensions,
  );
  env.MC_V2_SEARCH = JSON.stringify({
    searchProvider: assignment.settings.searchProvider,
    searchUrl: assignment.settings.searchUrl,
  });
  if (assignment.settings.reconnect)
    env.MC_V2_RECONNECT = JSON.stringify(assignment.settings.reconnect);
  env.NODE_NO_WARNINGS = "1";
  return env;
}
export async function killTree(pid: number) {
  if (process.platform === "win32") {
    await new Promise<void>((resolve, reject) =>
      execFile(
        path.join(
          process.env.SystemRoot ?? "C:\\Windows",
          "System32",
          "taskkill.exe",
        ),
        ["/PID", String(pid), "/T", "/F"],
        { windowsHide: true, timeout: 10000 },
        (error) => {
          if (!error) {
            resolve();
            return;
          }
          try {
            process.kill(pid, 0);
            reject(error);
          } catch (e) {
            if ((e as NodeJS.ErrnoException).code === "ESRCH") resolve();
            else reject(error);
          }
        },
      ),
    );
    return;
  }
  try {
    process.kill(-pid, "SIGTERM");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
  await new Promise((resolve) => setTimeout(resolve, 100));
  try {
    process.kill(-pid, "SIGKILL");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
}
/** Uses the public Pi JSONL protocol; no private RpcClient process access. */
export function createWorkerFactory(
  cliPath: string,
  memberExtension: string,
): WorkerFactory {
  return async (assignment, signal, onEvent) => {
    signal.throwIfAborted();
    const { member, task } = assignment;
    const publicStream = new WorkerPublicStream();
    const sessionDir = path.join(assignment.directory, "sessions", member.id);
    fs.mkdirSync(sessionDir, { recursive: true, mode: 0o700 });
    const args = [
      cliPath,
      "--mode",
      "rpc",
      "--no-extensions",
      "--no-mcp",
      "--no-prompt-templates",
      "--no-themes",
      "--no-approve",
      "--tools",
      // The member extension owns the active allowlist and tool-call guard.
      // A CLI name allowlist would erase configured project tools before discovery.
      "*",
      "--session-dir",
      sessionDir,
      "--session-id",
      member.sessionId,
      "--extension",
      memberExtension,
      "--extension",
      path.join(path.dirname(memberExtension), "compaction.ts"),
    ];
    if (member.model) {
      const slash = member.model.indexOf("/");
      if (slash < 1) throw new Error("Member model must be provider/model-id");
      args.push(
        "--provider",
        member.model.slice(0, slash),
        "--model",
        member.model.slice(slash + 1),
      );
    }
    args.push("--thinking", member.thinkingLevel);
    for (const extension of assignment.settings.workerExtensions)
      args.push("--extension", extension);
    const child = spawn(process.execPath, args, {
      cwd: member.workspace.root,
      env: workerEnvironment(assignment),
      stdio: ["pipe", "pipe", "pipe"],
      detached: process.platform !== "win32",
      windowsHide: true,
    });
    const pending = new Map<
      string,
      {
        resolve: (v: any) => void;
        reject: (e: Error) => void;
        timer: ReturnType<typeof setTimeout>;
      }
    >();
    let settled = false,
      stopping = false,
      started = false,
      cleanSettlement = false,
      lastText = "",
      lastError: string | undefined,
      outputTokens = 0,
      sessionFile: string | undefined,
      stderr = "",
      unknown = false;
    let resolveResult!: (r: WorkerOutcome) => void;
    const result = new Promise<WorkerOutcome>((resolve) => {
      resolveResult = resolve;
    });
    let resolveClosed!: () => void;
    const closed = new Promise<void>((resolve) => {
      resolveClosed = resolve;
    });
    const cleanupRequests = (error: Error) => {
      for (const p of pending.values()) {
        clearTimeout(p.timer);
        p.reject(error);
      }
      pending.clear();
    };
    const send = (body: any, timeoutMs = 15000) =>
      new Promise<any>((resolve, reject) => {
        if (child.exitCode !== null || child.signalCode !== null) {
          reject(new Error("Worker process exited"));
          return;
        }
        const id = randomUUID();
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`RPC ${body.type} acceptance timed out`));
        }, timeoutMs);
        timer.unref?.();
        pending.set(id, { resolve, reject, timer });
        child.stdin.write(JSON.stringify({ ...body, id }) + "\n", (error) => {
          if (error) {
            clearTimeout(timer);
            pending.delete(id);
            reject(error);
          }
        });
      });
    const stop = async () => {
      if (stopping) {
        await closed;
        return;
      }
      stopping = true;
      if (child.exitCode === null && child.signalCode === null && child.pid) {
        if (started && !cleanSettlement)
          await send({ type: "abort" }, 1000).catch(() => {});
        try {
          await killTree(child.pid);
        } catch (error) {
          unknown = true;
          lastError = `Process tree termination unconfirmed: ${String(error)}`;
          child.kill("SIGKILL");
        }
      }
      await Promise.race([
        closed,
        new Promise<void>((resolve) => {
          const t = setTimeout(() => {
            unknown = true;
            resolve();
          }, 3000);
          t.unref?.();
        }),
      ]);
    };
    const finish = async (ok: boolean) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", abort);
      await stop();
      cleanupRequests(new Error("Worker settled"));
      resolveResult({
        ok: ok && !signal.aborted && !unknown,
        text: lastText,
        error: signal.aborted
          ? signal.reason instanceof Error &&
            signal.reason.name !== "AbortError"
            ? signal.reason.message
            : "Task cancelled by its controller"
          : lastError,
        outputTokens,
        sessionFile,
        cleanSettlement,
        processState: unknown ? "unknown" : "stopped",
      });
    };
    const abort = () => {
      lastError =
        signal.reason instanceof Error
          ? signal.reason.message
          : "Task cancelled by its controller";
      void finish(false);
    };
    signal.addEventListener("abort", abort, { once: true });
    child.stderr.on("data", (chunk) => {
      stderr = (stderr + chunk.toString()).slice(-8000);
    });
    child.stdin.on("error", (error) => {
      lastError = error.message;
      void finish(false);
    });
    child.once("error", (error) => {
      lastError = error.message;
      resolveClosed();
      void finish(false);
    });
    child.once("exit", (code, sig) => {
      resolveClosed();
      if (!settled) {
        lastError =
          lastError ??
          `Worker exited before settlement (${code ?? sig}): ${stderr}`;
        void finish(false);
      }
    });
    const receive = (line: string) => {
      if (Buffer.byteLength(line) > 8 * 1024 * 1024) {
        lastError = "Worker protocol line exceeded 8 MiB";
        void finish(false);
        return;
      }
      let event: any;
      try {
        event = JSON.parse(line);
      } catch {
        return;
      }
      if (event.type === "response" && event.id) {
        const p = pending.get(event.id);
        if (p) {
          clearTimeout(p.timer);
          pending.delete(event.id);
          event.success === false
            ? p.reject(new Error(event.error ?? "RPC failed"))
            : p.resolve(event.data);
        }
        return;
      }
      if (event.type === "agent_start") started = true;
      const preview = publicStream.accept(event);
      if (preview) onEvent(preview);
      if (event.type === "message_end" && event.message?.role === "assistant") {
        lastText = textOf(event.message).slice(0, 1_000_000);
        outputTokens += event.message.usage?.output ?? 0;
        if (
          event.message.stopReason === "error" ||
          event.message.stopReason === "aborted"
        )
          lastError = cleanText(
            event.message.errorMessage ?? event.message.stopReason,
            2000,
          );
        else lastError = undefined;
        onEvent({
          type: "message",
          text: lastText.slice(-800),
          timestamp: Date.now(),
        });
      }
      if (event.type === "tool_execution_start")
        onEvent({
          type: "tool",
          tool: cleanText(event.toolName ?? "", 80),
          timestamp: Date.now(),
        });
      if (event.type === "agent_settled" && started) {
        cleanSettlement = true;
        void send({ type: "get_state" })
          .then(
            (state) => {
              sessionFile = state?.sessionFile;
            },
            () => {},
          )
          .finally(() => finish(!lastError && !event.aborted));
      }
    };
    void (async () => {
      try {
        for await (const line of lfLines(child.stdout, 8 * 1024 * 1024))
          receive(line);
      } catch (error) {
        lastError = String(error);
        await finish(false);
      }
    })();
    void (async () => {
      try {
        const state = await send({ type: "get_state" });
        if (state?.sessionFile) {
          sessionFile = state.sessionFile;
          onEvent({ type: "session", sessionFile });
        }
        if (signal.aborted) return;
        const data = await send(
          { type: "prompt", message: assignment.prompt },
          15000,
        );
        if (data?.disposition === "handled") {
          lastError = "Worker prompt was handled without running";
          await finish(false);
        }
      } catch (error) {
        lastError = String(error);
        await finish(false);
      }
    })();
    return {
      result,
      deliver: async (message: string) => {
        if (settled || stopping) throw new Error("Worker is settling");
        await send({ type: "steer", message });
      },
      stop: async () => {
        await stop();
        if (!settled) await finish(false);
      },
    };
  };
}
