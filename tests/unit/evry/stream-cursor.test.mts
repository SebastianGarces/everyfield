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
		export const approveProposal = undefined, cancelProposal = undefined, cancelTurn = undefined, checkProposal = undefined, createConversation = undefined, listConversations = undefined, openLatestConversation = undefined, pipelineListsPeople = undefined, readCatalog = undefined, readReview = undefined, readStagedPhoto = undefined, retryTurn = undefined, retryUnresolvedEffects = undefined, reviseProposal = undefined, stageAttachment = undefined, submitTurn = undefined;
		export const projectError = (error) => ({ message: String(error) });
		export const readConversation = async (_db, _actor, _id, after) => { calls.read.push(after); };
		export async function* observeRun(_db, _actor, _id, after) { calls.observe.push(after); }
	`),
	"next/server": stub(`export const after = () => {};`),
	"server-only": stub(""),
	"@everyfield/db/schema": stub(`export const privateStorage = () => ({});`),
	"../platform/boundary": stub(`export const mutatingRoute = (handler) => handler; export const privateHeaders = {};`),
	"../platform/json.ts": stub(`export const parseJson = JSON.parse;`),
	"../database": stub(`export const requestDatabase = () => ({});`),
	"./native": stub(`export const evryNative = () => ({});`),
	"./index": stub(`
		export const requestActor = async () => ({});
		export const errorResponse = (error) => new Response(String(error), { status: 500 });
		export const drainEffects = () => {};
		export const drainTurns = () => {};
		export const evryMail = () => ({});
		export const evryResponse = () => new Response();
	`),
};
registerHooks({
	resolve: (specifier, context, next) =>
		specifier in stubs ? { url: stubs[specifier]!, shortCircuit: true } : next(specifier, context),
});

const { conversationStreamGet } = (await import("../../../apps/web/src/server/evry/http.ts")) as {
	conversationStreamGet: (request: Request, context: { params: Promise<{ id: string }> }) => Promise<Response>;
};

async function cursorFor(after: string) {
	calls.read.length = 0;
	calls.observe.length = 0;
	const response = await conversationStreamGet(
		new Request(`https://x.test/api/evry/conversations/c1/stream?after=${after}`),
		{
			params: Promise.resolve({ id: "c1" }),
		},
	);
	assert.equal(response.status, 200);
	assert.match(await response.text(), /event: idle/);
	return { read: [...calls.read], observe: [...calls.observe] };
}

test("BUG-PR551: a malformed ?after= reads from cursor 0", async () => {
	for (const after of ["abc", "-1", "1.5", "", "1e400"])
		assert.deepEqual(await cursorFor(after), { read: [0], observe: [0] }, `after=${after}`);
});

test("BUG-PR551: a valid ?after= is passed through", async () => {
	assert.deepEqual(await cursorFor("7"), { read: [7], observe: [7] });
	assert.deepEqual(await cursorFor("0"), { read: [0], observe: [0] });
});
