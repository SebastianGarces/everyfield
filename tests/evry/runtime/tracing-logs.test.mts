import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createRequire } from "node:module";
import type { AddressInfo } from "node:net";
import { flushTraces, registerTracing, traceTurn } from "../../../packages/evry/src/runtime/trace.ts";

// What tracing writes about itself to the server log, against a local stand-in for Langfuse's OTLP endpoint that answers
// with `status`. Registration sets process-global OpenTelemetry state, so this file registers once and every later
// registration finds the first one global.

// The OpenTelemetry API instance Evry registers its diag logger on.
const { diag } = createRequire(new URL("../../../packages/evry/package.json", import.meta.url))(
	"@opentelemetry/api",
) as typeof import("@opentelemetry/api");

let status = 401;
const authorization: string[] = [];
const langfuse = createServer((request: IncomingMessage, response: ServerResponse) => {
	if (request.headers.authorization) authorization.push(request.headers.authorization);
	request.resume().on("end", () => response.writeHead(status, { "content-type": "application/json" }).end("{}"));
});

const secrets = {
	publicKey: "pk-lf-distinct-7f3a",
	secretKey: "sk-lf-distinct-91c2",
	user: "user-x9",
	password: "pass-q7",
	token: "tok-z4",
};
let env: Record<string, string>;
let host: string;

/** Every line any test here wrote, for the secrets check at the end. */
const written: string[] = [];
async function logged<T>(body: () => T | Promise<T>) {
	const lines: Record<string, unknown>[] = [];
	const { log, error } = console;
	console.log = console.error = (text: string) => {
		written.push(text);
		lines.push(JSON.parse(text));
	};
	try {
		return { result: await body(), lines };
	} finally {
		Object.assign(console, { log, error });
	}
}
const events = (lines: Record<string, unknown>[], event: string) => lines.filter((line) => line.event === event);
const turn = () =>
	traceTurn(
		{ turnId: randomUUID(), conversationId: randomUUID(), submittedAt: new Date(), request: "Find Casey" },
		async (report) => {
			report({ text: "Casey Reed" });
			return "done";
		},
	);

before(async () => {
	await new Promise<void>((resolve) => langfuse.listen(0, "127.0.0.1", resolve));
	host = `127.0.0.1:${(langfuse.address() as AddressInfo).port}`;
	env = {
		LANGFUSE_PUBLIC_KEY: secrets.publicKey,
		LANGFUSE_SECRET_KEY: secrets.secretKey,
		LANGFUSE_BASE_URL: `http://${secrets.user}:${secrets.password}@${host}/?token=${secrets.token}`,
		LANGFUSE_TRACING_ENVIRONMENT: "preview",
	};
});
after(() => {
	langfuse.closeAllConnections();
	langfuse.close();
});

test("INV-tracing: a valid configuration registers and writes one tracing_registered line with the host only", async () => {
	const { result, lines } = await logged(() => registerTracing(env));
	assert.equal(result, true);
	assert.deepEqual(lines, [
		{
			component: "evry",
			event: "tracing_registered",
			baseUrlHost: host,
			environment: "preview",
			environmentValid: true,
		},
	]);
});

test("INV-tracing: OpenTelemetry's own messages at WARN and above go to console.error as otel_diag lines", async () => {
	const { lines } = await logged(() => {
		diag.info("below the level");
		diag.warn("export slow", { attempt: 2 });
		diag.error("export broke", new Error("socket hang up"));
	});
	assert.deepEqual(lines, [
		{ component: "evry", event: "otel_diag", level: "warn", message: 'export slow {"attempt":2}' },
		{ component: "evry", event: "otel_diag", level: "error", message: "export broke socket hang up" },
	]);
});

test("INV-tracing: a refused export writes trace_export_failed with the HTTP status, and the flush reports its failure", async () => {
	status = 401;
	const { result, lines } = await logged(async () => {
		const answer = await turn();
		await flushTraces();
		return answer;
	});
	assert.equal(result, "done");
	assert.deepEqual(events(lines, "trace_export_failed"), [
		{ component: "evry", event: "trace_export_failed", code: "FAILED", httpStatus: 401, message: "Unauthorized" },
	]);
	assert.deepEqual(events(lines, "traces_flush_failed"), [
		{ component: "evry", event: "traces_flush_failed", message: "Unauthorized" },
	]);
	assert.ok(authorization.length > 0, "the export reached the stand-in with its auth header");
});

test("INV-tracing: a flush that exports writes traces_flushed with the spans it handed to the exporter", async () => {
	status = 200;
	const { lines } = await logged(async () => {
		await turn();
		await flushTraces();
	});
	const [flushed, ...more] = events(lines, "traces_flushed");
	assert.deepEqual(more, []);
	assert.deepEqual(
		{ ...flushed, ms: typeof flushed?.ms },
		{ component: "evry", event: "traces_flushed", spans: 1, ms: "number" },
	);
	assert.deepEqual(events(lines, "trace_export_failed"), []);
});

test("INV-tracing: a second registration names each global it could not set", async () => {
	const { result, lines } = await logged(() => registerTracing(env));
	assert.equal(result, true);
	assert.deepEqual(
		lines.filter((line) => line.event !== "otel_diag"),
		[
			{
				component: "evry",
				event: "tracing_registered",
				baseUrlHost: host,
				environment: "preview",
				environmentValid: true,
			},
			{ component: "evry", event: "tracing_not_global", which: "setGlobalContextManager" },
			{ component: "evry", event: "tracing_not_global", which: "setGlobalTracerProvider" },
		],
	);
	assert.ok(
		events(lines, "otel_diag").some((line) => String(line.message).includes("duplicate registration")),
		"OpenTelemetry's own refusal shows as otel_diag",
	);
});

test("INV-tracing: a console that throws never fails registration, a flush or a traced turn", async () => {
	const { log, error } = console;
	console.log = console.error = () => {
		throw new Error("console closed");
	};
	try {
		status = 401;
		assert.equal(registerTracing(env), true);
		assert.equal(registerTracing({}), false);
		diag.warn("unheard");
		assert.equal(await turn(), "done");
		await flushTraces();
		status = 200;
		assert.equal(await turn(), "done");
		await flushTraces();
	} finally {
		Object.assign(console, { log, error });
	}
});

test("INV-privacy: no tracing log line holds a key, the auth header, or the base URL's user info or token", () => {
	assert.ok(written.length >= 8, "every log path above wrote");
	const text = written.join("\n");
	for (const secret of [
		...Object.values(secrets),
		...authorization,
		...authorization.map((value) => value.replace(/^Basic /, "")),
	])
		assert.ok(!text.includes(secret), secret);
});
