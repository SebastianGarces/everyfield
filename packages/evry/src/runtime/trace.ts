import { LANGFUSE_SDK_VERSION } from "@langfuse/core";
import { LangfuseSpanProcessor } from "@langfuse/otel";
import { propagateAttributes, startObservation } from "@langfuse/tracing";
import { LangfuseVercelAiSdkIntegration } from "@langfuse/vercel-ai-sdk";
import { type Attributes, context, diag, DiagLogLevel, type DiagLogger, trace, TraceFlags } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import { ExportResultCode } from "@opentelemetry/core";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { CompressionAlgorithm } from "@opentelemetry/otlp-exporter-base";
import { type ReadableSpan, type SpanExporter, TracerProvider } from "@opentelemetry/sdk-trace";
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
	(message: string, ...args: unknown[]) =>
		quietly(() => {
			const error = args.find((arg) => arg instanceof Error);
			const template = asLogWord(`m${createHash("sha256").update(String(message)).digest("hex").slice(0, 12)}`);
			const fields = { component: "evry", event: "otel_diag", level, template } as const;
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

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);
const exportsTo = (url: URL, raw: string) =>
	(url.protocol === "https:" || LOOPBACK.has(url.hostname)) && !url.username && !url.password && !/[?#]/.test(raw);
const ENVIRONMENT = /^(?!langfuse)[a-z0-9_-]+$/;

const BATCH_BYTES_DEFAULT = 64 * 1024 * 1024;

const batchBytesMax = (raw: string | undefined) => {
	const limit = /^\d+$/.test(raw?.trim() ?? "") ? Number(raw) : 0;
	return Number.isSafeInteger(limit) && limit > 0 ? limit : BATCH_BYTES_DEFAULT;
};

const textBytes = (attributes: Attributes) =>
	Object.entries(attributes).reduce(
		(bytes, [key, value]) =>
			bytes +
			key.length +
			[value].flat().reduce<number>((n, item) => n + (typeof item === "string" ? item.length : 0), 0),
		0,
	);

const batchBytes = (spans: ReadableSpan[]) =>
	spans.reduce(
		(bytes, span) =>
			bytes +
			span.name.length +
			(span.status.message?.length ?? 0) +
			textBytes(span.attributes) +
			span.events.reduce((n, event) => n + event.name.length + textBytes(event.attributes ?? {}), 0) +
			span.links.reduce((n, link) => n + textBytes(link.attributes ?? {}), 0),
		0,
	);

const ERROR_TEXT = new Set(["exception.message", "exception.stacktrace"]);
const withoutErrorText = (span: ReadableSpan): ReadableSpan =>
	Object.create(span, {
		status: { value: { code: span.status.code } },
		events: {
			value: span.events.map((event) => ({
				...event,
				attributes: Object.fromEntries(Object.entries(event.attributes ?? {}).filter(([key]) => !ERROR_TEXT.has(key))),
			})),
		},
	});

const exportFailed = (code: "FAILED" | "TOO_LARGE", httpStatus: number | null, error: unknown) =>
	quietly(() => logFailure({ component: "evry", event: "trace_export_failed", code, httpStatus }, error));

function langfuseExporter(publicKey: string, secretKey: string, baseUrl: string, bytesMax: number): SpanExporter {
	const otlp = new OTLPTraceExporter({
		url: `${baseUrl}/api/public/otel/v1/traces`,
		headers: {
			Authorization: `Basic ${Buffer.from(`${publicKey}:${secretKey}`).toString("base64")}`,
			"x-langfuse-sdk-name": "javascript",
			"x-langfuse-sdk-version": LANGFUSE_SDK_VERSION,
			"x-langfuse-public-key": publicKey,
			"x-langfuse-ingestion-version": "4",
		},
		timeoutMillis: 5000,
		compression: CompressionAlgorithm.GZIP,
	});
	return {
		export(raw, done) {
			state.exported += raw.length;
			const spans = raw.map(withoutErrorText);
			if (batchBytes(spans) > bytesMax) {
				const error = new RangeError("span batch over the byte limit");
				exportFailed("TOO_LARGE", null, error);
				return done({ code: ExportResultCode.FAILED, error });
			}
			otlp.export(spans, (result) => {
				if (result.code !== ExportResultCode.SUCCESS) {
					const status = (result.error as { code?: unknown } | undefined)?.code;
					exportFailed("FAILED", typeof status === "number" ? status : null, result.error ?? null);
				}
				done(result);
			});
		},
		forceFlush: () => otlp.forceFlush(),
		shutdown: () => otlp.shutdown(),
	};
}

export function registerTracing(env: Record<string, string | undefined> = process.env) {
	const { LANGFUSE_PUBLIC_KEY: publicKey, LANGFUSE_SECRET_KEY: secretKey } = env;
	const environment = env.LANGFUSE_TRACING_ENVIRONMENT;
	const baseUrl = env.LANGFUSE_BASE_URL ?? "";
	const parsed = baseUrl === baseUrl.trim() ? URL.parse(baseUrl) : null;
	const url = parsed?.protocol === "http:" || parsed?.protocol === "https:" ? parsed : null;
	const environmentValid = environment === undefined || ENVIRONMENT.test(environment);
	const config = {
		component: "evry",
		baseUrlHost: url ? asLogHost(url.host) : null,
		environment: environment === undefined ? null : asLogWord(environment),
		environmentValid,
	} as const;
	const disabled = (reason: "missing_keys" | "invalid_base_url" | "invalid_environment") => {
		quietly(() => logLine({ ...config, event: "tracing_disabled", reason }));
		return false;
	};
	if (!publicKey || !secretKey) return disabled("missing_keys");
	if (!url || !exportsTo(url, baseUrl)) return disabled("invalid_base_url");
	if (!environmentValid) return disabled("invalid_environment");
	const exporter = langfuseExporter(
		publicKey,
		secretKey,
		baseUrl,
		batchBytesMax(env.LANGFUSE_OTEL_MAX_BATCH_SIZE_BYTES),
	);
	const processor = new LangfuseSpanProcessor({ publicKey, secretKey, baseUrl, environment, exporter });
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
		const first = Array.isArray(error) ? (error.find((e) => e instanceof Error) ?? error) : error;
		quietly(() => logFailure({ component: "evry", event: "traces_flush_failed" }, first));
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
