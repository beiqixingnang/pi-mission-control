/**
 * Compaction-summary model extension
 *
 * Routes context compaction (`session_before_compact`) and branch summaries
 * (`session_before_tree`) to a configurable model instead of the conversation's
 * active model. Useful when the main model has tight upstream rate limits: the
 * large summarization request then goes to a cheaper/roomier model.
 *
 * Model selection (first match wins):
 *   1. env  PI_COMPACTION_SUMMARY_MODEL=provider/model-id
 *   2. file <agentDir>/compaction-summary.json  { "model": "...", "maxTokens": 8192 }
 *   3. default below
 *
 * Change it at runtime with the `/compaction-model [provider/model-id]` command.
 *
 * Any failure falls back to Pi's normal compaction (returning nothing).
 * Set PI_COMPACTION_DEBUG=1 to append a line per compaction to
 * <agentDir>/compaction-summary.log.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { uuidv7 } from "@earendil-works/pi-ai";
import {
	convertToLlm,
	type ExtensionAPI,
	getAgentDir,
	prepareBranchEntries,
	serializeConversation,
} from "@earendil-works/pi-coding-agent";

const DEFAULT_MODEL = "";
const CONFIG_FILE = "compaction-summary.json";
const LOG_FILE = "compaction-summary.log";
const DEFAULT_MAX_TOKENS = 8192;
const DEFAULT_BRANCH_RESERVE = 16384;

interface SummaryConfig {
	model?: string;
	maxTokens?: number;
}

function configPath(): string {
	return path.join(getAgentDir(), CONFIG_FILE);
}

function readConfig(): SummaryConfig {
	try {
		const raw = fs.readFileSync(configPath(), "utf-8");
		const parsed = JSON.parse(raw);
		return parsed && typeof parsed === "object" ? (parsed as SummaryConfig) : {};
	} catch {
		return {};
	}
}

function writeConfig(config: SummaryConfig): void {
	fs.mkdirSync(path.dirname(configPath()), { recursive: true });
	fs.writeFileSync(configPath(), `${JSON.stringify(config, null, 2)}\n`, "utf-8");
}

function modelSpec(): string | undefined {
	const fromEnv = process.env.PI_COMPACTION_SUMMARY_MODEL?.trim();
	if (fromEnv) return fromEnv;
	const fromFile = readConfig().model?.trim();
	if (fromFile) return fromFile;
	return DEFAULT_MODEL || undefined;
}

function maxTokens(): number {
	const value = readConfig().maxTokens;
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : DEFAULT_MAX_TOKENS;
}

function parseSpec(spec: string | undefined): [string, string] | undefined {
	if (!spec) return undefined;
	const slash = spec.indexOf("/");
	if (slash <= 0 || slash >= spec.length - 1) return undefined;
	return [spec.slice(0, slash), spec.slice(slash + 1)];
}

function appendLog(line: string): void {
	if (!process.env.PI_COMPACTION_DEBUG) return;
	try {
		fs.appendFileSync(path.join(getAgentDir(), LOG_FILE), `${new Date().toISOString()} ${line}\n`, "utf-8");
	} catch {
		// best effort
	}
}

function buildPrompt(
	kind: "compaction" | "branch",
	conversationText: string,
	previousSummary: string | undefined,
	fileOps: { readFiles?: string[]; modifiedFiles?: string[] } | undefined,
	customInstructions: string | undefined,
): string {
	const intro =
		kind === "compaction"
			? "You are compacting an AI coding conversation. Produce one summary that replaces the history below so work can continue seamlessly. Be thorough but concise; preserve concrete file paths, commands, decisions, and open threads."
			: "You are summarizing a branch of an AI coding session that is being left, so its context carries into the new branch. Be concise but keep concrete paths, commands, decisions, and open threads.";

	const previous = previousSummary
		? `\n\nPrevious summary (update and extend it, keep still-relevant details):\n${previousSummary}`
		: "";

	const userExtra = customInstructions?.trim()
		? `\n\nAdditional instructions from the user:\n${customInstructions.trim()}`
		: "";

	const fileBits: string[] = [];
	if (fileOps?.readFiles?.length) fileBits.push(`Files read:\n${fileOps.readFiles.map((f) => `- ${f}`).join("\n")}`);
	if (fileOps?.modifiedFiles?.length) {
		fileBits.push(`Files modified:\n${fileOps.modifiedFiles.map((f) => `- ${f}`).join("\n")}`);
	}
	const fileSection = fileBits.length ? `\n\nKnown file operations:\n${fileBits.join("\n")}` : "";

	return `${intro}${previous}${userExtra}${fileSection}

Use exactly this markdown structure:

## Goal

## Constraints & Preferences

## Progress
### Done
### In Progress
### Blocked

## Key Decisions

## Next Steps

## Critical Context

<conversation>
${conversationText}
</conversation>`;
}

function extractText(message: { content: Array<{ type: string; text?: string }> }): string {
	return message.content
		.filter((block): block is { type: "text"; text: string } => block.type === "text" && typeof block.text === "string")
		.map((block) => block.text)
		.join("\n")
		.trim();
}

export default function (pi: ExtensionAPI) {
	pi.registerCommand("compaction-model", {
		description: "Show or set the model used for context compaction summaries",
		handler: async (args, ctx) => {
			const arg = (args ?? "").trim();
			if (!arg) {
				ctx.ui.notify(
					`Compaction summary model: ${modelSpec() ?? "Pi default"}  (config: ${configPath()})`,
					"info",
				);
				return;
			}
			const parsed = parseSpec(arg);
			if (!parsed || !ctx.modelRegistry.find(parsed[0], parsed[1])) {
				ctx.ui.notify(`Unknown or malformed model: "${arg}". Use provider/model-id.`, "error");
				return;
			}
			const config = readConfig();
			config.model = arg;
			writeConfig(config);
			ctx.ui.notify(`Compaction summary model set to ${arg}`, "info");
		},
	});

	pi.on("session_before_compact", async (event, ctx) => {
		const spec = modelSpec();
		const parsed = parseSpec(spec);
		if (!parsed) return;
		const model = ctx.modelRegistry.find(parsed[0], parsed[1]);
		if (!model) {
			appendLog(`reason=compaction fallback=model_not_found spec=${spec}`);
			return;
		}

		const { messagesToSummarize, turnPrefixMessages, tokensBefore, firstKeptEntryId, previousSummary, fileOps } =
			event.preparation;
		const allMessages = [...messagesToSummarize, ...turnPrefixMessages];
		if (allMessages.length === 0) return;

		const conversationText = serializeConversation(convertToLlm(allMessages));
		const prompt = buildPrompt("compaction", conversationText, previousSummary, fileOps, event.customInstructions);

		try {
			const response = await ctx.modelRegistry.complete(
				model,
				{
					messages: [{ role: "user" as const, content: [{ type: "text" as const, text: prompt }], timestamp: Date.now() }],
				},
				{
					maxTokens: maxTokens(),
					signal: event.signal,
					cacheRetention: "none",
					sessionId: uuidv7(),
				},
			);
			const summary = extractText(response);
			if (!summary) {
				appendLog(`reason=compaction fallback=empty_summary spec=${spec}`);
				return;
			}
			appendLog(`reason=compaction ok=1 spec=${spec} msgs=${allMessages.length} tokensBefore=${tokensBefore}`);
			return { compaction: { summary, firstKeptEntryId, tokensBefore, usage: response.usage } };
		} catch (error) {
			appendLog(`reason=compaction fallback=error spec=${spec} err=${String((error as Error)?.message ?? error)}`);
			return;
		}
	});

	pi.on("session_before_tree", async (event, ctx) => {
		const { preparation } = event;
		if (!preparation.userWantsSummary) return;

		const spec = modelSpec();
		const parsed = parseSpec(spec);
		if (!parsed) return;
		const model = ctx.modelRegistry.find(parsed[0], parsed[1]);
		if (!model) {
			appendLog(`reason=branch fallback=model_not_found spec=${spec}`);
			return;
		}

		try {
			const prepared = prepareBranchEntries(preparation.entriesToSummarize, DEFAULT_BRANCH_RESERVE);
			if (prepared.messages.length === 0) return;

			const conversationText = serializeConversation(convertToLlm(prepared.messages));
			const prompt = buildPrompt("branch", conversationText, undefined, prepared.fileOps, preparation.customInstructions);

			const response = await ctx.modelRegistry.complete(
				model,
				{
					messages: [{ role: "user" as const, content: [{ type: "text" as const, text: prompt }], timestamp: Date.now() }],
				},
				{
					maxTokens: maxTokens(),
					signal: event.signal,
					cacheRetention: "none",
					sessionId: uuidv7(),
				},
			);
			const summary = extractText(response);
			if (!summary) {
				appendLog(`reason=branch fallback=empty_summary spec=${spec}`);
				return;
			}
			appendLog(`reason=branch ok=1 spec=${spec} msgs=${prepared.messages.length}`);
			return {
				summary: {
					summary,
					usage: response.usage,
					details: {
						readFiles: prepared.fileOps.readFiles ?? [],
						modifiedFiles: prepared.fileOps.modifiedFiles ?? [],
					},
				},
			};
		} catch (error) {
			appendLog(`reason=branch fallback=error spec=${spec} err=${String((error as Error)?.message ?? error)}`);
			return;
		}
	});
}
