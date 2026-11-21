import assert from "node:assert/strict";
import { test } from "node:test";
import {
	createEvryPanelStore,
	type EvryPort,
} from "../../../apps/web/src/features/evry/conversation/EvryPanel.store.ts";

const conversation = (id: string) => ({
	id,
	title: "Old church",
	context: "plant" as const,
	lastSequence: 2,
	activeTurnId: null,
	updatedAt: "2026-11-21T10:00:00Z",
});
const page = (id: string) => ({
	conversation: conversation(id),
	run: null,
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
const settled = () => new Promise((resolve) => setImmediate(resolve));

function fakePort(latest: string) {
	const calls = { open: 0, submit: [] as string[], reloads: 0 };
	let held: string | null = null;
	const port = {
		openLatest: async () => (calls.open++, { status: "ok", value: { ...page(latest), pipeline: false } }),
		readConversation: async (id: string) => ({ status: "ok", value: page(id) }),
		createConversation: async () => ({ status: "ok", value: conversation("new") }),
		submitTurn: async (id: string) => (calls.submit.push(id), { status: "refused", error: refusal }),
		retryTurn: async () => ({ status: "lost" }),
		cancelTurn: async () => ({ status: "lost" }),
		streamUrl: () => "",
		checkPhoto: () => null,
		stagePhoto: async () => {
			throw Error("no photos here");
		},
		heldDraft: () => held,
		holdDraft: (draft: string | null) => void (held = draft),
		reloadPage: () => void calls.reloads++,
	} as unknown as EvryPort;
	return { port, calls, held: () => held };
}

test("INV-church-changed: a moved seat's send shows the church change, stops reading, and Reload reopens Evry with the message", async () => {
	const { port, calls, held } = fakePort("church-a");
	const store = createEvryPanelStore({ context: "plant:a", port });
	store.getState().actions.show(true);
	await settled();
	assert.equal(store.getState().chat.conversation?.id, "church-a");
	const off = store.getState().actions.followStream(() => {});

	store.getState().actions.send("Who is new this week?", [], "plant:a");
	await settled();
	const state = store.getState();
	assert.equal(state.churchChanged, true);
	assert.deepEqual(calls.submit, ["church-a"]);
	assert.deepEqual(
		state.chat.sends.map((s) => [s.text, s.state, s.error?.code]),
		[["Who is new this week?", "refused", "church_changed"]],
	);
	assert.equal(state.chat.activeTurnId, null);
	assert.equal(state.chat.events.length, 1, "nothing new from the old church is shown");

	store.getState().actions.reloadForChurch(state.chat.sends[0]!);
	assert.equal(held(), "Who is new this week?");
	assert.equal(calls.reloads, 1);
	off();

	const reopened = createEvryPanelStore({ context: "plant:b", port });
	assert.equal(reopened.getState().open, true);
	assert.equal(reopened.getState().draft, "Who is new this week?");
	const opens = calls.open;
	const stop = reopened.getState().actions.followStream(() => {});
	await settled();
	assert.equal(calls.open, opens + 1, "the reopened panel opens the new church's latest conversation");
	assert.equal(reopened.getState().load, "ready");
	assert.equal(reopened.getState().churchChanged, false);
	assert.equal(held(), null, "the kept message is used once");
	stop();

	const later = createEvryPanelStore({ context: "plant:b", port });
	assert.equal(later.getState().open, false, "a later page load opens nothing");
	assert.equal(later.getState().draft, "");
});
