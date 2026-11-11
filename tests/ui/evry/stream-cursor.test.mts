// The Evry stream route's cursor: a malformed ?after= reads from the start (sequence 0) for both the access check and
// the stream, and a valid one is passed through. The route's imports are stubbed so it runs without Next, a database
// or an account.
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { test } from "node:test";

type Calls = { read: number[]; observe: number[] };
const calls: Calls = ((globalThis as { __streamCursorCalls?: Calls }).__streamCursorCalls = { read: [], observe: [] });

const stub = (source: string) => `data:text/javascript,${encodeURIComponent(source)}`;
const stubs: Record<string, string> = {
	"@everyfield/evry": stub(`
		const calls = globalThis.__streamCursorCalls;
		export const flushTraces = () => {};
		export const projectError = (error) => ({ message: String(error) });
		export const readConversation = async (_db, _actor, _id, after) => { calls.read.push(after); };
		export async function* observeRun(_db, _actor, _id, after) { calls.observe.push(after); }
	`),
	"next/server": stub(`export const after = () => {};`),
	"@/server/evry": stub(`
		export const evryDatabase = () => ({});
		export const requestActor = async () => ({});
		export const errorResponse = (error) => new Response(String(error), { status: 500 });
	`),
};
registerHooks({
	resolve: (specifier, context, next) =>
		specifier in stubs ? { url: stubs[specifier]!, shortCircuit: true } : next(specifier, context),
});

const { GET } = (await import("../../../apps/web/src/app/api/evry/conversations/[id]/stream/route.ts")) as {
	GET: (request: Request, context: { params: Promise<{ id: string }> }) => Promise<Response>;
};

async function cursorFor(after: string) {
	calls.read.length = 0;
	calls.observe.length = 0;
	const response = await GET(new Request(`https://x.test/api/evry/conversations/c1/stream?after=${after}`), {
		params: Promise.resolve({ id: "c1" }),
	});
	assert.equal(response.status, 200);
	// The stream reads from observeRun as it is consumed.
	assert.match(await response.text(), /event: idle/);
	return { read: [...calls.read], observe: [...calls.observe] };
}

test("a malformed ?after= reads from cursor 0", async () => {
	for (const after of ["abc", "-1", "1.5", "", "1e400"])
		assert.deepEqual(await cursorFor(after), { read: [0], observe: [0] }, `after=${after}`);
});

test("a valid ?after= is passed through", async () => {
	assert.deepEqual(await cursorFor("7"), { read: [7], observe: [7] });
	assert.deepEqual(await cursorFor("0"), { read: [0], observe: [0] });
});
