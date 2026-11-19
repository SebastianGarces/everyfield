import { LangfuseSpanProcessor } from "@langfuse/otel";
import { propagateAttributes, startObservation } from "@langfuse/tracing";
import { LangfuseVercelAiSdkIntegration } from "@langfuse/vercel-ai-sdk";
import { context, diag, DiagLogLevel, type DiagLogger, trace, TraceFlags } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import { ExportResultCode } from "@opentelemetry/core";
import { type SpanExporter, TracerProvider } from "@opentelemetry/sdk-trace";
import { registerTelemetry } from "ai";
import { asLogHost, asLogWord, logFailure, logInfo, logLine } from "@everyfield/domain/log";
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
	exported: 0,
}) as { exported: number; provider?: TracerProvider };

type DiagLevel = "error" | "warn" | "info" | "debug" | "verbose";
const otelDiag =
	(level: DiagLevel) =>
	(_message: string, ...args: unknown[]) =>
		quietly(() => {
			const error = args.find((arg) => arg instanceof Error);
			const fields = { component: "evry", event: "otel_diag", level } as const;
			if (error) logFailure(fields, error);
			else logLine(fields);
		});
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
				quietly(() =>
					logFailure(
						{
							component: "evry",
							event: "trace_export_failed",
							code: "FAILED",
							httpStatus: typeof status === "number" ? status : null,
						},
						result.error ?? null,
					),
				);
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
	const environmentValid = environment === undefined || ENVIRONMENT.test(environment);
	const config = {
		component: "evry",
		baseUrlHost: url ? asLogHost(url.host) : null,
		environment: environment === undefined ? null : asLogWord(environment),
		environmentValid,
	} as const;
	const reason =
		!publicKey || !secretKey
			? "missing_keys"
			: !url
				? "invalid_base_url"
				: !environmentValid
					? "invalid_environment"
					: undefined;
	if (reason) {
		quietly(() => logLine({ ...config, event: "tracing_disabled", reason }));
		return false;
	}
	const processor = new LangfuseSpanProcessor({ publicKey, secretKey, baseUrl, environment });
	watchExports(processor);
	diag.setLogger(diagLogger, DiagLogLevel.WARN);
	quietly(() => logInfo({ ...config, event: "tracing_registered" }));
	if (!context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable()))
		quietly(() => logLine({ component: "evry", event: "tracing_not_global", which: "setGlobalContextManager" }));
	const provider = new TracerProvider({ spanProcessors: [processor] });
	if (trace.setGlobalTracerProvider(provider)) state.provider = provider;
	else quietly(() => logLine({ component: "evry", event: "tracing_not_global", which: "setGlobalTracerProvider" }));
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
		const spans = state.exported - before;
		const ms = Math.round(performance.now() - started);
		quietly(() => logInfo({ component: "evry", event: "traces_flushed", spans, ms }));
	} catch (error) {
		quietly(() => logFailure({ component: "evry", event: "traces_flush_failed" }, error));
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
