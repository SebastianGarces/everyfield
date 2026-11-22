import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { flushTraces, registerTracing, traceTurn } from "../../../packages/evry/src/runtime/trace.ts";

let received = 0;
const langfuse = createServer((request: IncomingMessage, response: ServerResponse) => {
	request.resume().on("end", () => {
		received++;
		response.writeHead(200, { "content-type": "application/json" }).end("{}");
	});
});

async function logged<T>(body: () => T | Promise<T>) {
	const lines: Record<string, unknown>[] = [];
	const { log, error } = console;
	console.log = console.error = (text: string) => void lines.push(JSON.parse(text));
	try {
		return { result: await body(), lines };
	} finally {
		Object.assign(console, { log, error });
	}
}

before(async () => {
	await new Promise<void>((resolve) => langfuse.listen(0, "127.0.0.1", resolve));
	const { result } = await logged(() =>
		registerTracing({
			LANGFUSE_PUBLIC_KEY: "pk-lf-limit",
			LANGFUSE_SECRET_KEY: "sk-lf-limit",
			LANGFUSE_BASE_URL: `http://127.0.0.1:${(langfuse.address() as AddressInfo).port}`,
			LANGFUSE_OTEL_MAX_BATCH_SIZE_BYTES: "64",
		}),
	);
	assert.equal(result, true);
});
after(() => {
	langfuse.closeAllConnections();
	langfuse.close();
});

test("INV-tracing: a span batch over the configured byte limit never leaves the process and is logged as TOO_LARGE", async () => {
	const { result, lines } = await logged(async () => {
		const answer = await traceTurn(
			{ turnId: randomUUID(), conversationId: randomUUID(), submittedAt: new Date(), request: "Find Casey Reed" },
			async (report) => {
				report({ text: "Casey Reed is in the Hope Church pipeline" });
				return "done";
			},
		);
		await flushTraces();
		return answer;
	});
	assert.equal(result, "done");
	assert.equal(received, 0);
	assert.deepEqual(
		lines.filter((line) => line.event === "trace_export_failed"),
		[
			{
				component: "evry",
				event: "trace_export_failed",
				code: "TOO_LARGE",
				httpStatus: null,
				error: { name: "RangeError", code: null },
			},
		],
	);
});
