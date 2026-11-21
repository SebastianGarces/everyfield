import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { S3Client } from "../../../packages/db/src/schema/storage.ts";
import {
	createConversation,
	readConversation,
	stageAttachment,
	submitTurn,
	type EvryActor,
} from "../../../packages/evry/src/index.ts";
import type { PrivateStorage } from "../../../packages/db/src/schema/storage.ts";
import { readAttachment } from "../../../packages/evry/src/attachments/store.ts";
import { runDueObjectCleanup } from "../../../packages/domain/src/jobs/object-cleanup.ts";
import { claimDue, finishClaim } from "../../../packages/domain/src/jobs/queue.ts";
import { transaction } from "../../../packages/domain/src/jobs/transaction.ts";
import { approveProposal, executeProposal, readReview } from "../../../packages/evry/src/index.ts";
import { IMPORT_TOO_LARGE, readNative } from "../../../packages/contracts/src/documents/index.ts";
import * as W from "../../integration/documents/fixtures/word.mts";
import { actor, admin, db, people, plant, setup, sql, teardown, work } from "./support.mts";

before(async () => {
	await setup();
	await admin.execute(sql`UPDATE person SET email='alex.rivera@example.test' WHERE id=${people.alexRivera}::uuid`);
});
after(teardown);

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
const files = bucket();
const shared = globalThis as Record<symbol, { configured?: unknown; checks: WeakMap<object, unknown> } | undefined>;
(shared[Symbol.for("everyfield.db.privateStorage")] ??= { checks: new WeakMap() }).configured = files.storage;

const LAUNCH_FORM = [
	"first_name,last_name,email",
	"Jordan,Lee,jordan.lee@example.test",
	"Alex,Rivera,alex.rivera@example.test",
	"Sam,Ortiz,not-an-email",
].join("\n");

async function conversation(who: EvryActor) {
	return (await createConversation(db, who, { requestKey: randomUUID() })).id;
}
async function attach(who: EvryActor, conversationId: string, name: string, text: string | Buffer) {
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

const WELCOME = W.word(
	W.styled("Heading1", "Welcome to Hope Fellowship") +
		W.p("We are a church for the city of Austin.") +
		W.styled("Heading2", "Our Sundays") +
		W.p("We gather at 10 am at the Eastside school."),
	{ styles: W.styles(W.style("Heading1", "heading 1"), W.style("Heading2", "heading 2")) },
);
const documents = async () =>
	(
		await admin.execute(
			sql`SELECT d.id,d.title,r.body FROM document d JOIN document_revision r ON r.id=d.current_revision_id
				WHERE d.tenant_id=${plant}::uuid AND d.kind='native' ORDER BY d.id`,
		)
	).rows as { id: string; title: string; body: string }[];
const proposalsIn = async (conversationId: string) =>
	Number(
		(await admin.execute(sql`SELECT count(*)::int AS n FROM proposal WHERE conversation_id=${conversationId}::uuid`))
			.rows[0]!.n,
	);
async function effect() {
	const [claim] = await claimDue(db, ["evry_effect"], 1, 60);
	assert.ok(claim);
	const outcome = await executeProposal(
		db,
		{ jobId: claim.id, tenantId: claim.tenant_id, leaseOwner: claim.lease_owner, generation: claim.claim_generation },
		{ reminders: async () => undefined, phaseNotices: async () => undefined },
	);
	if (outcome !== "lost") await transaction(db, (tx) => finishClaim(tx, claim, { state: "succeeded" }));
	return outcome;
}
const domainRefusal = async (bytes: Buffer, format: "docx" | "text") => {
	const owner = await actor("owner");
	const { documentsWriter } = await import("../../../packages/domain/src/documents/index.ts");
	const reply = await documentsWriter.importTextOrWord(
		db,
		owner.authority,
		{ title: "Compare", format, bytes: new Uint8Array(bytes), expectedRevision: "0", requestKey: randomUUID() },
		files.storage,
	);
	assert.equal(reply.status, "refused");
	return (reply as { error: { details: { issues: { problem: string }[] } } }).error.details.issues[0]!.problem;
};

test("AC:CASE-DOC-016 AC:GAP-EVR-422 an attached Word file becomes a church document through one review: nothing is in Documents until Approve, then one document with the file's headings and paragraphs, however often it is approved or retried", async () => {
	const owner = await actor("owner");
	const before = await documents();
	const here = await conversation(owner);
	const file = await attach(owner, here, "Welcome letter.docx", WELCOME);
	const asked = await say(owner, here, "make this a church document", [file]);
	assert.match(asked.text, /Nothing is added to Documents until you approve it/);
	const card = asked.reviews.find((r) => r?.operation === "documents.importTextOrWord")!;
	assert.equal(card.status, "pending");
	assert.deepEqual(
		card.review.changes.map((c: { field: string; after: unknown }) => [c.field, c.after]),
		[
			["file", "Welcome letter.docx"],
			["title", "Welcome letter"],
			[
				"text",
				"Welcome to Hope Fellowship · We are a church for the city of Austin. · Our Sundays · We gather at 10 am at the Eastside school.",
			],
		],
	);
	assert.deepEqual(await documents(), before);

	const review = await readReview(db, owner, card.id);
	await approveProposal(db, owner, card.id, { revision: review.revision, digest: review.digest }, null);
	await approveProposal(db, owner, card.id, { revision: review.revision, digest: review.digest }, null);
	assert.equal(await effect(), "completed");
	const done = await readReview(db, owner, card.id);
	assert.equal(done.outcome, "completed");
	const added = (await documents()).filter((d) => !before.some((b) => b.id === d.id));
	assert.equal(added.length, 1);
	assert.equal(added[0]!.id, done.receipt?.receiptId);
	assert.equal(added[0]!.title, "Welcome letter");
	const blocks = (
		readNative(added[0]!.body).body.content as unknown as {
			type: string;
			attrs?: { level?: number };
			content?: { text: string }[];
		}[]
	).map((b) => [b.type, b.attrs?.level ?? null, b.content?.map((t) => t.text).join("") ?? ""]);
	assert.deepEqual(blocks, [
		["heading", 1, "Welcome to Hope Fellowship"],
		["paragraph", null, "We are a church for the city of Austin."],
		["heading", 2, "Our Sundays"],
		["paragraph", null, "We gather at 10 am at the Eastside school."],
	]);

	const { DOCUMENTS_COMMANDS } = await import("../../../packages/evry/src/adapters/documents/commands/index.ts");
	const { gatedTransaction } = await import("../../../packages/domain/src/operations/index.ts");
	const [p] = (await admin.execute(sql`SELECT id,revision,input FROM proposal WHERE id=${card.id}::uuid`)).rows as {
		id: string;
		revision: number;
		input: unknown;
	}[];
	const retried = await gatedTransaction(db, (tx) =>
		DOCUMENTS_COMMANDS["documents.importTextOrWord"].execute(
			tx,
			{ session: owner.session, selected: owner.owner },
			p!.input,
			`evry:${p!.id}:${p!.revision}`,
			{ reminders: async () => undefined, phaseNotices: async () => undefined },
			{ authority: owner.authority, ports: null },
		),
	);
	assert.deepEqual(retried, { receiptId: added[0]!.id, revision: "1" });
	assert.equal((await documents()).length, before.length + 1);
});

const REFUSED: [string, string, Buffer, "docx" | "text", string][] = [
	[
		"an old .doc",
		"Minutes.doc",
		Buffer.concat([Buffer.from([0xd0, 0xcf, 0x11, 0xe0]), Buffer.alloc(508)]),
		"docx",
		"Legacy Word documents are not accepted.",
	],
	[
		"a .docx with macros",
		"Budget.docx",
		W.storedZip([
			{ name: "word/document.xml", data: "<w:document/>" },
			{ name: "word/vbaProject.bin", data: "macro" },
		]),
		"docx",
		"Word macros and embedded objects are not accepted.",
	],
	["a .txt that is not UTF-8", "Notes.txt", Buffer.from([0x48, 0x69, 0xff, 0xfe, 0x21]), "text", "Text must be UTF-8."],
	[
		"a .docx that expands too far",
		"Huge.docx",
		W.storedZip([{ name: "word/document.xml", data: Buffer.alloc(40 * 1024 * 1024 + 1), deflate: true }]),
		"docx",
		"The Word file expands past 40 MiB.",
	],
];
for (const [what, name, bytes, format, message] of REFUSED)
	test(`AC:CASE-DOC-016 ${what} is refused with the Documents import's own message and nothing is written`, async () => {
		assert.equal(await domainRefusal(bytes, format), message);
		const owner = await actor("owner");
		const before = await documents();
		const here = await conversation(owner);
		const file = await attach(owner, here, name, bytes);
		const refused = await say(owner, here, "make this a church document", [file]);
		assert.equal(refused.text, `I can't import that file. ${message}`);
		assert.deepEqual(refused.reviews, []);
		assert.equal(await proposalsIn(here), 0);
		assert.deepEqual(await documents(), before);
	});

test("AC:CASE-DOC-016 a file larger than the import limit is refused with the import's size message and nothing is written", async () => {
	const owner = await actor("owner");
	const before = await documents();
	const here = await conversation(owner);
	const file = await attach(owner, here, "Big.docx", WELCOME);
	files.objects.set(`private/${plant}/${file.id}`, Buffer.alloc(10 * 1024 * 1024 + 1));
	const refused = await say(owner, here, "make this a church document", [file]);
	assert.equal(refused.text, `I can't import that file. ${IMPORT_TOO_LARGE}`);
	assert.equal(await proposalsIn(here), 0);
	assert.deepEqual(await documents(), before);
});

test("AC:GAP-EVR-422 a Word file attached in another conversation, or past its 24 hours, can't be imported", async () => {
	const owner = await actor("owner");
	const before = await documents();
	const there = await conversation(owner);
	const file = await attach(owner, there, "Welcome letter.docx", WELCOME);
	await submitTurn(db, owner, there, { requestKey: randomUUID(), text: "here it is", attachments: [file] });
	assert.equal(await work(undefined, { storage: files.storage }), "succeeded");
	const elsewhere = await conversation(owner);
	const none = await say(owner, elsewhere, "make this a church document");
	assert.match(none.text, /can't see a file in this conversation\. Attach it here/);
	assert.equal(await proposalsIn(elsewhere), 0);

	const old = randomUUID();
	const key = `private/${plant}/${old}`;
	files.objects.set(key, WELCOME);
	await admin.execute(sql`INSERT INTO file_object(id,tenant_id,purpose,opaque_key,media_type,max_bytes,state,upload_key,claim_generation,expires_at)
		VALUES(${old}::uuid,${plant}::uuid,'assistant_staging',${key},'application/vnd.openxmlformats-officedocument.wordprocessingml.document',${WELCOME.length},'pending',${`evry-attachment/${there}/${old}`},0,clock_timestamp()-interval '1 second')`);
	await admin.execute(sql`WITH c AS (UPDATE conversation SET last_sequence=last_sequence+1 WHERE id=${there}::uuid RETURNING id,last_sequence)
		INSERT INTO conversation_event(conversation_id,sequence,kind,body,created_at)
		SELECT id,last_sequence,'user_message',${JSON.stringify({ text: "the letter", references: [], attachments: [{ id: old, name: "Letter.docx" }] })}::jsonb,
			clock_timestamp() FROM c`);
	const gone = await say(owner, there, "make this a church document");
	assert.match(gone.text, /That file is gone: attached files last 24 hours\. Please attach it again/);
	assert.equal(await proposalsIn(there), 0);
	assert.deepEqual(await documents(), before);
});
