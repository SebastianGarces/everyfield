import assert from "node:assert/strict";
import { test } from "node:test";
import {
	createEvryPanelStore,
	type EvryPort,
} from "../../../apps/web/src/features/evry/conversation/EvryPanel.store.ts";
import { resendable, sendNotice, type Send } from "../../../apps/web/src/features/evry/conversation/model.ts";

const START_REFUSED = "Evry can't start a new conversation right now. Please try again in a moment.";
const conversation = {
	id: "11111111-1111-4111-8111-111111111111",
	title: "New conversation",
	contextKind: "church",
	createdAt: "2026-11-21T00:00:00Z",
	updatedAt: "2026-11-21T00:00:00Z",
};
const refused = (code: string) => ({
	status: "refused" as const,
	error: { code, correlationId: "c0ffee00-0000-4000-8000-000000000000", retry: "never", outcome: "refused" },
});
const settle = () => new Promise((resolve) => setImmediate(resolve));

function panel(answers: { create: unknown[]; submit?: unknown[] }) {
	const calls: string[] = [];
	const next = (list: unknown[] | undefined) => list?.shift() ?? { status: "lost" };
	const port = {
		openLatest: async () => ({ status: "ok", value: { conversation: null } }),
		readConversation: async () => ({ status: "lost" }),
		createConversation: async () => (calls.push("create"), next(answers.create)),
		submitTurn: async () => (calls.push("submit"), next(answers.submit)),
		retryTurn: async () => ({ status: "lost" }),
		cancelTurn: async () => ({ status: "lost" }),
		streamUrl: () => "",
		checkPhoto: () => null,
		stagePhoto: async () => {
			throw new Error("no photos here");
		},
	} as unknown as EvryPort;
	const store = createEvryPanelStore({ context: "/communication", port });
	const send = async (text: string) => {
		store.getState().actions.send(text, [], "/communication");
		await settle();
	};
	const only = (): Send => {
		const sends = store.getState().chat.sends;
		assert.equal(sends.length, 1);
		return sends[0]!;
	};
	return { store, calls, send, only };
}

for (const code of ["access_denied", "invalid_input"]) {
	test(`a first message whose new conversation is refused with ${code} says Evry can't start one, with no code`, async () => {
		const { calls, send, only } = panel({ create: [refused(code)] });
		await send("Who visited last Sunday?");
		const notice = sendNotice(only());
		assert.equal(notice, START_REFUSED);
		assert.ok(!notice?.includes("this conversation"));
		assert.ok(!notice?.includes(code));
		assert.deepEqual(calls, ["create"]);
	});
}

test("sending again after a refused start asks for the conversation again and sends the message", async () => {
	const { store, calls, send, only } = panel({
		create: [refused("access_denied"), { status: "ok", value: conversation }],
		submit: [{ status: "ok", value: { turnId: "t1", sequence: 1, replayed: false } }],
	});
	await send("Who visited last Sunday?");
	const first = only();
	assert.equal(resendable(first), true);
	store.getState().actions.resend(first);
	await settle();
	assert.deepEqual(calls, ["create", "create", "submit"]);
	assert.equal(store.getState().chat.conversation?.id, conversation.id);
	assert.equal(sendNotice(only()), null);
});

test("a refused start that is refused again keeps the same line and the send-again control", async () => {
	const { store, calls, send, only } = panel({ create: [refused("access_denied"), refused("invalid_input")] });
	await send("Who visited last Sunday?");
	store.getState().actions.resend(only());
	await settle();
	assert.deepEqual(calls, ["create", "create"]);
	assert.equal(sendNotice(only()), START_REFUSED);
	assert.equal(resendable(only()), true);
});

test("a turn refused for access in an existing conversation keeps its own line", async () => {
	const { send, only, calls } = panel({
		create: [{ status: "ok", value: conversation }],
		submit: [refused("access_denied")],
	});
	await send("Who visited last Sunday?");
	assert.deepEqual(calls, ["create", "submit"]);
	assert.equal(sendNotice(only()), "Not sent. You no longer have access to this conversation.");
	assert.equal(resendable(only()), false);
});

test("a lost start still reads as not confirmed, not as a refusal", async () => {
	const { send, only } = panel({ create: [{ status: "lost" }] });
	await send("Who visited last Sunday?");
	assert.equal(sendNotice(only()), "Not confirmed. Check your connection, then send it again.");
});
