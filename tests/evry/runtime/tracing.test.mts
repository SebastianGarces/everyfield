import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { setTimeout as sleep } from "node:timers/promises";
import { gunzipSync } from "node:zlib";
import {
	createConversation,
	flushTraces,
	observeConversation,
	readConversation,
	submitTurn,
} from "../../../packages/evry/src/index.ts";
import { registerTracing } from "../../../packages/evry/src/runtime/trace.ts";
import { actor, admin, db, people, setup, sql, teardown, work } from "./support.mts";

// A local stand-in for Langfuse's OTLP endpoint: it records every exported span, or hangs to act as an outage.
type Span = { traceId: string; name: string; attributes: { key: string; value: { stringValue?: string } }[] };
const spans: Span[] = [];
const hung: ServerResponse[] = [];
let outage = false;
const langfuse = createServer((request: IncomingMessage, response: ServerResponse) => {
	const chunks: Buffer[] = [];
	request.on("data", (c: Buffer) => chunks.push(c));
	request.on("end", () => {
		if (outage) return void hung.push(response);
		const raw = Buffer.concat(chunks);
		const body = JSON.parse(String(request.headers["content-encoding"] === "gzip" ? gunzipSync(raw) : raw));
		spans.push(...body.resourceSpans.flatMap((r: any) => r.scopeSpans.flatMap((s: any) => s.spans)));
		response.writeHead(200, { "content-type": "application/json" }).end("{}");
	});
});

before(async () => {
	await new Promise<void>((resolve) => langfuse.listen(0, "127.0.0.1", resolve));
	assert.ok(
		registerTracing({
			LANGFUSE_PUBLIC_KEY: "pk-lf-test",
			LANGFUSE_SECRET_KEY: "sk-lf-test",
			LANGFUSE_BASE_URL: `http://127.0.0.1:${(langfuse.address() as AddressInfo).port}`,
		}),
	);
	await setup();
});
after(async () => {
	langfuse.closeAllConnections();
	langfuse.close();
	await teardown();
});

async function ask(text: string) {
	const owner = await actor("owner");
	const { id } = await createConversation(db, owner, { requestKey: randomUUID() });
	const { turnId } = await submitTurn(db, owner, id, { requestKey: randomUUID(), text, references: [] });
	return { owner, conversationId: id, turnId };
}
const attribute = (name: string, key: string) =>
	spans.find((s) => s.name === name)?.attributes.find((a) => a.key === key)?.value.stringValue;

test("INV-privacy C64: one Evry turn sends one Langfuse trace with the queue, access check, model steps, tools, first saved text and first delivery; it holds the text the model saw and nothing more", async () => {
	await admin.execute(
		sql`UPDATE person SET city='sk-live-abcdefghijklmnopqrstuvwx', email='casey@example.test' WHERE id=${people.casey}`,
	);
	const { owner, conversationId, turnId } = await ask("Find Casey");
	assert.equal(await work(), "succeeded");
	for await (const _ of observeConversation(db, owner, conversationId, 0, AbortSignal.timeout(5_000), 20));
	await flushTraces();

	const traceId = createHash("sha256").update(turnId).digest("hex").slice(0, 32);
	assert.deepEqual([...new Set(spans.map((s) => s.traceId))], [traceId], "one trace, keyed by the turn");
	assert.deepEqual(
		spans.map((s) => s.name).sort(),
		[
			"access check",
			"access check",
			"chat scripted",
			"chat scripted",
			"chat scripted",
			"evry turn",
			"execute_tool people_read",
			"first SSE delivery",
			"first text saved",
			"invoke_agent scripted",
			"invoke_agent scripted",
			"load turn",
			"queue claim",
			"queue wait",
			"step 1",
			"step 1",
			"step 2",
		],
		"the classification call, then two answer steps with one tool call",
	);
	assert.equal(attribute("evry turn", "session.id"), conversationId);
	assert.match(attribute("first text saved", "langfuse.observation.metadata.submitToFirstTextMs") ?? "", /^\d+$/);
	assert.match(attribute("first SSE delivery", "langfuse.observation.metadata.submitToFirstSseMs") ?? "", /^\d+$/);

	// Full text: the request, the tool result and the answer as the model saw them; scrubbed and private values never.
	const sent = JSON.stringify(spans);
	for (const seen of ["Find Casey", "Casey Reed", "[removed]"]) assert.ok(sent.includes(seen), seen);
	for (const secret of ["sk-live-abcdefghijklmnopqrstuvwx", "casey@example.test", "sk-lf-test"])
		assert.ok(!sent.includes(secret), secret);
});

test("INV-tracing: a Langfuse outage never fails or holds a turn", async () => {
	outage = true;
	await ask("Find Casey");
	assert.equal(await work(), "succeeded");
	const flushed = flushTraces();
	while (!hung.length) await sleep(10);
	// The export hangs while the next turn runs and saves its end.
	const { owner, conversationId } = await ask("Find Casey");
	assert.equal(await work(), "succeeded");
	const { events } = await readConversation(db, owner, conversationId);
	assert.equal(events.at(-1)?.body.state, "completed");
	for (const response of hung) response.destroy();
	await flushed;
});
