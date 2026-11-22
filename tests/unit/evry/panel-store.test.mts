import assert from "node:assert/strict";
import { test } from "node:test";
import {
	createEvryPanelStore,
	type EvryPort,
} from "../../../apps/web/src/features/evry/conversation/EvryPanel.store.ts";
import type { ProjectedError } from "../../../apps/web/src/features/evry/conversation/model.ts";

const CURRENT = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const conversation = (id: string) => ({
	id,
	title: id,
	context: "plant" as const,
	lastSequence: 0,
	activeTurnId: null,
	updatedAt: "2026-11-22T00:00:00Z",
});
const refused = (code: ProjectedError["code"]) =>
	({
		status: "refused",
		code,
		error: { code, correlationId: "x", retry: "never", outcome: "refused" },
	}) as const;

function panelWith(readOther: () => Promise<Awaited<ReturnType<EvryPort["readConversation"]>>>) {
	const port = {
		openLatest: async () => ({
			status: "ok",
			value: { conversation: conversation(CURRENT), run: null, events: [], reviews: {}, more: false },
		}),
		readConversation: async (id: string) =>
			id === OTHER
				? readOther()
				: { status: "ok", value: { conversation: conversation(id), run: null, events: [], reviews: {}, more: false } },
	} as unknown as EvryPort;
	return createEvryPanelStore({ context: "plant:p", port });
}

async function select(store: ReturnType<typeof createEvryPanelStore>, id: string) {
	store.getState().actions.show(true);
	await new Promise((resolve) => setImmediate(resolve));
	store.getState().actions.select(id);
	await new Promise((resolve) => setImmediate(resolve));
	return store.getState();
}

test("opening a conversation from History that the server refuses says access is gone, not the connection", async () => {
	for (const code of ["not_found", "access_denied"] as const) {
		const state = await select(
			panelWith(async () => refused(code)),
			OTHER,
		);
		assert.equal(state.problem, "You no longer have access to that conversation.", code);
		assert.equal(state.chat.conversation?.id, CURRENT, code);
	}
});

test("opening a conversation from History that gets no answer asks to check the connection", async () => {
	const state = await select(
		panelWith(async () => ({ status: "lost" })),
		OTHER,
	);
	assert.equal(state.problem, "That conversation could not open. Check your connection and try again.");
	assert.equal(state.chat.conversation?.id, CURRENT);
});
