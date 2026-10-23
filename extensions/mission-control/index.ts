import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { finished } from "node:stream/promises";
import { randomUUID } from "node:crypto";
import { workspaceResumeInstruction } from "../../runtime/workspace-control.ts";
import { Type, type TSchema } from "typebox";
import {
  getAgentDir,
  getPackageDir,
  copyToClipboard,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { MissionKernel } from "../../runtime/kernel.ts";
import { runArchive } from "../../runtime/archive/job.ts";
import { openBridge } from "../../runtime/bridge.ts";
import { createWorkerFactory } from "../../runtime/rpc-worker.ts";
import {
  cleanText,
  textOf,
  streamPublicSession,
} from "../../runtime/public.ts";
import {
  terminal,
  type Settings,
  type Workspace,
  type Wake,
} from "../../runtime/types.ts";
import { resolveWorkspace } from "../workspace/policy.ts";
import { searchWeb, fetchPage } from "../../runtime/web.ts";
import { board } from "./ui.ts";
import { MissionPanel } from "./viewer.ts";
import { GoalPanel } from "./goals-ui.ts";
import { installLeadHistory } from "./lead-history.ts";
import {
  memberSessionFiles,
  transcriptPage,
} from "../../runtime/transcript.ts";
import installReconnect from "./reconnect.ts";
import { installProject } from "./project.ts";
import {
  goalPlanningGuidance,
  delegationGuidance,
} from "../../runtime/guidance.ts";
import { taskTiming } from "../../runtime/task-policy.ts";
import {
  delegationInput,
  optionalText,
  workspaceInput,
} from "../../runtime/arguments.ts";

const optional = (schema: any) =>
  Type.Optional(Type.Union([schema, Type.Null()]));
const timingSchema = {
  timeoutPolicy: optional(
    Type.Union([Type.Literal("none"), Type.Literal("fixed")]),
  ),
  timeoutMs: optional(
    Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
  ),
  queueTimeoutMs: optional(
    Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
  ),
};
const scopeSchema = Type.Object({
  unitKind: Type.Union(
    ["file", "module", "batch", "artifact"].map((value) => Type.Literal(value)),
  ),
  items: Type.Array(Type.String({ minLength: 1, maxLength: 400 }), {
    minItems: 1,
    maxItems: 100,
  }),
  files: Type.Optional(
    Type.Array(Type.String({ minLength: 1, maxLength: 400 }), {
      minItems: 1,
      maxItems: 100,
    }),
  ),
});
const pluginVersion: string = JSON.parse(
  fsSync.readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
).version;

const WorkspaceSchema = Type.Object({
  root: optional(Type.String()),
  access: optional(
    Type.Union([Type.Literal("read-only"), Type.Literal("read-write")]),
  ),
  execution: optional(
    Type.Union([
      Type.Literal("host"),
      Type.Literal("sandbox"),
      Type.Literal("files"),
    ]),
  ),
  extraReadRoots: optional(Type.Array(Type.String(), { maxItems: 20 })),
  sandbox: optional(
    Type.Object({
      engine: optional(Type.Literal("podman")),
      image: optional(Type.String()),
      cpus: optional(Type.Number()),
      memoryMb: optional(Type.Number()),
      pidsLimit: optional(Type.Number()),
      maxSeconds: optional(Type.Number()),
    }),
  ),
});
const evidence = Type.Array(
  Type.Object({
    criterion: Type.Integer({ minimum: 1 }),
    evidence: Type.String({ minLength: 8, maxLength: 2000 }),
  }),
  { maxItems: 30 },
);
const goalEvidence = Type.Array(
  Type.Object({
    criterion: Type.Integer({ minimum: 1 }),
    summary: Type.String({ minLength: 8, maxLength: 2000 }),
    source: Type.Union(
      ["statement", "artifact", "task", "tool", "acceptance"].map((value) =>
        Type.Literal(value),
      ),
    ),
    path: Type.Optional(Type.String()),
    taskId: Type.Optional(Type.String()),
    receiptId: Type.Optional(Type.String()),
    acceptanceId: Type.Optional(Type.String()),
  }),
  { minItems: 1, maxItems: 100 },
);
const textResult = (value: unknown) => {
  const text =
    typeof value === "string" ? value : JSON.stringify(value, null, 2);
  return {
    details: undefined,
    content: [
      {
        type: "text" as const,
        text:
          text.length > 32000
            ? text.slice(0, 32000) +
              "\n[Bounded view. Retrieve a specific task result for more detail.]"
            : text,
      },
    ],
  };
};

export default function (pi: ExtensionAPI) {
  if (process.env.MC_V2_MEMBER) return;
  pi.registerMessageRenderer(
    "mission-control-wake",
    (message, options, theme) =>
      new Text(
        options.expanded
          ? cleanText(String(message.content), 18000)
          : theme.fg("accent", "Mission Control · 团队结果或计划检查已到达") +
            "\n" +
            theme.fg(
              "muted",
              "按 Pi 的工具详情展开键查看内容；/mission 查看任务与交付",
            ),
        0,
        0,
      ),
  );
  let kernel: MissionKernel | undefined,
    ctx: ExtensionContext | undefined,
    bridge: Awaited<ReturnType<typeof openBridge>> | undefined;
  let redraw: (() => void) | undefined,
    renderTimer: ReturnType<typeof setTimeout> | undefined;
  let panel: MissionPanel | undefined;
  let goalPanel: GoalPanel | undefined;
  let removeCompactionListener: (() => void) | undefined;
  let activeCompactionRun: string | undefined;
  let agentsOpen = false;
  const archiveControllers = new Set<AbortController>();
  let archiveGeneration = 0;
  const sourceCache = new Map<string, string>();
  const sourcePath = (value: string) => {
    const cached = sourceCache.get(value);
    if (cached) return cached;
    const file = value.startsWith("file:") ? fileURLToPath(value) : value;
    let resolved = path.resolve(file);
    try {
      resolved = fsSync.realpathSync.native(resolved);
    } catch {}
    const normalized =
      process.platform === "win32" ? resolved.toLowerCase() : resolved;
    sourceCache.set(value, normalized);
    return normalized;
  };
  const leadSources = new Set(
    [import.meta.url, new URL("./compaction.ts", import.meta.url).href].map(
      sourcePath,
    ),
  );
  const missionTools = () =>
    pi
      .getAllTools()
      .filter(
        (t) =>
          t.exposure !== "hidden" &&
          leadSources.has(sourcePath(t.sourceInfo.path)),
      );
  const activateMissionTools = () => {
    const available = new Set(pi.getAllTools().map((t) => t.name));
    const active = new Set(
      pi.getActiveTools().filter((name) => available.has(name)),
    );
    for (const tool of missionTools()) active.add(tool.name);
    pi.setActiveTools([...active]);
  };
  const runtimeIdentity = () => {
    const active = new Set(pi.getActiveTools());
    return {
      version: pluginVersion,
      toolDelivery: "direct model declarations from the host registry",
      registeredMissionTools: missionTools().length,
      recoveryTools: Object.fromEntries(
        ["mission_reconcile", "mission_control", "mission_capabilities"].map(
          (name) => [name, active.has(name)],
        ),
      ),
    };
  };
  const current = () => {
    if (!kernel)
      throw new Error("Mission Control is not attached to a Pi session");
    return kernel;
  };
  function modelStatus() {
    const snapshot = current().snapshot();
    const report = { runtime: runtimeIdentity(), ...snapshot };
    if (JSON.stringify(report).length <= 30000) return report;
    const m = snapshot.mission;
    return {
      ...report,
      recoveryPlan: current().recoveryPlan(5),
      // Preserve structured recovery instructions instead of cutting a JSON string.
      mission: m
        ? {
            ...m,
            objective: cleanText(m.objective, 1200),
            criteria: m.criteria
              .slice(0, 3)
              .map((text) => cleanText(text, 200)),
            evidence: m.evidence?.slice(0, 3).map((item) => ({
              ...item,
              evidence: cleanText(item.evidence, 200),
            })),
          }
        : undefined,
      members: snapshot.members.slice(0, 8).map((member) => ({
        id: member.id,
        name: member.name,
        model: member.model,
        sessionId: member.sessionId,
      })),
      tasks: snapshot.tasks.slice(0, 12).map((task) => ({
        id: task.id,
        memberId: task.memberId,
        member: task.member,
        missionId: task.missionId,
        state: task.state,
        processState: task.processState,
        epoch: task.epoch,
        attemptOf: task.attemptOf,
      })),
      deliveries: snapshot.deliveries.slice(0, 8).map((delivery) => ({
        id: delivery.id,
        from: delivery.from,
        kind: delivery.kind,
        state: delivery.state,
        taskId: delivery.taskId,
        summary: cleanText(delivery.summary, 200),
      })),
      schedules: snapshot.schedules.slice(0, 8).map((schedule) => ({
        id: schedule.id,
        title: cleanText(schedule.title, 200),
        state: schedule.state,
        nextAt: schedule.nextAt,
      })),
      bounded: true,
      counts: {
        criteria: m?.criteria.length ?? 0,
        members: snapshot.members.length,
        tasks: snapshot.tasks.length,
        deliveries: snapshot.deliveries.length,
        schedules: snapshot.schedules.length,
      },
      details:
        "Large fields and lists are excerpted. Use team_list, team_tree, team_collect or lifecycle_history for specific details; recoveryPlan contains the next exact recovery call.",
    };
  }
  const refresh = () => {
    if (renderTimer) return;
    renderTimer = setTimeout(() => {
      renderTimer = undefined;
      if (!ctx || !kernel) return;
      if (ctx.mode === "tui") {
        if (!agentsOpen)
          ctx.ui.setWidget(
            "mission-control",
            (_tui, theme) => ({
              render: (width) => {
                try {
                  return board(
                    current(),
                    width,
                    false,
                    theme,
                    process.stdout.rows ?? 30,
                  );
                } catch {
                  return board(
                    current(),
                    width,
                    false,
                    undefined,
                    process.stdout.rows ?? 30,
                  );
                }
              },
              invalidate() {},
            }),
            { placement: "aboveEditor" },
          );
        ctx.ui.setStatus(
          "mission-control",
          kernel.snapshot().mission?.status ?? "ready",
        );
        redraw?.();
      }
    }, 100);
    renderTimer.unref?.();
  };
  const leadHistory = installLeadHistory(pi, () => {
    if (panel?.scope === "lead") refresh();
  });
  const close = async () => {
    archiveGeneration++;
    for (const controller of archiveControllers) controller.abort();
    removeCompactionListener?.();
    removeCompactionListener = undefined;
    activeCompactionRun = undefined;
    goalPanel?.dispose();
    goalPanel = undefined;
    panel?.dispose();
    panel = undefined;
    agentsOpen = false;
    const old = kernel;
    kernel = undefined;
    if (renderTimer) clearTimeout(renderTimer);
    renderTimer = undefined;
    await old?.close();
    await bridge?.close();
    bridge = undefined;
    ctx?.ui.setWidget("mission-control", undefined);
    ctx?.ui.setStatus("mission-control", undefined);
    ctx?.ui.setStatus("mission-export", undefined);
  };
  pi.on("session_start", async (_event, context) => {
    await close();
    ctx = context;
    removeCompactionListener = pi.events.on(
      "mission-control:compaction-state",
      (value: any) => {
        if (
          value?.scope !== "lead" ||
          value.sessionId !== kernel?.options.sessionId
        )
          return;
        if (typeof value.runId !== "string") return;
        if (value.phase === "started") {
          activeCompactionRun = value.runId;
          kernel?.compactionStarted();
        }
        if (value.phase === "failed" && value.runId === activeCompactionRun)
          kernel?.compactionSettled(
            undefined,
            String(value.error ?? "Summary failed"),
          );
      },
    );
    // Resumed sessions replay their historical active-tool set. Re-add tools
    // introduced by a newer plugin version before the next model request.
    activateMissionTools();
    const settingsFile = path.join(getAgentDir(), "mission-control.json");
    let settings: Partial<Settings> = {};
    try {
      settings = JSON.parse(await fs.readFile(settingsFile, "utf8"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const sessionId = context.sessionManager.getSessionId() ?? randomUUID();
    if (!/^[a-zA-Z0-9_-]{1,120}$/.test(sessionId))
      throw new Error("Invalid session identity");
    const directory = path.join(
      getAgentDir(),
      "mission-control",
      "v2",
      sessionId,
    );
    kernel = new MissionKernel({
      directory,
      sessionId,
      cwd: context.cwd,
      settings,
      workerFactory: createWorkerFactory(
        path.join(getPackageDir(), "dist/bundle/cli.js"),
        fileURLToPath(new URL("./member.ts", import.meta.url)),
      ),
      isLeadIdle: () => Boolean(ctx?.isIdle() && !ctx?.hasPendingMessages()),
      onChange: refresh,
      wake: (wake) =>
        pi.sendMessage(
          {
            customType: "mission-control-wake",
            content: wake.content,
            display: true,
            details: {
              batchId: wake.batchId,
              generation: wake.generation,
              deliveryIds: wake.deliveryIds,
            },
          },
          { triggerTurn: true },
        ),
      notify: (message) => ctx?.ui.notify(message, "warning"),
      compact: () => ctx?.compact(),
    });
    try {
      bridge = await openBridge((token, request) =>
        current().memberRequest(token, request),
      );
      kernel.bridgeUrl = bridge.url;
      kernel.start();
      if (
        !context.sessionManager
          .getBranch()
          .some(
            (e) =>
              e.type === "custom" &&
              e.customType === "mission-control-v2" &&
              (e.data as any)?.sessionId === sessionId,
          )
      )
        pi.appendEntry("mission-control-v2", {
          schema: 2,
          sessionId,
          stateDirectory: directory,
        });
    } catch (error) {
      await close();
      throw error;
    }
    refresh();
  });
  pi.on("session_shutdown", async () => {
    await close();
    ctx = undefined;
  });
  pi.on("input", (event) => {
    if (event.source === "interactive" && !event.text.startsWith("/"))
      kernel?.onHumanInput(event.text);
  });
  pi.on("before_agent_start", (event, context) => {
    ctx = context;
    // A resumed session can restore its historical tool declaration before
    // session_start finishes. Reapply the current registry immediately before
    // building this model request, including schema changes to existing tools.
    activateMissionTools();
    event.systemPromptOptions.promptGuidelines.unshift(
      goalPlanningGuidance,
      delegationGuidance,
    );
    event.systemPromptOptions.promptGuidelines.unshift(
      `Mission Control ${pluginVersion}: mission_reconcile and mission_control are directly callable lead tools. When the current recovery plan permits model recovery, inspect the actual blocker and use these tools; old claims that only a user slash command can reconcile or resume no_progress are obsolete. Reload itself never attests stopped processes. Explicit user/workspace/budget/decision controls remain authoritative.`,
    );
    event.systemPromptOptions.promptGuidelines.unshift(
      "Mission Control autonomy policy: choose implementation details, retries, commands, files, member assignments and formatting within the approved scope. Ask the user only for a concrete business boundary (scope, acceptance, permission, budget, deadline, release or irreversible risk). Do not call mission_decision for generic validation, planning, implementation or execution choices.",
    );
    event.systemPromptOptions.promptGuidelines.unshift(
      "For work with multiple deliverables, inventory the required modules, outputs and checks, then register stages and leaf goals with goal_plan before implementation. Declare stage dependsOn gates to preserve the approved batch order. Use goal_tree to recover exact progress, goal_focus before execution, goal_edit for blockers/next steps and goal_accept for evidence against every criterion. These are directly callable tools: fill missing plan/focus/evidence yourself within approved scope. Acceptance is recorded once and reused; model statements are labelled claims. Keep multiple main goals with one selected through goal_activate. Default depth is three; flatten excess detail into execution tasks rather than routinely asking for more depth.",
    );
    const wake =
      event.messageType === "custom" &&
      event.message.customType === "mission-control-wake"
        ? (event.message.details as any)
        : undefined;
    if (wake && kernel && !kernel.validWake(wake.batchId, wake.generation)) {
      kernel.rejectStaleWake();
      context.abort();
      return;
    }
    kernel?.leadStarted(
      wake
        ? {
            ...wake,
            content:
              event.messageType === "custom"
                ? String(event.message.content)
                : "",
          }
        : undefined,
    );
    const reminder = kernel?.context();
    if (reminder) event.systemPromptOptions.promptGuidelines.push(reminder);
  });
  pi.on("context", (event, context) => {
    if (kernel && !kernel.admitLeadRequest()) {
      context.abort();
      return;
    }
    for (const message of event.messages as any[]) {
      if (
        message.role === "custom" &&
        message.customType === "mission-control-wake" &&
        message.details?.batchId
      )
        kernel?.includeWake(message.details.batchId);
      if (
        message.role === "toolResult" &&
        Array.isArray(message.details?.missionDeliveryIds)
      )
        kernel?.includeCollected(message.details.missionDeliveryIds);
    }
  });
  pi.on("message_end", (event, context) => {
    if (event.message.role === "assistant") {
      const cancelled =
        Boolean(context.signal?.aborted) &&
        ["error", "aborted"].includes(event.message.stopReason);
      kernel?.leadMessage(
        !cancelled &&
          (event.message.stopReason === "error" ||
            Boolean(
              event.message.errorMessage &&
                event.message.stopReason !== "aborted",
            ) ||
            event.message.stopReason === "aborted"),
        event.message.usage?.output ?? 0,
        event.message.errorMessage,
        cancelled,
      );
    }
  });
  pi.on("agent_settled", (event) => {
    kernel?.leadSettled(event.aborted);
    refresh();
  });
  pi.on("session_compact", (event, context) => {
    if (
      kernel?.options.sessionId === context.sessionManager.getSessionId() &&
      context.sessionManager
        .getBranch()
        .some((entry) => entry.id === event.compactionEntry.id)
    ) {
      kernel.compactionSettled(event.compactionEntry.id);
      activeCompactionRun = undefined;
    }
  });
  pi.on("session_compact_failed", (event) => {
    kernel?.compactionSettled(
      undefined,
      event.errorMessage ??
        (event.aborted ? "Compaction cancelled" : "Compaction failed"),
    );
    activeCompactionRun = undefined;
  });
  pi.on("session_tree", async () => {
    if (
      kernel?.store.mission() &&
      !["complete", "stopped"].includes(kernel.store.mission()!.status)
    ) {
      await kernel.userControl("pause");
      ctx?.ui.notify(
        "Session branch changed. Work and results are retained; /mission resume explicitly reconnects the mission to this branch.",
        "info",
      );
    }
  });
  pi.on("tool_call", (event) => {
    if (
      !kernel ||
      !["write", "edit", "bash", "powershell"].includes(event.toolName)
    )
      return;
    if (kernel.store.get("relocationHold"))
      return { block: true, reason: workspaceResumeInstruction };
    const mission = kernel.store.mission();
    if (!mission || ["complete", "stopped"].includes(mission.status)) return;
    try {
      // A pre-existing flat goal remains compatible. Planned work requires focus.
      if (
        kernel.goals.children(mission.id).length &&
        (mission.status !== "active" ||
          kernel.snapshot().held ||
          mission.humanPaused ||
          kernel.store.get("relocationHold"))
      )
        throw new Error("Resolve mission holds before executing planned work");
      kernel.goals.captureStart(event.toolCallId, event.toolName, event.input);
    } catch (error) {
      return { block: true, reason: String((error as Error).message ?? error) };
    }
  });
  pi.on("tool_result", (event) => {
    kernel?.goals.captureEnd(
      event.toolCallId,
      textOf({ content: event.content }),
      event.isError,
    );
    if (!event.isError && ["write", "edit"].includes(event.toolName))
      kernel?.leadActed();
  });

  function tool(
    name: string,
    label: string,
    description: string,
    parameters: TSchema,
    execute: (
      args: any,
      signal: AbortSignal | undefined,
      context: any,
    ) => unknown | Promise<unknown>,
    terminate: boolean | ((context: any) => boolean) = false,
  ) {
    pi.registerTool({
      name,
      label,
      description,
      parameters,
      executionMode: "sequential",
      async execute(_id, args, signal, _update, context) {
        try {
          const value: any = await execute(args, signal, context);
          const ids = value?.$deliveryIds;
          const body = ids ? value.data : value;
          return {
            ...textResult(body),
            ...(ids ? { details: { missionDeliveryIds: ids } } : {}),
            ...((
              typeof terminate === "function" ? terminate(context) : terminate
            )
              ? { terminate: true }
              : {}),
          };
        } catch (error) {
          return {
            ...textResult(String((error as Error).message ?? error)),
            isError: true,
          };
        }
      },
    });
  }
  async function exportPublic(
    context: ExtensionContext,
    destination: string,
    signal?: AbortSignal,
    includeArchived = false,
  ) {
    signal?.throwIfAborted();
    if (!destination.trim())
      throw new Error("A new export destination is required");
    const target = path.resolve(context.cwd, destination);
    // Open exclusively before streaming; an asynchronous EEXIST can otherwise
    // destroy the stream before a producer starts awaiting a drain event.
    const out = fsSync.createWriteStream(target, {
      fd: fsSync.openSync(target, "wx", 0o600),
      autoClose: true,
    });
    const completed = finished(out);
    void completed.catch(() => {});
    const abort = () =>
      out.destroy(new Error("Public export cancelled; partial file retained"));
    signal?.addEventListener("abort", abort, { once: true });
    let count = 0;
    try {
      const files = [
        context.sessionManager.getSessionFile(),
        ...current()
          .store.members(includeArchived)
          .map((m) => m.sessionFile),
      ].filter((x): x is string => Boolean(x));
      for (const member of current().store.members(includeArchived))
        files.push(
          ...(await memberSessionFiles(current().store.directory, member.id)),
        );
      for (const file of [...new Set(files)]) {
        signal?.throwIfAborted();
        out.write(JSON.stringify({ type: "source", sessionFile: file }) + "\n");
        count += await streamPublicSession(file, out, signal);
      }
      out.end();
      await completed;
      return { destination: target, entries: count };
    } catch (error) {
      out.destroy();
      await completed.catch(() => {});
      throw error;
    } finally {
      signal?.removeEventListener("abort", abort);
    }
  }
  async function exportArchive(
    context: ExtensionContext,
    destination: string,
    signal?: AbortSignal,
    includeArchived?: boolean,
  ) {
    if (!destination.trim())
      throw new Error("A new archive directory is required");
    const k = current(),
      sessionFile = context.sessionManager.getSessionFile();
    if (!sessionFile) throw new Error("A saved Pi conversation is required");
    const controller = new AbortController(),
      epoch = archiveGeneration;
    archiveControllers.add(controller);
    const sessionId = context.sessionManager.getSessionId()!;
    const currentScope = () =>
      epoch === archiveGeneration &&
      context.sessionManager.getSessionId() === sessionId;
    try {
      return await runArchive(
        {
          stateDirectory: k.options.directory,
          sessionFile,
          sessionId,
          leafId: context.sessionManager.getLeafId() ?? undefined,
          destination: path.resolve(context.cwd, destination),
          includeArchived,
        },
        {
          signal: signal
            ? AbortSignal.any([signal, controller.signal])
            : controller.signal,
          onProgress: (value) => {
            if (currentScope() && context.mode === "tui")
              context.ui.setStatus(
                "mission-export",
                `归档 ${value.phase}${value.bytes !== undefined ? ` · ${Math.floor(value.bytes / 1048576)} MiB` : ""}`,
              );
          },
        },
      );
    } finally {
      archiveControllers.delete(controller);
      if (currentScope() && context.mode === "tui")
        context.ui.setStatus("mission-export", undefined);
    }
  }
  async function workspace(
    raw: any,
    context: ExtensionContext,
  ): Promise<Workspace> {
    raw = workspaceInput(raw);
    const execution =
      raw?.execution ??
      (raw?.access === "read-only"
        ? "files"
        : current().settings.defaultExecution);
    if (execution === "host" && raw?.access === "read-only")
      throw new Error(
        "Read-only + host shell cannot be enforced. Use files or sandbox for read-only members.",
      );
    const w = await resolveWorkspace(
      {
        root: raw?.root ?? context.cwd,
        access: raw?.access ?? "read-write",
        execution: execution === "files" ? "disabled" : execution,
        extraReadRoots: raw?.extraReadRoots ?? [],
        sandbox: raw?.sandbox,
      },
      context.cwd,
    );
    return { ...w, execution };
  }
  const spawnSchema = Type.Object({
    name: Type.String({ maxLength: 48 }),
    role: Type.String({ minLength: 1, maxLength: 12000 }),
    model: optional(Type.String()),
    thinkingLevel: optional(
      Type.Union(
        ["off", "minimal", "low", "medium", "high", "xhigh", "max"].map((x) =>
          Type.Literal(x),
        ),
      ),
    ),
    workspace: optional(WorkspaceSchema),
    tools: optional(
      Type.Array(Type.String({ minLength: 1 }), { maxItems: 100 }),
    ),
    communication: optional(
      Type.Object({ allow: Type.Array(Type.String(), { maxItems: 50 }) }),
    ),
  });
  async function prepareMember(
    args: any,
    context: ExtensionContext,
    temporary = false,
  ) {
    const model =
      optionalText(args.model) ??
      (context.model
        ? `${context.model.provider}/${context.model.id}`
        : undefined);
    if (model) {
      const slash = model.indexOf("/");
      if (
        slash < 1 ||
        !context.modelRegistry.find(
          model.slice(0, slash),
          model.slice(slash + 1),
        )
      )
        throw new Error(`Unknown configured member model: ${model}`);
    }
    return {
      name: args.name,
      role: args.role,
      model,
      thinkingLevel: optionalText(args.thinkingLevel) ?? pi.getThinkingLevel(),
      workspace: await workspace(args.workspace, context),
      allow: args.communication?.allow ?? [],
      tools: args.tools ?? undefined,
      temporary,
    };
  }
  async function addMember(
    args: any,
    context: ExtensionContext,
    temporary = false,
  ) {
    return current().addMember(await prepareMember(args, context, temporary));
  }
  tool(
    "team_spawn",
    "Create team member",
    "Create a persistent team identity and explicit capabilities. Tasks automatically enroll in runtime maintenance; no Goal or supervisor setup is required. Host means trusted unconfined commands, sandbox requires configured Podman.",
    spawnSchema,
    (args, _signal, context) => addMember(args, context),
  );
  tool(
    "team_configure",
    "Configure idle member",
    "Change an idle member's role/model/workspace/communication or optional tool allowlist. Omit tools to keep the current list; tools:null restores all permitted tools. Existing running work must finish or be cancelled.",
    Type.Object({
      name: Type.String(),
      role: optional(Type.String()),
      model: optional(Type.String()),
      thinkingLevel: optional(Type.String()),
      workspace: optional(WorkspaceSchema),
      tools: optional(
        Type.Array(Type.String({ minLength: 1 }), { maxItems: 100 }),
      ),
      communication: optional(
        Type.Object({ allow: Type.Array(Type.String()) }),
      ),
    }),
    async (args, _signal, context) => {
      if (args.model) {
        const slash = args.model.indexOf("/");
        if (
          slash < 1 ||
          !context.modelRegistry.find(
            args.model.slice(0, slash),
            args.model.slice(slash + 1),
          )
        )
          throw new Error(
            "Member model must name a configured provider/model-id",
          );
      }
      if (
        args.thinkingLevel &&
        !["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(
          args.thinkingLevel,
        )
      )
        throw new Error("Invalid thinking level");
      const patch: any = {};
      for (const key of ["role", "model", "thinkingLevel"])
        if (optionalText(args[key])) patch[key] = optionalText(args[key]);
      if (args.workspace)
        patch.workspace = await workspace(
          workspaceInput(
            args.workspace,
            current().store.member(args.name)?.workspace,
          ),
          context,
        );
      if (args.communication) patch.allow = args.communication.allow;
      if (args.tools !== undefined) patch.tools = args.tools ?? undefined;
      return current().configureMember(args.name, patch);
    },
  );
  tool(
    "team_disband",
    "Remove team member",
    "Stop a member's current work, archive its identity and remove it from the active roster. Use * for all persistent members; temporary subagents are removed automatically after their task settles.",
    Type.Object({
      name: Type.String({ minLength: 1, maxLength: 48 }),
      reason: Type.Optional(Type.String({ maxLength: 2000 })),
    }),
    (args) => current().disbandMember(args.name, args.reason),
  );
  const collected = (data: unknown, ids: string[]) => ({
    data,
    $deliveryIds: current()
      .store.deliveries("lead")
      .filter((d) => d.taskId && ids.includes(d.taskId))
      .map((d) => d.id),
  });
  const oneShot = (context: ExtensionContext) =>
    context.mode === "print" || context.mode === "json";
  tool(
    "team_send",
    "Assign team task",
    "Durably assign work. Choose deadlines for the actual task: none disables the total deadline; fixed requires positive timeoutMs. Queue timeout is separate. Default has no execution deadline unless configured. TUI/RPC wait:false returns immediately with automatic completion wakeups. One-shot print/json joins children.",
    Type.Object({
      to: Type.String(),
      message: Type.String({ minLength: 1, maxLength: 200000 }),
      wait: Type.Optional(Type.Boolean()),
      ...timingSchema,
      goalId: Type.Optional(Type.String()),
    }),
    async (args, signal, context) => {
      const task = current().dispatch(args.to, args.message, {
        timeoutMs: args.timeoutMs,
        timeoutPolicy: args.timeoutPolicy,
        queueTimeoutMs: args.queueTimeoutMs,
        goalId: args.goalId,
      });
      if (args.wait || oneShot(context))
        return collected(await waitForTask(task.id, signal), [task.id]);
      return {
        accepted: true,
        taskId: task.id,
        maintenance: "automatic",
        next: "Call mission_wait alone when no independent work remains",
      };
    },
  );
  async function waitForTask(id: string, signal?: AbortSignal) {
    while (true) {
      signal?.throwIfAborted();
      const task = current().store.task(id)!;
      if (terminal(task))
        return {
          task,
          result: task.resultPath
            ? current().store.readArtifact(task.resultPath)
            : undefined,
        };
      await new Promise<void>((resolve, reject) => {
        const abort = () => {
          clearTimeout(t);
          reject(
            new Error(
              "Wait cancelled; accepted task retained. Use team_cancel to cancel it.",
            ),
          );
        };
        const t = setTimeout(() => {
          signal?.removeEventListener("abort", abort);
          resolve();
        }, 100);
        signal?.addEventListener("abort", abort, { once: true });
      });
    }
  }
  tool(
    "team_broadcast",
    "Assign to team",
    "Assign the same approved input to selected members, enrolling every task in automatic maintenance.",
    Type.Object({
      members: Type.Array(Type.String(), { minItems: 1, maxItems: 16 }),
      message: Type.String({ maxLength: 200000 }),
      goalId: Type.Optional(Type.String()),
      ...timingSchema,
    }),
    async (args, signal, context) => {
      const tasks = current().store.transaction(() =>
        args.members.map((name: string) =>
          current().dispatch(name, args.message, {
            ...taskTiming(args, current().settings.taskTimeoutMs),
            goalId: args.goalId,
          }),
        ),
      );
      return oneShot(context)
        ? collected(
            await Promise.all(tasks.map((t: any) => waitForTask(t.id, signal))),
            tasks.map((t: any) => t.id),
          )
        : tasks;
    },
  );
  tool(
    "team_list",
    "Team status",
    "Read team definitions and actual task state. Avoid polling; task completion is automatic.",
    Type.Object({}),
    () => ({
      members: current().store.members(),
      tasks: current()
        .store.tasks()
        .map(({ inputPath, resultPath, ...t }) => ({ ...t, resultPath })),
      maintenance: current().snapshot().maintenance,
    }),
  );
  tool(
    "team_tree",
    "Task tree",
    "Read parent/task/attempt state and public result references.",
    Type.Object({}),
    () => current().store.tasks(),
  );
  tool(
    "team_collect",
    "Collect team result",
    "Retrieve a known task's saved public output; this does not re-execute it.",
    Type.Object({ taskId: Type.Optional(Type.String()) }),
    (args) => {
      const tasks = args.taskId
        ? [current().store.task(args.taskId)].filter(Boolean)
        : current().store.tasks().filter(terminal).slice(0, 5);
      return collected(
        tasks.map((t) => ({
          task: t,
          result: t?.resultPath
            ? current().store.readArtifact(t.resultPath, 24000)
            : undefined,
        })),
        tasks.map((t) => t!.id),
      );
    },
  );
  tool(
    "team_cancel",
    "Cancel task",
    "Cancel one task subtree or a member's tasks, retaining identities and evidence. This does not disable mission maintenance.",
    Type.Object({
      taskId: Type.Optional(Type.String()),
      jobId: Type.Optional(Type.String()),
      name: Type.Optional(Type.String()),
    }),
    async (args) => {
      const id = args.taskId ?? args.jobId;
      if (Boolean(id) === Boolean(args.name))
        throw new Error("Specify exactly one taskId or member name");
      const ids = id
        ? [id]
        : current()
            .store.tasks(true)
            .filter((t) => t.member === args.name)
            .map((t) => t.id);
      for (const taskId of ids) await current().cancelTask(taskId);
      return { cancelled: ids };
    },
  );
  tool(
    "team_resume",
    "New execution attempt",
    "After inspecting previous receipts, explicitly retry interrupted/failed/cancelled work under a new task identity. Never retry commands merely because a notification was delayed.",
    Type.Object({ taskId: Type.String() }),
    (args) => current().resumeTask(args.taskId),
  );
  tool(
    "team_message",
    "Message a teammate",
    "Send an approved instruction to a running member using steering; if idle, create a new tracked turn. This is separate from team_send, which always assigns a task.",
    Type.Object({
      to: Type.String(),
      message: Type.String({ minLength: 1, maxLength: 16000 }),
    }),
    (args) => current().messageMember(args.to, args.message),
  );
  tool(
    "subagent",
    "Delegate isolated task",
    "Run one task, parallel tasks, or a dependency chain. Choose workspace, tools and deadlines from the task rather than its role name. Default has full permitted development tools and no total deadline unless configured. Each task can override shared timing. All work is tracked; default is asynchronous.",
    Type.Object({
      agent: optional(Type.String()),
      task: optional(Type.String()),
      model: optional(Type.String()),
      workspace: optional(WorkspaceSchema),
      tools: optional(
        Type.Array(Type.String({ minLength: 1 }), { maxItems: 100 }),
      ),
      goalId: optional(Type.String()),
      ...timingSchema,
      tasks: optional(
        Type.Array(
          Type.Object({
            agent: optional(Type.String()),
            task: Type.String(),
            model: optional(Type.String()),
            workspace: optional(WorkspaceSchema),
            tools: optional(
              Type.Array(Type.String({ minLength: 1 }), { maxItems: 100 }),
            ),
            goalId: optional(Type.String()),
            ...timingSchema,
          }),
          { maxItems: 16 },
        ),
      ),
      chain: optional(
        Type.Array(
          Type.Object({
            agent: optional(Type.String()),
            task: Type.String(),
            model: optional(Type.String()),
            workspace: optional(WorkspaceSchema),
            tools: optional(
              Type.Array(Type.String({ minLength: 1 }), { maxItems: 100 }),
            ),
            goalId: optional(Type.String()),
            ...timingSchema,
          }),
          { maxItems: 16 },
        ),
      ),
    }),
    async (args, _signal, context) => {
      const { inputs, chain } = delegationInput(args);
      const prepared: {
        definition: Awaited<ReturnType<typeof prepareMember>>;
        task: string;
        timing: ReturnType<typeof taskTiming>;
        goalId?: string;
      }[] = [];
      for (const input of inputs) {
        const name = `sub-${(input.agent ?? "worker").replace(/[^a-z0-9-]/g, "").slice(0, 20)}-${randomUUID().slice(0, 8)}`;
        const definition = await prepareMember(
          {
            name,
            role: input.agent ?? "worker",
            model: input.model ?? args.model,
            workspace: input.workspace,
            tools: input.tools,
          },
          context,
          true,
        );
        prepared.push({
          definition,
          task: input.task,
          timing: taskTiming(input, current().settings.taskTimeoutMs),
          goalId: input.goalId,
        });
      }
      const jobs = current().store.transaction(() => {
        let previous: string | undefined;
        return prepared.map(({ definition, task: input, timing, goalId }) => {
          current().addMember(definition);
          const task = current().dispatch(definition.name, input, {
            dependsOn: chain ? previous : undefined,
            ...timing,
            goalId,
          });
          previous = task.id;
          return task;
        });
      });
      return oneShot(context)
        ? collected(
            await Promise.all(jobs.map((t) => waitForTask(t.id, _signal))),
            jobs.map((t) => t.id),
          )
        : {
            accepted: jobs.map((t) => ({ taskId: t.id, member: t.member })),
            maintenance: "automatic",
          };
    },
  );
  const wait = async (
    _args: any,
    signal: AbortSignal | undefined,
    context: ExtensionContext,
  ) => {
    const tasks = current().store.tasks(true);
    if (oneShot(context)) {
      await Promise.all(
        tasks.filter((t) => !t.parentId).map((t) => waitForTask(t.id, signal)),
      );
      const results = current()
        .store.tasks()
        .filter(
          (t) => t.missionId === current().store.mission()?.id && terminal(t),
        );
      return collected(
        results.map((t) => ({
          task: t,
          result: t.resultPath
            ? current().store.readArtifact(t.resultPath, 12000)
            : undefined,
        })),
        results.map((t) => t.id),
      );
    }
    if (!tasks.length)
      throw new Error(
        "No unfinished tasks. Collect results and continue approved work or complete the mission with evidence.",
      );
    return "Lead turn ended. Runtime maintenance and result wakeups remain active.";
  };
  tool(
    "mission_wait",
    "Wait for team",
    "Call as the only tool in its response after dispatch. TUI/RPC ends this lead run; one-shot print/json joins results before Pi exits.",
    Type.Object({}),
    wait,
    (context) => !oneShot(context),
  );
  tool(
    "goal_wait",
    "Wait for team",
    "Compatibility alias for mission_wait. Works even when no Goal was explicitly created.",
    Type.Object({}),
    wait,
    (context) => !oneShot(context),
  );
  tool(
    "mission_status",
    "Mission status",
    "Read the current recoveryPlan first: it identifies the next directly callable model tool and exact task epochs or goal revision. Also returns loaded plugin version, tool visibility, objective, tasks and notifications. Reload does not reconcile unknown processes; a status query is not a recovery attempt.",
    Type.Object({}),
    () => modelStatus(),
  );
  tool(
    "goal_status",
    "Goal status",
    "Read the runtime-owned mission/Goal; maintenance also works without an explicit Goal.",
    Type.Object({}),
    () => {
      const status = modelStatus();
      return {
        runtime: status.runtime,
        recoveryPlan: status.recoveryPlan,
        ...(status.mission ?? {
          status: "none",
          maintenance: "automatic upon dispatch",
        }),
        ...("bounded" in status
          ? { bounded: true, counts: status.counts }
          : {}),
      };
    },
  );
  tool(
    "goal_start",
    "Set mission goal",
    "Set explicit acceptance criteria on the current automatically enrolled mission. This is optional for task completion wakeups.",
    Type.Object({
      objective: Type.String({ minLength: 1, maxLength: 8000 }),
      criteria: Type.Optional(Type.Array(Type.String(), { maxItems: 30 })),
    }),
    (args) => current().setGoal(args.objective, args.criteria),
  );
  tool(
    "goal_plan",
    "Register goal plan",
    "Atomically register main goals and stage/leaf deliverables with explicit acceptance criteria. Level 2 organizes phases; level 3+ code leaves name concrete files or an explicitly listed batch, the work and its verifiable output. Record scope when known; a vague subsystem-wide objective is not a useful leaf. Scope describes work and never grants file permissions. Default depth is three; parentId/dependsOn can reference batch keys. " +
      goalPlanningGuidance,
    Type.Object({
      goals: Type.Array(
        Type.Object({
          key: Type.Optional(Type.String({ minLength: 1, maxLength: 120 })),
          parentId: Type.Optional(Type.String()),
          objective: Type.String({ minLength: 1, maxLength: 8000 }),
          criteria: Type.Array(Type.String({ minLength: 1, maxLength: 2000 }), {
            minItems: 1,
            maxItems: 30,
          }),
          dependsOn: Type.Optional(
            Type.Array(Type.String(), { maxItems: 100 }),
          ),
          module: Type.Optional(Type.String({ maxLength: 200 })),
          scope: Type.Optional(scopeSchema),
          nextStep: Type.Optional(Type.String({ maxLength: 2000 })),
          estimateMs: Type.Optional(
            Type.Tuple([
              Type.Integer({ minimum: 0 }),
              Type.Integer({ minimum: 0 }),
            ]),
          ),
        }),
        { minItems: 1, maxItems: 100 },
      ),
    }),
    (args) => ({
      created: current()
        .planGoals(args.goals)
        .map((node) => ({
          id: node.id,
          key: node.key,
          depth: node.depth,
          revision: node.revision,
        })),
      progress: current().goals.summary(),
      planningGuidance: goalPlanningGuidance,
    }),
  );
  tool(
    "goal_tree",
    "Read goal ledger",
    "Read persistent goal hierarchy, accepted counts and current focus. Supply goalId for acceptance history, tool receipts, blockers and task results. Main-goal selection and acceptance survive /reload. Counts mean accepted deliverables, not finished agent turns. Remaining effort is a range, not a wall-clock deadline.",
    Type.Object({
      rootId: Type.Optional(Type.String()),
      goalId: Type.Optional(Type.String()),
      section: Type.Optional(
        Type.Union(
          [
            "summary",
            "definition",
            "scope",
            "acceptance",
            "history",
            "receipts",
            "tasks",
          ].map((value) => Type.Literal(value)),
        ),
      ),
      offset: Type.Optional(Type.Integer({ minimum: 0 })),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 10 })),
    }),
    (args) => {
      const ledger = current().goals,
        offset = args.offset ?? 0,
        limit = args.limit ?? 10;
      const brief = (node: any) => ({
        ...node,
        objective: cleanText(node.objective, 300),
        criteria: undefined,
        criterionCount: node.criteria.length,
        scope: node.scope
          ? {
              unitKind: node.scope.unitKind,
              items: node.scope.items
                .slice(0, 2)
                .map((value: string) => cleanText(value, 120)),
              itemCount: node.scope.items.length,
              fileCount: node.scope.files?.length ?? 0,
              full: "goal_tree(section:scope)",
            }
          : undefined,
        reason: node.reason ? cleanText(node.reason, 300) : undefined,
        nextStep: node.nextStep ? cleanText(node.nextStep, 300) : undefined,
      });
      if (args.goalId) {
        const detail = ledger.detail(args.goalId);
        if (args.section === "definition") {
          const pageSize = Math.min(limit, 5);
          return {
            goalId: detail.goal.id,
            revision: detail.goal.revision,
            objective: detail.goal.objective,
            scope: brief(detail.goal).scope,
            dependsOn: detail.goal.dependsOn,
            nextStep: detail.goal.nextStep,
            reason: detail.goal.reason,
            total: detail.goal.criteria.length,
            offset,
            nextOffset:
              offset + pageSize < detail.goal.criteria.length
                ? offset + pageSize
                : undefined,
            criteria: detail.goal.criteria
              .slice(offset, offset + pageSize)
              .map((text, index) => ({ criterion: offset + index + 1, text })),
          };
        }
        const entries =
          args.section === "scope"
            ? [
                ...(detail.goal.scope?.items.map((value) => ({
                  kind: "item",
                  value,
                })) ?? []),
                ...(detail.goal.scope?.files?.map((value) => ({
                  kind: "file",
                  value,
                })) ?? []),
              ]
            : args.section === "acceptance"
              ? (detail.acceptance?.evidence ?? [])
              : args.section === "history"
                ? detail.history.map((r) => ({
                    id: r.id,
                    revision: r.revision,
                    at: r.at,
                    imported: r.imported,
                  }))
                : args.section === "receipts"
                  ? detail.receipts
                  : args.section === "tasks"
                    ? detail.tasks.map((t) => ({
                        id: t.id,
                        goalId: t.goalId,
                        state: t.state,
                        processState: t.processState,
                        resultPath: t.resultPath,
                      }))
                    : undefined;
        const pageSize =
          args.section === "receipts" ? Math.min(limit, 4) : limit;
        if (entries)
          return {
            goalId: detail.goal.id,
            revision: detail.goal.revision,
            acceptanceId: detail.acceptance?.id,
            section: args.section,
            total: entries.length,
            offset,
            nextOffset:
              offset + pageSize < entries.length
                ? offset + pageSize
                : undefined,
            entries: entries.slice(offset, offset + pageSize),
            bounded: true,
          };
        return {
          goal: {
            ...brief(detail.goal),
            criteria: detail.goal.criteria.map((c) => cleanText(c, 200)),
          },
          blockers: detail.blockers.slice(0, 10).map((b) => cleanText(b, 300)),
          acceptance: detail.acceptance
            ? {
                id: detail.acceptance.id,
                revision: detail.acceptance.revision,
                evidenceCount: detail.acceptance.evidence.length,
                children: detail.acceptance.children.slice(0, 10),
              }
            : undefined,
          historyCount: detail.history.length,
          taskCount: detail.tasks.length,
          receipts: detail.receipts.slice(0, 3).map((r) => ({
            ...r,
            input: cleanText(r.input, 300),
            output: r.output ? cleanText(r.output, 500) : undefined,
          })),
          bounded: true,
          next: "Use section:definition|acceptance|history|receipts|tasks with offset/limit for retained details",
        };
      }
      const snapshot = ledger.snapshot(
        args.rootId ?? current().store.mission()?.id,
      );
      return {
        ...snapshot,
        nodes: snapshot.nodes.slice(offset, offset + limit).map(brief),
        roots: snapshot.roots.slice(offset, offset + limit).map(brief),
        nodeTotal: snapshot.nodes.length,
        rootTotal: snapshot.roots.length,
        offset,
        nextOffset:
          offset + limit <
          Math.max(snapshot.nodes.length, snapshot.roots.length)
            ? offset + limit
            : undefined,
        bounded: true,
      };
    },
  );
  tool(
    "goal_edit",
    "Update goal progress",
    "Update a goal's definition, concrete scope, blockers, next step or estimate. Scope changes revise the goal and invalidate affected acceptances. Keep code leaves at explicit file or batch level. state:planned reopens accepted work. A workspace pause belongs to runtime control: ask the user to manually run /mission resume; do not create an ordinary business blocker for it. If recording this pause is necessary, pair state:blocked with blockedBy:workspace so the same user resume can release it. Independent business blockers omit blockedBy. Cannot accept or silently exclude scope; holds and budgets remain authoritative.",
    Type.Object({
      goalId: Type.String(),
      revision: Type.Integer({ minimum: 0 }),
      objective: Type.Optional(Type.String({ minLength: 1, maxLength: 8000 })),
      criteria: Type.Optional(
        Type.Array(Type.String({ minLength: 1, maxLength: 2000 }), {
          minItems: 1,
          maxItems: 30,
        }),
      ),
      dependsOn: Type.Optional(Type.Array(Type.String(), { maxItems: 100 })),
      scope: optional(scopeSchema),
      state: Type.Optional(
        Type.Union(
          ["planned", "active", "review", "blocked"].map((value) =>
            Type.Literal(value),
          ),
        ),
      ),
      reason: Type.Optional(Type.String({ maxLength: 2000 })),
      nextStep: Type.Optional(Type.String({ maxLength: 2000 })),
      blockedBy: Type.Optional(Type.Literal("workspace")),
      estimateMs: Type.Optional(
        Type.Tuple([
          Type.Integer({ minimum: 0 }),
          Type.Integer({ minimum: 0 }),
        ]),
      ),
    }),
    (args) => {
      const { goalId, revision, ...patch } = args;
      current().editGoal(goalId, patch, revision);
      const node = current().goals.node(goalId);
      return {
        id: node.id,
        revision: node.revision,
        state: node.state,
        progress: current().goals.summary(),
      };
    },
  );
  tool(
    "goal_focus",
    "Focus leaf goal",
    "Select a ready leaf goal for the lead's commands and default delegated tasks. Ancestor stage prerequisites must be accepted. Different ready leaves may have parallel member tasks; focus identifies the lead's current work. Reopen accepted work explicitly before more execution.",
    Type.Object({
      goalId: Type.String(),
      revision: Type.Integer({ minimum: 0 }),
    }),
    (args) => {
      const node = current().focusGoal(args.goalId, args.revision);
      return {
        id: node.id,
        revision: node.revision,
        state: node.state,
        progress: current().goals.summary(),
      };
    },
  );
  tool(
    "goal_accept",
    "Accept goal with evidence",
    "Register one acceptance for this exact goal revision after every criterion and required child has evidence. Artifact paths, completed task IDs, successful tool receipt IDs or current descendant acceptance IDs are checked once. statement is explicitly a model claim, suitable for explanatory planning evidence, never an automatically verified test. Reuse accepted evidence; no repeated model reviews are required. Accepting the main goal also completes the mission.",
    Type.Object({
      goalId: Type.String(),
      revision: Type.Integer({ minimum: 0 }),
      evidence: goalEvidence,
    }),
    (args) => {
      const record = current().acceptGoal(
          args.goalId,
          args.evidence,
          args.revision,
        ),
        node = current().goals.node(record.goalId);
      return {
        id: record.id,
        goalId: node.id,
        revision: node.revision,
        state: node.state,
        evidenceCount: record.evidence.length,
        childCount: record.children.length,
        progress: current().goals.summary(),
      };
    },
  );
  tool(
    "goal_activate",
    "Select main goal",
    "Select one existing main goal while preserving its progress, evidence, activity and budget usage. Settle running/unknown executions and observe old results first. Selection cannot release user, workspace, decision, budget or recovery holds. Completion does not automatically activate another main goal.",
    Type.Object({ goalId: Type.String() }),
    (args) => {
      const m = current().activateGoal(args.goalId);
      return {
        id: m.id,
        status: m.status,
        turns: m.turns,
        outputTokens: m.outputTokens,
        budgetStartedAt: m.budgetStartedAt,
        progress: current().goals.summary(),
      };
    },
  );
  tool(
    "goal_export",
    "Export goal ledger",
    "Export a consistent JSON snapshot on demand to a new file. Includes goal definitions, current states, immutable acceptance history, tool receipts and task/artifact references. Does not copy artifact contents or create periodic JSON files. Omit rootId for all main goals.",
    Type.Object({
      destination: Type.String({ minLength: 1 }),
      rootId: Type.Optional(Type.String()),
    }),
    (args) => current().goals.export(args.destination, args.rootId),
  );
  tool(
    "goal_update",
    "Update goal",
    "Revise the goal definition and acceptance criteria. Clear prior evidence and advance its revision while preserving user holds, budgets and usage.",
    Type.Object({
      goalId: Type.Optional(Type.String()),
      objective: Type.String({ minLength: 1, maxLength: 8000 }),
      criteria: Type.Optional(Type.Array(Type.String(), { maxItems: 30 })),
      revision: Type.Optional(Type.Integer({ minimum: 0 })),
    }),
    (args) =>
      current().updateGoal(
        args.objective,
        args.criteria,
        args.goalId,
        args.revision,
      ),
  );
  tool(
    "goal_stop",
    "Stop goal",
    "Stop the active goal, cancel its unfinished task tree, suppress stale deliveries and archive the goal. A later objective starts a new goal identity.",
    Type.Object({
      goalId: Type.Optional(Type.String()),
      reason: Type.Optional(Type.String({ maxLength: 2000 })),
    }),
    (args) => current().stopGoal(args.goalId, args.reason),
  );
  tool(
    "mission_complete",
    "Accept mission",
    "Mark the whole approved objective complete only after all work has settled and every acceptance criterion has verified evidence. Answering an intermediate question is not completion.",
    Type.Object({
      evidence,
      revision: Type.Optional(Type.Integer({ minimum: 0 })),
    }),
    (args) => current().complete(args.evidence, undefined, args.revision),
  );
  tool(
    "goal_finish",
    "Accept goal",
    "Compatibility alias for mission_complete. Requires no active tasks and evidence for every criterion.",
    Type.Object({
      evidence,
      goalId: Type.Optional(Type.String()),
      revision: Type.Optional(Type.Integer({ minimum: 0 })),
    }),
    (args) => {
      if (args.goalId && current().store.goal(args.goalId)?.parentId) {
        const node = current().goals.node(args.goalId);
        if (args.revision === undefined)
          throw new Error(
            "Use goal_accept with an exact revision for a subgoal",
          );
        return current().acceptGoal(
          node.id,
          args.evidence.map((e: any) => ({
            criterion: e.criterion,
            source: "statement",
            summary: e.evidence,
          })),
          args.revision,
        );
      }
      if (args.goalId && args.goalId !== current().store.mission()?.id)
        throw new Error("Goal identity changed");
      return current().complete(args.evidence, undefined, args.revision);
    },
  );
  tool(
    "mission_decision",
    "Request user decision",
    "Request a concrete business decision, optionally blocking only taskIds. Execution choices belong to the lead inside the approved scope. Resolve by exact decisionId after a new direct human answer, quoting it verbatim. A natural-language answer delegating this choice is valid; no A/B/C letter is required. Choose and explain the approved next step without re-asking solely for a letter. Runtime faults use recovery tools.",
    Type.Object({
      action: Type.Optional(
        Type.Union([Type.Literal("request"), Type.Literal("resolve")]),
      ),
      reason: Type.Optional(Type.String({ minLength: 1, maxLength: 2000 })),
      taskIds: Type.Optional(Type.Array(Type.String(), { maxItems: 100 })),
      decisionId: Type.Optional(Type.String()),
      answer: Type.Optional(Type.String({ minLength: 1, maxLength: 16000 })),
      kind: Type.Optional(
        Type.Union([Type.Literal("business"), Type.Literal("execution")]),
      ),
    }),
    (args) =>
      args.action === "resolve"
        ? current().resolveDecision(args.decisionId ?? "", args.answer ?? "")
        : current().requireDecision(args.reason ?? "", args.taskIds, args.kind),
  );
  tool(
    "mission_policy",
    "Inspect or apply autonomy policy",
    "Inspect the default business-only policy, or apply that same policy when asked. Execution choices within approved scope stay with the lead; material scope, permission or irreversible-risk questions still require their own authority. Applying policy does not resolve an existing decision, release a hold or authorize actions. No user slash command is required to apply this policy.",
    Type.Object({
      action: Type.Optional(
        Type.Union([Type.Literal("status"), Type.Literal("apply")]),
      ),
      policy: Type.Optional(Type.Literal("business-only")),
    }),
    (args) => ({
      ...(args.action === "apply"
        ? current().setDecisionPolicy(args.policy ?? "business-only")
        : { policy: current().decisionPolicy() }),
      default: true,
      meaning:
        "Choose routine execution details within the approved scope; ask only for business boundaries or irreversible-risk choices.",
      existingDecision: current().store.mission()?.decision?.id,
      note: "Natural-language delegation can answer an exact pending decision after a new direct human reply. A/B/C is not required; applying this policy alone does not resolve it.",
    }),
  );
  tool(
    "mission_recover",
    "Inspect runtime recovery",
    "Check the exact fault and goal revision. Recovery runs automatically within existing budgets. This never clears user pauses, business decisions, workspace holds or budget limits.",
    Type.Object({
      faultId: Type.String(),
      expectedRevision: Type.Integer({ minimum: 0 }),
    }),
    (args) => current().requestRecovery(args.faultId, args.expectedRevision),
  );
  tool(
    "mission_reconcile",
    "Reconcile stopped executions",
    "After inspecting saved artifacts and host processes, attest that the listed old executions have stopped. Supply exact task epochs and concrete evidence. This records your inspection, does not perform an OS scan or kill processes, and never replays commands. After reconciling all unknown executions, use mission_control to resume no-progress attention and team_resume for an explicit new attempt.",
    Type.Object({
      tasks: Type.Array(
        Type.Object({
          taskId: Type.String(),
          expectedEpoch: Type.Integer({ minimum: 0 }),
        }),
        { minItems: 1, maxItems: 100 },
      ),
      evidence: Type.String({ minLength: 8, maxLength: 2000 }),
    }),
    (args) => current().reconcileProcesses(args.tasks, args.evidence),
  );
  tool(
    "mission_control",
    "Resume inspected progress",
    "Resume only runtime no-progress attention after inspecting the blocker and selecting the next approved step. Exact goal identity/revision required; usage is preserved. User pause, workspace authorization, real business decisions and budget renewal retain their own controls.",
    Type.Object({
      action: Type.Literal("resume"),
      goalId: Type.String(),
      expectedRevision: Type.Integer({ minimum: 0 }),
      reason: Type.String({ minLength: 8, maxLength: 2000 }),
    }),
    (args) =>
      current().resumeProgress(args.goalId, args.expectedRevision, args.reason),
  );
  tool(
    "mission_report",
    "Set progress interval",
    "Set an approved regular progress-report interval in seconds. Completion/failure wakeups and maintenance remain automatic.",
    Type.Object({ seconds: Type.Integer({ minimum: 1, maximum: 86400 }) }),
    (args) => {
      current().setReportInterval(args.seconds * 1000);
      return { seconds: current().settings.progressIntervalMs / 1000 };
    },
  );
  tool(
    "mission_compact",
    "Compact this conversation",
    "End this lead run and request one compaction after settlement and idle. Original history and successful summary chunks remain on failure. Requires a persistent interactive/RPC host; use compaction_model to inspect or set the summary model.",
    Type.Object({}),
    (_args, _signal, context) => {
      if (oneShot(context))
        throw new Error("Queued compaction needs a persistent TUI/RPC host");
      return current().queueCompaction();
    },
    true,
  );
  tool(
    "mission_export",
    "Export public history",
    "Export this conversation and its members. format=jsonl keeps the bounded public transcript format; format=archive creates a complete-length, chunked HTML reading directory with goals, evidence, tasks and per-file snapshot boundaries, including archived members by default. Source runtime is read-only; existing destinations are never overwritten. A reading archive is not a raw runtime backup.",
    Type.Object({
      destination: Type.String({ minLength: 1 }),
      includeArchived: Type.Optional(Type.Boolean()),
      format: Type.Optional(
        Type.Union([Type.Literal("jsonl"), Type.Literal("archive")]),
      ),
    }),
    (args, signal, context) =>
      args.format === "archive"
        ? exportArchive(context, args.destination, signal, args.includeArchived)
        : exportPublic(context, args.destination, signal, args.includeArchived),
  );
  tool(
    "mission_history",
    "Read public conversation history",
    "Read a bounded page of this lead conversation or an active/archived member. Session index 0 is the newest; use returned before cursor for older pages. No private reasoning is exposed.",
    Type.Object({
      member: Type.Optional(Type.String()),
      sessionIndex: Type.Optional(Type.Integer({ minimum: 0 })),
      before: Type.Optional(Type.Integer({ minimum: 0 })),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
    }),
    async (args, _signal, context) => {
      let files: string[];
      if (args.member) {
        const member = current().store.member(args.member, true);
        if (!member) throw new Error("Unknown active or archived member");
        files = await memberSessionFiles(current().store.directory, member.id);
      } else
        files = [context.sessionManager.getSessionFile()].filter(
          (x): x is string => Boolean(x),
        );
      const file = files[args.sessionIndex ?? 0];
      if (!file) return { records: [], sessions: files.length };
      const page = await transcriptPage(file, args.before, args.limit ?? 20);
      let size = 0;
      const records: any[] = [];
      for (const record of [...page.records].reverse()) {
        const text = JSON.stringify(record.entry);
        const item =
          text.length > 16000
            ? {
                offset: record.offset,
                preview: text.slice(0, 16000),
                truncated: true,
              }
            : record;
        const length = JSON.stringify(item).length;
        if (records.length && size + length > 22000) break;
        records.unshift(item);
        size += length;
      }
      return {
        sessionFile: file,
        sessions: files.length,
        records,
        before: records[0]?.offset ?? page.before,
        skipped: page.skipped,
        truncated: records.length < page.records.length,
      };
    },
  );
  tool(
    "mission_capabilities",
    "Mission Control tool catalog",
    "List every Mission Control tool from the host registry, its active model visibility and available command counterparts. Tools are declared directly to the lead; no discovery call is required before using them. Optionally filter by toolName and include its schema.",
    Type.Object({
      toolName: Type.Optional(Type.String()),
      includeSchemas: Type.Optional(Type.Boolean()),
    }),
    (args) => {
      const active = new Set(pi.getActiveTools()),
        all = missionTools();
      const selected = args.toolName
        ? all.filter((t) => t.name === args.toolName)
        : all;
      if (args.toolName && !selected.length)
        throw new Error("Unknown Mission Control tool");
      const shown =
        args.includeSchemas && !args.toolName ? selected.slice(0, 5) : selected;
      const m = current().store.mission();
      return {
        runtime: runtimeIdentity(),
        recoveryPlan: current().recoveryPlan(),
        visibility:
          "Tools are directly declared from one host registry, refreshed at session start and before model requests",
        tools: shown.map((t) => ({
          name: t.name,
          description: t.description,
          active: active.has(t.name),
          exposure: t.exposure,
          module: path.basename(t.sourceInfo.path),
          ...(args.includeSchemas ? { parameters: t.parameters } : {}),
        })),
        schemaPageLimited: shown.length < selected.length,
        unknownExecutions: current()
          .store.members()
          .flatMap((member) =>
            current()
              .store.memberTasks(member.id)
              .filter((t) => t.processState === "unknown")
              .map((t) => ({
                taskId: t.id,
                expectedEpoch: t.epoch,
                member: t.member,
                state: t.state,
              })),
          ),
        mission: m
          ? {
              goalId: m.id,
              revision: m.revision ?? 0,
              status: m.status,
              blocker: m.blocker,
            }
          : undefined,
        commandTools: {
          reconcile: "mission_reconcile",
          report: "mission_report",
          export: "mission_export",
          history: "mission_history",
          compact: "mission_compact",
          summaryModel: "compaction_model",
          reconnect: "reconnect_config",
          schedules: "schedule",
          memberMessage: "team_message",
          runtimeProgressResume: "mission_control",
        },
        userControls: [
          "Explicit user pause/stop and budget renewal: /mission",
          "Workspace authorization: direct natural-language rename/switch request or /project allow; project_status exposes the exact one-use grant for project_apply",
          "Interactive display/editor/copy UI remains user-owned",
        ],
      };
    },
  );
  tool(
    "mission_wait_external",
    "Wait for an external event",
    "End this lead run while waiting for a concrete external producer. Supply a future ISO deadline with timezone. Save the returned id/token; matching signal or deadline wakes once. Unchanged progress reports are suppressed during the wait.",
    Type.Object({
      reason: Type.String({ minLength: 1, maxLength: 2000 }),
      deadline: Type.String(),
    }),
    (args) => {
      if (!/(?:Z|[+-]\d{2}:\d{2})$/i.test(args.deadline))
        throw new Error("External wait deadline needs an explicit timezone");
      return current().waitExternal(args.reason, Date.parse(args.deadline));
    },
    true,
  );
  tool(
    "mission_signal",
    "Signal an external event",
    "Signal an actual event for an exact external wait id/token. This retains user and budget holds; inspect the real producer result before continuing.",
    Type.Object({ waitId: Type.String(), token: Type.String() }),
    (args) => current().signalExternal(args.waitId, args.token),
  );
  tool(
    "lifecycle_history",
    "Lifecycle history",
    "Inspect archived goals, members and reminders after they leave the active roster.",
    Type.Object({
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
    }),
    (args) => current().lifecycleHistory(args.limit),
  );
  tool(
    "supervisor_control",
    "Maintenance status",
    "Maintenance is runtime-owned and automatically active. Inspect it here; use mission_report for an approved report interval and mission_control for inspected no-progress recovery. This cannot disable maintenance or release user holds.",
    Type.Object({ action: Type.Optional(Type.String()) }),
    (args) => {
      if (args.action && !["status", "on"].includes(args.action))
        throw new Error(
          "Only the user may pause/stop or renew mission budgets through /mission. Runtime faults recover automatically; inspect mission_status.recovery and mission_recover. Do not turn runtime faults into business decisions.",
        );
      return {
        maintenance: "automatic",
        reportIntervalMs: current().settings.progressIntervalMs,
      };
    },
  );
  tool(
    "schedule",
    "Schedule reminder",
    "Create, list and manage persistent reminders. Omit unused time fields; empty string placeholders are ignored. Delivery is independent of Goal state. Intervals are fixed seconds; at must include an explicit timezone. Deleting or pausing a reminder cancels its stale pending deliveries.",
    Type.Object({
      action: Type.Union([
        Type.Literal("create"),
        Type.Literal("list"),
        Type.Literal("update"),
        Type.Literal("delete"),
        Type.Literal("pause"),
        Type.Literal("resume"),
      ]),
      id: Type.Optional(Type.String()),
      title: Type.Optional(Type.String({ maxLength: 120 })),
      prompt: Type.Optional(Type.String({ maxLength: 8000 })),
      at: Type.Optional(Type.String()),
      afterSeconds: Type.Optional(Type.Integer({ minimum: 1 })),
      everySeconds: Type.Optional(
        Type.Integer({ minimum: 1, maximum: 604800 }),
      ),
    }),
    (args) => {
      if (args.action === "list") return current().store.schedules();
      if (!args.id && args.action !== "create")
        throw new Error("id is required for reminder updates and deletion");
      if (args.action === "delete") {
        current().deleteSchedule(args.id);
        return { deleted: args.id };
      }
      if (args.action === "pause" || args.action === "resume")
        return current().updateSchedule(args.id, {
          state: args.action === "pause" ? "paused" : "active",
        });
      if (args.action === "update") {
        const at =
          typeof args.at === "string" && args.at.trim()
            ? args.at.trim()
            : undefined;
        const next = args.at
          ? Date.parse(at!)
          : args.afterSeconds !== undefined
            ? Date.now() + args.afterSeconds * 1000
            : undefined;
        if (at && !/(Z|[+-]\d\d:\d\d)$/.test(at))
          throw new Error("at requires an ISO timestamp with timezone");
        return current().updateSchedule(args.id, {
          title: args.title,
          prompt: args.prompt,
          nextAt: next,
          intervalMs:
            args.everySeconds === undefined
              ? undefined
              : args.everySeconds * 1000,
        });
      }
      const at =
        typeof args.at === "string" && args.at.trim()
          ? args.at.trim()
          : undefined;
      const afterSeconds = Number.isSafeInteger(args.afterSeconds)
        ? args.afterSeconds
        : undefined;
      const everySeconds = Number.isSafeInteger(args.everySeconds)
        ? args.everySeconds
        : undefined;
      let selector: "at" | "afterSeconds" | "everySeconds";
      if (at) selector = "at";
      else if (afterSeconds !== undefined && everySeconds === undefined)
        selector = "afterSeconds";
      else if (everySeconds !== undefined && afterSeconds === undefined)
        selector = "everySeconds";
      else if (
        afterSeconds !== undefined &&
        everySeconds !== undefined &&
        everySeconds === 1 &&
        afterSeconds > 1
      )
        // Models often emit everySeconds=1 as a placeholder while intending
        // the meaningful afterSeconds value. Treat that exact shape as a
        // one-shot reminder instead of trapping the lead in validation retries.
        selector = "afterSeconds";
      else if (
        afterSeconds !== undefined &&
        everySeconds !== undefined &&
        afterSeconds === 1 &&
        everySeconds > 1
      )
        selector = "everySeconds";
      else
        throw new Error(
          "Supply exactly one nonempty time selector: at, afterSeconds or everySeconds",
        );
      if (at && !/(Z|[+-]\d\d:\d\d)$/.test(at))
        throw new Error("at requires an ISO timestamp with timezone");
      const next =
        selector === "at"
          ? Date.parse(at!)
          : Date.now() +
            (selector === "afterSeconds" ? afterSeconds! : everySeconds!) *
              1000;
      return current().addSchedule(
        args.title ?? "Reminder",
        args.prompt ?? "",
        next,
        selector === "everySeconds" ? everySeconds! * 1000 : undefined,
      );
    },
  );
  tool(
    "web_search",
    "Search web",
    "Search public sources with Exa, or user-configured Brave/SearXNG. Only the query is sent; inspect returned sources before relying on claims.",
    Type.Object({ query: Type.String({ minLength: 1, maxLength: 4000 }) }),
    (args, signal) => searchWeb(args.query, current().settings, signal),
  );
  tool(
    "web_fetch",
    "Read web page",
    "Fetch a bounded public HTTP(S) page. Local/private network destinations and credentials in URLs are rejected.",
    Type.Object({ url: Type.String({ maxLength: 4000 }) }),
    (args, signal) =>
      fetchPage(args.url, signal, undefined, current().settings.webFetch),
  );

  const openAgents = async (
    context: ExtensionContext,
    memberName?: string,
    lead = false,
  ) => {
    const k = current();
    if (agentsOpen) throw new Error("The team workbench is already open");
    if (memberName && !k.store.member(memberName))
      throw new Error("Use /agents <existing-member-name>");
    agentsOpen = true;
    context.ui.setWidget("mission-control", undefined);
    try {
      await context.ui.custom<void>((tui, theme, _keys, done) => {
        redraw = () => tui.requestRender();
        panel = new MissionPanel(k, redraw, done, {
          theme,
          copyMessage: copyToClipboard,
          editMessage: async (name) => context.ui.editor(`Message to ${name}`),
          leadSessionFile: () => context.sessionManager.getSessionFile(),
          leadPreviews: () => leadHistory.previews(),
        });
        const active = panel;
        const opening = lead
          ? active.openLead()
          : memberName
            ? active.openMember(memberName)
            : undefined;
        void opening?.catch((error) => {
          try {
            context.ui.notify(`无法打开对话：${String(error)}`, "warning");
          } catch {
            /* A disposed host context must not turn navigation into an unhandled rejection. */
          }
        });
        return {
          render: (width: number) => active.render(width),
          invalidate() {},
          handleInput: (data: string) => active.handleInput(data),
          dispose() {
            active.dispose();
            if (panel === active) panel = undefined;
            redraw = undefined;
          },
        };
      });
    } finally {
      agentsOpen = false;
      refresh();
    }
  };

  const openGoals = async (context: ExtensionContext) => {
    if (context.mode !== "tui") {
      context.ui.notify(
        JSON.stringify(current().goals.snapshot(), null, 2),
        "info",
      );
      return;
    }
    if (agentsOpen)
      throw new Error("A Mission Control workbench is already open");
    agentsOpen = true;
    context.ui.setWidget("mission-control", undefined);
    try {
      await context.ui.custom<void>((tui, theme, _keys, done) => {
        redraw = () => tui.requestRender();
        const active = (goalPanel = new GoalPanel(current(), redraw, done, {
          theme,
        }));
        return {
          render: (width: number) => active.render(width),
          invalidate() {},
          handleInput: (data: string) => active.handleInput(data),
          dispose() {
            active.dispose();
            if (goalPanel === active) goalPanel = undefined;
            redraw = undefined;
          },
        };
      });
    } finally {
      agentsOpen = false;
      refresh();
    }
  };
  pi.registerCommand("mission", {
    description:
      "Mission dashboard; goals [export <new-file>|activate <id>|depth <3..12>|skip|cancel <id> <reason>] | policy status|business-only | time|timeline | view <member> | start <objective> | status | pause | resume | stop | report <seconds> | schedules | unschedule <id> | export <new-file.jsonl> | archive <new-directory>",
    handler: async (args, context) => {
      try {
        const [command, ...rest] = args.trim().split(/\s+/);
        const k = current();
        if (command === "goals") {
          const [action, ...values] = rest;
          if (action === "export") {
            if (!values.length)
              throw new Error("Use /mission goals export <new-file.json>");
            context.ui.notify(
              JSON.stringify(
                k.goals.export(values.join(" ").replace(/^\"|\"$/g, "")),
                null,
                2,
              ),
              "info",
            );
            return;
          }
          if (action === "depth") {
            const result = k.goals.setMaxDepth(Number(values[0]));
            context.ui.notify(
              `目标深度上限已设为 ${result.maxDepth}；超过三级不建议，优先使用执行任务记录细节。`,
              "info",
            );
            return;
          }
          if (action === "activate") {
            k.activateGoal(values[0]);
            context.ui.notify(
              "已切换主目标，进度、证据、用量和暂停限制均保留。",
              "info",
            );
            return;
          }
          if (action === "skip" || action === "cancel") {
            const node = k.goals.node(values[0]),
              reason = values.slice(1).join(" ");
            if (!node.parentId)
              throw new Error(
                "Use /mission stop to stop the current main goal",
              );
            if (!reason.trim())
              throw new Error("Provide a reason for excluding this goal");
            k.editGoal(
              node.id,
              { state: action === "skip" ? "skipped" : "cancelled", reason },
              node.revision,
              true,
            );
            context.ui.notify(
              "已记录范围排除及原因，详细看板保留历史。",
              "info",
            );
            return;
          }
          if (action)
            throw new Error(
              "Use /mission goals [export|activate|depth|skip|cancel]",
            );
          await openGoals(context);
          return;
        }
        if (command === "policy") {
          const value = rest[0] ?? "status";
          if (value === "status") {
            context.ui.notify(
              JSON.stringify({ policy: k.decisionPolicy() }, null, 2),
              "info",
            );
            return;
          }
          if (value !== "business-only")
            throw new Error("Use /mission policy status|business-only");
          k.setDecisionPolicy(value);
          context.ui.notify(
            "已应用默认自主策略：批准范围内的实现与执行细节由模型决定；真正的范围、权限及不可逆风险仍需对应授权。已有裁决和暂停状态保留。",
            "info",
          );
          return;
        }
        if (command === "start") {
          const m = k.store.mission();
          if (m && !["complete", "stopped"].includes(m.status))
            throw new Error(
              "An unfinished mission already exists; resume it or explicitly stop it before starting another",
            );
          const parts = rest
            .join(" ")
            .split("|")
            .map((s) => s.trim());
          k.setGoal(parts[0], parts.slice(1));
          context.ui.notify(
            "Mission started; task maintenance and continuation are automatic",
            "info",
          );
          return;
        }
        if (["pause", "resume", "stop"].includes(command)) {
          const workspaceHeld = Boolean(k.store.get("relocationHold"));
          if (command !== "resume")
            pi.events.emit("mission-control:interrupt", {
              reason: `User ${command}`,
            });
          await k.userControl(command as any);
          if (command !== "resume" && !context.isIdle()) context.abort();
          context.ui.notify(
            command === "resume" && workspaceHeld
              ? "已解除迁移暂停；原有业务阻塞和待核对任务仍按实际状态处理。"
              : `Mission ${command}`,
            "info",
          );
          return;
        }
        if (command === "report") {
          const seconds = Number(rest[0]);
          if (!Number.isInteger(seconds) || seconds < 1)
            throw new Error("Use /mission report <seconds>");
          k.setReportInterval(seconds * 1000);
          context.ui.notify(
            "Progress report interval updated; result wakeups and safety maintenance remain automatic",
            "info",
          );
          return;
        }
        if (command === "time" || command === "timeline") {
          if (context.mode !== "tui")
            context.ui.notify(
              "主会话时间线需要Pi交互模式；时间仅在插件视图显示。",
              "info",
            );
          else await openAgents(context, undefined, true);
          return;
        }
        if (command === "schedules") {
          context.ui.notify(
            JSON.stringify(k.store.schedules(), null, 2),
            "info",
          );
          return;
        }
        if (command === "unschedule") {
          k.deleteSchedule(rest[0]);
          context.ui.notify(
            "Reminder ended; task maintenance remains active",
            "info",
          );
          return;
        }
        if (command === "reconcile") {
          k.acknowledgeProcess(rest[0]);
          context.ui.notify(
            "Recorded your confirmation that the previous process is stopped. A new attempt may now be created.",
            "info",
          );
          return;
        }
        if (command === "archive") {
          if (!rest.length)
            throw new Error("Use /mission archive <new-directory>");
          const result = await exportArchive(
            context,
            rest.join(" ").replace(/^"|"$/g, ""),
          );
          context.ui.notify(
            `Archive ${result.status}: ${result.index}\n${result.sources} sources, ${result.items} content items. Source tasks and budgets were not changed.`,
            "info",
          );
          return;
        }
        if (command === "export") {
          if (!rest.length)
            throw new Error("Use /mission export <new-file.jsonl>");
          const out = await exportPublic(
            context,
            rest.join(" ").replace(/^"|"$/g, ""),
          );
          context.ui.notify(
            `Exported ${out.entries} public entries to ${out.destination}. Original Pi history was not modified.`,
            "info",
          );
          return;
        }
        if (context.mode !== "tui" || command === "status") {
          context.ui.notify(JSON.stringify(k.snapshot(), null, 2), "info");
          return;
        }
        if (command && command !== "view" && command !== "agents")
          throw new Error(
            "Unknown /mission command. Use /mission for the dashboard or /mission view <member>.",
          );
        await openAgents(context, command === "view" ? rest[0] : undefined);
      } catch (error) {
        context.ui.notify(String((error as Error).message ?? error), "error");
      }
    },
  });
  pi.registerCommand("agents", {
    description:
      "Open the full-screen team status and member conversation workbench",
    handler: async (args, context) => {
      try {
        if (context.mode !== "tui") {
          context.ui.notify(
            JSON.stringify(current().snapshot(), null, 2),
            "info",
          );
          return;
        }
        await openAgents(context, args.trim() || undefined);
      } catch (error) {
        context.ui.notify(String((error as Error).message ?? error), "error");
      }
    },
  });
  installReconnect(pi, {
    read: () => ({
      ...current().settings.reconnect,
      ...current().store.get<
        import("../../runtime/reconnect.ts").ReconnectOptions
      >("reconnect"),
    }),
    write: (value) => current().store.set("reconnect", value),
    retryAllowed: () => current().canRetryLeadRequest(),
  });
  installProject(pi, current);
  pi.registerCommand("stop", {
    description:
      "Stop the main run and this mission's task tree; preserve identities and history.",
    handler: async (_args, context) => {
      pi.events.emit("mission-control:interrupt", { reason: "User stop" });
      if (current().store.mission()) await current().userControl("stop");
      if (!context.isIdle()) context.abort();
      context.ui.notify("Stopped; results and member history retained", "info");
    },
  });
}
