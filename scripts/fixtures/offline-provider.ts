/** Deterministic provider used ONLY by isolated process integration tests. No API calls. */
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
	const attempts = new Map<string, number>();
	pi.registerProvider("workbench-fixture", {
		baseUrl: "http://127.0.0.1/unused", api: "workbench-fixture", apiKey: "test-only",
		models: [{ id: "model", name: "Offline integration fixture", reasoning: false, input: ["text"], contextWindow: 64000, maxTokens: 4096, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
		streamSimple(model, context) {
			const stream = createAssistantMessageEventStream();
			queueMicrotask(() => {
				const textOf = (message: any) => typeof message.content === "string" ? message.content : (message.content ?? []).filter((block: any) => block.type === "text").map((block: any) => block.text).join("");
				const users = context.messages.filter(message => message.role === "user");
				const commandText = users.map(textOf).filter(text => text.includes("PROBE:")).at(-1) || "";
				const message: any = { role: "assistant", api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(), usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, content: [], stopReason: "stop" };
				try {
					const command = JSON.parse(commandText.slice(commandText.indexOf("PROBE:") + 6));
					const last = context.messages.at(-1);
					if (command.op === "failure-sequence") {
						const count = (attempts.get(commandText) ?? 0);
						attempts.set(commandText, count + 1);
						if (count < command.failures) {
							message.stopReason = "error";
							message.errorMessage = command.error || "upstream_error: OPENAI返回：Selected model is 布拉布拉";
							stream.push({ type: "error", reason: "error", error: message }); stream.end(); return;
						}
					}
					let result: unknown;
					if (last?.role === "toolResult") result = { isError: last.isError, content: last.content, details: (last as any).details };
					else if (command.tool) {
						message.content = [{ type: "toolCall", id: `fixture-${Date.now()}`, name: command.tool, arguments: command.args }];
						message.stopReason = "toolUse";
					} else if (command.op === "remember") result = { remembered: command.token };
					else if (command.op === "recall") {
						const memories = users.map(textOf).filter(text => text.includes('"op":"remember"'));
						result = { memories };
					} else result = { ok: true };
					if (message.stopReason !== "toolUse") message.content = [{ type: "text", text: JSON.stringify(result) }];
					stream.push({ type: "start", partial: message });
					stream.push({ type: "done", reason: message.stopReason, message });
				} catch (error) {
					message.stopReason = "error"; message.errorMessage = String(error);
					stream.push({ type: "error", reason: "error", error: message });
				}
				stream.end();
			});
			return stream;
		},
	});
}
