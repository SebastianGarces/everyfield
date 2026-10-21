import { LangfuseSpanProcessor } from "@langfuse/otel";
import { propagateAttributes, startObservation } from "@langfuse/tracing";
import { LangfuseVercelAiSdkIntegration } from "@langfuse/vercel-ai-sdk";
import { context, ProxyTracerProvider, trace, TraceFlags } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import { TracerProvider } from "@opentelemetry/sdk-trace";
import { registerTelemetry } from "ai";
import { createHash } from "node:crypto";

// Evry turn tracing in Langfuse (C64): one trace per turn with the full text the model sees, from the AI SDK's own
// telemetry, plus our spans for the work around the model. Tracing is an observer: a tracing error is swallowed, and
// export runs in the background and is flushed after the response, so it never fails or slows a turn. Without the
// Langfuse keys nothing is registered and every span below is a no-op.

/** The time the worker spent claiming the turn from the queue. */
export type Claimed = { claimStart: Date; claimEnd: Date };
type Metadata = Record<string, unknown>;

const quietly = <T>(body: () => T): T | undefined => {
	try {
		return body();
	} catch {
		return undefined;
	}
};

/**
 * Sends spans and AI SDK telemetry to Langfuse when LANGFUSE_PUBLIC_KEY and LANGFUSE_SECRET_KEY are set. The processor
 * reads LANGFUSE_BASE_URL and LANGFUSE_TRACING_ENVIRONMENT itself. Once per process, from Next.js instrumentation.
 */
export function registerTracing(env: Record<string, string | undefined> = process.env) {
	if (!env.LANGFUSE_PUBLIC_KEY || !env.LANGFUSE_SECRET_KEY) return false;
	const processor = new LangfuseSpanProcessor({
		publicKey: env.LANGFUSE_PUBLIC_KEY,
		secretKey: env.LANGFUSE_SECRET_KEY,
		baseUrl: env.LANGFUSE_BASE_URL,
	});
	context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());
	trace.setGlobalTracerProvider(new TracerProvider({ spanProcessors: [processor] }));
	registerTelemetry(new LangfuseVercelAiSdkIntegration());
	return true;
}

/** Exports the spans still buffered. Call it inside after(), once the response and the turn are done. Never throws. */
export async function flushTraces() {
	const global = trace.getTracerProvider();
	const provider = global instanceof ProxyTracerProvider ? global.getDelegate() : global;
	await (provider as { forceFlush?: () => Promise<void> }).forceFlush?.().catch(() => undefined);
}

/**
 * One trace per turn: its id derives from the turn id (Langfuse's createTraceId rule, computed synchronously), so the
 * stream route can add its delivery span to it.
 */
const turnContext = (turnId: string) => ({
	traceId: createHash("sha256").update(turnId).digest("hex").slice(0, 32),
	spanId: "0123456789abcdef",
	traceFlags: TraceFlags.SAMPLED,
	isRemote: true,
});

/** A span that already ended, under the active observation. */
function past(name: string, start: Date, end: Date, metadata?: Metadata) {
	quietly(() => startObservation(name, { metadata }, { startTime: start }).end(end));
}

/**
 * Runs `body` in a child observation of the active trace. The span carries timing and `metadata` only: model input and
 * output come from the AI SDK spans. A tracing failure never reaches the caller; `body`'s own errors pass through.
 */
export async function traced<T>(name: string, body: () => Promise<T>, metadata?: (result: T) => Metadata): Promise<T> {
	const span = quietly(() => startObservation(name));
	const active = span && quietly(() => trace.setSpan(context.active(), span.otelSpan));
	let result: { value: T } | undefined;
	try {
		result = { value: await (active ? context.with(active, body) : body()) };
		return result.value;
	} finally {
		quietly(() =>
			span?.update({ level: result ? "DEFAULT" : "ERROR", metadata: result && metadata?.(result.value) }).end(),
		);
	}
}

/**
 * The turn's trace, from submit to the saved end: queue wait, queue claim and turn load as past spans, then `body`
 * inside the root observation. `body` reports the turn's final answer as the trace output.
 */
export async function traceTurn<T>(
	turn: { turnId: string; conversationId: string; submittedAt: Date; request: string; claimed?: Claimed },
	body: (report: (output: Metadata) => void) => Promise<T>,
): Promise<T> {
	const root = quietly(() =>
		startObservation(
			"evry turn",
			{ input: { text: turn.request }, metadata: { turnId: turn.turnId } },
			{ asType: "agent", startTime: turn.submittedAt, parentSpanContext: turnContext(turn.turnId) },
		),
	);
	const active = root && quietly(() => trace.setSpan(context.active(), root.otelSpan));
	if (!root || !active) return body(() => undefined);
	const loaded = new Date();
	return context.with(active, () =>
		propagateAttributes({ sessionId: turn.conversationId, traceName: "evry turn" }, async () => {
			const { claimed } = turn;
			if (claimed) {
				past("queue wait", turn.submittedAt, claimed.claimStart);
				past("queue claim", claimed.claimStart, claimed.claimEnd);
				past("load turn", claimed.claimEnd, loaded);
			}
			try {
				return await body((output) => quietly(() => root.update({ output })));
			} finally {
				quietly(() => root.end());
			}
		}),
	);
}

/**
 * Called by an observer right after it delivered a turn's first saved text: a span in that turn's trace from the save to
 * the delivery (the poll), with the time from submit when the observer also saw the user's message.
 */
export function traceDelivery(turnId: string, savedAt: Date, submittedAt: Date | null) {
	const delivered = new Date();
	quietly(() =>
		startObservation(
			"first SSE delivery",
			{
				metadata: {
					pollMs: delivered.getTime() - savedAt.getTime(),
					...(submittedAt && { submitToFirstSseMs: delivered.getTime() - submittedAt.getTime() }),
				},
			},
			{ startTime: savedAt, parentSpanContext: turnContext(turnId) },
		).end(delivered),
	);
}
