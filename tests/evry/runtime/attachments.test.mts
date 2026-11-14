// Files attached in the Evry panel (WP-054): staged in the private bucket for one conversation, checked with
// people.previewImport, imported only through a review card bound to the checked bytes, and deleted after 24 hours.
// Every turn runs on the scripted model through the real runtime.
import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { S3Client } from "../../../packages/db/node_modules/@aws-sdk/client-s3/dist-cjs/index.js";
import {
	createConversation,
	readConversation,
	stageAttachment,
	submitTurn,
	type EvryActor,
} from "../../../packages/evry/src/index.ts";
import type { PrivateStorage } from "../../../packages/db/src/schema/storage.ts";
import { readAttachment } from "../../../packages/evry/src/attachments/store.ts";
import { runDueObjectCleanup } from "../../../apps/web/src/server/jobs/object-cleanup.ts";
import { actor, admin, db, people, plant, setup, sql, teardown, work } from "./support.mts";

before(async () => {
	await setup();
	await admin.execute(sql`UPDATE person SET email='alex.rivera@example.test' WHERE id=${people.alexRivera}::uuid`);
});
after(teardown);

/**
 * A private bucket on a real S3 client, so uploads are signed as in production, whose provider calls stay in memory:
 * the bucket ACL check, reading an object and deleting one. A test "puts" a file by storing its bytes under the key the
 * signed URL names, as the browser's PUT would.
 */
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
const files = bucket();

/** The launch interest form: one new person, one who shares Alex Rivera's email, and one bad email. */
const LAUNCH_FORM = [
	"first_name,last_name,email",
	"Jordan,Lee,jordan.lee@example.test",
	"Alex,Rivera,alex.rivera@example.test",
	"Sam,Ortiz,not-an-email",
].join("\n");

async function conversation(who: EvryActor) {
	return (await createConversation(db, who, { requestKey: randomUUID() })).id;
}
/** Attaches a CSV to the conversation as the panel does: sign the upload, then put the exact bytes. */
async function attach(who: EvryActor, conversationId: string, name: string, text: string) {
	const bytes = Buffer.from(text);
	const staged = await stageAttachment(db, files.storage, who, conversationId, { name, byteLength: bytes.length });
	const key = decodeURIComponent(new URL(staged.upload.url).pathname).replace("/synthetic-only/", "");
	files.objects.set(key, bytes);
	return staged.attachment;
}
async function say(
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
const peopleCount = async () =>
	Number((await admin.execute(sql`SELECT count(*)::int AS n FROM person WHERE plant_id=${plant}::uuid`)).rows[0]!.n);

test("AC:CLN-04 AC:GAP-EVR-422 an attached launch interest form is checked row by row and nothing is imported; a file attached in another conversation can't be used", async () => {
	const owner = await actor("owner");
	const before = await peopleCount();
	const here = await conversation(owner);
	const form = await attach(owner, here, "launch-interest.csv", LAUNCH_FORM);
	const checked = await say(owner, here, "I uploaded the spreadsheet from our launch interest form, check it", [form]);
	const preview = checked.results.find((r) => r.operation === "people.previewImport")!;
	assert.deepEqual(preview.input, { attachmentId: form.id });
	assert.deepEqual(
		preview.result.rows
			.filter((r: any) => r.kind === "import")
			.map((r: any) => [r.label, r.fields.status, r.fields.problems]),
		[
			["Jordan Lee", "valid", null],
			["Alex Rivera", "valid", null],
			["Row 3", "invalid", "invalid_email"],
		],
	);
	assert.match(
		checked.text,
		/Jordan Lee: valid[\s\S]*Alex Rivera: possible duplicate of Alex Rivera[\s\S]*Row 3: can't be imported \(invalid_email\)/,
	);
	assert.match(checked.text, /Nothing is imported/);
	// The model never sees the file's contact values.
	assert.ok(!JSON.stringify(preview.result).includes("@example.test"));
	assert.equal(await peopleCount(), before);

	// Another conversation does not list the file, and a read naming it there is refused without failing the turn.
	const elsewhere = await conversation(owner);
	const refused = await say(owner, elsewhere, "check the spreadsheet I uploaded");
	assert.match(refused.text, /can't see a file in this conversation\. Attach it here/);
	assert.deepEqual(refused.results, []);
	await assert.rejects(
		submitTurn(db, owner, elsewhere, { requestKey: randomUUID(), text: "check it", attachments: [form] }),
		/attachment_gone/,
	);
});

test("AC:GAP-EVR-422 the import review is built from the conversation's own check; People is unchanged until approval; a replaced file is checked afresh first", async () => {
	const owner = await actor("owner");
	const before = await peopleCount();
	const here = await conversation(owner);
	const form = await attach(owner, here, "launch-interest.csv", LAUNCH_FORM);
	await say(owner, here, "check the spreadsheet I uploaded", [form]);
	const imported = await say(owner, here, "import it");
	const card = imported.reviews.find((r) => r?.operation === "people.executeBulkImport")!;
	assert.equal(card.status, "pending");
	assert.deepEqual(
		card.review.changes.map((c) => [c.field, c.after]),
		[
			["file", "launch-interest.csv"],
			["rows", 3],
			["create", 1],
			["skip", 1],
			["invalid", 1],
		],
	);
	assert.match(imported.text, /People stays as it is until you approve it/);
	assert.equal(await peopleCount(), before);

	// The same name attached again replaces the file: importing now meets file_changed and gets a fresh check, no card.
	const replaced = await conversation(owner);
	const first = await attach(owner, replaced, "launch-interest.csv", LAUNCH_FORM);
	await say(owner, replaced, "check the spreadsheet I uploaded", [first]);
	const second = await attach(owner, replaced, "launch-interest.csv", LAUNCH_FORM + "\nRiley,Park,riley@example.test");
	const again = await say(owner, replaced, "Here is the new version. import it", [second]);
	const proposed = again.results.filter((r) => r.operation === "evry.prepareProposal");
	assert.deepEqual(proposed, []);
	assert.deepEqual(
		again.results.map((r) => [r.operation, r.input]),
		[["people.previewImport", { attachmentId: second.id }]],
	);
	assert.match(again.text, /changed since I checked it, so here is a fresh check[\s\S]*Riley Park: valid/);
	assert.deepEqual(
		(await admin.execute(sql`SELECT count(*)::int AS n FROM proposal WHERE conversation_id=${replaced}::uuid`)).rows[0]!
			.n,
		0,
	);
});

test("INV-attachment-expiry: an attached file unused for 24 hours is gone: Evry asks for it again and its staged bytes are deleted", async () => {
	const owner = await actor("owner");
	const here = await conversation(owner);
	// A file attached now is staged for exactly 24 hours, with its cleanup queued for that moment.
	const fresh = await attach(owner, here, "launch-interest.csv", LAUNCH_FORM);
	const [staged] = (
		await admin.execute(
			sql`SELECT j.eligible_at=f.expires_at AS queued, f.expires_at-clock_timestamp() BETWEEN interval '23 hours 59 minutes' AND interval '24 hours' AS day
				FROM file_object f JOIN job j ON j.subject_record_id=f.id AND j.kind='object_cleanup' WHERE f.id=${fresh.id}::uuid`,
		)
	).rows as { queued: boolean; day: boolean }[];
	assert.deepEqual([staged!.queued, staged!.day], [true, true]);

	// The same file attached in this conversation 24 hours ago and never used: the staged row, its bytes, its due
	// cleanup and the message that attached it, placed through their rows (a file row's expiry is immutable).
	const old = randomUUID();
	const key = `private/${plant}/${old}`;
	files.objects.set(key, Buffer.from(LAUNCH_FORM));
	await admin.execute(sql`INSERT INTO file_object(id,tenant_id,purpose,opaque_key,media_type,max_bytes,state,upload_key,claim_generation,expires_at)
		VALUES(${old}::uuid,${plant}::uuid,'assistant_staging',${key},'text/csv',${LAUNCH_FORM.length},'pending',${`evry-attachment/${here}/${old}`},0,clock_timestamp()-interval '1 second')`);
	await admin.execute(sql`INSERT INTO job(tenant_id,kind,subject_record_id,producer_key,state,eligible_at,attempt_count,max_attempts,claim_generation)
		VALUES(${plant}::uuid,'object_cleanup',${old}::uuid,${"evry-attachment/" + old},'ready',clock_timestamp()-interval '1 second',0,4,0)`);
	await admin.execute(sql`WITH c AS (UPDATE conversation SET last_sequence=last_sequence+1 WHERE id=${here}::uuid RETURNING id,last_sequence)
		INSERT INTO conversation_event(conversation_id,sequence,kind,body,created_at)
		SELECT id,last_sequence,'user_message',${JSON.stringify({ text: "Here is the file for later", references: [], attachments: [{ id: old, name: "interest-form.csv" }] })}::jsonb,
			clock_timestamp()-interval '24 hours' FROM c`);

	const gone = await say(owner, here, "check the spreadsheet I uploaded");
	assert.match(gone.text, /That file is gone: attached files last 24 hours\. Please attach it again/);
	assert.deepEqual(gone.results, []);
	assert.equal(await runDueObjectCleanup(db, files.storage, 10), 1);
	assert.deepEqual(files.deleted, [key]);
	assert.equal(files.objects.has(key), false);
	const [row] = (await admin.execute(sql`SELECT state FROM file_object WHERE id=${old}::uuid`)).rows;
	assert.equal(row!.state, "purged");
	// A read naming the gone file is refused as gone, never served from anywhere else; another conversation's read of it
	// is refused as not its own.
	await assert.rejects(readAttachment(db, files.storage, owner, here, old), /attachment_gone/);
	await assert.rejects(
		readAttachment(db, files.storage, owner, await conversation(owner), old),
		/attachment_elsewhere/,
	);
});
