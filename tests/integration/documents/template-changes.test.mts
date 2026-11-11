// T-81 "Template changes" (D-423): a three-way compare of a Church Document with its template that lists only what
// the template changed between the version the document records (the base, D-422) and the current one, and accepting
// some of those changes as one revision. Version 2 of the built-in policy exists only in this file (no repo template
// file changes); the church template's versions 2 and 3 are written through "Update a church template" (T-79). Runs
// on a fresh schema of the shared development database.
//   Criterion 2: a v1 document lists exactly the title, page setup, header and body blocks v2 added, removed or reworded.
//   Criterion 3: the church's edits to blocks the template did not change are not listed.
//   Criterion 4: both changed is one item; a change the document already removed or already has is not listed.
//   Criterion 6: accepting one item, then Accept all on another document, gives the exact body.
//   Criterion 7: one revision recording v2; the next compare's base is v2, declined changes stay in All differences.
//   Criterion 8: no "behind" when every change since the base is in the document; "behind" when one is missing.
//   Criterion 9: a base that is not stored gives only All differences, and accept works from it.
//   Criterion 10: a church template updated twice compares its stored v1 with v3; another plant's offers no compare.
//   Criterion 11: on a policy, the legal notice is never listed or removed; a new field prints a value or fallback.
//   Criterion 12: a stale compare and a key from the other list are conflicts and write nothing.
//   Criterion 13: a Member is refused both operations.
import { testDatabase } from "../../support/test-database.mts";
import { sql } from "../../../packages/db/node_modules/drizzle-orm/index.js";
import { RequestActor } from "../../../packages/domain/src/access/session.ts";
import { documentsWriter, templateStatus } from "../../../packages/domain/src/documents/index.ts";
import { docTemplateById, publishedTemplate } from "../../../packages/domain/src/documents/doc-templates.ts";
import { LEGAL_NOTICE, docTemplate, templateHash } from "../../../packages/contracts/src/documents/index.ts";
import { pdfPages } from "./fixtures/readers.mts";
import test, { after, before, describe } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

const POLICY = "conflict-of-interest-policy";
const v1 = docTemplateById(POLICY)!;
const B = v1.body.content!;
const para = (text) => ({ type: "paragraph", content: [{ type: "text", text }] });
const shape = (items) => items.map((d) => [d.id, d.part, d.kind]);
const ASK = {
	type: "paragraph",
	content: [
		{ type: "text", text: "Questions go to " },
		{ type: "field", attrs: { key: "pastor_name" } },
		{ type: "text", text: "." },
	],
};
const PASTOR = { key: "pastor_name", label: "Pastor", type: "text", source: "church.pastor", fallback: "our pastor" };
const HEADING_4 = { ...B[4], content: [{ type: "text", text: "Why this policy exists" }] };
const PARA_12 = para("A board member with a personal interest in a decision tells the board in writing.");

/**
 * The test-only version 2 of the built-in policy: a new title, a wider top margin, a header, block 4 reworded, block 5
 * and block 22 removed, a new paragraph after block 7 that prints a new field, and block 12 reworded.
 */
function versionTwo() {
	const v2 = structuredClone(v1);
	v2.version = 2;
	v2.title = "Conflict of Interest and Disclosure Policy";
	v2.page.margin.top = v1.page.margin.top + 18;
	v2.page.header = { pages: "all", content: [para("Board copy")] };
	v2.fields.push(PASTOR);
	v2.body.content = B.flatMap((block, i) =>
		i === 4 ? [HEADING_4] : i === 5 || i === 22 ? [] : i === 7 ? [block, ASK] : i === 12 ? [PARA_12] : [block],
	);
	return docTemplate.parse(v2);
}
const v2 = versionTwo();
/** The built-in templates with v2 as the policy's current version, published beside the stored v1. */
const sources = async (current = v2) => {
	const hash = await templateHash(current);
	return {
		current: (id) => (id === POLICY ? current : docTemplateById(id)),
		published: (id, h) => (id === POLICY && h === hash ? current : publishedTemplate(id, h)),
	};
};
/** What v2 changed from v1, in reading order, as Template changes lists it for a document that has v1's content. */
const V2_CHANGES = [
	[0, "title", "changed"],
	[1, "page", "changed"],
	[2, "header", "template-only"],
	[3, "body", "changed"],
	[4, "body", "removed"],
	[5, "body", "template-only"],
	[6, "body", "changed"],
	[7, "body", "removed"],
];
/** The church's three edits to blocks v2 did not change: block 9 reworded, block 18 deleted, one paragraph added. */
const OWN_9 = para("A board member has an interest when a decision could help them or their family.");
const OWN_END = para("Our own closing line.");
function ownEdits(body) {
	const edited = structuredClone(body);
	const blocks = edited.body.content;
	blocks[9] = OWN_9;
	blocks.splice(18, 1);
	blocks.push(OWN_END);
	return edited;
}

const database = await testDatabase({ prefix: "t81chg" });
const { admin, schema } = database;
const db = database.pools.runtime;
const P = randomUUID();
const Q = randomUUID();
const actors = Array.from({ length: 4 }, () => ({ id: randomUUID(), user: randomUUID(), session: randomUUID() }));
const OWNER = 0;
const MEMBER = 1;
const ADMIN = 2;
const OTHER = 3;

const ok = (result) => {
	assert.equal(result.status, "ok", JSON.stringify(result.status === "refused" ? result.error : result.status));
	return result.value;
};
const refused = (result, code) => {
	assert.equal(result.status, "refused", JSON.stringify(result));
	assert.equal(result.error.code, code, JSON.stringify(result.error));
	return result.error;
};
const authority = async (who) => {
	const actor = await RequestActor.resolve(db, actors[who].session);
	assert.ok(actor instanceof RequestActor, JSON.stringify(actor));
	return actor;
};
const create = async (who, templateId) =>
	ok(await documentsWriter.createFromTemplate(db, await authority(who), { templateId, requestKey: randomUUID() }));
const save = async (who, documentId, expectedRevision, body) =>
	documentsWriter.saveNative(db, await authority(who), { documentId, expectedRevision, body });
const compare = async (who, documentId, templates?) =>
	documentsWriter.readTemplateCompare(db, await authority(who), { documentId }, templates);
const accept = async (who, request, templates?) =>
	documentsWriter.acceptTemplateChanges(db, await authority(who), request, templates);
/** An accept of items from the list `view` of a compare. */
const acceptFrom = async (who, found, view, items, templates?) =>
	accept(
		who,
		{
			documentId: found.documentId,
			expectedRevision: found.revision,
			templateHash: found.templateHash,
			view,
			key: found.keys[view],
			accept: items,
		},
		templates,
	);
const status = async (who, documentId) =>
	ok(await documentsWriter.readChurchForEdit(db, await authority(who), { documentId })).template;
const history = async (who, documentId) =>
	ok(await documentsWriter["history.list"](db, await authority(who), { documentId }));
const revisionBody = async (documentId, revision) =>
	ok(await documentsWriter["history.get"](db, await authority(MEMBER), { documentId, revision })).body;
const pdfText = async (who, documentId) => {
	const f = ok(await documentsWriter.readChurchFile(db, await authority(who), { documentId, format: "pdf" }, null));
	return (await pdfPages(Buffer.from(f.bytes, "base64"))).join(" ").replace(/\s+/g, " ");
};
const revisionCount = async (id) =>
	Number(
		(await admin.execute(sql`SELECT count(*)::int AS n FROM document_revision WHERE document_id = ${id}::uuid`)).rows[0]
			.n,
	);
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
/** The next version of a church template, written through "Update a church template" from a document made from it. */
async function updateTemplate(template, expectedVersion, edit) {
	const doc = await create(OWNER, template.templateId);
	const body = structuredClone(doc.body);
	edit(body);
	const saved = ok(await save(OWNER, doc.id, "1", body));
	const updated = ok(
		await documentsWriter.updateChurchTemplate(db, await authority(OWNER), {
			templateId: template.id,
			expectedVersion,
			documentId: doc.id,
			revision: Number(saved.revision),
			requestKey: randomUUID(),
		}),
	);
	assert.equal(updated.version, expectedVersion + 1);
}

before(async () => {
	for (const actor of actors) {
		await admin.execute(
			sql`INSERT INTO auth_user(id,email,email_verified,name) VALUES(${actor.user},${actor.id + "@example.test"},true,'Synthetic')`,
		);
		await admin.execute(
			sql`INSERT INTO account(id,auth_user_id,registration_state,registration_kind) VALUES(${actor.id},${actor.user},'active','planter')`,
		);
		await admin.execute(
			sql`INSERT INTO auth_session(id,user_id,token,expires_at) VALUES(${actor.session},${actor.user},${randomUUID()},clock_timestamp()+interval '1 day')`,
		);
	}
	for (const [id, name, tz] of [
		[P, "Harvest Point", "America/Chicago"],
		[Q, "Other Church", "America/New_York"],
	])
		await admin.execute(
			sql`INSERT INTO plant(id,name,timezone,warning_days,alert_days,digest_weekday,digest_hour,phase,material_revision) VALUES(${id},${name},${tz},7,14,1,8,1,1)`,
		);
	for (const [index, plant, role] of [
		[OWNER, P, "owner"],
		[MEMBER, P, "member"],
		[ADMIN, P, "admin"],
		[OTHER, Q, "admin"],
	])
		await admin.execute(
			sql`INSERT INTO seat(account_id,plant_id,role,accepted_at) VALUES(${actors[index].id},${plant},${role},clock_timestamp())`,
		);
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

describe("T-81 Template changes on a Church Document", { concurrency: 1 }, () => {
	test("criterion 2: a v1 document lists exactly what v2 added, removed or reworded, each with its mark", async () => {
		const templates = await sources();
		const doc = await create(OWNER, POLICY);
		const found = ok(await compare(OWNER, doc.id, templates));
		assert.equal(found.baseVersion, 1);
		assert.equal(found.templateVersion, 2);
		assert.deepEqual(shape(found.changes), V2_CHANGES);
		const [title, page, header, heading, removed, added, reworded, removedLast] = found.changes;
		assert.deepEqual([title.document, title.template], [v1.title, v2.title]);
		assert.equal(page.document.margin.top, v1.page.margin.top);
		assert.equal(page.template.margin.top, v2.page.margin.top);
		assert.deepEqual([header.document, header.template], [null, v2.page.header]);
		assert.deepEqual([heading.document, heading.template], [B[4], HEADING_4]);
		assert.deepEqual([removed.document, removed.template], [B[5], null]);
		assert.deepEqual([added.document, added.template], [null, ASK]);
		assert.deepEqual([reworded.document, reworded.template], [B[12], PARA_12]);
		assert.deepEqual([removedLast.document, removedLast.template], [B[22], null]);
		assert.equal(await templateStatus(doc.body, templates), "behind");
	});

	test("criterion 3: blocks the church edited, added or deleted that the template did not change are not listed", async () => {
		const templates = await sources();
		const doc = await create(OWNER, POLICY);
		ok(await save(OWNER, doc.id, "1", ownEdits(doc.body)));
		const found = ok(await compare(OWNER, doc.id, templates));
		assert.deepEqual(shape(found.changes), V2_CHANGES);
		const listed = JSON.stringify(found.changes);
		for (const block of [OWN_9, OWN_END, B[9], B[18]])
			assert.ok(!listed.includes(JSON.stringify(block.content)), "an untouched block the church changed");
		// All differences still lists the church's own edits.
		assert.ok(JSON.stringify(found.differences).includes("Our own closing line."));
	});

	test("criterion 4: both changed is listed once; a change already removed or already made is not listed", async () => {
		const templates = await sources();
		const doc = await create(ADMIN, POLICY);
		const edited = structuredClone(doc.body);
		const blocks = edited.body.content;
		const own12 = para("Our board members tell the board about any interest at once.");
		const own22 = para("The board talks with the member first.");
		blocks[4] = HEADING_4; // already matches v2
		blocks[12] = own12; // v2 rewords it too
		blocks[22] = own22; // v2 removes it
		blocks.splice(5, 1); // v2 removes it too
		ok(await save(ADMIN, doc.id, "1", edited));
		const found = ok(await compare(ADMIN, doc.id, templates));
		assert.deepEqual(shape(found.changes), [
			[0, "title", "changed"],
			[1, "page", "changed"],
			[2, "header", "template-only"],
			[3, "body", "template-only"],
			[4, "body", "both"],
			[5, "body", "both"],
		]);
		assert.deepEqual([found.changes[4].document, found.changes[4].template], [own12, PARA_12]);
		assert.deepEqual([found.changes[5].document, found.changes[5].template], [own22, null]);
	});

	test("criteria 6, 7: one accepted item lands in its place; one revision records v2; declined ones move to All differences", async () => {
		const templates = await sources();
		const doc = await create(OWNER, POLICY);
		const own = ok(await save(OWNER, doc.id, "1", ownEdits(doc.body)));
		const found = ok(await compare(OWNER, doc.id, templates));
		assert.deepEqual(found.changes[5].template, ASK);
		const accepted = ok(await acceptFrom(OWNER, found, "changes", [5], templates));
		// The church's body with the new paragraph after block 7, its own place in the template.
		const expected = structuredClone(own.body.body.content);
		expected.splice(8, 0, ASK);
		assert.deepEqual(accepted.body.body.content, expected);
		assert.equal(accepted.body.title, v1.title, "the declined title keeps the church's");
		assert.deepEqual(accepted.body.page, own.body.page);
		assert.deepEqual(accepted.body.origin, { template: POLICY, version: 2, hash: await templateHash(v2) });
		assert.equal(accepted.body.data.pastor_name, "Pastor Ada");
		assert.ok((await pdfText(OWNER, doc.id)).includes("Questions go to Pastor Ada."));

		// Exactly one new revision; the earlier ones are unchanged.
		assert.deepEqual(
			(await history(MEMBER, doc.id)).revisions.map((r) => r.number),
			[1, 2, 3],
		);
		assert.deepEqual(await revisionBody(doc.id, 1), doc.body);
		assert.deepEqual(await revisionBody(doc.id, 2), own.body);

		// The next compare's base is v2: Template changes is empty, the declined changes are in All differences.
		const again = ok(await compare(OWNER, doc.id, templates));
		assert.equal(again.baseVersion, 2);
		assert.deepEqual(again.changes, []);
		assert.equal(await templateStatus(accepted.body, templates), "current");
		assert.deepEqual(shape(again.differences), [
			[0, "title", "changed"],
			[1, "page", "changed"],
			[2, "header", "template-only"],
			[3, "body", "changed"],
			[4, "body", "document-only"],
			[5, "body", "changed"],
			[6, "body", "changed"],
			[7, "body", "template-only"],
			[8, "body", "document-only"],
			[9, "body", "document-only"],
		]);
		assert.deepEqual(again.differences[5].document, OWN_9);

		// Accept all on another document keeps the church's own edits and takes every template change.
		const other = await create(OWNER, POLICY);
		ok(await save(OWNER, other.id, "1", ownEdits(other.body)));
		const all = ok(await acceptFrom(OWNER, ok(await compare(OWNER, other.id, templates)), "changes", "all", templates));
		const want = B.flatMap((block, i) =>
			i === 4
				? [HEADING_4]
				: i === 5 || i === 22 || i === 18
					? []
					: i === 7
						? [block, ASK]
						: i === 9
							? [OWN_9]
							: i === 12
								? [PARA_12]
								: [block],
		);
		want.push(OWN_END);
		assert.deepEqual(all.body.body.content, want);
		assert.equal(all.body.title, v2.title);
		assert.deepEqual(all.body.page, v2.page);
	});

	test("criterion 8: no behind status once every template change is in the document; behind when one is missing", async () => {
		const templates = await sources();
		const doc = await create(ADMIN, POLICY);
		// The church made every v2 change by hand, kept its v1 origin, and edited block 9 too.
		const by = structuredClone(doc.body);
		Object.assign(by, { title: v2.title, page: v2.page, fields: [...by.fields, PASTOR] });
		by.body = { type: "doc", content: structuredClone(v2.body.content) };
		by.body.content[8] = OWN_9;
		const saved = ok(await save(ADMIN, doc.id, "1", by));
		assert.equal(saved.body.origin.hash, await templateHash(v1));
		assert.equal(await templateStatus(saved.body, templates), "current");
		const found = ok(await compare(ADMIN, doc.id, templates));
		assert.deepEqual(found.changes, [], "the document already has every template change");
		assert.equal(found.behind, true, "the recorded hash is still v1's");
		// One change missing: the header.
		const missing = ok(await save(ADMIN, doc.id, "2", { ...by, page: { ...v2.page, header: null } }));
		assert.equal(await templateStatus(missing.body, templates), "behind");
		assert.deepEqual(shape(ok(await compare(ADMIN, doc.id, templates)).changes), [[0, "header", "template-only"]]);
	});

	test("criterion 9: a base that is not stored offers All differences only, and accept works from it", async () => {
		const doc = await create(ADMIN, POLICY);
		const forged = structuredClone(doc.body);
		forged.origin = { ...forged.origin, hash: `sha256:${"0".repeat(64)}` };
		forged.body.content.splice(5, 1);
		ok(await save(ADMIN, doc.id, "1", forged));
		const found = ok(await compare(ADMIN, doc.id));
		assert.equal(found.baseVersion, null);
		assert.equal(found.changes, null);
		assert.equal(found.keys.changes, null);
		assert.deepEqual(shape(found.differences), [[0, "body", "template-only"]]);
		refused(await acceptFrom(ADMIN, { ...found, keys: { changes: found.keys.all } }, "changes", "all"), "conflict");
		const accepted = ok(await acceptFrom(ADMIN, found, "all", "all"));
		assert.deepEqual(accepted.body.body, v1.body);
		assert.deepEqual(accepted.body.origin, { template: POLICY, version: 1, hash: await templateHash(v1) });
		const again = ok(await compare(ADMIN, doc.id));
		assert.equal(again.baseVersion, 1, "the accept recorded a stored version");
		assert.deepEqual(again.changes, []);
	});

	test("criterion 10: a church template updated twice compares its stored v1 with v3; accepting records v3", async () => {
		const template = await churchTemplate(OWNER, "Twice-updated policy");
		const doc = await create(ADMIN, template.templateId);
		const own = structuredClone(doc.body);
		own.body.content[9] = OWN_9;
		const r2 = ok(await save(ADMIN, doc.id, "1", own));
		await updateTemplate(template, 1, (body) => {
			body.body.content[4] = HEADING_4;
		});
		await updateTemplate(template, 2, (body) => {
			body.body.content.splice(12, 1, PARA_12);
			body.body.content.push(OWN_END);
		});
		assert.equal(await status(ADMIN, doc.id), "behind");
		const found = ok(await compare(ADMIN, doc.id));
		assert.equal(found.churchTemplate, true);
		assert.equal(found.baseVersion, 1);
		assert.equal(found.templateVersion, 3);
		assert.deepEqual(shape(found.changes), [
			[0, "body", "changed"],
			[1, "body", "changed"],
			[2, "body", "template-only"],
		]);
		assert.deepEqual(
			found.changes.map((d) => d.template),
			[HEADING_4, PARA_12, OWN_END],
		);
		const accepted = ok(await acceptFrom(ADMIN, found, "changes", [1]));
		const expected = structuredClone(r2.body.body.content);
		expected[12] = PARA_12;
		assert.deepEqual(accepted.body.body.content, expected);
		assert.equal(accepted.body.origin.version, 3);
		assert.equal(await status(ADMIN, doc.id), "current", "the base is now v3");
		assert.equal(ok(await compare(ADMIN, doc.id)).baseVersion, 3);
		// Another church plant's seat has no compare of this document's template.
		refused(await compare(OTHER, doc.id), "unavailable");
		// A deleted church template offers no compare.
		ok(await documentsWriter.deleteChurchTemplate(db, await authority(OWNER), { templateId: template.id }));
		assert.equal(await status(ADMIN, doc.id), null);
		refused(await compare(ADMIN, doc.id), "unavailable");
	});

	test("criterion 11: on a policy the legal notice is never listed or removed; a new field prints a value or fallback", async () => {
		const templates = await sources();
		// Other Church has no senior pastor and another name: a value-only field difference is not listed.
		const doc = await create(OTHER, POLICY);
		const found = ok(await compare(OTHER, doc.id, templates));
		assert.deepEqual(shape(found.changes), V2_CHANGES);
		assert.ok(!JSON.stringify(found.changes).includes(LEGAL_NOTICE));
		const accepted = ok(await acceptFrom(OTHER, found, "changes", "all", templates));
		assert.equal(accepted.documentClass, "formal/legal");
		assert.equal(accepted.body.data.pastor_name, "our pastor");
		const pdf = await pdfText(OTHER, doc.id);
		assert.ok(pdf.includes("Questions go to our pastor."));
		assert.ok(pdf.includes(LEGAL_NOTICE));
	});

	test("criterion 12: a compare made stale by another save or a new template, or a key from the other list, is a conflict", async () => {
		const templates = await sources();
		const doc = await create(ADMIN, POLICY);
		const found = ok(await compare(ADMIN, doc.id, templates));
		// A second session saves after the compare opened.
		ok(await save(OWNER, doc.id, "1", ownEdits(doc.body)));
		refused(await acceptFrom(ADMIN, found, "changes", [0], templates), "conflict");
		assert.equal(await revisionCount(doc.id), 2);
		const reloaded = ok(await compare(ADMIN, doc.id, templates));
		assert.equal(reloaded.revision, "2");
		// The template changes after the compare opened: v1 is current when it opens, v2 when it accepts.
		const onV1 = ok(await compare(ADMIN, doc.id));
		refused(await acceptFrom(ADMIN, onV1, "all", "all", templates), "conflict");
		// Items from one list sent with the other.
		refused(
			await acceptFrom(ADMIN, { ...reloaded, keys: { all: reloaded.keys.changes } }, "all", [0], templates),
			"conflict",
		);
		refused(
			await acceptFrom(ADMIN, { ...reloaded, keys: { changes: reloaded.keys.all } }, "changes", [0], templates),
			"conflict",
		);
		assert.equal(await revisionCount(doc.id), 2);
	});

	test("criterion 13: a Member is refused the compare and the accept", async () => {
		const templates = await sources();
		const doc = await create(ADMIN, POLICY);
		const found = ok(await compare(ADMIN, doc.id, templates));
		refused(await compare(MEMBER, doc.id, templates), "access_denied");
		refused(await acceptFrom(MEMBER, found, "changes", "all", templates), "access_denied");
		assert.equal(await revisionCount(doc.id), 1);
	});
});
