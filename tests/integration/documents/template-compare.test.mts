// T-19 "Compare with template": a Church Document beside the current version of its template, and accepting changes
// as one new revision. The pure compare runs without a database; the read and the accept run on a fresh schema of the
// shared development database. Template version 2 exists only in this file: no repo template file changes.
//   Criterion 2: each edit (a deleted paragraph, a reworded heading, a new margin) is listed once, with its mark.
//   Criterion 3: a fresh document has no differences.
//   Criterion 4: a merge field compares by key, so a value-only difference is not listed.
//   Criteria 5, 6, 7, 9, 14: accepting some changes of a version 2 makes one revision with the exact body and origin.
//   Criterion 10: the legal notice is never a difference, and accept all keeps it in the PDF and the Word file.
//   Criterion 11: an accept from a stale compare is a conflict and writes nothing.
//   Criterion 12: a Member is refused; a blank document and a gone template have nothing to compare with.
import { createDatabase, closeDatabase } from "../../../packages/db/src/client.ts";
import { sql } from "../../../packages/db/node_modules/drizzle-orm/index.js";
import { migrate } from "../../../packages/db/src/schema/migrate.ts";
import { RequestActor } from "../../../packages/domain/src/access/session.ts";
import { documentsWriter, templateStatus } from "../../../packages/domain/src/documents/index.ts";
import {
	DOC_TEMPLATES,
	docTemplateById,
	publishedTemplate,
} from "../../../packages/domain/src/documents/doc-templates.ts";
import {
	LEGAL_NOTICE,
	acceptDifferences,
	compareWithTemplate,
	docTemplate,
	forkTemplate,
	templateHash,
} from "../../../packages/contracts/src/documents/index.ts";
import { pdfPages, docxParts, wordText } from "./fixtures/readers.mts";
import { documentFrom, editorContent } from "../../../apps/web/src/features/documents/church/editor/document-json.ts";
import { editorSchema } from "../../../apps/web/src/features/documents/church/editor/schema.ts";
import test, { after, before, describe } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";

const POLICY = "conflict-of-interest-policy";
const v1 = docTemplateById(POLICY)!;

/** Through the editor and back, as a Save stores it: the editor writes every default attribute. */
const throughEditor = (doc) =>
	documentFrom(doc, editorSchema().nodeFromJSON(editorContent(doc)).toJSON() as Record<string, unknown>);
const para = (text) => ({ type: "paragraph", content: [{ type: "text", text }] });
const shape = (differences) => differences.map((d) => [d.id, d.part, d.kind]);

/**
 * The test-only version 2 of the policy: block 4 ("Purpose") is reworded, block 5 (its paragraph) is gone, and a new
 * paragraph after block 7 prints a field the version 1 document does not have.
 */
function versionTwo() {
	const v2 = structuredClone(v1);
	v2.version = 2;
	v2.fields.push({
		key: "pastor_name",
		label: "Pastor",
		type: "text",
		source: "church.pastor",
		fallback: "our pastor",
	});
	const blocks = v2.body.content;
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
	return docTemplate.parse(v2);
}

/** The built-in templates with `next` as the policy's current version, published beside the stored ones. */
async function withVersion(next) {
	const hash = await templateHash(next);
	return {
		current: (id) => (id === POLICY ? next : docTemplateById(id)),
		published: (id, h) => (id === POLICY && h === hash ? next : publishedTemplate(id, h)),
	};
}

describe("T-19 compare a document with its template (no database)", () => {
	test("criterion 3: a fresh fork of each built-in template, saved through the editor, has no differences", async () => {
		for (const template of DOC_TEMPLATES) {
			const fork = await forkTemplate(template, { data: { church_name: "Harvest Point" } });
			assert.deepEqual(compareWithTemplate(fork, template), [], `${template.id} as forked`);
			assert.deepEqual(compareWithTemplate(throughEditor(fork), template), [], `${template.id} after a save`);
		}
	});

	test("criterion 2: a deleted paragraph, a reworded heading and a new margin are each listed once, in reading order", async () => {
		const fork = await forkTemplate(v1, { data: { church_name: "Harvest Point" } });
		const edited = structuredClone(fork);
		edited.page.margin.left = 72;
		edited.body.content[4] = { ...edited.body.content[4], content: [{ type: "text", text: "Our purpose" }] };
		edited.body.content.splice(7, 1);
		const differences = compareWithTemplate(throughEditor(edited), v1);
		assert.deepEqual(shape(differences), [
			[0, "page", "changed"],
			[1, "body", "changed"],
			[2, "body", "template-only"],
		]);
		assert.equal(differences[0].document.margin.left, 72);
		assert.equal(differences[0].template.margin.left, 40);
		assert.equal(differences[1].document.content[0].text, "Our purpose");
		assert.equal(differences[1].template.content[0].text, "Purpose");
		assert.deepEqual(differences[2].template, v1.body.content[7]);
		assert.equal(differences[2].document, null);
	});

	test("criterion 2: the title, the header and the footer are listed too", async () => {
		const fork = await forkTemplate(v1, { data: { church_name: "Harvest Point" } });
		const edited = structuredClone(fork);
		edited.title = "Our Conflict Policy";
		edited.page.header = { pages: "all", content: [para("Board copy")] };
		edited.page.footer = null;
		assert.deepEqual(shape(compareWithTemplate(edited, v1)), [
			[0, "title", "changed"],
			[1, "header", "document-only"],
			[2, "footer", "template-only"],
		]);
	});

	test("criterion 4: a merge field that differs only by its frozen value is not a difference", async () => {
		const fork = await forkTemplate(v1, { data: { church_name: "Somewhere Else", church_legal_name: "Else, Inc." } });
		assert.deepEqual(compareWithTemplate(fork, v1), []);
	});

	test("criterion 3: a block that spells out its default attributes equals one that leaves them out", async () => {
		// The editor writes the defaults once a person picks a style and picks the default back (Lead, then Body).
		const fork = await forkTemplate(v1);
		const at = fork.body.content.findIndex((block) => block.type === "paragraph" && !block.attrs);
		assert.notEqual(at, -1, "the template has a paragraph with no attrs");
		fork.body.content[at] = { ...fork.body.content[at], attrs: { align: "left", style: "body" } };
		assert.deepEqual(compareWithTemplate(fork, v1), []);
	});

	test("criterion 5: accepting one difference applies only it; accept all gives the template's body", async () => {
		const fork = await forkTemplate(v1, { data: { church_name: "Harvest Point" } });
		const edited = structuredClone(fork);
		edited.body.content[2] = { ...edited.body.content[2], content: [{ type: "text", text: "Our Policy" }] };
		edited.body.content.splice(5, 1);
		edited.body.content.push(para("Our own closing line."));
		const differences = compareWithTemplate(edited, v1);
		assert.deepEqual(shape(differences), [
			[0, "body", "changed"],
			[1, "body", "template-only"],
			[2, "body", "document-only"],
		]);
		const origin = { template: POLICY, version: 1, hash: await templateHash(v1) };
		const one = acceptDifferences(edited, v1, [1], { origin, values: {} });
		const expected = structuredClone(edited.body.content);
		expected.splice(5, 0, v1.body.content[5]);
		assert.deepEqual(one.body.content, expected);
		const all = acceptDifferences(edited, v1, "all", { origin, values: {} });
		assert.deepEqual(all.body, v1.body);
		assert.deepEqual(compareWithTemplate(all, v1), []);
	});
});

// ---------------------------------------------------------------- the read and the accept, on the database

const source = new URL(process.env.DATABASE_URL_UNPOOLED ?? process.env.DATABASE_URL ?? "about:blank");
const localCi =
	process.env.CI === "true" &&
	process.env.EARLY_ACCESS_TEST_DATABASE === "1" &&
	["localhost", "127.0.0.1"].includes(source.hostname) &&
	source.pathname === "/everyfield_ci";
if (
	(!localCi && source.hostname !== "ep-autumn-dew-b8ltidky.c-14.us-east-1.aws.neon.tech") ||
	process.env.NODE_ENV === "production"
)
	throw Error("Only approved shared development or disposable CI endpoint allowed");
if (!localCi) source.searchParams.set("sslmode", "verify-full");

const schema = "t19cmp_" + randomUUID().replaceAll("-", "");
const roleName = "t19cmp_" + randomBytes(8).toString("hex");
const admin = createDatabase({
	connectionString: source.href,
	max: 4,
	options: `-c search_path=${schema},pg_catalog,pg_temp`,
});
const P = randomUUID();
const Q = randomUUID();
const actors = Array.from({ length: 4 }, () => ({ id: randomUUID(), user: randomUUID(), session: randomUUID() }));
const OWNER = 0;
const MEMBER = 1;
const ADMIN = 2;
const OTHER = 3;
let db;

const ok = (result) => {
	assert.equal(result.status, "ok", JSON.stringify(result.status === "refused" ? result.error : result.status));
	return result.value;
};
const refused = (result, code) => {
	assert.equal(result.status, "refused", JSON.stringify(result));
	assert.equal(result.error.code, code, JSON.stringify(result.error));
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
const documentRow = async (id) =>
	(
		await admin.execute(
			sql`SELECT template_version, revision::text AS revision, input_provenance FROM document WHERE id = ${id}::uuid`,
		)
	).rows[0];
const revisionCount = async (id) =>
	Number(
		(await admin.execute(sql`SELECT count(*)::int AS n FROM document_revision WHERE document_id = ${id}::uuid`)).rows[0]
			.n,
	);

before(async () => {
	await admin.execute(sql.raw(`CREATE SCHEMA ${schema}`));
	await migrate(admin, schema);
	const password = randomBytes(32).toString("hex");
	await admin.execute(
		sql.raw(
			`CREATE ROLE ${roleName} LOGIN INHERIT PASSWORD '${password}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS`,
		),
	);
	await admin.execute(sql.raw(`GRANT everyfield_runtime TO ${roleName}`));
	const url = new URL(source);
	url.username = roleName;
	url.password = password;
	db = createDatabase({ connectionString: url.href, max: 4, options: `-c search_path=${schema},pg_catalog,pg_temp` });
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
	if (db) await closeDatabase(db);
	try {
		await admin.execute(sql.raw(`DROP SCHEMA IF EXISTS ${schema} CASCADE`));
		await admin.execute(sql.raw(`DROP ROLE IF EXISTS ${roleName}`));
	} finally {
		await closeDatabase(admin);
	}
});

describe("T-19 compare and accept on a Church Document", { concurrency: 1 }, () => {
	test("criterion 3: a fresh document matches its template and lists nothing", async () => {
		const doc = await create(ADMIN, "guest-sign-in-sheet");
		assert.equal(await templateStatus(doc.body), "current");
		const found = ok(await compare(ADMIN, doc.id));
		assert.equal(found.behind, false);
		assert.deepEqual(found.differences, []);
		assert.equal(found.revision, "1");
	});

	test("criteria 5, 6, 7, 9, 14: accepting some changes of a version 2 writes one revision with the exact body and origin", async () => {
		const v2 = versionTwo();
		const templates = await withVersion(v2);
		const doc = await create(OWNER, POLICY);
		// The church's own edit: its lead paragraph.
		const edited = structuredClone(doc.body);
		edited.body.content[3] = para("Our board keeps this policy so every decision serves the church.");
		const r2 = ok(await save(OWNER, doc.id, "1", throughEditor(edited)));
		assert.equal(r2.revision, "2");
		assert.equal(await templateStatus(r2.body, templates), "behind");
		const rev1Pdf = await file(MEMBER, doc.id, "pdf", 1);
		const rev2Body = await revisionBody(doc.id, 2);

		const found = ok(await compare(OWNER, doc.id, templates));
		assert.equal(found.behind, true);
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

		const accepted = ok(
			await accept(
				OWNER,
				{
					documentId: doc.id,
					expectedRevision: "2",
					templateHash: found.templateHash,
					view: "all",
					key: found.keys.all,
					accept: [1, 2, 3],
				},
				templates,
			),
		);
		assert.equal(accepted.revision, "3");
		assert.equal(accepted.templateVersion, 2);
		// The document's own blocks, with the reworded heading, the new paragraph and without the removed one.
		const expected = structuredClone(r2.body.body.content);
		expected[4] = v2.body.content[4];
		expected.splice(7, 0, v2.body.content[6]);
		expected.splice(5, 1);
		assert.deepEqual(accepted.body.body.content, expected, "only the accepted blocks take the template's version");
		assert.deepEqual(accepted.body.origin, { template: POLICY, version: 2, hash: await templateHash(v2) });
		assert.deepEqual(
			accepted.body.fields.map((f) => f.key),
			["church_name", "church_legal_name", "pastor_name"],
		);
		assert.deepEqual(accepted.body.data, {
			church_name: "Harvest Point",
			church_legal_name: "Harvest Point",
			pastor_name: "Pastor Ada",
		});
		// The revision records the template version; the row keeps the version and values it was made with.
		const row = await documentRow(doc.id);
		assert.equal(row.template_version, 1);
		assert.equal(row.revision, "3");
		assert.deepEqual(row.input_provenance, doc.provenance);
		assert.equal(
			ok(await documentsWriter.readChurch(db, await authority(MEMBER), { documentId: doc.id })).templateVersion,
			2,
		);
		assert.equal(
			ok(await documentsWriter.listChurch(db, await authority(MEMBER), {})).documents.find((d) => d.id === doc.id)
				?.templateVersion,
			2,
			"the library shows the version the document page shows",
		);

		// Exactly one new revision; the earlier ones are unchanged and still render the same file.
		assert.deepEqual(
			(await history(MEMBER, doc.id)).revisions.map((r) => r.number),
			[1, 2, 3],
		);
		assert.deepEqual(await revisionBody(doc.id, 1), doc.body);
		assert.deepEqual(await revisionBody(doc.id, 2), rev2Body);
		assert.equal((await file(MEMBER, doc.id, "pdf", 1)).digest, rev1Pdf.digest);

		// Criterion 8: the PDF and the Word file print the accepted content and the church's value.
		const pdf = await pdfText(await file(MEMBER, doc.id, "pdf"));
		const word = docxText(await file(MEMBER, doc.id, "docx"));
		for (const text of [pdf, word]) {
			assert.ok(text.includes("Why this policy exists"), "the accepted heading prints");
			assert.ok(text.includes("Questions go to Pastor Ada."), "the new field prints the church's value");
			assert.ok(text.includes("Our board keeps this policy"), "the kept edit prints");
			assert.ok(!text.includes("pastor_name"), "no raw key prints");
		}

		// Criterion 7: the document is current, and compare still lists the difference the church kept.
		assert.equal(await templateStatus(accepted.body, templates), "current");
		const again = ok(await compare(OWNER, doc.id, templates));
		assert.equal(again.behind, false);
		assert.equal(again.revision, "3");
		assert.deepEqual(shape(again.differences), [[0, "body", "changed"]]);
		assert.equal(again.differences[0].document.content[0].text, r2.body.body.content[3].content[0].text);
	});

	test("criterion 9: a church with no value for a new field prints the template's fallback", async () => {
		const v2 = versionTwo();
		const templates = await withVersion(v2);
		const doc = await create(OTHER, POLICY);
		const found = ok(await compare(OTHER, doc.id, templates));
		assert.equal(found.values.pastor_name, "our pastor");
		const accepted = ok(
			await accept(
				OTHER,
				{
					documentId: doc.id,
					expectedRevision: "1",
					templateHash: found.templateHash,
					view: "all",
					key: found.keys.all,
					accept: "all",
				},
				templates,
			),
		);
		assert.deepEqual(accepted.body.body, v2.body);
		assert.equal(accepted.body.data.pastor_name, "our pastor");
		assert.ok((await pdfText(await file(OTHER, doc.id, "pdf"))).includes("Questions go to our pastor."));
	});

	test("criterion 10: after Delete all content, the legal notice is never a difference and accept all keeps it", async () => {
		const doc = await create(ADMIN, POLICY);
		const emptied = structuredClone(doc.body);
		emptied.body = { type: "doc" };
		emptied.page.header = null;
		emptied.page.footer = null;
		ok(await save(ADMIN, doc.id, "1", emptied));
		const found = ok(await compare(ADMIN, doc.id));
		assert.equal(found.differences.length, v1.body.content.length + 1, "every body block and the footer");
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

	test("criterion 11: an accept from a compare that a later save made stale is a conflict and writes nothing", async () => {
		const doc = await create(ADMIN, POLICY);
		const edited = structuredClone(doc.body);
		edited.body.content.splice(5, 1);
		ok(await save(ADMIN, doc.id, "1", edited));
		const found = ok(await compare(ADMIN, doc.id));
		assert.equal(found.revision, "2");
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
		refused(await accept(ADMIN, request), "conflict");
		assert.equal(await revisionCount(doc.id), 3);
		// A compare made for another template version is a conflict too.
		const stale = { ...request, expectedRevision: "3", templateHash: `sha256:${"0".repeat(64)}` };
		refused(await accept(ADMIN, stale), "conflict");
		// A number the compare does not have is refused as invalid.
		const reloaded = ok(await compare(ADMIN, doc.id));
		refused(
			await accept(ADMIN, { ...request, expectedRevision: "3", key: reloaded.keys.all, accept: [99] }),
			"invalid_input",
		);
		assert.equal(await revisionCount(doc.id), 3);
		assert.equal(reloaded.revision, "3");
		assert.deepEqual(shape(reloaded.differences), [
			[0, "title", "changed"],
			[1, "body", "template-only"],
		]);
	});

	test("criterion 12: a Member is refused; a blank document and a gone template have nothing to compare with", async () => {
		const doc = await create(ADMIN, POLICY);
		const found = ok(await compare(ADMIN, doc.id));
		refused(await compare(MEMBER, doc.id), "access_denied");
		refused(
			await accept(MEMBER, {
				documentId: doc.id,
				expectedRevision: "1",
				templateHash: found.templateHash,
				view: "all",
				key: found.keys.all,
				accept: "all",
			}),
			"access_denied",
		);
		assert.equal(await revisionCount(doc.id), 1);

		const gone = { current: () => undefined, published: publishedTemplate };
		assert.equal(await templateStatus(doc.body, gone), null);
		refused(await compare(ADMIN, doc.id, gone), "unavailable");

		const blank = { ...structuredClone(doc.body), origin: null };
		const saved = ok(await save(ADMIN, doc.id, "1", blank));
		assert.equal(await templateStatus(saved.body), null);
		refused(await compare(ADMIN, doc.id), "unavailable");
		refused(
			await accept(ADMIN, {
				documentId: doc.id,
				expectedRevision: "2",
				templateHash: found.templateHash,
				view: "all",
				key: found.keys.all,
				accept: "all",
			}),
			"unavailable",
		);
	});
});
