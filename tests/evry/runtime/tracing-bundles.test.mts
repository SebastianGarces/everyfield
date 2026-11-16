import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createRequire } from "node:module";
import type { AddressInfo } from "node:net";
import { flushTraces, registerTracing, traceTurn } from "../../../packages/evry/src/runtime/trace.ts";

const require = createRequire(new URL("../../../packages/evry/package.json", import.meta.url));
type Api = typeof import("@opentelemetry/api");

function foreignApi(): Api {
	const root = require.resolve("@opentelemetry/api").replace(/build\/src\/index\.js$/, "");
	const ours = Object.keys(require.cache).filter((key) => key.startsWith(root));
	const saved = ours.map((key) => [key, require.cache[key]] as const);
	for (const key of ours) delete require.cache[key];
	try {
		return require("@opentelemetry/api") as Api;
	} finally {
		for (const key of Object.keys(require.cache)) if (key.startsWith(root)) delete require.cache[key];
		for (const [key, module] of saved) require.cache[key] = module;
	}
}

let received = 0;
const langfuse = createServer((request: IncomingMessage, response: ServerResponse) => {
	request.resume().on("end", () => {
		received++;
		response.writeHead(200, { "content-type": "application/json" }).end("{}");
	});
});

before(async () => {
	await new Promise<void>((resolve) => langfuse.listen(0, "127.0.0.1", resolve));
	const { port } = langfuse.address() as AddressInfo;
	const env = {
		LANGFUSE_PUBLIC_KEY: "pk-lf-bundles",
		LANGFUSE_SECRET_KEY: "sk-lf-bundles",
		LANGFUSE_BASE_URL: `http://127.0.0.1:${port}`,
		LANGFUSE_TRACING_ENVIRONMENT: "preview",
	};
	const { log } = console;
	console.log = () => undefined;
	try {
		assert.equal(registerTracing(env), true);
	} finally {
		console.log = log;
	}
	const ours = require("@opentelemetry/api") as Api;
	const foreign = foreignApi();
	const registered = (ours.trace.getTracerProvider() as InstanceType<Api["ProxyTracerProvider"]>).getDelegate();
	const proxy = new foreign.ProxyTracerProvider();
	proxy.setDelegate(registered);
	assert.ok(!(proxy instanceof ours.ProxyTracerProvider), "the proxy is another copy's class");
	ours.trace.disable();
	assert.equal(ours.trace.setGlobalTracerProvider(proxy), true);
});
after(() => {
	langfuse.closeAllConnections();
	langfuse.close();
});

test("INV-tracing: a flush from another bundle's copy of the OpenTelemetry API exports the turn's spans", async () => {
	const lines: Record<string, unknown>[] = [];
	const { log, error } = console;
	console.log = console.error = (text: string) => lines.push(JSON.parse(text));
	try {
		const answer = await traceTurn(
			{ turnId: randomUUID(), conversationId: randomUUID(), submittedAt: new Date(), request: "Find Casey" },
			async (report) => {
				report({ text: "Casey Reed" });
				return "done";
			},
		);
		assert.equal(answer, "done");
		await flushTraces();
	} finally {
		Object.assign(console, { log, error });
	}
	assert.deepEqual(
		lines.map((line) => ({ ...line, ms: typeof line.ms })),
		[{ component: "evry", event: "traces_flushed", spans: 1, ms: "number" }],
	);
	assert.equal(received, 1, "the spans reached the stand-in during the flush, not on a later batch timer");
});
