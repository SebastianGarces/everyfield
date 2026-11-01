import { LangfuseSpanProcessor } from "@langfuse/otel";
import { propagateAttributes, startObservation } from "@langfuse/tracing";
import { LangfuseVercelAiSdkIntegration } from "@langfuse/vercel-ai-sdk";
import {
	context,
	diag,
	DiagLogLevel,
	type DiagLogger,
	ProxyTracerProvider,
	trace,
	TraceFlags,
} from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import { ExportResultCode } from "@opentelemetry/core";
import { type SpanExporter, TracerProvider } from "@opentelemetry/sdk-trace";
import { registerTelemetry } from "ai";
import { createHash } from "node:crypto";

// Evry turn tracing in Langfuse (C64): one trace per turn with the full text the model sees, from the AI SDK's own
// telemetry, plus our spans for the work around the model. Tracing is an observer: a tracing error never reaches a turn,
// and export runs in the background and is flushed after the response, so it never fails or slows a turn. Without the
// Langfuse keys nothing is registered and every span below is a no-op. Tracing reports its own state as JSON lines in the
// server log (registration or refusal, OpenTelemetry's own warnings, each failed export, each flush), and no line holds
// a key, an auth header or the base URL's user info or query.

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
 * Process-wide like the OpenTelemetry globals, since Next.js may bundle instrumentation apart from the routes that flush:
 * `hidden` holds the values no log line may show (the keys, their Basic auth form, and the base URL's user info, query
 * and fragment), `exported` counts the spans handed to the exporter so far, so a flush reports its share.
 */
const state = ((globalThis as { [key: symbol]: unknown })[Symbol.for("everyfield.evry.tracing")] ??= {
	hidden: new Set<string>(),
	exported: 0,
}) as { hidden: Set<string>; exported: number };

/** Writes one JSON line with the secrets above masked. Never throws, also when the console itself throws. */
function log(stream: "log" | "error", line: { event: string } & Metadata) {
	quietly(() => {
		let text = JSON.stringify({ component: "evry", ...line });
		for (const value of state.hidden) text = text.replaceAll(value, "[redacted]");
		console[stream](text);
	});
}

/** A message for a log line. An error shows only its message; a failed flush rejects with a list of them. */
const describe = (value: unknown): string =>
	value instanceof Error
		? value.message
		: typeof value === "string"
			? value
			: Array.isArray(value)
				? value.map(describe).join("; ")
				: (quietly(() => JSON.stringify(value)) ?? "");

/** OpenTelemetry's own registration and export messages, at WARN and above. */
const otelDiag =
	(level: string) =>
	(message: string, ...args: unknown[]) =>
		log("error", { event: "otel_diag", level, message: [message, ...args.map(describe)].join(" ") });
const diagLogger: DiagLogger = {
	error: otelDiag("error"),
	warn: otelDiag("warn"),
	info: otelDiag("info"),
	debug: otelDiag("debug"),
	verbose: otelDiag("verbose"),
};

/** LangfuseSpanProcessor's own default when it gets no base URL: the EU region. */
const DEFAULT_BASE_URL = "https://cloud.langfuse.com";
/** Langfuse's rule for an environment name. */
const ENVIRONMENT = /^(?!langfuse)[a-z0-9_-]+$/;

/**
 * Logs each failed export. The processor builds its OTLP exporter inside (auth header, compression, batch byte limit),
 * so the wrap goes around that instance and the export itself stays the SDK's own. The SDK versions are pinned, and the
 * export-failure test fails if this shape ever moves.
 */
function watchExports(processor: LangfuseSpanProcessor) {
	const exporter = (processor as unknown as { processor?: { _exporter?: SpanExporter } }).processor?._exporter;
	if (!exporter) return;
	const send = exporter.export.bind(exporter);
	exporter.export = (spans, done) => {
		state.exported += spans.length;
		send(spans, (result) => {
			if (result.code !== ExportResultCode.SUCCESS) {
				const status = (result.error as { code?: unknown } | undefined)?.code;
				log("error", {
					event: "trace_export_failed",
					code: ExportResultCode[result.code],
					httpStatus: typeof status === "number" ? status : null,
					message: result.error?.message ?? null,
				});
			}
			done(result);
		});
	};
}

/**
 * Sends spans and AI SDK telemetry to Langfuse when LANGFUSE_PUBLIC_KEY and LANGFUSE_SECRET_KEY are set, with
 * LANGFUSE_BASE_URL (default: the SDK's EU host) and LANGFUSE_TRACING_ENVIRONMENT. A configuration that can never export
 * is refused: an environment name Langfuse rejects, or a base URL that is not an absolute http(s) URL. Writes one
 * startup line either way. Once per process, from Next.js instrumentation.
 */
export function registerTracing(env: Record<string, string | undefined> = process.env) {
	const { LANGFUSE_PUBLIC_KEY: publicKey, LANGFUSE_SECRET_KEY: secretKey } = env;
	const environment = env.LANGFUSE_TRACING_ENVIRONMENT;
	const baseUrl = env.LANGFUSE_BASE_URL ?? DEFAULT_BASE_URL;
	const parsed = baseUrl === baseUrl.trim() ? URL.parse(baseUrl) : null;
	const url = parsed?.protocol === "http:" || parsed?.protocol === "https:" ? parsed : null;
	const credentials = publicKey && secretKey && Buffer.from(`${publicKey}:${secretKey}`).toString("base64");
	for (const value of [publicKey, secretKey, credentials, parsed?.username, parsed?.password])
		if (value) state.hidden.add(value);
	for (const value of [parsed?.search, parsed?.hash]) if (value && value.length > 1) state.hidden.add(value.slice(1));
	const environmentValid = environment === undefined || ENVIRONMENT.test(environment);
	const config = { baseUrlHost: url?.host ?? null, environment: environment ?? null, environmentValid };
	const reason =
		!publicKey || !secretKey
			? "missing_keys"
			: !url
				? "invalid_base_url"
				: !environmentValid
					? "invalid_environment"
					: undefined;
	if (reason) {
		log("error", { event: "tracing_disabled", reason, ...config });
		return false;
	}
	const processor = new LangfuseSpanProcessor({ publicKey, secretKey, baseUrl, environment });
	watchExports(processor);
	diag.setLogger(diagLogger, DiagLogLevel.WARN);
	log("log", { event: "tracing_registered", ...config });
	if (!context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable()))
		log("error", { event: "tracing_not_global", which: "setGlobalContextManager" });
	if (!trace.setGlobalTracerProvider(new TracerProvider({ spanProcessors: [processor] })))
		log("error", { event: "tracing_not_global", which: "setGlobalTracerProvider" });
	registerTelemetry(new LangfuseVercelAiSdkIntegration());
	return true;
}

/**
 * Exports the spans still buffered and writes how many went to the exporter, or why the flush failed. Call it inside
 * after(), once the response and the turn are done. Writes nothing when tracing is not registered. Never throws.
 */
export async function flushTraces() {
	const global = trace.getTracerProvider();
	const provider = (global instanceof ProxyTracerProvider ? global.getDelegate() : global) as {
		forceFlush?: () => Promise<void>;
	};
	if (!provider.forceFlush) return;
	const started = performance.now();
	const before = state.exported;
	try {
		await provider.forceFlush();
		log("log", {
			event: "traces_flushed",
			spans: state.exported - before,
			ms: Math.round(performance.now() - started),
		});
	} catch (error) {
		log("error", { event: "traces_flush_failed", message: describe(error) });
	}
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
function past(name: string, start: Date, end: Date) {
	quietly(() => startObservation(name, {}, { startTime: start }).end(end));
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
 * the delivery, with the time from submit when the observer also saw the user's message. The span starts on the database
 * clock and ends on the app clock, so its length includes their offset. The poll is `submitToFirstSseMs` minus the
 * turn's `submitToFirstTextMs`: both measure app time against the database's submit time, so the offset cancels.
 */
export function traceDelivery(turnId: string, savedAt: Date, submittedAt: Date | null) {
	const delivered = new Date();
	quietly(() =>
		startObservation(
			"first SSE delivery",
			{
				metadata: submittedAt ? { submitToFirstSseMs: delivered.getTime() - submittedAt.getTime() } : {},
			},
			{ startTime: savedAt, parentSpanContext: turnContext(turnId) },
		).end(delivered),
	);
}
