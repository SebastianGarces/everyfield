// T-80 "Compare with template" for a document made from the church's own saved template (T-18): the compare names
// the church template, says it is the church's own and accepts changes as one revision recording its current version.
// Version 2 of the church template exists only in this file: it is written through "Update a church template" (T-79)
// from a test document. No built-in template file changes. Runs on a fresh schema of the shared development database.
//   Criterion 1: the editor read says "behind" when the church template changed, "current" when it matches.
//   Criterion 2: a deleted paragraph, a reworded heading and a new margin are each listed once; the name shows.
//   Criterion 3: a fresh document has no differences.
//   Criteria 4, 5, 6, 12: accepting some changes of version 2 writes one revision with the exact body and origin; a
//     new field prints the church's value or the template's fallback; accept all gives version 2's body.
//   Criterion 7: the legal notice is never a difference, and accept all keeps it in the PDF and the Word file.
//   Criterion 8: an accept after another save, or after the church template changed, is a conflict and writes nothing.
//   Criterion 9: a deleted church template offers no compare; the document still opens, saves and exports.
//   Criterion 10: a Member, another church's seat and a forged origin are refused, write nothing and reveal nothing.
import { fixture, ok, refused } from "../../support/fixture.mts";
import { sql } from "../../../packages/db/node_modules/drizzle-orm/index.js";
import { RequestActor } from "../../../packages/domain/src/access/session.ts";
import { documentsWriter } from "../../../packages/domain/src/documents/index.ts";
import { LEGAL_NOTICE, docTemplate, templateHash } from "../../../packages/contracts/src/documents/index.ts";
import { pdfPages, docxParts, wordText } from "./fixtures/readers.mts";
import test, { after, before, describe } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

const POLICY = "conflict-of-interest-policy";
const para = (text) => ({ type: "paragraph", content: [{ type: "text", text }] });
const shape = (differences) => differences.map((d) => [d.id, d.part, d.kind]);

const database = await fixture({ prefix: "t80cmp", plant: { name: "Harvest Point" } });
const { admin, schema } = database;
const db = database.pools.runtime;
const P = database.tenant.id;
const Q = (await database.plant({ name: "Other Church", timezone: "America/New_York" })).id;
const actors = [
	database.actors.owner,
	database.actors.member,
	database.actors.admin,
	await database.actor({ kind: "plant", id: Q }, "admin"),
];
const OWNER = 0;
const MEMBER = 1;
const ADMIN = 2;
const OTHER = 3;

const authority = async (who) => {
	const actor = await RequestActor.resolve(db, actors[who].session);
	assert.ok(actor instanceof RequestActor, JSON.stringify(actor));
	return actor;
};
const create = async (who, templateId) =>
	ok(await documentsWriter.createFromTemplate(db, await authority(who), { templateId, requestKey: randomUUID() }));
const save = async (who, documentId, expectedRevision, body) =>
	documentsWriter.saveNative(db, await authority(who), { documentId, expectedRevision, body });
const compare = async (who, documentId) =>
	documentsWriter.readTemplateCompare(db, await authority(who), { documentId });
const accept = async (who, request) => documentsWriter.acceptTemplateChanges(db, await authority(who), request);
const status = async (who, documentId) =>
	ok(await documentsWriter.readChurchForEdit(db, await authority(who), { documentId })).template;
const history = async (who, documentId) =>
	ok(await documentsWriter["history.list"](db, await authority(who), { documentId }));
const revisionBody = async (documentId, revision) =>
	ok(await documentsWriter["history.get"](db, await authority(MEMBER), { documentId, revision })).body;
const file = async (who, documentId, format, revision?) =>
	ok(
		await documentsWriter.readChurchFile(
			db,
			await authority(who),
			{ documentId, format, ...(revision ? { revision } : {}) },
			null,
		),
	);
const pdfText = async (f) => (await pdfPages(Buffer.from(f.bytes, "base64"))).join(" ").replace(/\s+/g, " ");
/** The words of the Word file: its body, headers and footers. */
const docxText = (f) =>
	Object.entries(docxParts(Buffer.from(f.bytes, "base64")))
		.filter(([name]) => /^word\/(document|header\d*|footer\d*)\.xml$/.test(name))
		.map(([, xml]) => wordText(xml))
		.join(" ");
const countOf = async (table, where = "") =>
	Number((await admin.execute(sql.raw(`SELECT count(*)::int AS n FROM ${table} ${where}`))).rows[0].n);
const counts = async () => ({
	documents: await countOf("document"),
	revisions: await countOf("document_revision"),
	audits: await countOf("audit_event"),
});

/** A church template saved from a fresh copy of the built-in policy, as "Save as template" makes it. */
async function churchTemplate(who, name) {
	const base = await create(who, POLICY);
	return ok(
		await documentsWriter.saveChurchTemplate(db, await authority(who), {
			documentId: base.id,
			revision: 1,
			name,
			description: "",
			requestKey: randomUUID(),
		}),
	);
}
/** The church template's current version, as stored. */
const storedTemplate = async (recordId) =>
	docTemplate.parse(
		JSON.parse(
			(
				await admin.execute(
					sql`SELECT r.body FROM document t JOIN document_revision r ON r.id = t.current_revision_id
					WHERE t.id = ${recordId}::uuid`,
				)
			).rows[0].body,
		),
	);

/**
 * The test-only version 2 of a church template, written through "Update a church template" from a document made from
 * it: block 4 ("Purpose") is reworded, block 5 (its paragraph) is gone, and a new paragraph after block 7 prints a
 * field the version 1 document does not have.
 */
async function versionTwo(template) {
	const doc = await create(OWNER, template.templateId);
	const body = structuredClone(doc.body);
	body.fields.push({
		key: "pastor_name",
		label: "Pastor",
		type: "text",
		source: "church.pastor",
		fallback: "our pastor",
	});
	const blocks = body.body.content;
	blocks[4] = { ...blocks[4], content: [{ type: "text", text: "Why this policy exists" }] };
	blocks.splice(7, 0, {
		type: "paragraph",
		content: [
			{ type: "text", text: "Questions go to " },
			{ type: "field", attrs: { key: "pastor_name" } },
			{ type: "text", text: "." },
		],
	});
	blocks.splice(5, 1);
	const saved = ok(await save(OWNER, doc.id, "1", body));
	const updated = ok(
		await documentsWriter.updateChurchTemplate(db, await authority(OWNER), {
			templateId: template.id,
			expectedVersion: 1,
			documentId: doc.id,
			revision: Number(saved.revision),
			requestKey: randomUUID(),
		}),
	);
	assert.equal(updated.version, 2);
	return storedTemplate(template.id);
}

before(async () => {
	// Harvest Point has a senior pastor, so the pastor field prints the church's value; Other Church has none.
	const pastor = randomUUID();
	const team = randomUUID();
	const role = randomUUID();
	await admin.execute(
		sql`INSERT INTO person(id,tenant_id,plant_id,display_name,source,stage,adult_classification,commitment_state,pipeline_position,state,created_at)
			VALUES(${pastor},${P},${P},'Pastor Ada','other','leader','adult','unknown',0,'live',clock_timestamp())`,
	);
	await admin.execute(
		sql`INSERT INTO team(id,plant_id,name,state,sort_order) VALUES(${team},${P},'Leadership','active',0)`,
	);
	await admin.execute(
		sql`INSERT INTO team_role(id,plant_id,team_id,name,leadership,sort_order,template_key) VALUES(${role},${P},${team},'Senior Pastor',true,0,'senior_pastor')`,
	);
	await admin.execute(
		sql`INSERT INTO team_tenure(plant_id,role_id,person_id,started_on) VALUES(${P},${role},${pastor},'2026-01-01')`,
	);
});
after(async () => {
	await database.close();
});

describe("T-80 compare a document with the church's own template", { concurrency: 1 }, () => {
	test("criteria 1, 3: a fresh document matches its church template; the compare names it as the church's own", async () => {
		const template = await churchTemplate(ADMIN, "Board policy");
		const doc = await create(ADMIN, template.templateId);
		assert.equal(doc.body.origin.template, template.templateId);
		assert.equal(await status(ADMIN, doc.id), "current");
		const found = ok(await compare(ADMIN, doc.id));
		assert.equal(found.templateTitle, "Board policy");
		assert.equal(found.churchTemplate, true);
		assert.equal(found.templateVersion, 1);
		assert.equal(found.behind, false);
		assert.deepEqual(found.differences, []);
		// A rename shows in the compare: the name is the template row's (D-171).
		ok(
			await documentsWriter.editChurchTemplate(db, await authority(ADMIN), {
				templateId: template.id,
				name: "Board conflict policy",
				description: "",
				requestKey: randomUUID(),
			}),
		);
		assert.equal(ok(await compare(ADMIN, doc.id)).templateTitle, "Board conflict policy");
		// A built-in template is not the church's own.
		const builtIn = ok(await compare(ADMIN, (await create(ADMIN, POLICY)).id));
		assert.equal(builtIn.churchTemplate, false);
	});

	test("criterion 2: a deleted paragraph, a reworded heading and a new margin are each listed once, in reading order", async () => {
		const template = await churchTemplate(OWNER, "Margins policy");
		const v1 = await storedTemplate(template.id);
		const doc = await create(OWNER, template.templateId);
		const edited = structuredClone(doc.body);
		edited.page.margin.left = 72;
		edited.body.content[4] = { ...edited.body.content[4], content: [{ type: "text", text: "Our purpose" }] };
		edited.body.content.splice(7, 1);
		ok(await save(OWNER, doc.id, "1", edited));
		const found = ok(await compare(OWNER, doc.id));
		assert.equal(found.templateTitle, "Margins policy");
		assert.equal(found.churchTemplate, true);
		assert.deepEqual(shape(found.differences), [
			[0, "page", "changed"],
			[1, "body", "changed"],
			[2, "body", "template-only"],
		]);
		assert.equal(found.differences[0].document.margin.left, 72);
		assert.equal(found.differences[0].template.margin.left, v1.page.margin.left);
		assert.equal(found.differences[1].document.content[0].text, "Our purpose");
		assert.equal(found.differences[1].template.content[0].text, "Purpose");
		assert.deepEqual(found.differences[2].template, v1.body.content[7]);
	});

	test("AC:DOC-COMPARE-CHURCH criteria 1, 4, 5, 6, 12: accepting some changes of version 2 writes one revision with the exact body and origin", async () => {
		const template = await churchTemplate(OWNER, "Our conflict policy");
		const doc = await create(ADMIN, template.templateId);
		const other = await create(ADMIN, template.templateId);
		// The church's own edit on the document: its lead paragraph.
		const edited = structuredClone(doc.body);
		edited.body.content[3] = para("Our board keeps this policy so every decision serves the church.");
		const r2 = ok(await save(ADMIN, doc.id, "1", edited));
		const rev1Pdf = await file(MEMBER, doc.id, "pdf", 1);
		const rev2Body = await revisionBody(doc.id, 2);

		const v2 = await versionTwo(template);
		assert.equal(v2.version, 2);
		assert.equal(await status(ADMIN, doc.id), "behind", "the church template changed after the document was made");

		const found = ok(await compare(ADMIN, doc.id));
		assert.equal(found.behind, true);
		assert.equal(found.churchTemplate, true);
		assert.equal(found.templateTitle, "Our conflict policy");
		assert.equal(found.templateVersion, 2);
		assert.equal(found.templateHash, await templateHash(v2));
		assert.deepEqual(shape(found.differences), [
			[0, "body", "changed"],
			[1, "body", "changed"],
			[2, "body", "document-only"],
			[3, "body", "template-only"],
		]);
		assert.equal(found.differences[1].template.content[0].text, "Why this policy exists");
		// The new field shows what it would print: the church's pastor, never a raw key or a blank.
		assert.equal(found.values.pastor_name, "Pastor Ada");
		assert.equal(found.values.church_name, "Harvest Point");

		const before = await counts();
		const accepted = ok(
			await accept(ADMIN, {
				documentId: doc.id,
				expectedRevision: "2",
				templateHash: found.templateHash,
				view: "all",
				key: found.keys.all,
				accept: [1, 2, 3],
			}),
		);
		assert.deepEqual(await counts(), { ...before, revisions: before.revisions + 1, audits: before.audits + 1 });
		assert.equal(accepted.revision, "3");
		assert.equal(accepted.templateVersion, 2);
		// The document's own lead paragraph stays; the reworded heading, the removal and the new paragraph come in.
		const expected = structuredClone(r2.body.body.content);
		expected[4] = v2.body.content[4];
		expected.splice(7, 0, v2.body.content[6]);
		expected.splice(5, 1);
		assert.deepEqual(accepted.body.body.content, expected, "only the accepted blocks take the template's version");
		assert.deepEqual(accepted.body.origin, { template: template.templateId, version: 2, hash: await templateHash(v2) });
		assert.deepEqual(
			accepted.body.fields.map((f) => f.key),
			["church_name", "church_legal_name", "pastor_name"],
		);
		assert.equal(accepted.body.data.pastor_name, "Pastor Ada");
		assert.equal(await status(ADMIN, doc.id), "current", "the notice is gone");

		// Exactly one new revision; the earlier ones are unchanged and still render the same file.
		assert.deepEqual(
			(await history(MEMBER, doc.id)).revisions.map((r) => r.number),
			[1, 2, 3],
		);
		assert.deepEqual(await revisionBody(doc.id, 1), doc.body);
		assert.deepEqual(await revisionBody(doc.id, 2), rev2Body);
		assert.equal((await file(MEMBER, doc.id, "pdf", 1)).digest, rev1Pdf.digest);
		const pdf = await pdfText(await file(MEMBER, doc.id, "pdf"));
		const word = docxText(await file(MEMBER, doc.id, "docx"));
		for (const text of [pdf, word]) {
			assert.ok(text.includes("Why this policy exists"), "the accepted heading prints");
			assert.ok(text.includes("Questions go to Pastor Ada."), "the new field prints the church's value");
			assert.ok(text.includes("Our board keeps this policy"), "the kept edit prints");
			assert.ok(!text.includes("pastor_name"), "no raw key prints");
		}
		// The kept edit is still a difference; nothing else is.
		assert.deepEqual(shape(ok(await compare(ADMIN, doc.id)).differences), [[0, "body", "changed"]]);

		// Accept all on another document gives version 2's body.
		const otherFound = ok(await compare(OWNER, other.id));
		const all = ok(
			await accept(OWNER, {
				documentId: other.id,
				expectedRevision: "1",
				templateHash: otherFound.templateHash,
				view: "all",
				key: otherFound.keys.all,
				accept: "all",
			}),
		);
		assert.equal(all.revision, "2");
		assert.deepEqual(all.body.body, v2.body);
		assert.deepEqual(ok(await compare(OWNER, other.id)).differences, []);
	});

	test("criterion 6: a church with no value for a new field prints the template's fallback; a value is not a difference", async () => {
		const template = await churchTemplate(OTHER, "Other policy");
		const doc = await create(OTHER, template.templateId);
		// Other Church's details change: a frozen value that differs is not a difference.
		await admin.execute(sql`UPDATE plant SET name = 'Other Church Renamed' WHERE id = ${Q}::uuid`);
		assert.deepEqual(ok(await compare(OTHER, doc.id)).differences, []);
		// Version 2, written by Other Church's admin from its own document.
		const source = await create(OTHER, template.templateId);
		const body = structuredClone(source.body);
		body.fields.push({
			key: "pastor_name",
			label: "Pastor",
			type: "text",
			source: "church.pastor",
			fallback: "our pastor",
		});
		body.body.content.push({
			type: "paragraph",
			content: [
				{ type: "text", text: "Questions go to " },
				{ type: "field", attrs: { key: "pastor_name" } },
			],
		});
		const saved = ok(await save(OTHER, source.id, "1", body));
		ok(
			await documentsWriter.updateChurchTemplate(db, await authority(OTHER), {
				templateId: template.id,
				expectedVersion: 1,
				documentId: source.id,
				revision: Number(saved.revision),
				requestKey: randomUUID(),
			}),
		);
		const found = ok(await compare(OTHER, doc.id));
		assert.deepEqual(shape(found.differences), [[0, "body", "template-only"]]);
		assert.equal(found.values.pastor_name, "our pastor");
		const accepted = ok(
			await accept(OTHER, {
				documentId: doc.id,
				expectedRevision: "1",
				templateHash: found.templateHash,
				view: "all",
				key: found.keys.all,
				accept: "all",
			}),
		);
		assert.equal(accepted.body.data.pastor_name, "our pastor");
		assert.ok((await pdfText(await file(OTHER, doc.id, "pdf"))).includes("Questions go to our pastor"));
	});

	test("criterion 7: after Delete all content, the legal notice is never a difference and accept all keeps it", async () => {
		const template = await churchTemplate(ADMIN, "Legal policy");
		assert.equal(template.documentClass, "formal/legal");
		const v1 = await storedTemplate(template.id);
		const doc = await create(ADMIN, template.templateId);
		const emptied = structuredClone(doc.body);
		emptied.body = { type: "doc" };
		emptied.page.header = null;
		emptied.page.footer = null;
		ok(await save(ADMIN, doc.id, "1", emptied));
		const found = ok(await compare(ADMIN, doc.id));
		assert.ok(found.differences.length > 0);
		assert.ok(found.differences.every((d) => d.kind === "template-only"));
		assert.ok(!JSON.stringify(found.differences).includes(LEGAL_NOTICE));
		const accepted = ok(
			await accept(ADMIN, {
				documentId: doc.id,
				expectedRevision: "2",
				templateHash: found.templateHash,
				view: "all",
				key: found.keys.all,
				accept: "all",
			}),
		);
		assert.equal(accepted.documentClass, "formal/legal");
		assert.deepEqual(accepted.body.body, v1.body);
		assert.deepEqual(ok(await compare(ADMIN, doc.id)).differences, []);
		assert.ok((await pdfText(await file(ADMIN, doc.id, "pdf"))).includes(LEGAL_NOTICE));
		assert.ok(docxText(await file(ADMIN, doc.id, "docx")).includes(LEGAL_NOTICE));
	});

	test("criterion 8: an accept after another save, or after the church template changed, is a conflict and writes nothing", async () => {
		const template = await churchTemplate(OWNER, "Conflict policy");
		const doc = await create(ADMIN, template.templateId);
		const edited = structuredClone(doc.body);
		edited.body.content.splice(5, 1);
		ok(await save(ADMIN, doc.id, "1", edited));
		const found = ok(await compare(ADMIN, doc.id));
		// Another tab saves revision 3 after the compare opened.
		ok(await save(OWNER, doc.id, "2", { ...edited, title: "Saved elsewhere" }));
		const request = {
			documentId: doc.id,
			expectedRevision: "2",
			templateHash: found.templateHash,
			view: "all",
			key: found.keys.all,
			accept: [0],
		};
		let before = await counts();
		refused(await accept(ADMIN, request), "conflict");
		assert.deepEqual(await counts(), before);
		// The compare reloads on revision 3; then the church template changes before the accept.
		const reloaded = ok(await compare(ADMIN, doc.id));
		assert.equal(reloaded.revision, "3");
		await versionTwo(template);
		before = await counts();
		refused(
			await accept(ADMIN, {
				...request,
				expectedRevision: "3",
				templateHash: reloaded.templateHash,
				key: reloaded.keys.all,
			}),
			"conflict",
		);
		assert.deepEqual(await counts(), before);
		assert.equal(ok(await compare(ADMIN, doc.id)).templateVersion, 2);
	});

	test("criterion 9: a deleted church template offers no compare; the document still opens, saves and exports", async () => {
		const template = await churchTemplate(OWNER, "Gone policy");
		const doc = await create(OWNER, template.templateId);
		const found = ok(await compare(OWNER, doc.id));
		ok(await documentsWriter.deleteChurchTemplate(db, await authority(OWNER), { templateId: template.id }));
		assert.equal(await status(OWNER, doc.id), null, "no notice and no Compare action");
		const before = await counts();
		refused(await compare(OWNER, doc.id), "unavailable");
		refused(
			await accept(OWNER, {
				documentId: doc.id,
				expectedRevision: "1",
				templateHash: found.templateHash,
				view: "all",
				key: found.keys.all,
				accept: "all",
			}),
			"unavailable",
		);
		assert.deepEqual(await counts(), before);
		const opened = ok(await documentsWriter.readChurch(db, await authority(MEMBER), { documentId: doc.id }));
		assert.equal(opened.templateName, "Gone policy");
		const saved = ok(await save(OWNER, doc.id, "1", { ...doc.body, title: "Still mine" }));
		assert.equal(saved.revision, "2");
		assert.ok((await pdfText(await file(OWNER, doc.id, "pdf"))).includes("Conflict of Interest Policy"));
		assert.ok(docxText(await file(OWNER, doc.id, "docx")).length > 0);
	});

	test("AC:DOC-COMPARE-CHURCH-MEMBER criterion 10: a Member, another church's seat and a forged origin are refused, write nothing and reveal nothing", async () => {
		const template = await churchTemplate(OWNER, "Private board policy");
		const doc = await create(OWNER, template.templateId);
		const found = ok(await compare(OWNER, doc.id));
		const request = {
			documentId: doc.id,
			expectedRevision: "1",
			templateHash: found.templateHash,
			view: "all",
			key: found.keys.all,
			accept: "all",
		};
		const before = await counts();

		// A Member: no editor read (so no notice), no compare, no accept.
		refused(
			await documentsWriter.readChurchForEdit(db, await authority(MEMBER), { documentId: doc.id }),
			"access_denied",
		);
		refused(await compare(MEMBER, doc.id), "access_denied");
		refused(await accept(MEMBER, request), "access_denied");
		// Another church plant's Admin naming this church's document.
		const theirs = [await compare(OTHER, doc.id), await accept(OTHER, request)];
		for (const reply of theirs) {
			refused(reply, "unavailable");
			assert.ok(!JSON.stringify(reply).includes("Private board policy"), "another church's template is never named");
		}
		assert.deepEqual(await counts(), before);

		// Another church's document whose origin names this church's template: nothing to compare with.
		const own = await create(OTHER, POLICY);
		const forged = ok(
			await save(OTHER, own.id, "1", { ...own.body, origin: { ...own.body.origin, template: template.templateId } }),
		);
		assert.equal(await status(OTHER, own.id), null);
		const forgedBefore = await counts();
		for (const reply of [
			await compare(OTHER, own.id),
			await accept(OTHER, {
				documentId: own.id,
				expectedRevision: forged.revision,
				templateHash: found.templateHash,
				view: "all",
				key: found.keys.all,
				accept: "all",
			}),
		]) {
			refused(reply, "unavailable");
			assert.ok(!JSON.stringify(reply).includes("Private board policy"));
		}
		assert.deepEqual(await counts(), forgedBefore);
	});
});
