/**
 * Pi 1.2.0's RpcClient.promptAndWait leaves collectEvents() temporarily
 * unhandled while it awaits prompt acceptance. A timeout or rejected prompt
 * can therefore crash the host. Subscribe, deadline, and acceptance belong to
 * one promise; every outcome cleans up and every rejection has a handler.
 */
export interface PromptPeer {
	onEvent(listener: (event: any) => void): () => void;
	prompt(message: string, images?: any[]): Promise<string | undefined>;
}

export function promptAndWaitSafely(
	client: PromptPeer,
	message: string,
	images?: any[],
	timeoutMs = 600_000,
	signal?: AbortSignal,
): Promise<any[]> {
	if (signal?.aborted) return Promise.reject(new Error("Team task was cancelled."));
	if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2_147_483_647) {
		return Promise.reject(new Error("RPC timeout must be a positive number below 2147483648 ms."));
	}
	return new Promise((resolve, reject) => {
		const events: any[] = [];
		let started = false;
		let settled = false;
		let timer: ReturnType<typeof setTimeout> | undefined;
		let unsubscribe = () => {};
		const finish = (error?: unknown) => {
			if (settled) return;
			settled = true;
			if (timer) clearTimeout(timer);
			signal?.removeEventListener("abort", abort);
			unsubscribe();
			if (error !== undefined) reject(error);
			else resolve(events);
		};
		const abort = () => finish(new Error("Team task was cancelled."));
		signal?.addEventListener("abort", abort, { once: true });
		unsubscribe = client.onEvent((event) => {
			if (settled) return;
			if (event?.type === "agent_start" && !started) {
				started = true;
				events.length = 0;
			}
			if (!started) return;
			events.push(event);
			if (event?.type === "agent_settled") finish();
		});
		timer = setTimeout(() => finish(new Error(`Team member timed out after ${timeoutMs} ms.`)), timeoutMs);
		// Attach both handlers immediately, including when prompt() throws before
		// returning a promise or rejects after the event deadline has expired.
		void Promise.resolve().then(() => client.prompt(message, images)).then(
			(disposition) => { if (disposition === "handled") finish(); },
			(error) => finish(error),
		);
	});
}
