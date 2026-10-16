/** Test-only driver: forces a real lead to settle after dispatching two real members. */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

export default function (pi: ExtensionAPI) {
	let checkpointDone = false;
	pi.registerTool({
		name: "probe_checkpoint", label: "Test: force continuation boundary", description: "After automatic team wake, call this once as the only tool call BEFORE goal_finish. It ends a lead run while the goal remains unfinished, forcing Goal's continuation boundary to resume it.", parameters: Type.Object({}),
		async execute() { checkpointDone = true; return { content: [{ type: "text", text: "Checkpoint reached. Goal remains unfinished; its controller must continue automatically now. On continuation, call goal_finish." }], details: {}, terminate: true }; },
	});
	pi.registerCommand("probe-close", { description: "Close the isolated integration-test runtime", handler: async (_args, ctx) => { ctx.shutdown(); } });
	pi.registerTool({
		name: "probe_dispatch", label: "Test: dispatch real team", description: "Run the requested Goal/team integration probe once, then stop the lead while two real model members work.",
		parameters: Type.Object({}), reachesTools: () => ["goal_start", "team_spawn", "team_send"],
		async execute(_id, _params, signal, _update, ctx) {
			const call = async (name: string, args: unknown) => {
				const result = await ctx.executeTool(name, args, { signal });
				if (result.isError) throw new Error(`${name} failed: ${JSON.stringify(result.result.content)}`);
				return result.result;
			};
			await call("goal_start", {
				objective: "Have two configured members compute independently, save their answers, and verify both artifacts after automatic wakeup.",
				criteria: ["Member A writes member-a.txt containing exactly 323 for 17 * 19.", "Member B writes member-b.txt containing exactly 667 for 23 * 29."],
				verificationCommands: ["node -e 'const fs=require(\"fs\");if(fs.readFileSync(\"member-a.txt\",\"utf8\").trim()!==\"323\"||fs.readFileSync(\"member-b.txt\",\"utf8\").trim()!==\"667\")process.exit(1);console.log(\"ARTIFACTS_VERIFIED\")'"],
				maxContinuations: 5, maxMinutes: 5, maxOutputTokens: 12000,
			});
			const memberAModel = process.env.PI_LIVE_MEMBER_MODEL_A || process.env.PI_LIVE_MEMBER_MODEL;
			const memberBModel = process.env.PI_LIVE_MEMBER_MODEL_B || process.env.PI_LIVE_MEMBER_MODEL;
			if (!memberAModel || !memberBModel) throw new Error("Set PI_LIVE_MEMBER_MODEL (or PI_LIVE_MEMBER_MODEL_A/B) before running the live Goal test.");
			for (const [name, model] of [["member-a", memberAModel], ["member-b", memberBModel]]) {
				await call("team_spawn", { name, model, cwd: ctx.cwd, role: "Arithmetic and artifact verification probe", tools: ["write"],
					systemPrompt: "Only do the exact arithmetic/file task from the lead. Use the write tool once with the requested absolute path. Do not delegate. After writing, reply with the result and the file path." });
			}
			await call("team_send", { to: "member-a", wait: false, timeoutMs: 90000, message: `Compute 17 * 19. Write only the numeric result and a newline to ${ctx.cwd.replace(/\\/g, "/")}/member-a.txt using write. Then report the answer.` });
			await call("team_send", { to: "member-b", wait: false, timeoutMs: 90000, message: `Compute 23 * 29. Write only the numeric result and a newline to ${ctx.cwd.replace(/\\/g, "/")}/member-b.txt using write. Then report the answer.` });
			return { content: [{ type: "text", text: "Both real member tasks were dispatched. This lead run now ends; member completion must wake it without any new user prompt or polling." }], details: {}, terminate: true };
		},
	});
	pi.on("tool_call", event => {
		if (event.toolName === "goal_finish" && !checkpointDone) return { block: true, reason: "Call probe_checkpoint once, as the only tool call, before accepting the goal." };
	});
	pi.on("before_agent_start", event => {
		event.systemPromptOptions.promptGuidelines.push("Integration test: on the initial request, call probe_dispatch exactly once as the only tool call. After team completion wakes you, call probe_checkpoint ONCE as the ONLY tool call before goal_finish. It intentionally ends a run with the goal unfinished. When the Goal controller continues after that checkpoint, accept the goal with goal_finish and one evidence item per criterion; its configured bash check must run. Do not call probe_dispatch again. After success reply exactly GOAL_TEAM_PASS. Do not poll team_list or call team_collect.");
	});
}
