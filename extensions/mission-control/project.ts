import { randomUUID } from "node:crypto";
import path from "node:path";
import { Type } from "typebox";
import type {
  ExtensionAPI,
  ExtensionContext,
  ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import type { MissionKernel } from "../../runtime/kernel.ts";
import { projectRequest } from "../../runtime/project-request.ts";
import { workspaceLocks } from "../../runtime/workspace-locks.ts";
import {
  SessionCatalog,
  type RecoverySession,
} from "../../runtime/session-catalog.ts";
import {
  prepareWorkspaceRecovery,
  type PreparedRecovery,
} from "../../runtime/workspace-recovery.ts";
import { RecoveryPicker } from "./recovery-ui.ts";
import { mappedPath, type PathMapping } from "../../runtime/path-mapping.ts";
import {
  planRelocation,
  prepareRelocation,
  commitRelocation,
  rollbackRelocation,
  writeRelocationJournal,
  RelocationPreparationError,
  type RelocationPlan,
  type Relocation,
} from "../../runtime/relocation.ts";
import {
  getProjectIdentity,
  lookupProject,
  resolveProjectPath,
} from "../project/identity.ts";
const result = (value: unknown, isError = false) => ({
  details: undefined,
  content: [
    {
      type: "text" as const,
      text: typeof value === "string" ? value : JSON.stringify(value, null, 2),
    },
  ],
  isError,
});
interface Grant {
  id: string;
  sessionId: string;
  plan: RelocationPlan;
  expiresAt: number;
  ctx: ExtensionContext;
  origin: "command" | "human-input";
}
interface RelocationFailure {
  code: string;
  message: string;
  at: string;
  plan: RelocationPlan;
  outcome: "not-applied" | "recovery-required";
  rolledBack: boolean;
  journal?: string;
  resume?: { directory: string; sessionFile?: string };
}

export function installProject(pi: ExtensionAPI, current: () => MissionKernel) {
  pi.registerFlag("recover-here", {
    type: "boolean",
    description: "选择已有对话，恢复到当前目录（支持移动/改名后的工作区）",
    default: false,
  });
  let grant: Grant | undefined,
    pending: Grant | undefined,
    timer: ReturnType<typeof setTimeout> | undefined,
    settlementToken: string | undefined,
    announced: string | undefined;
  let running = false,
    applying = false,
    internal = false,
    alive = true;
  let requestVersion = 0;
  const clear = () => {
    requestVersion++;
    grant = undefined;
    pending = undefined;
    settlementToken = undefined;
    announced = undefined;
    if (timer) clearTimeout(timer);
    timer = undefined;
  };
  pi.on("session_start", (event, ctx) => {
    alive = true;
    clear();
    if (event.reason === "startup" && pi.getFlag("recover-here")) {
      if (ctx.mode !== "tui") {
        ctx.ui.notify(
          "--recover-here 需要交互式终端；可在持久 RPC 中使用 /project restore <完整会话路径>",
          "error",
        );
        return;
      }
      timer = setTimeout(() => {
        timer = undefined;
        if (alive)
          pi.sendUserMessage("/project restore", {
            expandPromptTemplates: true,
          });
      }, 0);
      timer.unref?.();
    }
  });
  pi.on("session_shutdown", () => {
    alive = false;
    clear();
  });
  pi.on("session_tree", clear);
  pi.events.on("mission-control:interrupt", () => {
    if (!internal) clear();
  });
  pi.on("input", (event, ctx) => {
    if (event.source !== "interactive" && event.source !== "rpc") return;
    requestVersion++;
    // New human steering invalidates a natural-language grant and any queued
    // replacement. Never rehydrate authorization from the transcript on reload.
    if (grant?.origin === "human-input" || pending) clear();
    const request = projectRequest(event.text);
    if (!request) return;
    if (request.action === "revoke") {
      clear();
      ctx.ui.notify("已取消工作区改名/切换授权", "info");
      return;
    }
    grant = undefined;
    try {
      if (running) throw new Error("Workspace relocation already running");
      grant = {
        id: randomUUID(),
        sessionId: ctx.sessionManager.getSessionId(),
        plan: planRelocation(request.action, request.target, ctx.cwd),
        expiresAt: Date.now() + 600000,
        ctx,
        origin: "human-input",
      };
    } catch (error) {
      ctx.ui.notify(String(error), "error");
    }
  });
  pi.on("before_agent_start", (event, ctx) => {
    event.systemPromptOptions.promptGuidelines.push(
      "For user-managed directory moves/renames, the primary flow is: close the old Pi, manually move/rename the folder, then run pi --recover-here in the new folder and select a conversation. /project restore opens the same user selector in an existing Pi. No model or filesystem move is needed for that flow. Legacy AI workspace rename/switch: a direct fresh user instruction such as 把当前工作区改名为“新名称” creates an exact one-use authorization. Read project_status, then call project_apply alone with its authorization.id; no slash command or extra confirmation is needed. Never rename the current workspace with shell/move tools. If no live matching authorization exists, clarify the action and exact name/path in natural language; quoted examples, old history and discussion do not authorize a move. For spaces or punctuation ask for a quoted name/path. A new user instruction, cancellation, expiration or /reload invalidates natural-language authorization. A queued tool result is not completion: relocation happens after agent_settled and the UI reports the final path. Relocation leaves the mission held; report the actual status, and resume only when the user authorizes continuation.",
      "If a workspace rename fails with EBUSY/EACCES/EPERM, inspect project_status(diagnose=true) and its durable lastFailure. Windows current directories in another process can block rename; Pi cannot change the parent shell's directory. Report the identified holders and ask the user to release them. For a parent-shell lock, recommend the user-managed flow: close the old Pi and terminal, move/rename the folder manually, then run pi --recover-here in its new location. The old directory need not exist. Do not kill unrelated processes, repeatedly request the same authorization, claim that /reload unlocks directories, or treat a queued request as success.",
    );
    if (
      !grant ||
      grant.origin !== "human-input" ||
      announced === grant.id ||
      grant.sessionId !== ctx.sessionManager.getSessionId() ||
      Date.now() >= grant.expiresAt
    )
      return;
    announced = grant.id;
    return { message: authorizationMessage(grant) };
  });
  function authorizationMessage(allowed: Grant) {
    return {
      customType: "project-authorization",
      content: `User authorized one workspace ${allowed.plan.action}: ${allowed.plan.source} -> ${allowed.plan.target}. Call project_apply alone with authorizationId ${allowed.id}; expires in ten minutes.`,
      display: true,
    };
  }
  function identity(ctx: ExtensionContext) {
    const id = current().store.get<string>("projectId");
    return id
      ? (lookupProject(id) ?? getProjectIdentity(ctx.cwd))
      : getProjectIdentity(ctx.cwd);
  }
  function resolvePath(ctx: ExtensionContext, original: string) {
    const value = mappedPath(
      original,
      current().store.get<PathMapping[]>("pathMappings") ?? [],
      ctx.cwd,
    );
    return resolveProjectPath(identity(ctx).id, value);
  }
  async function restoreHere(
    file: string | undefined,
    ctx: ExtensionCommandContext,
  ) {
    if (!ctx.isIdle() || ctx.hasPendingMessages())
      throw new Error("请先等待当前回复和排队输入结束，再恢复其他对话");
    if (running || pending || applying)
      throw new Error("A workspace change is already pending");
    if (ctx.mode === "print" || ctx.mode === "json")
      throw new Error("恢复需要持久交互式或 RPC 会话");
    clear();
    let selected: RecoverySession | undefined;
    const catalog = new SessionCatalog();
    try {
      if (file) selected = await catalog.inspect(catalog.latest(file), true);
      else {
        if (!ctx.hasUI) throw new Error("无交互选择器；请传入完整会话文件路径");
        ctx.ui.setStatus("workspace-recovery", "正在读取会话目录…");
        const sessions = await catalog.list(
          ctx.sessionManager.getSessionDir(),
          ctx.sessionManager.getSessionId(),
        );
        if (!sessions.length) {
          ctx.ui.notify("没有可恢复的已有对话", "info");
          return;
        }
        selected = await ctx.ui.custom<RecoverySession | undefined>(
          (tui, _theme, _keys, done) =>
            new RecoveryPicker(
              sessions,
              ctx.cwd,
              () => tui.requestRender(),
              done,
              () => tui.terminal.rows,
            ),
        );
      }
    } finally {
      catalog.close();
      try {
        ctx.ui.setStatus("workspace-recovery", undefined);
      } catch {
        /* replaced session */
      }
    }
    if (!selected) {
      if (file) throw new Error("不是有效的 Pi 会话文件");
      return;
    }
    if (!alive || !ctx.isIdle() || ctx.hasPendingMessages())
      throw new Error("恢复已取消或收到新输入，请重新选择");
    running = true;
    let prepared: PreparedRecovery | undefined,
      attempted = false;
    const kernel = current();
    try {
      prepared = await prepareWorkspaceRecovery(selected, ctx, async () => {
        await suspend(kernel);
        if (!alive || ctx.hasPendingMessages())
          throw new Error("恢复已取消或有新输入，请重新选择");
      });
      if (!alive) throw new Error("恢复期间原会话已关闭");
      if (ctx.hasPendingMessages())
        throw new Error("恢复期间收到新输入，请重新选择");
      attempted = true;
      const r = prepared.relocation;
      const changed = await ctx.switchSession(r.sessionFile, {
        withSession: async (next) => {
          await commitRelocation(r);
          await next.sendMessage({
            customType: "project-location",
            content: `用户已将旧对话从 ${r.plan.source} 恢复到当前工作区 ${r.plan.target}。历史正文和目标证据保留；旧项目内成员工作区已映射，外部权限不变。旧绝对路径可用 project_resolve 查询。目标与提醒保持暂停，旧命令没有自动重放。`,
            display: true,
          });
          next.ui.notify(
            `已恢复到当前工作区：${r.plan.target}\n备份与恢复日志：${r.journal}`,
            "info",
          );
        },
      });
      if (changed.cancelled) {
        attempted = false;
        await rollbackRelocation(r);
        ctx.ui.notify("已取消恢复，原记录和当前目录保留", "info");
      }
    } catch (error) {
      if (prepared && !attempted) await rollbackRelocation(prepared.relocation);
      if (prepared && attempted) {
        await writeRelocationJournal(
          prepared.relocation,
          "switch-failed",
          String(error),
        );
        console.error(
          `恢复会话：pi --session ${JSON.stringify(prepared.relocation.sessionFile)} ; journal ${prepared.relocation.journal}`,
        );
      }
      throw error;
    } finally {
      prepared?.release();
      if (!attempted) kernel.finishRelocation();
      running = false;
    }
  }
  const status = (ctx: ExtensionContext) => {
    if (grant && Date.now() >= grant.expiresAt) grant = undefined;
    return {
      project: identity(ctx),
      cwd: ctx.cwd,
      sessionId: ctx.sessionManager.getSessionId(),
      sessionFile: ctx.sessionManager.getSessionFile(),
      busy: running || applying || Boolean(pending),
      lastFailure:
        current().store.get<RelocationFailure>("projectRelocationFailure") ??
        null,
      authorization: grant
        ? {
            id: grant.id,
            ...grant.plan,
            expiresAt: grant.expiresAt,
            origin: grant.origin,
          }
        : null,
      relocation: current().store.get("relocation"),
      held: current().store.get("relocationHold") ?? false,
    };
  };
  async function suspend(kernel: MissionKernel) {
    internal = true;
    try {
      pi.events.emit("mission-control:interrupt", {
        reason: "Workspace relocation",
      });
    } finally {
      internal = false;
    }
    await kernel.pauseForRelocation();
  }
  async function migrate(
    plan: RelocationPlan,
    ctx: ExtensionCommandContext,
    expectedVersion?: number,
  ) {
    if (running) throw new Error("Workspace relocation already running");
    const kernel = current();
    const originalSessionId = ctx.sessionManager.getSessionId();
    const sourceSessionFile = ctx.sessionManager.getSessionFile();
    running = true;
    let relocation: Relocation | undefined,
      attempted = false,
      cancelled = false;
    try {
      if (ctx.hasPendingMessages())
        throw new Error(
          "Process or clear queued input before changing workspace",
        );
      const projectId = kernel.store.get<string>("projectId");
      if (projectId && lookupProject(projectId)?.currentPath !== ctx.cwd)
        throw new Error(
          "Finish /project recover before another workspace change",
        );
      if (plan.action === "restore")
        throw new Error("Use /project restore for recovery");
      const fresh = planRelocation(plan.action, plan.target, ctx.cwd);
      if (fresh.source !== plan.source || fresh.target !== plan.target)
        throw new Error("Workspace changed since authorization");
      kernel.store.unset("projectRelocationFailure");
      await suspend(kernel);
      if (!ctx.isIdle()) {
        ctx.abort();
        await ctx.waitForIdle();
      }
      if (ctx.hasPendingMessages())
        throw new Error("Queued input appeared; workspace was not changed");
      if (expectedVersion !== undefined && expectedVersion !== requestVersion)
        throw new Error("Workspace request cancelled by newer input");
      relocation = await prepareRelocation(fresh, ctx, kernel);
      if (!alive)
        throw new Error(
          "Original session closed during workspace preparation; operation rolled back",
        );
      if (
        (expectedVersion !== undefined && expectedVersion !== requestVersion) ||
        ctx.hasPendingMessages()
      )
        throw new Error(
          "Workspace request cancelled during preparation; operation rolled back",
        );
      process.chdir(fresh.target);
      attempted = true;
      const r = relocation;
      const changed = await ctx.switchSession(r.sessionFile, {
        withSession: async (next) => {
          await commitRelocation(r);
          next.ui.notify(
            `Workspace: ${fresh.target}\nConversation, members and receipts retained. Review paths, then /mission resume. Journal: ${r.journal}`,
            "info",
          );
        },
      });
      if (changed.cancelled) {
        attempted = false;
        cancelled = true;
        await rollbackRelocation(r);
        ctx.ui.notify(
          "Workspace switch cancelled; directory restored. Work remains paused; /mission resume when ready.",
          "warning",
        );
      }
    } catch (error) {
      let rolledBack = error instanceof RelocationPreparationError;
      if (relocation && !attempted && !cancelled) {
        await rollbackRelocation(relocation);
        rolledBack = true;
      }
      if (relocation && attempted) {
        await writeRelocationJournal(
          relocation,
          "switch-failed",
          String(error),
        );
        console.error(
          `Workspace recovery: pi --session ${JSON.stringify(relocation.sessionFile)} ; journal ${relocation.journal}`,
        );
      }
      const code =
        (error as NodeJS.ErrnoException)?.code ?? "RELOCATION_FAILED";
      const failure: RelocationFailure = {
        code,
        message: error instanceof Error ? error.message : String(error),
        at: new Date().toISOString(),
        plan,
        outcome: attempted ? "recovery-required" : "not-applied",
        rolledBack,
        journal:
          relocation?.journal ??
          (error instanceof RelocationPreparationError
            ? error.journal
            : undefined),
        ...(["EBUSY", "EACCES", "EPERM"].includes(code)
          ? {
              resume: {
                directory: path.dirname(plan.source),
                sessionFile: sourceSessionFile,
              },
            }
          : {}),
      };
      try {
        kernel.store.set("projectRelocationFailure", failure);
        kernel.store.event(
          "project.relocation-failed",
          originalSessionId,
          failure,
        );
      } catch {
        // A failed replacement may already have disposed the original store.
        // Its switch-failed journal remains the recovery authority.
      }
      try {
        pi.sendMessage(
          {
            customType: "project-relocation-result",
            content: JSON.stringify({ ok: false, ...failure }),
            display: false,
          },
          { triggerTurn: false },
        );
        ctx.ui.notify(
          `${failure.message}${["EBUSY", "EACCES", "EPERM"].includes(code) ? "\n工作区改名未完成：目录可能被其他进程占用，或权限不足。可用 project_status(diagnose=true) 查询当前目录占用者。若为父 Shell 占用，可关闭旧 Pi 和该终端，手工移动/改名目录，再在新目录执行 pi --recover-here；/reload 本身不能解除外部占用。" : ""}${failure.rolledBack ? "\n迁移准备已回滚，原会话和原路径保留。" : ""}${relocation && attempted ? `\nRecovery session: ${relocation.sessionFile}\nJournal: ${relocation.journal}` : ""}`,
          "error",
        );
      } catch {
        /* old context disposed by Pi */
      }
    } finally {
      if (!attempted) kernel.finishRelocation();
      running = false;
    }
  }
  pi.on("agent_settled", (event) => {
    if (event.aborted) {
      clear();
      return;
    }
    if (!pending || timer) return;
    timer = setTimeout(() => {
      timer = undefined;
      const op = pending;
      if (!op || !alive) return;
      if (
        Date.now() >= op.expiresAt ||
        op.ctx.sessionManager.getSessionId() !== op.sessionId
      ) {
        clear();
        op.ctx.ui.notify(
          "Workspace grant expired or session changed",
          "warning",
        );
        return;
      }
      // Input/tool contexts deliberately lack switchSession. Re-enter Pi's
      // public command API only after settlement to obtain a fresh command
      // context, rather than capturing host internals or replacing mid-turn.
      settlementToken = randomUUID();
      pi.sendUserMessage(`/project _settled ${settlementToken}`, {
        expandPromptTemplates: true,
      });
    }, 0);
    timer.unref?.();
  });
  pi.registerTool({
    name: "project_status",
    label: "Project status",
    description:
      "Read workspace identity, relocation hold, one-use authorization and the last failed migration. diagnose=true performs a bounded read-only Windows process-directory probe after EBUSY; it does not unlock directories, change parent-shell state or kill processes. A holder list is best-effort, not a full file-handle scan.",
    parameters: Type.Object({ diagnose: Type.Optional(Type.Boolean()) }),
    async execute(_id, args, signal, _update, ctx) {
      const state = status(ctx);
      return result(
        args.diagnose
          ? {
              ...state,
              locks: await workspaceLocks(
                state.lastFailure?.plan.source ?? ctx.cwd,
                signal,
              ),
            }
          : state,
      );
    },
  });
  pi.registerTool({
    name: "project_resolve",
    label: "Resolve evidence path",
    description:
      "Resolve an old absolute path through explicit workspace rename history without changing old messages or reading files.",
    parameters: Type.Object({ path: Type.String() }),
    async execute(_id, args, _signal, _update, ctx) {
      try {
        return result({
          original: args.path,
          resolved: resolvePath(ctx, args.path),
        });
      } catch (error) {
        return result(String(error), true);
      }
    },
  });
  pi.registerTool({
    name: "project_apply",
    label: "Apply authorized workspace change",
    description:
      "Apply the exact one-use authorization from a direct natural-language user workspace rename/switch request or /project allow. Read project_status for authorization.id. Call alone; ends the model run, then replacement occurs after settlement. A queued result is not migration success.",
    executionMode: "sequential",
    exposure: "model-only",
    parameters: Type.Object({ authorizationId: Type.String() }),
    async execute(_id, args, signal, _update, ctx) {
      if (ctx.mode === "print" || ctx.mode === "json")
        return result(
          "One-shot mode cannot queue a post-settlement workspace replacement. Run /project rename or /project switch as a user command first.",
          true,
        );
      const allowed = grant;
      if (
        !allowed ||
        allowed.id !== args.authorizationId ||
        allowed.sessionId !== ctx.sessionManager.getSessionId() ||
        Date.now() >= allowed.expiresAt ||
        pending ||
        running ||
        signal?.aborted
      )
        return result(
          "No matching live one-use authorization. Ask the user for a direct instruction naming the exact workspace destination, e.g. 把当前工作区改名为“新名称” or 把当前会话的工作区切换到“绝对路径”. Do not use shell to bypass this. /project allow remains available.",
          true,
        );
      grant = undefined;
      const version = requestVersion;
      applying = true;
      try {
        await suspend(current());
        if (
          signal?.aborted ||
          !alive ||
          version !== requestVersion ||
          Date.now() >= allowed.expiresAt
        ) {
          current().finishRelocation();
          return result("Workspace change cancelled", true);
        }
        pending = allowed;
        return {
          ...result({ queued: true, ...allowed.plan }),
          terminate: true,
        };
      } catch (error) {
        current().finishRelocation();
        return result(String(error), true);
      } finally {
        applying = false;
      }
    },
  });
  pi.registerCommand("project", {
    description:
      "Workspace: restore [session-file] | status | rename <name> | switch <path> | allow rename/switch <target> | revoke | resolve <old-path> | recover",
    handler: async (args, ctx) => {
      try {
        const match = /^(\S+)(?:\s+([\s\S]*))?$/.exec(args.trim());
        const command = match?.[1] ?? "status";
        let target = (match?.[2] ?? "").trim();
        if (command === "restore") {
          await restoreHere(
            target ? target.replace(/^(["'])(.*)\1$/, "$2") : undefined,
            ctx,
          );
          return;
        }
        if (command === "_settled") {
          const op = pending;
          if (!settlementToken || target !== settlementToken || !op)
            throw new Error("No matching settled workspace request");
          settlementToken = undefined;
          pending = undefined;
          if (
            !alive ||
            running ||
            Date.now() >= op.expiresAt ||
            op.sessionId !== ctx.sessionManager.getSessionId()
          )
            throw new Error("Workspace request expired or session changed");
          await migrate(op.plan, ctx, requestVersion);
          return;
        }
        if (command === "status") {
          ctx.ui.notify(JSON.stringify(status(ctx), null, 2), "info");
          return;
        }
        if (command === "revoke") {
          clear();
          ctx.ui.notify(
            "Workspace grant revoked; execution remains under user control",
            "info",
          );
          return;
        }
        if (command === "resolve") {
          ctx.ui.notify(
            resolvePath(ctx, target.replace(/^(["'])(.*)\1$/, "$2")),
            "info",
          );
          return;
        }
        if (command === "recover") {
          const r = current().store.get<Relocation>("relocation");
          if (
            !r ||
            r.sessionId !== ctx.sessionManager.getSessionId() ||
            r.plan.target !== ctx.cwd
          )
            throw new Error("No matching relocation to recover");
          await commitRelocation(r);
          ctx.ui.notify(
            "Workspace registry commit recovered; inspect /project status, then /mission resume",
            "info",
          );
          return;
        }
        if (running || applying || pending)
          throw new Error("A workspace change is already pending");
        let action = command;
        if (command === "allow") {
          const parts = /^(rename|switch)\s+([\s\S]+)$/.exec(target);
          if (!parts)
            throw new Error("Use /project allow rename|switch <target>");
          action = parts[1];
          target = parts[2];
        }
        if (action !== "rename" && action !== "switch")
          throw new Error(
            "Use /project status|rename|switch|allow|revoke|resolve|recover",
          );
        target = target.replace(/^(["'])(.*)\1$/, "$2");
        const plan = planRelocation(action, target, ctx.cwd);
        if (command === "allow") {
          grant = {
            id: randomUUID(),
            plan,
            ctx,
            sessionId: ctx.sessionManager.getSessionId(),
            expiresAt: Date.now() + 600000,
            origin: "command",
          };
          pi.sendMessage(authorizationMessage(grant), { triggerTurn: false });
          ctx.ui.notify(
            "One-use workspace grant created for ten minutes",
            "info",
          );
          return;
        }
        grant = undefined;
        await migrate(plan, ctx);
      } catch (error) {
        ctx.ui.notify(String(error), "error");
      }
    },
  });
  pi.registerTool({
    name: "project_recover",
    label: "Recover workspace registry commit",
    executionMode: "sequential",
    description:
      "Finish only an already-persisted workspace relocation whose session and destination match this exact current workspace. Does not create a new authorization, move new paths or release the user relocation hold.",
    parameters: Type.Object({}),
    async execute(_id, _args, _signal, _update, ctx) {
      try {
        const r = current().store.get<Relocation>("relocation");
        if (
          !r ||
          r.sessionId !== ctx.sessionManager.getSessionId() ||
          r.plan.target !== ctx.cwd ||
          running ||
          pending
        )
          throw new Error("No matching settled relocation journal to recover");
        await commitRelocation(r);
        current().store.event("lead.project-recovered", r.sessionId);
        return result({
          recovered: true,
          held: current().store.get("relocationHold") ?? false,
        });
      } catch (error) {
        return result(String(error), true);
      }
    },
  });
}
