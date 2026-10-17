import fs from "node:fs/promises";
import path from "node:path";
import { Type } from "typebox";
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
import type { Member } from "../../runtime/types.ts";

const result = (value: unknown) => ({
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
  ]);
  const names: string[] = [];
  const register = (definition: ToolDefinition<any, any>) => {
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
  const guard = (
    definition: ToolDefinition<any, any>,
  ): ToolDefinition<any, any> => {
    const original = definition.execute;
    return {
      ...definition,
      description:
        definition.description +
        " File access is restricted to the assigned roots.",
      async execute(id, args, signal, update, ctx) {
        const writing = ["write", "edit"].includes(definition.name);
        const target = await access.authorize(
          args.path ?? ".",
          writing,
          definition.name === "write",
        );
        return original(id, { ...args, path: target }, signal, update, ctx);
      },
    };
  };
  register(
    guard(
      createReadToolDefinition(process.cwd(), {
        operations: {
          access: async (target) => {
            await access.authorize(target);
          },
          readFile: (target) => access.read(target),
          detectImageMimeType: async () => undefined,
        },
      }),
    ),
  );
  if (policy.access === "read-write") {
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
            if (
              [
                ".git",
                ".pi",
                ".agents",
                "node_modules",
                ".mission-control",
              ].includes(e.name)
            )
              continue;
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
    name: "team_message",
    label: "Team message",
    description:
      "Assign approved downstream work, or send a progress/decision note. The coordinator validates directed communication permissions and task identity.",
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
        Type.Integer({ minimum: 1000, maximum: 3600000 }),
      ),
    }),
    async execute(id, args) {
      return result(await request(id, { op: "message", ...args }));
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
  pi.on("tool_call", (event) => {
    if (!names.includes(event.toolName))
      return {
        block: true,
        reason: "Tool is outside this member's explicit capability set",
      };
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
  pi.on("session_start", (_event, ctx) => {
    pi.setActiveTools(names);
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
      void request("ping", { op: "ping" }).then(
        () => {
          failures = 0;
        },
        () => {
          if (++failures >= 3) {
            ctx.abort();
            setTimeout(() => process.exit(1), 1000).unref();
          }
        },
      );
    }, 2000);
    timer.unref();
  });
  pi.on("before_agent_start", (event) => {
    event.systemPromptOptions.promptGuidelines.push(
      `You are ${member.name}: ${member.role}. Assigned root ${policy.root}, access ${policy.access}, execution ${policy.execution}. Host mode is explicitly trusted and unconfined at the OS level. Use team_message for permitted peers, team_wait alone for descendants, and report only significant decisions/failures to lead. Never ask the lead to run routine tests on your behalf.`,
    );
  });
  pi.on("session_shutdown", () => {
    if (timer) clearInterval(timer);
  });
}
