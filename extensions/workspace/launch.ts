import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Type } from "typebox";
import { POLICY_ENV, allowedTools, toolAlias, inside, resolveInput, resolveWorkspace, type WorkspaceOptions, type ResolvedWorkspace } from "./policy.ts";
export type { WorkspaceOptions, ResolvedWorkspace } from "./policy.ts";

export const WorkspaceSchema = Type.Object({
	root: Type.String({ minLength: 1, description: "Authorized workspace directory, resolved relative to the lead's cwd." }),
	access: Type.Optional(Type.Union([Type.Literal("read-only"), Type.Literal("read-write")], { description: "File access in the primary workspace; default read-write." })),
	extraReadRoots: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { maxItems: 20, description: "Additional separate directories that are always read-only." })),
	execution: Type.Optional(Type.Union([Type.Literal("disabled"), Type.Literal("sandbox")], { description: "Default disabled: no host commands or delegation. Sandbox requires a configured backend; unavailable backends fail instead of running on the host." })),
}, { additionalProperties: false });

export async function prepareWorkspaceLaunch(options: { baseCwd: string; cwd?: string; workspace?: WorkspaceOptions; tools?: string[] }): Promise<{ cwd: string; args: string[]; env: Record<string, string>; workspace?: ResolvedWorkspace }> {
	if (process.env[POLICY_ENV]) throw new Error("WORKSPACE_DENIED: restricted members cannot create nested agents or widen their workspace.");
	if (options.tools !== undefined && (!Array.isArray(options.tools) || options.tools.some(tool => typeof tool !== "string"))) throw new Error("Invalid tool allowlist.");
	if (options.workspace === undefined) {
		return { cwd: options.cwd ? resolveInput(options.cwd, options.baseCwd) : options.baseCwd, args: options.tools?.length ? ["--tools", options.tools.join(",")] : [], env: {} };
	}
	const workspace = await resolveWorkspace(options.workspace, options.baseCwd);
	const cwd = options.cwd ? resolveInput(options.cwd, options.baseCwd) : workspace.root;
	if (!inside(workspace.root, cwd)) throw new Error("Restricted member cwd must be inside its primary workspace.");
	// Verify cwd now, including junctions, rather than relying on a later spawn error.
	const { WorkspaceAccess } = await import("./policy.ts");
	await new WorkspaceAccess(workspace, workspace.root).authorize(cwd);
	if (!(await fs.stat(cwd)).isDirectory()) throw new Error("Restricted member cwd must be a directory.");
	const permitted = allowedTools(workspace);
	const requested = options.tools ?? permitted;
	for (const tool of requested) if (!permitted.includes(tool)) throw new Error(`WORKSPACE_DENIED: tool '${tool}' is not available in restricted mode. Allowed: ${permitted.join(", ")}.`);
	const guard = fileURLToPath(new URL("./index.ts", import.meta.url));
	return {
		cwd, workspace,
		args: ["--no-extensions", "--extension", guard, "--no-mcp", "--no-skills", "--no-prompt-templates", "--no-themes", "--no-context-files", "--no-approve", ...(requested.length ? ["--tools", requested.map(toolAlias).join(",")] : ["--no-tools"])],
		env: { [POLICY_ENV]: JSON.stringify(workspace) },
	};
}
