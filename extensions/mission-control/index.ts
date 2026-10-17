import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { finished } from "node:stream/promises";
import { randomUUID } from "node:crypto";
import { Type } from "typebox";
import {
  getAgentDir,
  getPackageDir,
  copyToClipboard,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { MissionKernel } from "../../runtime/kernel.ts";
import { openBridge } from "../../runtime/bridge.ts";
import { createWorkerFactory } from "../../runtime/rpc-worker.ts";
import { cleanText, streamPublicSession } from "../../runtime/public.ts";
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
import installReconnect from "./reconnect.ts";
import { installProject } from "./project.ts";
import {
  delegationInput,
  optionalText,
  workspaceInput,
} from "../../runtime/arguments.ts";

const optional = (schema: any) =>
  Type.Optional(Type.Union([schema, Type.Null()]));

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
const textResult = (value: unknown) => {
  const text =
    typeof value === "string" ? value : JSON.stringify(value, null, 2);
  return {
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
  let agentsOpen = false;
  const current = () => {
    if (!kernel)
      throw new Error("Mission Control is not attached to a Pi session");
    return kernel;
  };
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
  const close = async () => {
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
  };
  pi.on("session_start", async (_event, context) => {
    await close();
    ctx = context;
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
    const wake =
      event.messageType === "custom" &&
      event.message.customType === "mission-control-wake"
        ? (event.message.details as any)
        : undefined;
    if (wake && kernel && !kernel.validWake(wake.batchId, wake.generation)) {
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
  pi.on("context", (event) => {
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
  pi.on("message_end", (event) => {
    if (event.message.role === "assistant")
      kernel?.leadMessage(
        event.message.stopReason === "error",
        event.message.usage?.output ?? 0,
      );
  });
  pi.on("agent_settled", (event) => {
    kernel?.leadSettled(event.aborted);
    refresh();
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
      ![
        "mission_status",
        "team_list",
        "team_tree",
        "goal_status",
        "supervisor_control",
        "project_status",
        "project_resolve",
      ].includes(event.toolName)
    )
      kernel?.leadActed();
  });

  function tool(
    name: string,
    label: string,
    description: string,
    parameters: any,
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
    "Change an idle member's role/model/workspace/communication. Existing running work must finish or be cancelled.",
    Type.Object({
      name: Type.String(),
      role: optional(Type.String()),
      model: optional(Type.String()),
      thinkingLevel: optional(Type.String()),
      workspace: optional(WorkspaceSchema),
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
      return current().configureMember(args.name, patch);
    },
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
    "Durably assign work. TUI/RPC default wait:false returns immediately with automatic completion wakeups. One-shot print/json always waits for the result so Pi can finish normally without abandoning children.",
    Type.Object({
      to: Type.String(),
      message: Type.String({ minLength: 1, maxLength: 200000 }),
      wait: Type.Optional(Type.Boolean()),
      timeoutMs: Type.Optional(
        Type.Integer({ minimum: 1000, maximum: 3600000 }),
      ),
    }),
    async (args, signal, context) => {
      const task = current().dispatch(args.to, args.message, {
        timeoutMs: args.timeoutMs,
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
    }),
    async (args, signal, context) => {
      const tasks = current().store.transaction(() =>
        args.members.map((name: string) =>
          current().dispatch(name, args.message),
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
    "subagent",
    "Delegate isolated task",
    "Run one task, parallel tasks, or a dependency chain. All are tracked and wake the lead automatically. Default is asynchronous.",
    Type.Object({
      agent: optional(Type.String()),
      task: optional(Type.String()),
      model: optional(Type.String()),
      workspace: optional(WorkspaceSchema),
      tasks: optional(
        Type.Array(
          Type.Object({
            agent: optional(Type.String()),
            task: Type.String(),
            model: optional(Type.String()),
            workspace: optional(WorkspaceSchema),
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
          }),
          { maxItems: 16 },
        ),
      ),
    }),
    async (args, _signal, context) => {
      const { inputs, chain } = delegationInput(args);
      const prepared = [];
      for (const input of inputs) {
        const name = `sub-${(input.agent ?? "worker").replace(/[^a-z0-9-]/g, "").slice(0, 20)}-${randomUUID().slice(0, 8)}`;
        const definition = await prepareMember(
          {
            name,
            role: input.agent ?? "worker",
            model: input.model ?? args.model,
            workspace: input.workspace,
          },
          context,
          true,
        );
        prepared.push({ definition, task: input.task });
      }
      const jobs = current().store.transaction(() => {
        let previous: string | undefined;
        return prepared.map(({ definition, task: input }) => {
          current().addMember(definition);
          const task = current().dispatch(definition.name, input, {
            dependsOn: chain ? previous : undefined,
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
    "Read objective, real task state, durable notifications, schedules and automatic maintenance.",
    Type.Object({}),
    () => current().snapshot(),
  );
  tool(
    "goal_status",
    "Goal status",
    "Read the runtime-owned mission/Goal; maintenance also works without an explicit Goal.",
    Type.Object({}),
    () =>
      current().store.mission() ?? {
        status: "none",
        maintenance: "automatic upon dispatch",
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
    "mission_complete",
    "Accept mission",
    "Mark the whole approved objective complete only after all work has settled and every acceptance criterion has verified evidence. Answering an intermediate question is not completion.",
    Type.Object({ evidence }),
    (args) => current().complete(args.evidence),
  );
  tool(
    "goal_finish",
    "Accept goal",
    "Compatibility alias for mission_complete. Requires no active tasks and evidence for every criterion.",
    Type.Object({ evidence, goalId: Type.Optional(Type.String()) }),
    (args) => {
      if (args.goalId && args.goalId !== current().store.mission()?.id)
        throw new Error("Goal identity changed");
      return current().complete(args.evidence);
    },
  );
  tool(
    "mission_decision",
    "Request user decision",
    "Record a concrete user decision needed to continue; present the question clearly. This retains all work and maintenance and is not a way to turn monitoring off.",
    Type.Object({ reason: Type.String({ minLength: 1, maxLength: 2000 }) }),
    (args) => current().requireDecision(args.reason),
  );
  tool(
    "supervisor_control",
    "Maintenance status",
    "Maintenance is runtime-owned and automatically active. Model calls can inspect it but cannot disable it or change user report timing.",
    Type.Object({ action: Type.Optional(Type.String()) }),
    (args) => {
      if (args.action && !["status", "on"].includes(args.action))
        throw new Error(
          "Only the user may change mission control through /mission. Safety maintenance cannot be disabled by a model tool.",
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
    "Create or list persistent reminders. Delivery is independent of Goal state. Intervals are fixed seconds; at must include an explicit timezone. Only user commands can delete schedules.",
    Type.Object({
      action: Type.Union([Type.Literal("create"), Type.Literal("list")]),
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
      const selectors = [args.at, args.afterSeconds, args.everySeconds].filter(
        (v) => v !== undefined,
      );
      if (selectors.length !== 1)
        throw new Error("Supply exactly one at, afterSeconds or everySeconds");
      if (args.at && !/(Z|[+-]\d\d:\d\d)$/.test(args.at))
        throw new Error("at requires an ISO timestamp with timezone");
      const next = args.at
        ? Date.parse(args.at)
        : Date.now() + (args.afterSeconds ?? args.everySeconds) * 1000;
      return current().addSchedule(
        args.title ?? "Reminder",
        args.prompt ?? "",
        next,
        args.everySeconds ? args.everySeconds * 1000 : undefined,
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
    (args, signal) => fetchPage(args.url, signal),
  );

  const openAgents = async (context: ExtensionContext, memberName?: string) => {
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
        });
        const active = panel;
        if (memberName) void active.openMember(memberName);
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

  pi.registerCommand("mission", {
    description:
      "Mission dashboard; view <member> | start <objective> | status | pause | resume | stop | report <seconds> | schedules | unschedule <id> | export <new-file.jsonl>",
    handler: async (args, context) => {
      try {
        const [command, ...rest] = args.trim().split(/\s+/);
        const k = current();
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
          if (command !== "resume")
            pi.events.emit("mission-control:interrupt", {
              reason: `User ${command}`,
            });
          await k.userControl(command as any);
          if (command !== "resume" && !context.isIdle()) context.abort();
          context.ui.notify(`Mission ${command}`, "info");
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
        if (command === "export") {
          const destination = path.resolve(
            context.cwd,
            rest.join(" ").replace(/^"|"$/g, ""),
          );
          if (!rest.length)
            throw new Error("Use /mission export <new-file.jsonl>");
          const out = fsSync.createWriteStream(destination, {
            flags: "wx",
            mode: 0o600,
          });
          // Attach error observation before the first asynchronous stream operation.
          const completed = finished(out);
          void completed.catch(() => {});
          let count = 0;
          try {
            const files = [
              context.sessionManager.getSessionFile(),
              ...k.store.members().map((m) => m.sessionFile),
            ].filter((x): x is string => Boolean(x));
            for (const member of k.store.members()) {
              const dir = path.join(k.store.directory, "sessions", member.id);
              try {
                for (const name of await fs.readdir(dir))
                  if (name.endsWith(".jsonl")) files.push(path.join(dir, name));
              } catch (error) {
                if ((error as NodeJS.ErrnoException).code !== "ENOENT")
                  throw error;
              }
            }
            for (const file of [...new Set(files)]) {
              out.write(
                JSON.stringify({ type: "source", sessionFile: file }) + "\n",
              );
              count += await streamPublicSession(file, out);
            }
            out.end();
            await completed;
          } catch (error) {
            out.destroy();
            await completed.catch(() => {});
            throw error;
          }
          context.ui.notify(
            `Exported ${count} public entries to ${destination}. Original Pi history was not modified.`,
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
