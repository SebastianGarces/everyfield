import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { approveProposal, executeProposal, readReview, submitTurn } from "../../../../packages/evry/src/index.ts";
import { claimDue, finishClaim } from "../../../../packages/domain/src/jobs/queue.ts";
import { transaction } from "../../../../packages/domain/src/jobs/transaction.ts";
import { IMPORT_TOO_LARGE, readNative } from "../../../../packages/contracts/src/documents/index.ts";
import * as W from "../../../integration/documents/fixtures/word.mts";
import { actor, admin, db, plant, setup, sql, teardown, work } from "../../runtime/support.mts";
import { attach, conversation, files, say } from "../../runtime/attached.mts";

before(setup);
after(teardown);

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
	const { documentsWriter } = await import("../../../../packages/domain/src/documents/index.ts");
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

	const { DOCUMENTS_COMMANDS } = await import("../../../../packages/evry/src/adapters/documents/commands/index.ts");
	const { gatedTransaction } = await import("../../../../packages/domain/src/operations/index.ts");
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
