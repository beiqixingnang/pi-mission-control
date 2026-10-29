import fs from "node:fs/promises";
import path from "node:path";
import { Type, type TSchema } from "typebox";
import {
  createReadToolDefinition,
  createWriteToolDefinition,
  createEditToolDefinition,
  createBashToolDefinition,
  createPowerShellToolDefinition,
  getAgentDir,
  getPackageDir,
  type ExtensionAPI,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { WorkspaceAccess, resolveWorkspace } from "../workspace/policy.ts";
import { runSandbox } from "../workspace/sandbox.ts";
import installReconnect from "./reconnect.ts";
import { searchWeb, fetchPage } from "../../runtime/web.ts";
import { fileURLToPath } from "node:url";
import type { Member } from "../../runtime/types.ts";
import { memberWorkflowGuidance } from "../../runtime/guidance.ts";
import { capabilityView } from "../../runtime/team-policy.ts";

const result = (value: unknown) => ({
  details: undefined,
  content: [
    {
      type: "text" as const,
      text: typeof value === "string" ? value : JSON.stringify(value, null, 2),
    },
  ],
});
export default async function (pi: ExtensionAPI) {
  if (!process.env.MC_V2_MEMBER) return;
  installReconnect(pi);
  const config = JSON.parse(process.env.MC_V2_MEMBER) as {
    member: Member;
    taskId: string;
    epoch: number;
    directory: string;
  };
  const { member } = config;
  const policy = await resolveWorkspace(
    {
      ...member.workspace,
      execution:
        member.workspace.execution === "files"
          ? "disabled"
          : member.workspace.execution,
    },
    process.cwd(),
  );
  if (policy.execution === "host" && policy.access === "read-only")
    throw new Error(
      "Read-only host commands cannot be confined. Select files or sandbox execution for a read-only member.",
    );
  const access = new WorkspaceAccess(policy, process.cwd(), [
    getAgentDir(),
    getPackageDir(),
    config.directory,
    fileURLToPath(new URL("../../", import.meta.url)),
  ]);
  const names: string[] = [];
  let permitted = new Set<string>();
  let resourceAccess: WorkspaceAccess[] = [];
  const readAccess = async (source: string) => {
    try {
      await access.authorize(source);
      return access;
    } catch (error) {
      for (const resource of resourceAccess) {
        try {
          await resource.authorize(source);
          return resource;
        } catch {}
      }
      throw error;
    }
  };
  const register = <TParams extends TSchema, TDetails, TState>(
    definition: ToolDefinition<TParams, TDetails, TState>,
  ) => {
    names.push(definition.name);
    pi.registerTool(definition);
  };
  const request = async (id: string, body: unknown) => {
    const response = await fetch(process.env.MC_V2_BRIDGE!, {
      method: "POST",
      headers: {
        authorization: `Bearer ${process.env.MC_V2_TOKEN}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ id, ...(body as object) }),
      signal: AbortSignal.timeout(15000),
    });
    const data = (await response.json()) as any;
    if (!response.ok || !data.ok)
      throw new Error(data.error ?? `Coordinator HTTP ${response.status}`);
    return data.result;
  };
  const guard = <TParams extends TSchema, TDetails, TState>(
    definition: ToolDefinition<TParams, TDetails, TState>,
  ): ToolDefinition<TParams, TDetails, TState> => {
    const original = definition.execute;
    return {
      ...definition,
      description:
        definition.description +
        " File access is restricted to the assigned roots.",
      async execute(id, args, signal, update, ctx) {
        if (!args || typeof args !== "object")
          throw new Error("File tool arguments must be an object");
        const source = "path" in args ? args.path : ".";
        if (typeof source !== "string")
          throw new Error("File tool path must be a string");
        const writing = ["write", "edit"].includes(definition.name);
        const target = await (
          writing ? access : await readAccess(source)
        ).authorize(source, writing, definition.name === "write");
        return original(id, { ...args, path: target }, signal, update, ctx);
      },
    };
  };
  register(
    guard(
      createReadToolDefinition(process.cwd(), {
        operations: {
          access: async (target) => {
            await readAccess(target);
          },
          readFile: async (target) => (await readAccess(target)).read(target),
          detectImageMimeType: async () => undefined,
        },
      }),
    ),
  );
  if (access.writeRoots.length) {
    register(
      guard(
        createWriteToolDefinition(process.cwd(), {
          operations: {
            mkdir: (target) => access.mkdir(target),
            writeFile: (target, text) => access.write(target, text),
          },
        }),
      ),
    );
    register(
      guard(
        createEditToolDefinition(process.cwd(), {
          operations: {
            access: async (target) => {
              await access.authorize(target, true);
            },
            readFile: (target) => access.read(target),
            writeFile: (target, text) => access.write(target, text),
          },
        }),
      ),
    );
  }
  register({
    name: "ls",
    label: "List workspace",
    description:
      "List one authorized directory; links and protected directories are not traversed.",
    parameters: Type.Object({ path: Type.Optional(Type.String()) }),
    async execute(_id, args) {
      const directory = await access.authorize(args.path ?? ".");
      const entries = await fs.readdir(directory, { withFileTypes: true });
      return result(
        entries
          .slice(0, 500)
          .filter((e) => !e.isSymbolicLink())
          .map((e) => `${e.isDirectory() ? "d" : "f"} ${e.name}`)
          .join("\n"),
      );
    },
  });
  register({
    name: "grep",
    label: "Search workspace",
    description:
      "Search authorized regular text files with a literal string. Bounded to 10000 visited entries and 200 matches.",
    parameters: Type.Object({
      pattern: Type.String(),
      path: Type.Optional(Type.String()),
    }),
    async execute(_id, args, signal) {
      const root = await access.authorize(args.path ?? ".");
      const matches: string[] = [];
      let visits = 0;
      async function walk(target: string) {
        if (signal?.aborted) throw new Error("Cancelled");
        if (++visits > 10000 || matches.length >= 200) return;
        const stat = await fs.lstat(target);
        if (stat.isSymbolicLink()) return;
        if (stat.isDirectory()) {
          for (const e of await fs.readdir(target, { withFileTypes: true })) {
            if (["node_modules"].includes(e.name)) continue;
            await walk(path.join(target, e.name));
            if (matches.length >= 200) break;
          }
        } else if (stat.isFile() && stat.size < 1024 * 1024) {
          try {
            const body = (await access.read(target)).toString("utf8");
            if (!body.includes("\0"))
              body.split("\n").forEach((line, index) => {
                if (matches.length < 200 && line.includes(args.pattern))
                  matches.push(
                    `${path.relative(policy.root, target)}:${index + 1}: ${line.slice(0, 400)}`,
                  );
              });
          } catch (error) {
            if (!String(error).includes("WORKSPACE_DENIED")) throw error;
          }
        }
      }
      await walk(root);
      return result(matches.join("\n") || "No matches");
    },
  });
  if (policy.execution === "host")
    register({
      ...createBashToolDefinition(process.cwd()),
      description:
        "Trusted HOST shell execution. This command has the host user's authority and is not an OS sandbox; use only for the assigned task.",
    });
  if (policy.execution === "host" && process.platform === "win32")
    register({
      ...createPowerShellToolDefinition(process.cwd()),
      description:
        "Trusted native Windows PowerShell. Prefer this for Windows paths and host tools; bash may be a WSL shell. This is not an OS sandbox.",
    });
  if (policy.execution === "sandbox")
    register({
      name: "workspace_exec",
      label: "Container command",
      description:
        "Execute in the configured Podman snapshot container; no host fallback and no network.",
      parameters: Type.Object({
        command: Type.String(),
        timeoutSeconds: Type.Optional(Type.Number()),
        cwd: Type.Optional(Type.String()),
      }),
      async execute(_id, args, signal) {
        const value = await runSandbox(policy, args, signal);
        return {
          ...result({ ...value, output: value.output.slice(0, 16000) }),
          isError: !value.ok,
        };
      },
    });
  register({
    name: "find",
    label: "Find workspace files",
    description:
      "Find authorized regular files by a glob (*, **, ?) or literal path fragment. Bounded to 10000 entries and 500 results.",
    parameters: Type.Object({
      pattern: Type.String({ maxLength: 400 }),
      path: Type.Optional(Type.String()),
    }),
    async execute(_id, args, signal) {
      const root = await access.authorize(args.path ?? ".");
      const escape = (value: string) =>
        value.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
      const matcher =
        args.pattern.includes("*") || args.pattern.includes("?")
          ? new RegExp(
              "^" +
                args.pattern
                  .split("**")
                  .map((part) => part.split("*").map(escape).join("[^/]*"))
                  .join(".*")
                  .replaceAll("\\?", ".") +
                "$",
            )
          : undefined;
      const matches: string[] = [];
      let visits = 0;
      async function walk(file: string) {
        signal?.throwIfAborted();
        if (++visits > 10000 || matches.length >= 500) return;
        const stat = await fs.lstat(file);
        if (stat.isSymbolicLink()) return;
        if (stat.isDirectory())
          for (const entry of await fs.readdir(file, { withFileTypes: true })) {
            if (["node_modules"].includes(entry.name)) continue;
            await walk(path.join(file, entry.name));
            if (visits > 10000 || matches.length >= 500) break;
          }
        else if (stat.isFile()) {
          await access.authorize(file);
          const relative = path.relative(root, file).replaceAll("\\", "/");
          if (
            matcher
              ? matcher.test(relative) || matcher.test(path.basename(file))
              : relative.includes(args.pattern)
          )
            matches.push(relative);
        }
      }
      await walk(root);
      return result({
        files: matches,
        bounded: visits > 10000 || matches.length >= 500,
      });
    },
  });
  const searchConfig = JSON.parse(process.env.MC_V2_SEARCH ?? "{}");
  register({
    name: "web_search",
    label: "Search web",
    description:
      "Search public references for the assigned task using the configured provider.",
    parameters: Type.Object({
      query: Type.String({ minLength: 1, maxLength: 2000 }),
    }),
    async execute(_id, args, signal) {
      return result(await searchWeb(args.query, searchConfig, signal));
    },
  });
  register({
    name: "web_fetch",
    label: "Fetch public page",
    description:
      "Read a public HTTP(S) page for the assigned task; private hosts and unbounded responses are rejected.",
    parameters: Type.Object({ url: Type.String() }),
    async execute(_id, args, signal) {
      return result(
        await fetchPage(
          args.url,
          signal,
          undefined,
          JSON.parse(process.env.MC_V2_WEB_FETCH ?? "{}"),
        ),
      );
    },
  });
  register({
    name: "goal_context",
    label: "Read assigned goal",
    description:
      "Read this task's goal revision, parent stages, scope, acceptance criteria and optional execution plan. section:plan returns text pages and current planRevision/editPermission; goalId may select an ancestor, descendant or another explicitly authorized plan in this main goal. Fetch missing pages only when previews are incomplete. Reading grants no edit or acceptance authority.",
    parameters: Type.Object({
      section: Type.Optional(
        Type.Union(
          ["summary", "criteria", "scope", "plan"].map((value) =>
            Type.Literal(value),
          ),
        ),
      ),
      offset: Type.Optional(Type.Integer({ minimum: 0 })),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 5 })),
      goalId: Type.Optional(Type.String()),
    }),
    async execute(id, args) {
      return result(await request(id, { op: "goal-context", ...args }));
    },
  });
  register({
    name: "goal_submit",
    label: "Submit goal completion",
    description:
      "Submit one or many assigned goals as completed for lead acceptance while this member task continues. Bind every entry to its exact goalId and current revision; include a concrete result summary and optional criterion evidence paths. This records a pending submission, never accepts or changes criteria/scope, never waits for the lead, and never ends the task. Resubmit after code changes to supersede the prior submission; withdrawGoalIds retracts this task's current submissions so work can continue.",
    parameters: Type.Object({
      submissions: Type.Optional(
        Type.Array(
          Type.Object({
            goalId: Type.Optional(Type.String()),
            revision: Type.Integer({ minimum: 0 }),
            summary: Type.String({ minLength: 8, maxLength: 2000 }),
            evidence: Type.Optional(
              Type.Array(
                Type.Object({
                  criterion: Type.Integer({ minimum: 1 }),
                  summary: Type.String({ minLength: 8, maxLength: 2000 }),
                  path: Type.Optional(Type.String({ maxLength: 4000 })),
                }),
                { maxItems: 100 },
              ),
            ),
          }),
          { minItems: 1, maxItems: 50 },
        ),
      ),
      withdrawGoalIds: Type.Optional(
        Type.Array(
          Type.Object({
            goalId: Type.String(),
            revision: Type.Integer({ minimum: 0 }),
          }),
          { maxItems: 50 },
        ),
      ),
    }),
    async execute(id, args) {
      return result(await request(id, { op: "goal-submit", ...args }));
    },
  });
  register({
    name: "goal_plan_update",
    label: "Edit authorized execution plan",
    description:
      "Edit only execution-plan text for the assigned goal (or an explicitly authorized goalId in this main goal). Requires a once or permanent grant from the lead and the latest planRevision from goal_context(section:plan). A successful changed write consumes a once grant; stale/invalid/no-op writes do not. null removes the plan. Cannot change criteria, scope, acceptance, execution permission or grant editing to others.",
    parameters: Type.Object({
      goalId: Type.Optional(Type.String()),
      plan: Type.Union([Type.String({ maxLength: 16000 }), Type.Null()]),
      planRevision: Type.Integer({ minimum: 0 }),
    }),
    async execute(id, args) {
      return result(await request(id, { op: "goal-plan-update", ...args }));
    },
  });
  register({
    name: "team_message",
    label: "Team message",
    description:
      "Send a direct note to a permitted executor/reviewer (operation:note, the default; never creates a task), or explicitly assign approved formal downstream work (operation:assign). Ordinary review discussion and counterexamples stay between peers, without lead relay or new task rounds.",
    parameters: Type.Object({
      to: Type.String(),
      message: Type.String({ maxLength: 16000 }),
      operation: Type.Optional(
        Type.Union([Type.Literal("assign"), Type.Literal("note")]),
      ),
      kind: Type.Optional(
        Type.Union([
          Type.Literal("progress"),
          Type.Literal("decision"),
          Type.Literal("failure"),
        ]),
      ),
      timeoutMs: Type.Optional(
        Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
      ),
      timeoutPolicy: Type.Optional(
        Type.Union([Type.Literal("none"), Type.Literal("fixed")]),
      ),
      queueTimeoutMs: Type.Optional(
        Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
      ),
      goalId: Type.Optional(Type.String()),
      goalIds: Type.Optional(
        Type.Array(Type.String({ minLength: 1 }), {
          minItems: 1,
          maxItems: 100,
        }),
      ),
    }),
    async execute(id, args) {
      return result(await request(id, { op: "message", ...args }));
    },
  });
  register({
    name: "team_capabilities",
    label: "Inspect actual capabilities",
    description:
      "Read this member's desired and running capability revisions, actual tools, model, paths and pending changes. Names and roles grant no permissions.",
    parameters: Type.Object({}),
    async execute(id) {
      return result(await request(id, { op: "capabilities" }));
    },
  });
  register({
    name: "team_review",
    label: "Request or inspect paired review",
    description:
      "Request a formal review of an explicit file batch by a permitted peer and end this turn at a safe boundary. Execution stays held until review completes; status reads the current snapshot and review evidence without creating work.",
    parameters: Type.Object({
      action: Type.Optional(
        Type.Union([Type.Literal("request"), Type.Literal("status")]),
      ),
      reviewer: Type.Optional(Type.String()),
      message: Type.Optional(Type.String({ minLength: 1, maxLength: 16000 })),
      files: Type.Optional(
        Type.Array(Type.String(), { minItems: 1, maxItems: 100 }),
      ),
    }),
    async execute(id, args) {
      if (args.action === "status")
        return result(await request(id, { op: "review-status" }));
      return {
        ...result(await request(id, { op: "review", ...args })),
        terminate: true,
      };
    },
  });
  register({
    name: "team_wait",
    label: "Wait for descendants",
    description:
      "Call alone after assigning descendants. Ends this member turn; the runtime resumes the same session when descendants finish.",
    executionMode: "sequential",
    parameters: Type.Object({}),
    async execute(id) {
      return { ...result(await request(id, { op: "wait" })), terminate: true };
    },
  });
  register({
    name: "team_collect",
    label: "Collect descendant",
    description:
      "Read a saved result of this task or a direct descendant without bypassing workspace paths.",
    parameters: Type.Object({ taskId: Type.String() }),
    async execute(id, args) {
      return result(await request(id, { op: "collect", ...args }));
    },
  });
  register({
    name: "mission_decision",
    label: "Request decision",
    description:
      "Record a concrete decision needed from the coordinator; ends this turn and retains all task evidence.",
    parameters: Type.Object({
      reason: Type.String({ minLength: 1, maxLength: 2000 }),
    }),
    async execute(id, args) {
      return {
        ...result(await request(id, { op: "decision", ...args })),
        terminate: true,
      };
    },
  });
  const activeCalls = new Set<string>();
  pi.on("tool_call", async (event, ctx) => {
    if (!permitted.has(event.toolName))
      return {
        block: true,
        reason: "Tool is outside this member's explicit capability set",
      };
    const gate = await request(`begin:${event.toolCallId}`, {
      op: "tool-begin",
      callId: event.toolCallId,
      tool: event.toolName,
    });
    if (gate.denied) {
      if (gate.action === "settle") ctx.abort();
      return {
        block: true,
        reason:
          "This execution is settling at a safe boundary for review or a capability revision. The runtime retains results and resumes the authorized batch.",
      };
    }
    activeCalls.add(event.toolCallId);
  });
  pi.on("tool_execution_end", async (event, ctx) => {
    if (!activeCalls.delete(event.toolCallId)) return;
    const gate = await request(`end:${event.toolCallId}`, {
      op: "tool-end",
      callId: event.toolCallId,
    });
    if (gate.action === "settle") ctx.abort();
  });
  pi.on("user_bash", () => ({
    result: {
      output: "Interactive shell is disabled in member sessions",
      exitCode: 1,
      cancelled: false,
      truncated: false,
    },
  }));
  let timer: ReturnType<typeof setInterval> | undefined;
  let failures = 0;
  pi.on("session_start", async (_event, ctx) => {
    const configured: string[] = JSON.parse(
      process.env.MC_V2_WORKER_EXTENSIONS ?? "[]",
    );
    const sourcePath = (value: string) =>
      path
        .resolve(value.startsWith("file:") ? fileURLToPath(value) : value)
        .replaceAll("\\", "/")
        .toLowerCase();
    const extraSources = new Set(configured.map(sourcePath));
    extraSources.add(
      sourcePath(
        path.join(
          path.dirname(fileURLToPath(import.meta.url)),
          "compaction.ts",
        ),
      ),
    );
    const coordinator = new Set([
      "team_spawn",
      "team_configure",
      "team_disband",
      "team_send",
      "team_broadcast",
      "team_cancel",
      "team_resume",
      "goal_start",
      "goal_plan",
      "goal_plan_authorize",
      "goal_edit",
      "goal_focus",
      "goal_accept",
      "goal_activate",
      "goal_update",
      "goal_stop",
      "goal_pause",
      "goal_resume",
      "goal_finish",
      "mission_complete",
      "mission_control",
      "mission_policy",
      "mission_recover",
      "mission_reconcile",
      "mission_report",
      "mission_notifications",
      "mission_compact",
      "mission_wait_external",
      "mission_signal",
      "supervisor_control",
      "schedule",
      "subagent",
      "reconnect_config",
      "project_status",
      "project_resolve",
      "project_apply",
      "project_recover",
    ]);
    const extras = pi
      .getAllTools()
      .filter(
        (tool) =>
          tool.exposure !== "hidden" &&
          extraSources.has(sourcePath(tool.sourceInfo.path)) &&
          !coordinator.has(tool.name),
      )
      .map((tool) => tool.name);
    const available = new Set([...names, ...extras]);
    if (member.tools?.some((name) => !available.has(name)))
      throw new Error(
        "Requested member tool is unavailable under its workspace/extension policy",
      );
    const coordination = [
      "team_message",
      "team_wait",
      "team_collect",
      "mission_decision",
      "goal_context",
      "goal_submit",
      "goal_plan_update",
      "team_capabilities",
      "team_review",
    ];
    permitted = new Set(
      member.tools ? [...coordination, ...member.tools] : available,
    );
    pi.setActiveTools([...permitted]);
    await request("ready", { op: "ready", tools: [...permitted] });
    timer = setInterval(() => {
      let alive = true;
      try {
        process.kill(Number(process.env.MC_V2_PARENT_PID), 0);
      } catch {
        alive = false;
      }
      if (!alive) {
        ctx.abort();
        process.exitCode = 1;
        setTimeout(() => process.exit(1), 1000).unref();
        return;
      }
      void request("ping", { op: "ping" })
        .then(
          async (status) => {
            failures = 0;
            if (status.pending && !activeCalls.size) {
              const gate = await request(`checkpoint:${crypto.randomUUID()}`, {
                op: "checkpoint",
              });
              if (gate.action === "settle") ctx.abort();
            }
          },
          () => {
            if (++failures >= 3) {
              ctx.abort();
              setTimeout(() => process.exit(1), 1000).unref();
            }
          },
        )
        .catch(() => {});
    }, 2000);
    timer.unref();
  });
  pi.on("before_agent_start", async (event) => {
    resourceAccess = [];
    for (const skill of event.systemPromptOptions.skills) {
      const root = await fs.realpath(skill.baseDir);
      resourceAccess.push(
        new WorkspaceAccess(
          {
            root,
            access: "read-only",
            execution: "disabled",
            extraReadRoots: [],
          },
          process.cwd(),
        ),
      );
    }
    pi.setActiveTools([...permitted]);
    event.systemPromptOptions.promptGuidelines.push(
      `You are ${member.name}: ${member.role}. Assigned root ${policy.root}, access ${policy.access}, execution ${policy.execution}. Host mode is explicitly trusted and unconfined at the OS level. Use tools needed for the actual approved task; role names add no separate restrictions. Use goal_context for complete assigned criteria, scope and optional execution plans. When a concrete subgoal is finished, call goal_submit with its exact current revision, result summary and evidence paths; batch related assigned goals when appropriate. goal_submit records pending lead acceptance and lets this task continue; it never accepts the goal or waits for the lead. Resubmit after relevant changes or withdraw your current submission before continuing. Follow available plans within existing authorization and choose routine details without repeated questions. Read the current planRevision; goal_plan_update needs an explicit once/permanent grant for that goal and changes plan text only. Reuse valid evidence, report concrete results and uncovered items, and let the lead record acceptance. Choose routine methods yourself; avoid repeated checks or needless permission requests. Use team_message for permitted peers and team_wait alone for descendants. Never ask the lead to run routine tests on your behalf when your tools allow them; report an actual capability gap precisely.`,
      `Actual capabilities for this execution: ${JSON.stringify(capabilityView(member, [...permitted]))}`,
      memberWorkflowGuidance,
    );
  });
  pi.on("session_shutdown", () => {
    if (timer) clearInterval(timer);
  });
}
