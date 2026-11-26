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
		heldDraft: () => null,
		holdDraft: () => {},
		reloadPage: () => {},
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

test("an account with no church attaches Word and text files only: a CSV, photo or PDF says which files fit and is never sent", async () => {
	const staged: string[] = [];
	const port = {
		openLatest: async () => ({ status: "ok", value: { conversation: null } }),
		createConversation: async () => ({ status: "ok", value: { ...conversation(CURRENT), context: "account" } }),
		stageAttachment: async (_id: string, name: string) => {
			staged.push(name);
			return {
				status: "ok",
				value: { attachment: { id: OTHER, name }, upload: { url: "https://files.example.test", headers: {} } },
			};
		},
		putFile: async () => true,
		stageAvatar: async () => {
			staged.push("avatar");
			return null;
		},
		heldDraft: () => null,
		holdDraft: () => {},
	} as unknown as EvryPort;
	const store = createEvryPanelStore({ context: "account", port });
	const add = (...files: File[]) => store.getState().actions.addFiles(files, "documents");
	for (const file of [
		new File(["a,b"], "people.csv", { type: "text/csv" }),
		new File(["x"], "me.png", { type: "image/png" }),
		new File(["%PDF-"], "letter.pdf", { type: "application/pdf" }),
	]) {
		add(file);
		assert.equal(
			store.getState().fileNotice,
			"Evry can take Word (.docx) and text (.txt) files here. Save the file as one of those and attach it again.",
			file.name,
		);
		assert.deepEqual([store.getState().files, store.getState().photo], [[], null], file.name);
	}
	add(new File(["hope"], "Hopes.txt", { type: "text/plain" }), new File(["word"], "Call.docx"));
	for (let n = 0; n < 5; n++) await new Promise((resolve) => setImmediate(resolve));
	const { files, fileNotice } = store.getState();
	assert.deepEqual(
		[files.map((f) => [f.name, f.state]), fileNotice, staged],
		[
			[
				["Hopes.txt", "ready"],
				["Call.docx", "ready"],
			],
			null,
			["Hopes.txt", "Call.docx"],
		],
	);
});
