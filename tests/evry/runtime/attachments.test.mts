import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import {
	approveProposal,
	executeProposal,
	readReview,
	submitTurn,
	type EvryActor,
	type Proposal,
} from "../../../packages/evry/src/index.ts";
import { getCommitmentDownload } from "../../../packages/domain/src/people/commitments/index.ts";
import { UNREADABLE_DOCUMENT } from "../../../packages/contracts/src/people/assessments/index.ts";
import { claimDue, finishClaim } from "../../../packages/domain/src/jobs/queue.ts";
import { transaction } from "../../../packages/domain/src/jobs/transaction.ts";
import { pdf } from "../../integration/platform/fixtures.mjs";
import { readAttachment } from "../../../packages/evry/src/attachments/store.ts";
import { runDueObjectCleanup } from "../../../packages/domain/src/jobs/object-cleanup.ts";
import { accounts, actor, admin, db, people, plant, setup, sql, teardown } from "./support.mts";
import { attach, conversation, files, say } from "./attached.mts";

before(async () => {
	await setup();
	await admin.execute(sql`UPDATE person SET email='alex.rivera@example.test' WHERE id=${people.alexRivera}::uuid`);
});
after(teardown);

const LAUNCH_FORM = [
	"first_name,last_name,email",
	"Jordan,Lee,jordan.lee@example.test",
	"Alex,Rivera,alex.rivera@example.test",
	"Sam,Ortiz,not-an-email",
].join("\n");

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
	assert.ok(!JSON.stringify(preview.result).includes("@example.test"));
	assert.equal(await peopleCount(), before);

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
	const rows = (card.review as { rows?: { row: number; outcome: string; label: string | null }[] }).rows ?? [];
	assert.deepEqual(
		rows.map((r) => [r.row, r.outcome, r.label]),
		[
			[1, "create", "Jordan Lee"],
			[2, "skip", "Alex Rivera"],
			[3, "fail", null],
		],
	);
	assert.match(imported.text, /People stays as it is until you approve it/);
	assert.equal(await peopleCount(), before);

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
	const fresh = await attach(owner, here, "launch-interest.csv", LAUNCH_FORM);
	const [staged] = (
		await admin.execute(
			sql`SELECT j.eligible_at=f.expires_at AS queued, f.expires_at-clock_timestamp() BETWEEN interval '23 hours 59 minutes' AND interval '24 hours' AS day
				FROM file_object f JOIN job j ON j.subject_record_id=f.id AND j.kind='object_cleanup' WHERE f.id=${fresh.id}::uuid`,
		)
	).rows as { queued: boolean; day: boolean }[];
	assert.deepEqual([staged!.queued, staged!.day], [true, true]);

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
	await assert.rejects(readAttachment(db, files.storage, owner, here, old), /attachment_gone/);
	await assert.rejects(
		readAttachment(db, files.storage, owner, await conversation(owner), old),
		/attachment_elsewhere/,
	);
});

const pdfBytes = pdf();
const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const attachBytes = (who: EvryActor, conversationId: string, name: string, bytes: Uint8Array) =>
	attach(who, conversationId, name, Buffer.from(bytes));
async function approve(who: EvryActor, proposal: Proposal) {
	await approveProposal(db, who, proposal.id, { revision: proposal.revision, digest: proposal.digest }, files.storage);
	const [claim] = await claimDue(db, ["evry_effect"], 1, 60);
	assert.ok(claim);
	const outcome = await executeProposal(
		db,
		{ jobId: claim.id, tenantId: claim.tenant_id, leaseOwner: claim.lease_owner, generation: claim.claim_generation },
		{ reminders: async () => undefined as never, phaseNotices: async () => undefined },
	);
	await transaction(db, (tx) => finishClaim(tx, claim, { state: outcome === "failed" ? "failed" : "succeeded" }));
	return readReview(db, who, proposal.id);
}
const commitmentCard = (turn: { results: Record<string, any>[]; reviews: (Proposal | null | undefined)[] }) => {
	const id = turn.results.findLast((r) => r.operation === "evry.prepareProposal")?.result.proposalId;
	const card = turn.reviews.find((r) => r?.id === id && r?.operation === "people.createCommitment");
	assert.ok(card, "this turn prepared a commitment review");
	return card;
};
const cardsOf = async (personId: string) =>
	(
		await admin.execute(
			sql`SELECT k.object_id::text AS object FROM commitment k WHERE k.person_id=${personId}::uuid ORDER BY k.recorded_at`,
		)
	).rows.map((r) => r.object as string | null);
const referenced = async (fileId: string) =>
	(await admin.execute(sql`SELECT file_is_referenced(${fileId}::uuid) AS used`)).rows[0]!.used;
const changesOf = (p: Proposal) =>
	Object.fromEntries((p.review.changes as { field: string; after: unknown }[]).map((c) => [c.field, c.after]));
const peopleContext = { session: accounts.owner.session, selected: { kind: "plant", id: plant } } as never;

test("INV-evry-commitment-document: an attached signed PDF rides the commitment review; approval records it as the card's commitment document, and the download gives the same bytes", async () => {
	const owner = await actor("owner");
	const here = await conversation(owner);
	const card = await attachBytes(owner, here, "alex-signed-card.pdf", pdfBytes);
	const said = await say(owner, here, "Alex Rivera signed the core group commitment on Oct 4", [card]);
	const review = commitmentCard(said);
	assert.equal(review.status, "pending");
	assert.equal(review.review.refusal, undefined);
	const changes = changesOf(review);
	assert.deepEqual(
		[changes.kind, changes.occurredOn, changes.document],
		["core_group", "2026-10-04", "alex-signed-card.pdf"],
	);
	assert.deepEqual(await cardsOf(people.alexRivera), []);
	assert.equal(await referenced(card.id), false);

	const done = await approve(owner, review);
	assert.equal(done.outcome, "completed");
	assert.deepEqual(await cardsOf(people.alexRivera), [card.id]);
	const [file] = (
		await admin.execute(
			sql`SELECT f.purpose,f.state,f.sha256,f.media_type,f.byte_count::int AS bytes,f.opaque_key AS key FROM file_object f WHERE f.id=${card.id}::uuid`,
		)
	).rows as { purpose: string; state: string; sha256: string; media_type: string; bytes: number; key: string }[];
	assert.deepEqual(
		[file!.purpose, file!.state, file!.sha256, file!.media_type, file!.bytes],
		["commitment", "ready", sha(pdfBytes), "application/pdf", pdfBytes.length],
	);
	const [author] = (
		await admin.execute(
			sql`SELECT a.actor_id::text AS actor FROM audit_event a WHERE a.action='people.recorded' AND a.tenant_id=${plant}::uuid
				AND a.subject_id=${people.alexRivera}::uuid ORDER BY a.recorded_at DESC LIMIT 1`,
		)
	).rows;
	assert.equal(author!.actor, accounts.owner.id);

	const elsewhere = await conversation(owner);
	const asked = await say(owner, elsewhere, "get Alex Rivera's commitment");
	const reads = asked.results.map((r) => r.operation);
	assert.deepEqual(reads, ["people.listPeople", "people.getCommitments", "people.getCommitmentDownload"]);
	const [commitmentId] = (
		await admin.execute(sql`SELECT k.id::text AS id FROM commitment k WHERE k.object_id=${card.id}::uuid`)
	).rows.map((r) => r.id as string);
	assert.match(asked.text, /Download the signed document/);
	assert.ok(asked.text.includes(`people/${people.alexRivera}/commitments/${commitmentId}/document`));
	assert.ok(!JSON.stringify(asked.results).includes(people.alexChen));
	const native = await getCommitmentDownload(db, files.storage, peopleContext, { commitmentId });
	assert.equal(native.status, "ok");
	const url = new URL((native as { value: { url: string } }).value.url);
	assert.equal(decodeURIComponent(url.pathname).replace("/synthetic-only/", ""), file!.key);
	assert.equal(sha(files.objects.get(file!.key)!), sha(pdfBytes));
});

test("INV-evry-commitment-document: a renamed non-PDF, a replaced file and a document already on another card record nothing, and say why", async () => {
	const owner = await actor("owner");
	const fake = await conversation(owner);
	const renamed = await attachBytes(owner, fake, "card.pdf", Buffer.from(LAUNCH_FORM));
	const unreadable = commitmentCard(
		await say(owner, fake, "Alex Chen signed the core group commitment on Oct 4", [renamed]),
	);
	assert.equal(unreadable.review.refusal, UNREADABLE_DOCUMENT);
	await assert.rejects(
		approveProposal(db, owner, unreadable.id, { revision: unreadable.revision, digest: unreadable.digest }, null),
	);

	const twice = await conversation(owner);
	const shared = await attachBytes(owner, twice, "shared-card.pdf", pdfBytes);
	const first = commitmentCard(
		await say(owner, twice, "Alex Chen signed the core group commitment on Oct 4", [shared]),
	);
	const second = commitmentCard(await say(owner, twice, "Casey Reed signed the launch team commitment on Oct 5"));
	assert.equal(changesOf(second).document, "shared-card.pdf");
	assert.equal((await approve(owner, first)).outcome, "completed");
	const again = await approve(owner, second);
	assert.deepEqual([again.outcome, again.receipt?.code], ["refused", "attachment_used"]);
	assert.deepEqual(await cardsOf(people.casey), []);

	const swapped = await conversation(owner);
	const old = await attachBytes(owner, swapped, "casey-card.pdf", pdfBytes);
	const stale = commitmentCard(
		await say(owner, swapped, "Casey Reed signed the core group commitment on Oct 4", [old]),
	);
	const newer = await attachBytes(owner, swapped, "casey-card.pdf", pdfBytes);
	await say(owner, swapped, "here is the right scan", [newer]);
	const replaced = await approve(owner, stale);
	assert.deepEqual([replaced.outcome, replaced.receipt?.code], ["refused", "file_changed"]);
	assert.deepEqual(await cardsOf(people.casey), []);
	assert.equal(await referenced(old.id), false);
});

test("INV-evry-commitment-document: a staged PDF past its 24 hours records nothing, whether it lapsed before the review or was cleaned up before approval", async () => {
	const owner = await actor("owner");
	const here = await conversation(owner);
	const stage = async (name: string, expires: string, at: string) => {
		const id = randomUUID();
		const key = `private/${plant}/${id}`;
		files.objects.set(key, Buffer.from(pdfBytes));
		await admin.execute(sql`INSERT INTO file_object(id,tenant_id,purpose,opaque_key,media_type,max_bytes,state,upload_key,claim_generation,expires_at)
			VALUES(${id}::uuid,${plant}::uuid,'commitment',${key},'application/pdf',${pdfBytes.length},'pending',${`evry-attachment/${here}/${id}`},0,clock_timestamp()+${expires}::interval)`);
		await admin.execute(sql`WITH c AS (UPDATE conversation SET last_sequence=last_sequence+1 WHERE id=${here}::uuid RETURNING id,last_sequence)
			INSERT INTO conversation_event(conversation_id,sequence,kind,body,created_at)
			SELECT id,last_sequence,'user_message',${JSON.stringify({ text: "Here is the card", references: [], attachments: [{ id, name }] })}::jsonb,
				clock_timestamp()-${at}::interval FROM c`);
		return { id, key };
	};
	await stage("lapsed-card.pdf", "-1 second", "24 hours");
	const lapsed = commitmentCard(await say(owner, here, "Casey Reed signed the core group commitment on Oct 6"));
	assert.equal(changesOf(lapsed).document, "lapsed-card.pdf");
	assert.match(lapsed.review.refusal ?? "", /no longer available: attached files last 24 hours/);

	const later = await stage("cleaned-card.pdf", "1 hour", "23 hours");
	const review = commitmentCard(await say(owner, here, "Casey Reed signed the core group commitment on Oct 6"));
	assert.deepEqual([changesOf(review).document, review.review.refusal], ["cleaned-card.pdf", undefined]);
	await admin.execute(sql`INSERT INTO job(tenant_id,kind,subject_record_id,producer_key,state,eligible_at,attempt_count,max_attempts,claim_generation)
		VALUES(${plant}::uuid,'object_cleanup',${later.id}::uuid,${"evry-attachment/" + later.id},'ready',clock_timestamp()-interval '1 second',0,4,0)`);
	assert.equal(await runDueObjectCleanup(db, files.storage, 10), 1);
	const gone = await approve(owner, review);
	assert.deepEqual([gone.outcome, gone.receipt?.code], ["refused", "attachment_gone"]);
	assert.deepEqual(await cardsOf(people.casey), []);
});
