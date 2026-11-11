// DOC-020, CASE-DOC-020 `network-fills-slot` and `no-network-blank-slot` (D-106 to D-109): a Church Document made
// from a template starts with the sending network's statement of faith in its `statement-of-faith` slot, read once at
// creation. A plant with no network, or whose network has not written it, gets the marked blank.
// T-85, CASE-DOC-020 base case and `network-fills-preview` (D-417, D-418): a Bylaws preview and a file saved through
// "Save for your church" print the network's text as it stands when the action runs, and the marked blank otherwise.
//
// Every case creates from the built-in Bylaws, whose "Statement of faith" slot carries the key (T-56, D-110). The key
// test alone adds one fixture template with mixed slots (D-126), so an unkeyed and an other-keyed slot sit beside it.
// Every step runs through the real createFromTemplate, readChurch, history and export path.
import { testDatabase } from "../../support/test-database.mts";
import { sql } from "../../../packages/db/node_modules/drizzle-orm/index.js";
import { S3Client } from "../../../packages/db/node_modules/@aws-sdk/client-s3/dist-es/index.js";
import { RequestActor } from "../../../packages/domain/src/access/session.ts";
import { documentsReader, documentsWriter } from "../../../packages/domain/src/documents/index.ts";
import { DOC_TEMPLATES, docTemplateById, loadTemplate } from "../../../packages/domain/src/documents/doc-templates.ts";
import { SLOT_BLANK_NOTE } from "../../../packages/domain/src/documents/templates/church.ts";
import { pdfPages, docxParts, wordText } from "./fixtures/readers.mts";
import { DOCTRINAL } from "./fixtures/doctrinal.mts";
import test, { after, describe } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

const database = await testDatabase({ prefix: "t84" });
const { admin, schema } = database;
const db = database.pools.runtime;

class MemoryClient extends S3Client {
	objects = new Map();
	constructor() {
		super({
			region: "us-east-1",
			endpoint: "https://example.invalid",
			forcePathStyle: true,
			credentials: { accessKeyId: "test", secretAccessKey: "test" },
		});
	}
	async send(command) {
		const input = command.input ?? {};
		switch (command.constructor.name) {
			case "GetBucketAclCommand":
				return { Grants: [{ Grantee: { ID: "private-owner" }, Permission: "FULL_CONTROL" }] };
			case "PutObjectCommand":
				this.objects.set(input.Key, Buffer.from(input.Body));
				return {};
			case "GetObjectCommand": {
				const body = this.objects.get(input.Key);
				if (!body) throw Object.assign(new Error("missing"), { name: "NoSuchKey" });
				return { ContentLength: body.length, Body: { transformToByteArray: async () => body } };
			}
			case "DeleteObjectCommand":
				this.objects.delete(input.Key);
				return {};
			default:
				throw new Error(`unexpected provider operation ${command.constructor.name}`);
		}
	}
}
const client = new MemoryClient();
const storage = { bucket: "synthetic-only", client };

// ---------------------------------------------------------------- fixture templates

const LABEL = "Statement of faith";
const para = (text) => ({ type: "paragraph", content: [{ type: "text", text }] });
const policy = docTemplateById("conflict-of-interest-policy");
const withSlots = (id, slots) => {
	const t = structuredClone(policy);
	t.id = id;
	t.title = "Synthetic mixed slots";
	// After the masthead and its divider: the slot sits between two of the policy's own sections.
	t.body.content.splice(4, 0, ...slots);
	return loadTemplate(id, t);
};
const BYLAWS = "bylaws";
const MIXED = "t84-mixed-slots";
const AUTHORED = "The church writes its vision here.";
DOC_TEMPLATES.push(
	withSlots(MIXED, [
		{ type: "slot", attrs: { label: LABEL, key: "statement-of-faith" }, content: [] },
		{ type: "slot", attrs: { label: "Doctrinal notes" }, content: [] },
		{ type: "slot", attrs: { label: "Vision", key: "vision" }, content: [para(AUTHORED)] },
	]),
);

// ---------------------------------------------------------------- tenants

const TEXT = "We hold to these words as our network's own.\n\nWe gather, we send,\nand we serve together.";
const PARAGRAPHS = [
	para("We hold to these words as our network's own."),
	{
		type: "paragraph",
		content: [
			{ type: "text", text: "We gather, we send," },
			{ type: "hardBreak" },
			{ type: "text", text: "and we serve together." },
		],
	},
];

/** A plant with one Owner. Returns the plant id and a function giving that Owner's request authority. */
async function plantWithOwner(name) {
	const plant = randomUUID(),
		account = randomUUID(),
		user = randomUUID(),
		session = randomUUID();
	await admin.execute(
		sql`INSERT INTO plant(id,name,timezone,warning_days,alert_days,digest_weekday,digest_hour,phase,material_revision) VALUES(${plant},${name},'America/Chicago',7,14,1,8,1,1)`,
	);
	await admin.execute(
		sql`INSERT INTO auth_user(id,email,email_verified,name) VALUES(${user},${account + "@example.test"},true,'Synthetic')`,
	);
	await admin.execute(
		sql`INSERT INTO account(id,auth_user_id,registration_state,registration_kind) VALUES(${account},${user},'active','planter')`,
	);
	await admin.execute(
		sql`INSERT INTO auth_session(id,user_id,token,expires_at) VALUES(${session},${user},${randomUUID()},clock_timestamp()+interval '1 day')`,
	);
	await admin.execute(
		sql`INSERT INTO seat(account_id,plant_id,role,accepted_at) VALUES(${account},${plant},'owner',clock_timestamp())`,
	);
	const authority = async () => {
		const actor = await RequestActor.resolve(db, session);
		assert.ok(actor instanceof RequestActor, JSON.stringify(actor));
		return actor;
	};
	return { plant, authority };
}
async function organization(kind, statement = null) {
	const id = randomUUID();
	await admin.execute(
		sql`INSERT INTO organization(id,kind,name,timezone,material_revision,statement_of_faith) VALUES(${id},${kind},'Synthetic network','UTC',1,${statement})`,
	);
	return id;
}
const setStatement = (id, statement) =>
	admin.execute(sql`UPDATE organization SET statement_of_faith=${statement} WHERE id=${id}::uuid`);
async function affiliate(plant, org, acceptedAt = "2026-01-01T00:00:00Z") {
	const r = await admin.execute(
		sql`INSERT INTO affiliation(plant_id,organization_id,accepted_at,share_people,share_meetings,share_tasks,share_ministry_teams,share_wiki,share_activity,shared_findings)
			VALUES(${plant},${org},${acceptedAt}::timestamptz,false,false,false,false,false,false,false) RETURNING id`,
	);
	return r.rows[0].id;
}

// ---------------------------------------------------------------- the operations, as a user calls them

const ok = (result) => {
	assert.equal(result.status, "ok", JSON.stringify(result.status === "refused" ? result.error : result.status));
	return result.value;
};
const create = async (who, templateId = BYLAWS) =>
	ok(
		await documentsWriter.createFromTemplate(db, await who.authority(), {
			templateId,
			requestKey: randomUUID(),
		}),
	);
const slotsOf = (body) => body.body.content.filter((n) => n.type === "slot");
const keyedSlot = (body) => slotsOf(body).find((n) => n.attrs?.key === "statement-of-faith");
const revisionOne = async (who, documentId) =>
	ok(await documentsWriter["history.get"](db, await who.authority(), { documentId, revision: 1 })).body;
const current = async (who, documentId) =>
	ok(await documentsWriter.readChurch(db, await who.authority(), { documentId })).body;
async function exportsOf(who, documentId, revision = 1) {
	const text = {};
	for (const format of ["pdf", "docx"]) {
		const generated = ok(
			await documentsWriter.exportNative(
				db,
				await who.authority(),
				{ documentId, revision, format, requestKey: randomUUID() },
				storage,
			),
		);
		const [file] = (
			await admin.execute(
				sql`SELECT f.opaque_key FROM generated_document g JOIN file_object f ON f.id = g.object_id WHERE g.id = ${generated.id}::uuid`,
			)
		).rows;
		const bytes = client.objects.get(file.opaque_key);
		assert.ok(bytes, "the bytes are in private storage");
		text[format] =
			format === "pdf" ? (await pdfPages(bytes)).join(" ") : wordText(docxParts(bytes)["word/document.xml"]);
	}
	return [text.pdf, text.docx];
}
/** The network's text in the section: under the label, one paragraph per block, and no marked blank. */
async function assertNetworkText(who, documentId, paragraphs = PARAGRAPHS, revision = 1) {
	const words = paragraphs.flatMap((p) => p.content.filter((n) => n.type === "text").map((n) => n.text));
	for (const text of await exportsOf(who, documentId, revision)) {
		const at = text.search(/statement of faith/i);
		assert.ok(at >= 0, "the slot's label");
		let from = at;
		for (const word of words) {
			const next = text.indexOf(word, from);
			assert.ok(next > from, `"${word}" follows the label, in order`);
			from = next;
		}
		assert.equal(text.includes(SLOT_BLANK_NOTE), false, "no marked blank");
	}
}
/** The empty slot: the template's own, the marked blank in both files and no doctrinal words. */
async function assertMarkedBlank(who, doc) {
	assert.deepEqual(keyedSlot(doc.body), keyedSlot(docTemplateById(BYLAWS)), "the slot as Bylaws authored it");
	assert.deepEqual(keyedSlot(doc.body).content ?? [], [], "an empty slot");
	assert.deepEqual(keyedSlot(await revisionOne(who, doc.id)), keyedSlot(doc.body));
	for (const text of await exportsOf(who, doc.id)) {
		assert.match(text, /statement of faith/i);
		assert.ok(text.includes(SLOT_BLANK_NOTE), "the marked blank");
		assert.equal(DOCTRINAL.test(text), false, `doctrinal words: ${DOCTRINAL.exec(text)?.[0]}`);
		assert.equal(text.includes("network's own"), false);
	}
}

after(async () => {
	await database.close();
});

describe("DOC-020 network text fills a doctrinal section at creation", { concurrency: 1 }, () => {
	test("AC:CASE-DOC-020 network-fills-slot: revision 1 holds the network's exact text under the label, in both exports", async () => {
		const who = await plantWithOwner("Filled Plant");
		await affiliate(who.plant, await organization("sending_network", TEXT));
		const doc = await create(who);
		assert.equal(doc.revision, "1");
		const filled = { type: "slot", attrs: { label: LABEL, key: "statement-of-faith" }, content: PARAGRAPHS };
		assert.deepEqual(keyedSlot(doc.body), filled);
		assert.deepEqual(keyedSlot(await current(who, doc.id)), filled);
		assert.deepEqual(keyedSlot(await revisionOne(who, doc.id)), filled);
		await assertNetworkText(who, doc.id);
	});

	test("AC:CASE-DOC-020 no-network-blank-slot: a plant with no network gets the marked blank", async () => {
		const who = await plantWithOwner("Lone Plant");
		await assertMarkedBlank(who, await create(who));
	});

	test("DOC-020: a network that has not written it, or cleared it, or an ended affiliation gives the marked blank", async () => {
		const unset = await plantWithOwner("Unset Plant");
		await affiliate(unset.plant, await organization("sending_network"));
		await assertMarkedBlank(unset, await create(unset));

		const cleared = await plantWithOwner("Cleared Plant");
		const network = await organization("sending_network", TEXT);
		await affiliate(cleared.plant, network);
		await setStatement(network, null);
		await assertMarkedBlank(cleared, await create(cleared));

		const ended = await plantWithOwner("Ended Plant");
		const affiliation = await affiliate(ended.plant, await organization("sending_network", TEXT));
		await admin.execute(sql`UPDATE affiliation SET ended_at=clock_timestamp() WHERE id=${affiliation}::uuid`);
		await assertMarkedBlank(ended, await create(ended));
	});

	test("DOC-020: the text is read at creation only; a later change reaches only a later document", async () => {
		const who = await plantWithOwner("Changing Plant");
		const network = await organization("sending_network", TEXT);
		await affiliate(who.plant, network);
		const first = await create(who);
		await setStatement(network, "Our newer words.");
		const second = await create(who);

		assert.deepEqual(keyedSlot(await current(who, first.id)).content, PARAGRAPHS, "the first keeps the earlier text");
		assert.deepEqual(keyedSlot(await revisionOne(who, first.id)).content, PARAGRAPHS);
		await assertNetworkText(who, first.id);
		for (const text of await exportsOf(who, first.id)) assert.equal(text.includes("Our newer words."), false);

		assert.deepEqual(keyedSlot(second.body).content, [para("Our newer words.")]);
		await assertNetworkText(who, second.id, [para("Our newer words.")]);
	});

	test("DOC-020, D-108: with two active networks, the earliest-accepted one with a statement fills the slot", async () => {
		const who = await plantWithOwner("Two Networks");
		const earlier = await organization("sending_network");
		const later = await organization("sending_network", "The later network's words.");
		await affiliate(who.plant, earlier, "2026-01-01T00:00:00Z");
		await affiliate(who.plant, later, "2026-03-01T00:00:00Z");
		// A sending church affiliation never fills it.
		await affiliate(who.plant, await organization("sending_church"), "2025-01-01T00:00:00Z");

		assert.deepEqual(keyedSlot((await create(who)).body).content, [para("The later network's words.")]);
		await setStatement(earlier, "The earlier network's words.");
		assert.deepEqual(keyedSlot((await create(who)).body).content, [para("The earlier network's words.")]);
	});

	test("DOC-020, D-106: only a slot keyed statement-of-faith is filled; saveNative keeps the key", async () => {
		const who = await plantWithOwner("Mixed Plant");
		await affiliate(who.plant, await organization("sending_network", TEXT));
		const doc = await create(who, MIXED);
		assert.deepEqual(slotsOf(doc.body), [
			{ type: "slot", attrs: { label: LABEL, key: "statement-of-faith" }, content: PARAGRAPHS },
			{ type: "slot", attrs: { label: "Doctrinal notes" }, content: [] },
			{ type: "slot", attrs: { label: "Vision", key: "vision" }, content: [para(AUTHORED)] },
		]);

		// A plain save round trip: the key attr comes back as stored, on revision 2.
		const body = structuredClone(doc.body);
		body.body.content.push(para("A closing line the church adds."));
		const saved = ok(
			await documentsWriter.saveNative(db, await who.authority(), {
				documentId: doc.id,
				expectedRevision: doc.revision,
				body,
			}),
		);
		assert.equal(saved.revision, "2");
		assert.deepEqual(slotsOf(await current(who, doc.id)), slotsOf(doc.body));
	});
});

// ---------------------------------------------------------------- preview and "Save for your church" (T-85)

/** The Bylaws preview's PDF text, as `documents.preview` returns it. */
async function previewText(who) {
	const value = ok(await documentsReader.preview(db, await who.authority(), { templateId: BYLAWS, format: "pdf" }));
	assert.ok(value.artifact, "a preview artifact");
	return (await pdfPages(Buffer.from(value.artifact, "base64"))).join(" ");
}
/** The file `documents.generate` stored for Bylaws on this key, as PDF text, and its record id. */
async function savedText(who, requestKey = randomUUID()) {
	const generated = ok(
		await documentsWriter.generate(
			db,
			await who.authority(),
			{ templateId: BYLAWS, format: "pdf", requestKey },
			storage,
		),
	);
	return { id: generated.id, text: await storedPdfText(generated.id) };
}
async function storedPdfText(generatedId) {
	const [file] = (
		await admin.execute(
			sql`SELECT f.opaque_key FROM generated_document g JOIN file_object f ON f.id = g.object_id WHERE g.id = ${generatedId}::uuid`,
		)
	).rows;
	const bytes = client.objects.get(file.opaque_key);
	assert.ok(bytes, "the bytes are in private storage");
	return (await pdfPages(bytes)).join(" ");
}
/** The statement-of-faith section: what prints after the slot's label and before the next heading, "Members". */
function sectionOf(text) {
	const end = text.search(/\bMembers\b/);
	assert.ok(end > 0, "the heading after the section");
	const head = text.slice(0, end);
	const labels = [...head.matchAll(/statement of faith/gi)];
	assert.ok(labels.length, "the slot's label");
	const last = labels.at(-1);
	return head
		.slice(last.index + last[0].length)
		.replace(/\s*\d+\.?\s*$/, "")
		.trim();
}
const wordsOf = (paragraphs) =>
	paragraphs.flatMap((p) => p.content.filter((n) => n.type === "text").map((n) => n.text)).join(" ");
function assertSectionHolds(text, paragraphs = PARAGRAPHS) {
	assert.equal(sectionOf(text), wordsOf(paragraphs), "the network's exact text, block by block, under the label");
	assert.equal(text.includes(SLOT_BLANK_NOTE), false, "no marked blank");
}
function assertSectionBlank(text) {
	assert.equal(sectionOf(text), SLOT_BLANK_NOTE, "the marked blank");
	assert.equal(DOCTRINAL.test(text), false, `doctrinal words: ${DOCTRINAL.exec(text)?.[0]}`);
	assert.equal(text.includes("network's own"), false);
}

describe("DOC-020 network text in a Bylaws preview and a saved file", { concurrency: 1 }, () => {
	test("AC:CASE-DOC-020 network-fills-preview: preview and the saved file print the network's text in the section", async () => {
		const who = await plantWithOwner("Preview Plant");
		await affiliate(who.plant, await organization("sending_network", TEXT));
		assertSectionHolds(await previewText(who));
		assertSectionHolds((await savedText(who)).text);
	});

	test("DOC-020: the preview's section text equals the PDF export of revision 1 of a document made from Bylaws", async () => {
		const who = await plantWithOwner("Parity Plant");
		await affiliate(who.plant, await organization("sending_network", TEXT));
		const preview = sectionOf(await previewText(who));
		const [exported] = await exportsOf(who, (await create(who)).id);
		assert.equal(preview, wordsOf(PARAGRAPHS));
		assert.equal(preview, sectionOf(exported));
	});

	test("AC:CASE-DOC-020: a plant with no network previews and saves the marked blank, with no doctrinal words", async () => {
		const who = await plantWithOwner("Blank Preview Plant");
		assertSectionBlank(await previewText(who));
		assertSectionBlank((await savedText(who)).text);
	});

	test("DOC-020: an unset, a cleared or an ended network statement previews and saves the marked blank", async () => {
		const unset = await plantWithOwner("Unset Preview Plant");
		await affiliate(unset.plant, await organization("sending_network"));

		const cleared = await plantWithOwner("Cleared Preview Plant");
		const network = await organization("sending_network", TEXT);
		await affiliate(cleared.plant, network);
		await setStatement(network, null);

		const ended = await plantWithOwner("Ended Preview Plant");
		const affiliation = await affiliate(ended.plant, await organization("sending_network", TEXT));
		await admin.execute(sql`UPDATE affiliation SET ended_at=clock_timestamp() WHERE id=${affiliation}::uuid`);

		for (const who of [unset, cleared, ended]) {
			assertSectionBlank(await previewText(who));
			assertSectionBlank((await savedText(who)).text);
		}
	});

	test("DOC-020, D-108: with two active networks, the earliest-accepted one with a statement fills preview and save", async () => {
		const who = await plantWithOwner("Two Networks Preview");
		const earlier = await organization("sending_network");
		const later = await organization("sending_network", "The later network's words.");
		await affiliate(who.plant, earlier, "2026-01-01T00:00:00Z");
		await affiliate(who.plant, later, "2026-03-01T00:00:00Z");
		await affiliate(who.plant, await organization("sending_church"), "2025-01-01T00:00:00Z");

		const laterOnly = [para("The later network's words.")];
		assertSectionHolds(await previewText(who), laterOnly);
		assertSectionHolds((await savedText(who)).text, laterOnly);
		await setStatement(earlier, "The earlier network's words.");
		const earlierOnly = [para("The earlier network's words.")];
		assertSectionHolds(await previewText(who), earlierOnly);
		assertSectionHolds((await savedText(who)).text, earlierOnly);
	});

	test("DOC-020, D-109, D-418: the text is read when the action runs; a replay on the same key returns the earlier file", async () => {
		const who = await plantWithOwner("Changing Preview Plant");
		const network = await organization("sending_network", TEXT);
		await affiliate(who.plant, network);
		const key = randomUUID();
		const first = await savedText(who, key);
		assertSectionHolds(first.text);

		await setStatement(network, "Our newer words.");
		const newer = [para("Our newer words.")];
		assertSectionHolds(await previewText(who), newer);
		const second = await savedText(who);
		assertSectionHolds(second.text, newer);
		assert.notEqual(second.id, first.id);

		const replay = await savedText(who, key);
		assert.equal(replay.id, first.id, "the same key returns the earlier file");
		assertSectionHolds(replay.text);
		assertSectionHolds(await storedPdfText(first.id));
		const [{ inputs }] = (await admin.execute(sql`SELECT inputs FROM generated_document WHERE id = ${first.id}::uuid`))
			.rows;
		assert.equal(JSON.stringify(inputs).includes("network's own"), false, "the statement is not an input");
	});
});
