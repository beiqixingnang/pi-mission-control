import { restoreTasks,restoreDeliveries,type TaskRecord,type Delivery } from "./tasks.ts";
import path from "node:path";
import type { ResolvedWorkspace } from "../workspace/launch.ts";
import { communication, validMemberName, validRequestId, type Communication } from "./messaging.ts";

export const ROSTER_TYPE = "team-roster";
export interface MemberDefinition {
	name: string;
	role: string;
	systemPrompt?: string;
	model?: string;
	thinkingLevel?: string;
	tools?: string[];
	cwd: string;
	workspace?: ResolvedWorkspace;
	persistent: boolean;
	sessionId?: string;
	communication: Communication;
	createdAt: number;
	interrupted?: boolean;
	turns?: number;
	lastReply?: string;
	lastMessageAt?: number;
}
export interface SavedCompletion {
	parentId?:string;rootId?:string;batchId?:string;owner?:string;inputHash?:string;inputSummary?:string;resultPaths?:string[];deliveryId?:string;sequence?:number;timeoutLayer?:string;processState?:string;
	id: string;
	member: string;
	goalId?: string;
	ok: boolean;
	reply?: string;
	error?: string;
}
export interface RosterSnapshot {
	version: 1;
	members: MemberDefinition[];
	pendingJobs: Array<{ id: string; member: string; goalId?: string }>;
	completedJobs: SavedCompletion[];
	taskTree?:TaskRecord[];
	deliveries?:Delivery[];
	board?:Array<{id:string;title:string;assignee?:string;status:"todo"|"doing"|"done"|"blocked";note?:string;createdAt:number;updatedAt:number}>;
}
function optionalString(value: unknown) { return value === undefined || typeof value === "string"; }
/** Keep the exact ID of v1.0 members: renaming it would orphan their child history. */
export function validMemberSessionId(value: unknown, name: string): value is string {
	return validRequestId(value) || (typeof value === "string" && value.length <= 256 && value.startsWith("team-") && value.endsWith(`-${name}`) && /^[A-Za-z0-9][A-Za-z0-9._-]*[A-Za-z0-9]$/.test(value));
}
function parseDefinition(value: unknown): MemberDefinition {
	const member = value as MemberDefinition;
	if (!member || !validMemberName(member.name) || typeof member.role !== "string" || !member.role.trim() || typeof member.cwd !== "string" || !path.isAbsolute(member.cwd) || member.persistent !== true || !validMemberSessionId(member.sessionId, member.name) || !Number.isFinite(member.createdAt) || !optionalString(member.systemPrompt) || !optionalString(member.model) || !optionalString(member.thinkingLevel) || !optionalString(member.lastReply) || (member.interrupted !== undefined && typeof member.interrupted !== "boolean") || (member.turns !== undefined && (!Number.isSafeInteger(member.turns) || member.turns < 0)) || (member.tools !== undefined && (!Array.isArray(member.tools) || member.tools.some(tool => typeof tool !== "string")))) throw new Error("Invalid persistent team member definition.");
	// A malformed policy must never be restored as an unrestricted member.
	if (member.workspace !== undefined) {
		const workspace = member.workspace;
		if (!workspace || typeof workspace.root !== "string" || !path.isAbsolute(workspace.root) || !["read-only", "read-write"].includes(workspace.access) || !["disabled","sandbox"].includes(workspace.execution) || !Array.isArray(workspace.extraReadRoots) || workspace.extraReadRoots.some(root => typeof root !== "string" || !path.isAbsolute(root))) throw new Error("Invalid persisted team workspace policy.");
		if(workspace.execution==="sandbox"&&(!workspace.sandbox||workspace.sandbox.engine!=="podman"||typeof workspace.sandbox.image!=="string"))throw new Error("Invalid persisted sandbox configuration.");
	}
	return { ...JSON.parse(JSON.stringify(member)), communication: communication(member.communication) };
}
/** Use only the newest branch snapshot, including an explicit empty roster. */
export function readRoster(branch: readonly { type: string; customType?: string; data?: unknown }[]): RosterSnapshot | undefined {
	let latest: unknown;
	let found = false;
	for (const entry of branch) if (entry.type === "custom" && entry.customType === ROSTER_TYPE) { latest = entry.data; found = true; }
	if (!found) return undefined;
	const snapshot = latest as RosterSnapshot;
	if (!snapshot || snapshot.version !== 1 || !Array.isArray(snapshot.members) || snapshot.members.length > 100 || !Array.isArray(snapshot.pendingJobs) || snapshot.pendingJobs.length > 1000 || !Array.isArray(snapshot.completedJobs) || snapshot.completedJobs.length > 100) throw new Error("Invalid team-roster snapshot; no members were restored.");
	const members = snapshot.members.map(parseDefinition);
	if (new Set(members.map(member => member.name)).size !== members.length || new Set(members.map(member => member.sessionId)).size !== members.length) throw new Error("Duplicate persistent team identity.");
	const pendingJobs = snapshot.pendingJobs.map(job => {
		if (!job || typeof job.id !== "string" || !validMemberName(job.member) || !optionalString(job.goalId)) throw new Error("Invalid persisted team job.");
		return { id: job.id, member: job.member, goalId: job.goalId };
	});
	const completedJobs = snapshot.completedJobs.map(result => {
		if (!result || typeof result.id !== "string" || !validMemberName(result.member) || typeof result.ok !== "boolean" || !optionalString(result.goalId) || !optionalString(result.reply) || !optionalString(result.error)) throw new Error("Invalid persisted team completion.");
		return { ...result };
	});
	const taskTree=restoreTasks(snapshot.taskTree),deliveries=restoreDeliveries(snapshot.deliveries);
	if(snapshot.board!==undefined&&(!Array.isArray(snapshot.board)||snapshot.board.length>2000||snapshot.board.some(task=>!task||typeof task.id!=="string"||typeof task.title!=="string"||!["todo","doing","done","blocked"].includes(task.status))))throw new Error("Invalid task board snapshot.");
	return { version: 1, members, pendingJobs, completedJobs,taskTree,deliveries,board:snapshot.board??[] };
}
