import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
	approveProposal,
	createConversation,
	executeProposal,
	readConversation,
	stageAttachment,
	submitTurn,
	type EvryActor,
} from "../../../packages/evry/src/index.ts";
import { runDueObjectCleanup } from "../../../packages/domain/src/jobs/object-cleanup.ts";
import { transaction } from "../../../packages/domain/src/jobs/transaction.ts";
import { claimDue, finishClaim } from "../../../packages/domain/src/jobs/queue.ts";
import { actor, admin, bucket, db, plant, png, setup, sql, teardown, work } from "./support.mts";

const files = bucket();
let priya = "";
before(async () => {
	await setup();
	priya = randomUUID();
	await admin.execute(sql`INSERT INTO person(id,tenant_id,plant_id,display_name,source,created_at,stage,adult_classification,commitment_state,pipeline_position,state)
		VALUES(${priya},${plant},${plant},'Priya Shah','other',clock_timestamp(),'prospect','unknown','unknown',900,'live')`);
});
after(teardown);

const conversation = async (who: EvryActor) => (await createConversation(db, who, { requestKey: randomUUID() })).id;
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
		reviews: Object.values(page.reviews),
	};
}
const attachPhoto = async (who: EvryActor, conversationId: string, name = "priya.png") => {
	const { id, name: shown } = await files.attach(who, conversationId, name, png);
	return { id, name: shown };
};
const priyaPhoto = async () =>
	(await admin.execute(sql`SELECT photo_object_id FROM person WHERE id=${priya}::uuid`)).rows[0]!.photo_object_id;
const proposals = async (conversationId: string) =>
	Number(
		(await admin.execute(sql`SELECT count(*)::int n FROM proposal WHERE conversation_id=${conversationId}::uuid`))
			.rows[0]!.n,
	);
const stagedRows = async (conversationId: string) =>
	Number(
		(
			await admin.execute(
				sql`SELECT count(*)::int n FROM file_object WHERE upload_key LIKE ${`evry-attachment/${conversationId}/%`}`,
			)
		).rows[0]!.n,
	);

test("an Owner's attached photo becomes Priya's People photo only after Approve, and the effect runs once", async () => {
	const owner = await actor("owner");
	const here = await conversation(owner);
	const photo = await attachPhoto(owner, here);
	const asked = await say(owner, here, "use this as Priya Shah's photo", [photo]);
	assert.match(
		asked.text,
		/review to make it Priya Shah's People photo\. Their photo stays as it is until you approve it/,
	);
	const [card] = asked.reviews;
	assert.ok(card);
	assert.deepEqual(
		[card.operation, card.status, card.review.target?.label, card.review.changes],
		["people.setPersonPhoto", "pending", "Priya Shah", [{ field: "photo", before: null, after: photo.id }]],
	);
	assert.equal(await priyaPhoto(), null, "Priya's photo is unchanged before Approve");

	const witness = { revision: card.revision, digest: card.digest };
	await approveProposal(db, owner, card.id, witness, files.storage);
	assert.equal((await approveProposal(db, owner, card.id, witness, files.storage)).replayed, true);
	const [claim] = await claimDue(db, ["evry_effect"], 1, 60);
	assert.ok(claim);
	const lease = {
		jobId: claim.id,
		tenantId: claim.tenant_id,
		leaseOwner: claim.lease_owner,
		generation: claim.claim_generation,
	};
	const ports = { reminders: async () => {}, phaseNotices: async () => {} } as never;
	assert.equal(await executeProposal(db, lease, ports), "completed");
	await transaction(db, (tx) => finishClaim(tx, claim, { state: "succeeded" }));
	assert.deepEqual(await claimDue(db, ["evry_effect"], 1, 60), [], "approving twice queues one effect");
	assert.equal(await priyaPhoto(), photo.id);

	const again = await say(owner, here, "use this as Priya Shah's photo");
	assert.match(again.text, /already someone's People photo/);
	assert.equal(await proposals(here), 1, "the bound photo can't be proposed again");
	await admin.execute(
		sql`UPDATE job SET eligible_at=clock_timestamp()-interval '1 millisecond' WHERE kind='object_cleanup' AND subject_record_id=${photo.id}::uuid`,
	);
	assert.equal(await runDueObjectCleanup(db, files.storage, 10), 0, "the due staging cleanup keeps the bound photo");
	const [bound] = (await admin.execute(sql`SELECT purpose,state FROM file_object WHERE id=${photo.id}::uuid`)).rows;
	assert.deepEqual(bound, { purpose: "person_photo", state: "ready" });
});

test("a photo that is not JPG, PNG or WebP, or is larger than 5 MiB, is refused before anything is staged", async () => {
	const owner = await actor("owner");
	const here = await conversation(owner);
	for (const input of [
		{ name: "priya.gif", byteLength: 2048 },
		{ name: "priya.heic", byteLength: 2048 },
		{ name: "priya.jpg", byteLength: 5 * 1024 * 1024 + 1 },
	])
		await assert.rejects(stageAttachment(db, files.storage, owner, here, input), /invalid_input/, input.name);
	assert.equal(await stagedRows(here), 0);
	await stageAttachment(db, files.storage, owner, here, { name: "priya.jpg", byteLength: 5 * 1024 * 1024 });
	assert.equal(await stagedRows(here), 1, "a 5 MiB JPG is staged");
});

test("a photo attached in another conversation can't be used here: Evry asks for it here and prepares no review", async () => {
	const owner = await actor("owner");
	const elsewhere = await conversation(owner);
	const photo = await attachPhoto(owner, elsewhere);
	await say(owner, elsewhere, "here is a photo", [photo]);
	const here = await conversation(owner);
	const asked = await say(owner, here, "use the photo I just uploaded as Priya Shah's picture");
	assert.match(asked.text, /can't see a photo in this conversation\. Attach it here/);
	assert.deepEqual(asked.reviews, []);
	assert.equal(await proposals(here), 0);
	await assert.rejects(
		submitTurn(db, owner, here, { requestKey: randomUUID(), text: "use it", attachments: [photo] }),
		/attachment_gone/,
	);
});

test("INV-attachment-expiry: a photo unused for 24 hours is gone: Evry asks for it again and its staged bytes are deleted", async () => {
	const owner = await actor("owner");
	const here = await conversation(owner);
	const current = await priyaPhoto();
	const old = randomUUID();
	const key = `private/${plant}/${old}`;
	files.objects.set(key, png);
	await admin.execute(sql`INSERT INTO file_object(id,tenant_id,purpose,opaque_key,media_type,max_bytes,state,upload_key,claim_generation,expires_at)
		VALUES(${old}::uuid,${plant}::uuid,'assistant_staging',${key},'image/png',${png.length},'pending',${`evry-attachment/${here}/${old}`},0,clock_timestamp()-interval '1 millisecond')`);
	await admin.execute(sql`INSERT INTO job(tenant_id,kind,subject_record_id,producer_key,state,eligible_at,attempt_count,max_attempts,claim_generation)
		VALUES(${plant}::uuid,'object_cleanup',${old}::uuid,${"evry-attachment/" + old},'ready',clock_timestamp()-interval '1 millisecond',0,4,0)`);
	await admin.execute(sql`WITH c AS (UPDATE conversation SET last_sequence=last_sequence+1 WHERE id=${here}::uuid RETURNING id,last_sequence)
		INSERT INTO conversation_event(conversation_id,sequence,kind,body,created_at)
		SELECT id,last_sequence,'user_message',${JSON.stringify({ text: "Here is Priya's photo", references: [], attachments: [{ id: old, name: "priya.png" }] })}::jsonb,
			clock_timestamp()-interval '24 hours' FROM c`);

	const gone = await say(owner, here, "use this as Priya Shah's photo");
	assert.match(gone.text, /That photo is gone: attached photos last 24 hours\. Please attach it again/);
	assert.deepEqual(gone.reviews, []);
	assert.equal(await runDueObjectCleanup(db, files.storage, 10), 1);
	assert.deepEqual(files.deleted, [key]);
	assert.equal(files.objects.has(key), false);
	assert.equal(
		(await admin.execute(sql`SELECT state FROM file_object WHERE id=${old}::uuid`)).rows[0]!.state,
		"purged",
	);
	assert.equal(await priyaPhoto(), current);
});

test("a Member who asks to make a photo Priya's is told an Owner or Admin has to, and no review is prepared", async () => {
	const member = await actor("member");
	const here = await conversation(member);
	await assert.rejects(attachPhoto(member, here), /access_denied/, "a Member can't stage a church attachment");
	const asked = await say(member, here, "use this as Priya Shah's photo");
	assert.match(asked.text, /An Owner or Admin of this church has to set someone's People photo/);
	assert.deepEqual(asked.reviews, []);
	assert.equal(await proposals(here), 0);
});

test("INV-file-identity: only a pending staged JPG, PNG or WebP with its digest can become a ready person photo; every other purpose change is refused", async () => {
	const owner = await actor("owner");
	const here = await conversation(owner);
	const photo = await attachPhoto(owner, here, "other.png");
	const csv = await files.attach(owner, here, "people.csv", Buffer.from("first_name\nPriya"));
	const digest = "0".repeat(64);
	const outcome = (update: Promise<unknown>) =>
		update.then(
			() => "changed",
			(e: { cause?: { message?: string } }) => e.cause?.message,
		);
	const claim = (id: string, purpose: string) =>
		outcome(
			admin.execute(
				sql`UPDATE file_object SET purpose=${purpose},state='ready',byte_count=1,sha256=${digest} WHERE id=${id}::uuid`,
			),
		);
	assert.equal(await claim(csv.id, "person_photo"), "immutable_file_identity", "a CSV is not a photo");
	assert.equal(await claim(photo.id, "avatar"), "immutable_file_identity", "only a person photo");
	assert.equal(
		await outcome(
			admin.execute(sql`UPDATE file_object SET purpose='person_photo',state='ready' WHERE id=${photo.id}::uuid`),
		),
		"immutable_file_identity",
		"no digest, no claim",
	);
	assert.equal(await claim(photo.id, "person_photo"), "changed");
	assert.equal(
		await outcome(admin.execute(sql`UPDATE file_object SET purpose='assistant_staging' WHERE id=${photo.id}::uuid`)),
		"immutable_file_identity",
		"a claimed photo stays a person photo",
	);
});
