import assert from "node:assert/strict";
import { test } from "node:test";
import {
	createEvryPanelStore,
	type EvryPort,
} from "../../../apps/web/src/features/evry/conversation/EvryPanel.store.ts";

const conversation = (id: string, activeTurnId: string | null = null) => ({
	id,
	title: "Old church",
	context: "plant" as const,
	lastSequence: 2,
	activeTurnId,
	updatedAt: "2026-11-21T10:00:00Z",
});
const page = (id: string, running = false) => ({
	conversation: conversation(id, running ? "t1" : null),
	run: running ? { turnId: "t1", state: "running" as const } : null,
	events: [
		{
			sequence: 1,
			turnId: "t1",
			kind: "user_message" as const,
			body: { text: "First" },
			createdAt: "2026-11-21T10:00:00Z",
		},
	],
	reviews: {},
	more: false,
});
const refusal = {
	code: "church_changed" as const,
	correlationId: "00000000-0000-4000-8000-000000000000",
	retry: "never" as const,
	outcome: "refused" as const,
};
const refused = { status: "refused", error: refusal };
const settled = () => new Promise((resolve) => setImmediate(resolve));

class FakeSource extends EventTarget {
	static made: FakeSource[] = [];
	static CLOSED = 2;
	readyState = 1;
	closed = false;
	onopen: (() => void) | null = null;
	readonly url: string;
	constructor(url: string) {
		super();
		this.url = url;
		FakeSource.made.push(this);
	}
	close() {
		this.closed = true;
		this.readyState = FakeSource.CLOSED;
	}
}
Object.assign(globalThis, { EventSource: FakeSource });

function fakePort(running: boolean) {
	const calls = { reads: [] as string[], retries: 0, reloads: 0 };
	let held: string | null = null;
	let moved = false;
	const port = {
		openLatest: async () => ({ status: "ok", value: { ...page("church-a", running), pipeline: false } }),
		readConversation: async (id: string) => (calls.reads.push(id), moved ? refused : { status: "ok", value: page(id) }),
		createConversation: async () => ({ status: "ok", value: conversation("new") }),
		submitTurn: async () => refused,
		retryTurn: async () => (calls.retries++, refused),
		cancelTurn: async () => ({ status: "lost" }),
		streamUrl: (id: string) => `/stream/${id}`,
		stageAvatar: async () => null,
		heldDraft: () => held,
		holdDraft: (draft: string | null) => void (held = draft),
		reloadPage: () => void calls.reloads++,
	} as unknown as EvryPort;
	return { port, calls, held: () => held, move: () => void (moved = true) };
}

async function opened(running = false) {
	const fake = fakePort(running);
	const store = createEvryPanelStore({ context: "plant:a", port: fake.port });
	store.getState().actions.show(true);
	await settled();
	const off = store.getState().actions.followStream(() => {});
	await settled();
	return { ...fake, store, off };
}

test("INV-church-changed: a retry refused because the seat moved church shows the church change, keeps the draft for Reload and reads nothing more", async () => {
	const { store, calls, held, move, off } = await opened();
	move();
	store.getState().actions.write("Who is new this week?");
	const reads = calls.reads.length;
	store.getState().actions.retry("t1");
	await settled();
	const state = store.getState();
	assert.equal(state.churchChanged, true);
	assert.match(state.churchNotice ?? "", /^Evry did not try again\. Reload/);
	assert.equal(state.problem, null);
	assert.equal(calls.retries, 1);
	assert.equal(state.chat.events.length, 1);
	assert.equal(calls.reads.length, reads, "no read of the old church's conversation");

	store.getState().actions.reloadForChurch();
	assert.equal(held(), "Who is new this week?");
	assert.equal(calls.reloads, 1);
	off();
});

test("INV-church-changed: a run whose stream is refused because the seat moved church stops following and reads nothing more", async () => {
	const { store, calls, move, off } = await opened(true);
	assert.equal(store.getState().chat.activeTurnId, "t1");
	const source = FakeSource.made.at(-1)!;
	assert.equal(source.url, "/stream/church-a");
	move();
	source.dispatchEvent(new MessageEvent("error", { data: JSON.stringify(refusal) }));
	await settled();
	const state = store.getState();
	assert.equal(state.churchChanged, true);
	assert.match(state.churchNotice ?? "", /^Evry stopped, and nothing was changed\. Reload/);
	assert.equal(state.problem, null);
	assert.equal(state.chat.activeTurnId, null);
	assert.equal(source.closed, true);
	source.dispatchEvent(
		new MessageEvent("assistant_text", {
			data: JSON.stringify({ sequence: 2, turnId: "t1", kind: "assistant_text", body: { text: "Late" }, createdAt: "" }),
		}),
	);
	const made = FakeSource.made.length;
	const reads = calls.reads.length;
	store.getState().actions.write("still here");
	await settled();
	assert.equal(store.getState().chat.events.length, 1, "no later church A event shows");
	assert.equal(FakeSource.made.length, made, "the panel does not stream the old church again");
	assert.equal(calls.reads.length, reads);
	off();
});

test("INV-church-changed: a stream that closes and whose settle read is refused shows the same church change", async () => {
	const { store, calls, move, off } = await opened(true);
	const source = FakeSource.made.at(-1)!;
	move();
	source.readyState = FakeSource.CLOSED;
	source.dispatchEvent(new Event("error"));
	await settled();
	assert.equal(store.getState().churchChanged, true);
	assert.match(store.getState().churchNotice ?? "", /^Evry stopped/);
	const reads = calls.reads.length;
	store.getState().actions.reconnect();
	await settled();
	assert.equal(calls.reads.length, reads);
	assert.equal(FakeSource.made.at(-1), source, "Reconnect does not stream the old church");
	off();
});

test("INV-church-changed: opening an old church conversation from History after the seat moved shows the church change, not its events", async () => {
	const { store, calls, move, off } = await opened();
	move();
	store.getState().actions.select("church-a-older");
	await settled();
	const state = store.getState();
	assert.deepEqual(calls.reads.slice(-1), ["church-a-older"]);
	assert.equal(state.churchChanged, true);
	assert.match(state.churchNotice ?? "", /^That conversation is from your old church\. Reload/);
	assert.equal(state.problem, null);
	assert.equal(state.load, "ready");
	assert.notEqual(state.chat.conversation?.id, "church-a-older");
	off();
});
