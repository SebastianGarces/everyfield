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

async function panel(answers: { create: unknown[]; submit?: unknown[]; open?: unknown }) {
	const calls: string[] = [];
	const next = (list: unknown[] | undefined) => list?.shift() ?? { status: "lost" };
	const port = {
		openLatest: async () => answers.open ?? { status: "ok", value: { conversation: null } },
		readConversation: async () => ({ status: "lost" }),
		createConversation: async () => (calls.push("create"), next(answers.create)),
		submitTurn: async () => (calls.push("submit"), next(answers.submit)),
		retryTurn: async () => ({ status: "lost" }),
		cancelTurn: async () => ({ status: "lost" }),
		streamUrl: () => "",
		checkPhoto: () => null,
		heldDraft: () => null,
		holdDraft: () => {},
		reloadPage: () => {},
		stagePhoto: async () => {
			throw new Error("no photos here");
		},
	} as unknown as EvryPort;
	const store = createEvryPanelStore({ context: "/communication", port });
	store.getState().actions.show(true);
	await settle();
	const send = async (text: string) => {
		store.getState().actions.send(text, [], "/communication");
		await settle();
	};
	const only = (): Send => {
		const sends = store.getState().chat.sends;
		assert.equal(sends.length, 1);
		return sends[0]!;
	};
	const notice = () => sendNotice(only(), store.getState().churchName);
	return { store, calls, send, only, notice };
}

const NO_ACCESS = (church: string) =>
	`You don't have access to Evry for ${church} yet. Ask whoever manages your church's Everyfield account to add you.`;
const COULD_NOT_START = "Evry couldn't start a new conversation. Please try again.";
const TECHNICAL =
	/access_denied|invalid_input|not_found|model_unavailable|something_new|undefined|null|\{|\d{3}|\bcode\b|\bfield\b/i;

const opened = (churchName?: string | null) => ({
	status: "ok",
	value: { conversation: null, ...(churchName === undefined ? {} : { churchName }) },
});
const lines: [code: string, open: string, reply: unknown, line: string][] = [
	["access_denied", "named Grace Austin", opened("Grace Austin"), NO_ACCESS("Grace Austin")],
	["access_denied", "with no name", opened(null), NO_ACCESS("this church")],
	["access_denied", "that omits the name", opened(), NO_ACCESS("this church")],
	["access_denied", "with an empty name", opened(""), NO_ACCESS("this church")],
	["access_denied", "with a blank name", opened("   "), NO_ACCESS("this church")],
	["access_denied", "that was lost", { status: "lost" }, NO_ACCESS("this church")],
	["invalid_input", "named Grace Austin", opened("Grace Austin"), COULD_NOT_START],
	["not_found", "named Grace Austin", opened("Grace Austin"), START_REFUSED],
	["model_unavailable", "with no name", opened(null), START_REFUSED],
	["something_new", "named Grace Austin", opened("Grace Austin"), START_REFUSED],
];
for (const [code, open, reply, line] of lines) {
	test(`a first message refused on start with ${code}, after an open ${open}, reads its own line with no code`, async () => {
		const { calls, send, only, notice } = await panel({ create: [refused(code)], open: reply });
		await send("Who visited last Sunday?");
		assert.equal(notice(), line);
		assert.doesNotMatch(notice()!.replace("Grace Austin", ""), TECHNICAL);
		assert.equal(resendable(only()), true);
		assert.deepEqual(calls, ["create"]);
	});
}

for (const [code, line] of [
	["access_denied", NO_ACCESS("Grace Austin")],
	["invalid_input", COULD_NOT_START],
] as const) {
	test(`sending again after a ${code} start that is refused again asks again and shows the ${code} line again`, async () => {
		const { store, calls, send, only, notice } = await panel({
			create: [refused(code), refused(code)],
			open: opened("Grace Austin"),
		});
		await send("Who visited last Sunday?");
		assert.equal(notice(), line);
		store.getState().actions.resend(only());
		await settle();
		assert.deepEqual(calls, ["create", "create"]);
		assert.equal(notice(), line);
		assert.equal(resendable(only()), true);
	});
}

test("sending again after a refused start asks for the conversation again and sends the message", async () => {
	const { store, calls, send, only } = await panel({
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

test("a refused start that is refused again with another code shows that code's line and the send-again control", async () => {
	const { store, calls, send, only } = await panel({ create: [refused("access_denied"), refused("invalid_input")] });
	await send("Who visited last Sunday?");
	store.getState().actions.resend(only());
	await settle();
	assert.deepEqual(calls, ["create", "create"]);
	assert.equal(sendNotice(only()), COULD_NOT_START);
	assert.equal(resendable(only()), true);
});

test("a turn refused for access in an existing conversation keeps its own line", async () => {
	const { send, only, calls } = await panel({
		create: [{ status: "ok", value: conversation }],
		submit: [refused("access_denied")],
	});
	await send("Who visited last Sunday?");
	assert.deepEqual(calls, ["create", "submit"]);
	assert.equal(sendNotice(only()), "Not sent. You no longer have access to this conversation.");
	assert.equal(resendable(only()), false);
});

test("a lost start still reads as not confirmed, not as a refusal", async () => {
	const { send, only } = await panel({ create: [{ status: "lost" }] });
	await send("Who visited last Sunday?");
	assert.equal(sendNotice(only()), "Not confirmed. Check your connection, then send it again.");
});
