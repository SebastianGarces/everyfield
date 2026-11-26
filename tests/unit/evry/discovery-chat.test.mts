import "../runs-in/render.mjs";
import assert from "node:assert/strict";
import { test } from "node:test";
import { mount } from "./fake-dom.mts";

const { ReviewCard } = await import("../../../apps/web/src/features/evry/review/ReviewCard.tsx");
const { createReviewStore } = await import("../../../apps/web/src/features/evry/review/ReviewCard.store.ts");
const reviewApi = await import("../../../apps/web/src/features/evry/review/api.ts");
const { createEvryPanelStore } = await import("../../../apps/web/src/features/evry/conversation/EvryPanel.store.ts");
const { sendNotice } = await import("../../../apps/web/src/features/evry/conversation/model.ts");

const ID = "11111111-1111-4111-8111-111111111111";
const NOW = "2026-11-26T12:00:00Z";
const review = (operation: string, over: Record<string, unknown> = {}) => ({
	id: ID,
	conversationId: "c",
	operation,
	revision: 1,
	digest: "d",
	expiresAt: "2026-11-26T12:10:00Z",
	approvedAt: null,
	status: "pending",
	review: { target: { kind: "document", id: "doc", label: "Vision statement", href: "/documents/written/doc" }, changes: [] },
	outcome: null,
	executing: false,
	receipt: null,
	stale: null,
	now: NOW,
	...over,
});
const church = { changed: () => false, refused: () => false, leave() {}, reload() {}, converted() {} };
const settled = () => new Promise((resolve) => setImmediate(resolve));

test("INV-discovery-chats: a review left pending in a Discovery chat shows it is no longer open, that nothing changed, and where to edit the document", async () => {
	const at = await mount(ReviewCard, {
		proposalId: ID,
		target: null,
		seed: review("documents.saveNative", { closed: true }),
		church,
	});
	const text = at.text();
	await at.unmount();
	assert.ok(text.includes("No longer open"), text);
	assert.ok(
		text.includes(
			"This chat stays in Discovery, so this review is no longer open. Nothing was changed. You can edit the document directly in Documents.",
		),
		text,
	);
	assert.ok(text.includes("Open in Documents"), text);
	assert.ok(!text.includes("Approve"), "a closed review offers no approval");
	assert.ok(!text.includes("Revise") && !text.includes("Cancel"), "nor any other change to it");
});

test("INV-discovery-chats: approving the start of a church tells the panel its chat stays in Discovery; starting one without Discovery does not", async () => {
	for (const [operation, expected] of [
		["discovery.convertToPlant", 1],
		["onboarding.createPlant", 0],
	] as const) {
		const done = review(operation, { status: "approved", outcome: "completed", approvedAt: NOW });
		globalThis.fetch = (async (_url: string, init?: { method?: string }) =>
			init?.method === "POST"
				? Response.json({ proposal: done, replayed: false })
				: Response.json({ proposal: done })) as typeof fetch;
		const told = { converted: 0, refreshed: 0 };
		const store = createReviewStore({
			id: ID,
			seed: review(operation) as never,
			port: {
				...reviewApi,
				refresh: () => void told.refreshed++,
				church: { ...church, converted: () => void told.converted++ },
			},
		});
		const off = store.getState().actions.follow(() => {});
		await store.getState().actions.approve();
		off();
		assert.deepEqual(told, { converted: expected, refreshed: 1 }, operation);
	}
});

const conversation = { id: "d1", title: "Vision", context: "account", lastSequence: 1, activeTurnId: null, updatedAt: NOW };
const page = (discovery: boolean) => ({
	conversation: { ...conversation, discovery },
	run: null,
	events: [{ sequence: 1, turnId: "t1", kind: "user_message", body: { text: "Vision" }, createdAt: NOW }],
	reviews: {},
	more: false,
});
const readOnly = { code: "discovery_read_only", correlationId: "x", retry: "never", outcome: "refused" };
function port(discovery = false) {
	return {
		openLatest: async () => ({ status: "ok", value: { ...page(discovery), pipeline: false } }),
		readConversation: async () => ({ status: "ok", value: page(discovery) }),
		createConversation: async () => ({ status: "ok", value: { ...conversation, id: "new", discovery: false } }),
		submitTurn: async () => ({ status: "refused", error: readOnly }),
		retryTurn: async () => ({ status: "lost" }),
		cancelTurn: async () => ({ status: "lost" }),
		streamUrl: () => "",
		stageAvatar: async () => null,
		heldDraft: () => null,
		holdDraft() {},
		reloadPage() {},
	} as never;
}

test("INV-discovery-chats: after the church starts, the panel says the chat stays in Discovery and offers a new chat, with no church change or error", async () => {
	const store = createEvryPanelStore({ context: "account", port: port() });
	store.getState().actions.show(true);
	await settled();
	const off = store.getState().actions.followStream(() => {});
	store.getState().actions.leaveDiscovery();
	const state = store.getState();
	assert.equal(state.chat.conversation?.discovery, true);
	assert.deepEqual([state.churchChanged, state.churchNotice, state.problem], [false, null, null]);
	assert.equal(
		state.announcement,
		"This chat stays in Discovery. It's read-only, and you can still read it in History. Start a new chat to ask Evry about your church.",
	);
	store.getState().actions.newChat();
	assert.equal(store.getState().chat.conversation, null, "New chat leaves the Discovery chat");
	off();
});

test("INV-discovery-chats: a message refused because the chat stays in Discovery says so and turns the chat read-only", async () => {
	const store = createEvryPanelStore({ context: "plant:a", port: port() });
	store.getState().actions.show(true);
	await settled();
	store.getState().actions.send("One more thing", [], "plant:a");
	await settled();
	const state = store.getState();
	const [sent] = state.chat.sends;
	assert.equal(
		sent && sendNotice(sent),
		"Not sent. This chat stays in Discovery, so it is read-only. Start a new chat to ask Evry.",
	);
	assert.equal(state.chat.conversation?.discovery, true);
	assert.equal(state.churchChanged, false);
});
