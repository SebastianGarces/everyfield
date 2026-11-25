import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
	createConversation,
	readConversation,
	stageAttachment,
	submitTurn,
	type EvryActor,
} from "../../../packages/evry/src/index.ts";
import { bucket } from "./bucket.mts";
import { db, work } from "./support.mts";
import { toolResult } from "./saved.mts";

export const files = bucket();
const shared = globalThis as Record<symbol, { configured?: unknown; checks: WeakMap<object, unknown> } | undefined>;
(shared[Symbol.for("everyfield.db.privateStorage")] ??= { checks: new WeakMap() }).configured = files.storage;

export async function conversation(who: EvryActor) {
	return (await createConversation(db, who, { requestKey: randomUUID() })).id;
}
export async function attach(who: EvryActor, conversationId: string, name: string, text: string | Buffer) {
	const bytes = Buffer.from(text);
	const staged = await stageAttachment(db, files.storage, who, conversationId, { name, byteLength: bytes.length });
	const key = decodeURIComponent(new URL(staged.upload.url).pathname).replace("/synthetic-only/", "");
	files.objects.set(key, bytes);
	return staged.attachment;
}
export async function say(
	who: EvryActor,
	conversationId: string,
	text: string,
	attachments: { id: string; name: string }[] = [],
) {
	await submitTurn(db, who, conversationId, { requestKey: randomUUID(), text, attachments });
	assert.equal(await work(undefined, { storage: files.storage }), "succeeded");
	const page = await readConversation(db, who, conversationId);
	const turn = page.events.findLast((e) => e.kind === "user_message")!.turnId;
	const mine = page.events.filter((e) => e.turnId === turn);
	return {
		text: mine
			.filter((e) => e.kind === "assistant_text")
			.map((e) => e.body.text)
			.join(""),
		results: mine.filter((e) => e.kind === "tool_result").map((e) => toolResult.parse(e.body)),
		reviews: Object.values(page.reviews),
	};
}
