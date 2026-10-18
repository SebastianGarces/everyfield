import { randomUUID } from "node:crypto";
import { z } from "zod";

// Closed operation families cannot encode private-care existence or calendar metadata.
const observation = z.strictObject({
	kind: z.enum(["operation", "model_attempt", "error"]),
	operation: z.enum([
		"jobs.tickNotifications",
		"jobs.tickAssessments",
		"documents.generate",
		"intelligence.executeDemand",
		"feedback.createConfiguredIssue",
	]),
	correlation: z.uuid(),
	build: z.string().regex(/^[a-f0-9]{40}$/),
	status: z.enum(["ok", "refused", "failed", "unknown"]),
	duration_ms: z.number().int().min(0).max(3_600_000),
	input_tokens: z.number().int().min(0).max(128_000).optional(),
	output_tokens: z.number().int().min(0).max(16_000).optional(),
});
export type Observation = z.infer<typeof observation>;
const configSchema = z.strictObject({
	endpoint: z.url(),
	token: z.string().min(32).max(4096),
	timeoutMs: z.number().int().min(1).max(1000).default(500),
});
export function telemetryConfig(input: unknown) {
	const v = configSchema.parse(input);
	const url = new URL(v.endpoint);
	const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
	if (
		(url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) ||
		url.username ||
		url.password ||
		url.search ||
		url.hash
	)
		throw Error("invalid_telemetry_endpoint");
	return v;
}
export type TelemetryConfig = ReturnType<typeof telemetryConfig>;
export function createTelemetry(config: TelemetryConfig | null) {
	const selected = config === null ? null : telemetryConfig(config);
	let queue: Observation[] = [];
	let flushing = false;
	return {
		// Invalid input is dropped as a whole; arbitrary errors/headers are never serialized.
		record(input: unknown): boolean {
			if (!selected || queue.length >= 100) return false;
			const parsed = observation.safeParse(input);
			if (!parsed.success) return false;
			queue.push(parsed.data);
			return true;
		},
		async flush(): Promise<"disabled" | "busy" | "empty" | "sent" | "unavailable"> {
			if (!selected) return "disabled";
			if (flushing) return "busy";
			if (!queue.length) return "empty";
			const batch = queue;
			queue = [];
			flushing = true;
			const controller = new AbortController();
			let timer: ReturnType<typeof setTimeout> | undefined;
			try {
				const timeout = new Promise<"unavailable">((resolve) => {
					timer = setTimeout(() => {
						controller.abort();
						resolve("unavailable");
					}, selected.timeoutMs);
				});
				const send = fetch(selected.endpoint, {
					method: "POST",
					redirect: "error",
					signal: controller.signal,
					headers: { authorization: `Bearer ${selected.token}`, "content-type": "application/json" },
					body: JSON.stringify({ observations: batch }),
				})
					.then((response) => {
						void response.body?.cancel();
						return response.ok ? ("sent" as const) : ("unavailable" as const);
					})
					.catch(() => "unavailable" as const);
				return await Promise.race([send, timeout]);
			} finally {
				if (timer) clearTimeout(timer);
				flushing = false;
			}
		},
	};
}
export function safeFailure() {
	return { code: "unavailable" as const, correlation: randomUUID() };
}

export async function traceOperation<T>(
	telemetry: ReturnType<typeof createTelemetry>,
	metadata: Pick<Observation, "operation" | "correlation" | "build">,
	run: () => Promise<T>,
): Promise<T> {
	const start = performance.now();
	let status: Observation["status"] = "failed";
	try {
		const result = await run();
		status = "ok";
		return result;
	} finally {
		try {
			telemetry.record({
				...metadata,
				kind: "operation",
				status,
				duration_ms: Math.min(3_600_000, Math.round(performance.now() - start)),
			});
			await telemetry.flush();
		} catch {
			/* Advisory telemetry cannot replace the original result or exception. */
		}
	}
}
