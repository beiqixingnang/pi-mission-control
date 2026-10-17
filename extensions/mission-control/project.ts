import { randomUUID } from "node:crypto";
import { Type } from "typebox";
import type {
  ExtensionAPI,
  ExtensionContext,
  ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import type { MissionKernel } from "../../runtime/kernel.ts";
import {
  planRelocation,
  prepareRelocation,
  commitRelocation,
  rollbackRelocation,
  writeRelocationJournal,
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
  ctx: ExtensionCommandContext;
}

export function installProject(pi: ExtensionAPI, current: () => MissionKernel) {
  let grant: Grant | undefined,
    pending: Grant | undefined,
    timer: ReturnType<typeof setTimeout> | undefined;
  let running = false,
    internal = false,
    alive = true;
  const clear = () => {
    grant = undefined;
    pending = undefined;
    if (timer) clearTimeout(timer);
    timer = undefined;
  };
  pi.on("session_start", () => {
    alive = true;
    clear();
  });
  pi.on("session_shutdown", () => {
    alive = false;
    clear();
  });
  pi.on("session_tree", clear);
  pi.events.on("mission-control:interrupt", () => {
    if (!internal) clear();
  });
  function identity(ctx: ExtensionContext) {
    const id = current().store.get<string>("projectId");
    return id
      ? (lookupProject(id) ?? getProjectIdentity(ctx.cwd))
      : getProjectIdentity(ctx.cwd);
  }
  const status = (ctx: ExtensionContext) => {
    if (grant && Date.now() >= grant.expiresAt) grant = undefined;
    return {
      project: identity(ctx),
      cwd: ctx.cwd,
      sessionId: ctx.sessionManager.getSessionId(),
      sessionFile: ctx.sessionManager.getSessionFile(),
      busy: running || Boolean(pending),
      authorization: grant
        ? { id: grant.id, ...grant.plan, expiresAt: grant.expiresAt }
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
  async function migrate(plan: RelocationPlan, ctx: ExtensionCommandContext) {
    if (running) throw new Error("Workspace relocation already running");
    const kernel = current();
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
      const fresh = planRelocation(plan.action, plan.target, ctx.cwd);
      if (fresh.source !== plan.source || fresh.target !== plan.target)
        throw new Error("Workspace changed since authorization");
      await suspend(kernel);
      if (!ctx.isIdle()) {
        ctx.abort();
        await ctx.waitForIdle();
      }
      if (ctx.hasPendingMessages())
        throw new Error("Queued input appeared; workspace was not changed");
      relocation = await prepareRelocation(fresh, ctx, kernel);
      if (!alive)
        throw new Error(
          "Original session closed during workspace preparation; operation rolled back",
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
      if (relocation && !attempted && !cancelled)
        await rollbackRelocation(relocation);
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
      try {
        ctx.ui.notify(
          `${String(error)}${relocation && attempted ? `\nRecovery session: ${relocation.sessionFile}\nJournal: ${relocation.journal}` : ""}`,
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
      pending = undefined;
      if (!op || !alive) return;
      if (
        Date.now() >= op.expiresAt ||
        op.ctx.sessionManager.getSessionId() !== op.sessionId
      ) {
        op.ctx.ui.notify(
          "Workspace grant expired or session changed",
          "warning",
        );
        return;
      }
      void migrate(op.plan, op.ctx).catch((error) =>
        console.error(String(error)),
      );
    }, 0);
    timer.unref?.();
  });
  pi.registerTool({
    name: "project_status",
    label: "Project status",
    description:
      "Read workspace identity, relocation hold and one-use user authorization.",
    parameters: Type.Object({}),
    async execute(_id, _args, _signal, _update, ctx) {
      return result(status(ctx));
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
          resolved: resolveProjectPath(identity(ctx).id, args.path),
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
      "Apply the exact one-use /project allow grant. Ends the model run; replacement occurs only after settlement.",
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
          "No matching live one-use grant. User command: /project allow rename <name> or /project allow switch <path>.",
          true,
        );
      grant = undefined;
      try {
        await suspend(current());
        if (signal?.aborted) {
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
      }
    },
  });
  pi.registerCommand("project", {
    description:
      "Workspace: status | rename <name> | switch <path> | allow rename/switch <target> | revoke | resolve <old-path> | recover",
    handler: async (args, ctx) => {
      try {
        const match = /^(\S+)(?:\s+([\s\S]*))?$/.exec(args.trim());
        const command = match?.[1] ?? "status";
        let target = (match?.[2] ?? "").trim();
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
            resolveProjectPath(
              identity(ctx).id,
              target.replace(/^(["'])(.*)\1$/, "$2"),
            ),
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
        if (running || pending)
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
          };
          pi.sendMessage(
            {
              customType: "project-authorization",
              content: `User authorized one workspace ${action}: ${plan.source} -> ${plan.target}. Call project_apply alone with authorizationId ${grant.id}; expires in ten minutes.`,
              display: true,
            },
            { triggerTurn: false },
          );
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
}
