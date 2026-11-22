import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { S3Client, type PrivateStorage } from "../../../packages/db/src/schema/storage.ts";
import {
	createConversation,
	readConversation,
	stageAttachment,
	submitTurn,
	type EvryActor,
} from "../../../packages/evry/src/index.ts";
import { db, work } from "./support.mts";

function bucket() {
	const objects = new Map<string, Buffer>();
	const deleted: string[] = [];
	const client = new S3Client({
		endpoint: "http://127.0.0.1:9",
		region: "auto",
		forcePathStyle: true,
		credentials: { accessKeyId: "synthetic", secretAccessKey: "synthetic" },
	});
	client.send = (async (command: { constructor: { name: string }; input: { Key?: string } }) => {
		const name = command.constructor.name;
		if (name === "GetBucketAclCommand")
			return { Grants: [{ Grantee: { Type: "CanonicalUser", ID: "owner" }, Permission: "FULL_CONTROL" }] };
		const key = command.input.Key!;
		if (name === "DeleteObjectCommand") return (deleted.push(key), objects.delete(key), {});
		if (name === "PutObjectCommand")
			return (objects.set(key, Buffer.from((command.input as { Body: Uint8Array }).Body)), {});
		if (name !== "GetObjectCommand") throw Error("unexpected provider operation " + name);
		const body = objects.get(key);
		if (!body) throw Error("NoSuchKey");
		return {
			ContentLength: body.length,
			ContentType: "text/csv",
			Body: { transformToByteArray: async () => new Uint8Array(body) },
		};
	}) as never;
	return { storage: { bucket: "synthetic-only", client } as PrivateStorage, objects, deleted };
}
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
		results: mine.filter((e) => e.kind === "tool_result").map((e) => e.body as Record<string, any>),
		reviews: Object.values(page.reviews),
	};
}
