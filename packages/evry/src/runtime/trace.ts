import { LangfuseSpanProcessor } from "@langfuse/otel";
import { propagateAttributes, startObservation } from "@langfuse/tracing";
import { LangfuseVercelAiSdkIntegration } from "@langfuse/vercel-ai-sdk";
import { context, diag, DiagLogLevel, type DiagLogger, trace, TraceFlags } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import { ExportResultCode } from "@opentelemetry/core";
import { type SpanExporter, TracerProvider } from "@opentelemetry/sdk-trace";
import { registerTelemetry } from "ai";
import { createHash } from "node:crypto";

export type Claimed = { claimStart: Date; claimEnd: Date };
type Metadata = Record<string, unknown>;

const quietly = <T>(body: () => T): T | undefined => {
	try {
		return body();
	} catch {
		return undefined;
	}
};

const state = ((globalThis as { [key: symbol]: unknown })[Symbol.for("everyfield.evry.tracing")] ??= {
	hidden: new Set<string>(),
	exported: 0,
}) as { hidden: Set<string>; exported: number; provider?: TracerProvider };

function log(stream: "log" | "error", line: { event: string } & Metadata) {
	quietly(() => {
		let text = JSON.stringify({ component: "evry", ...line });
		for (const value of state.hidden) text = text.replaceAll(value, "[redacted]");
		console[stream](text);
	});
}

const describe = (value: unknown): string =>
	value instanceof Error
		? value.message
		: typeof value === "string"
			? value
			: Array.isArray(value)
				? value.map(describe).join("; ")
				: (quietly(() => JSON.stringify(value)) ?? "");

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

const DEFAULT_BASE_URL = "https://cloud.langfuse.com";
const ENVIRONMENT = /^(?!langfuse)[a-z0-9_-]+$/;

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
	const provider = new TracerProvider({ spanProcessors: [processor] });
	if (trace.setGlobalTracerProvider(provider)) state.provider = provider;
	else log("error", { event: "tracing_not_global", which: "setGlobalTracerProvider" });
	registerTelemetry(new LangfuseVercelAiSdkIntegration());
	return true;
}

export async function flushTraces() {
	const { provider } = state;
	if (!provider) return;
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

const turnContext = (turnId: string) => ({
	traceId: createHash("sha256").update(turnId).digest("hex").slice(0, 32),
	spanId: "0123456789abcdef",
	traceFlags: TraceFlags.SAMPLED,
	isRemote: true,
});

function past(name: string, start: Date, end: Date) {
	quietly(() => startObservation(name, {}, { startTime: start }).end(end));
}

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
