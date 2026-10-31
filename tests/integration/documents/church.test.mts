import { createDatabase, closeDatabase } from "../../../packages/db/src/client.ts";
import { sql } from "../../../packages/db/node_modules/drizzle-orm/index.js";
import { migrate } from "../../../packages/db/src/schema/migrate.ts";
import { S3Client } from "../../../packages/db/node_modules/@aws-sdk/client-s3/dist-es/index.js";
import { RequestActor } from "../../../packages/domain/src/access/session.ts";
import { documentsReader, documentsWriter } from "../../../packages/domain/src/documents/index.ts";
import { brandReader, brandWriter } from "../../../packages/domain/src/branding/index.ts";
import { uploadBrandAsset } from "../../../packages/domain/src/branding/files.ts";
import sharp from "../../../packages/db/node_modules/sharp/dist/index.mjs";
import { churchTemplate } from "../../../packages/domain/src/documents/templates/church.ts";
import { pdfPages, docxParts, wordText } from "./fixtures/readers.mts";
import test, { after, before, describe } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";

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

const schema = "wp037c_" + randomUUID().replaceAll("-", "");
const roleName = "wp037c_" + randomBytes(8).toString("hex");
const admin = createDatabase({
	connectionString: source.href,
	max: 4,
	options: `-c search_path=${schema},pg_catalog,pg_temp`,
});
const P = randomUUID();
const Q = randomUUID();
const actors = Array.from({ length: 5 }, () => ({ id: randomUUID(), user: randomUUID(), session: randomUUID() }));
let db;
let foreignMeeting;
const sha = (text) => createHash("sha256").update(text).digest("hex");

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
const OWNER = 0;
const MEMBER = 1;
const ADMIN = 2;
const OTHER = 3;
const countOf = async (table, where = "") =>
	Number((await admin.execute(sql.raw(`SELECT count(*)::int AS n FROM ${table} ${where}`))).rows[0].n);
const rowsOf = async (query) => (await admin.execute(query)).rows;
const counts = async () => ({
	documents: await countOf("document", `WHERE kind = 'church_document'`),
	revisions: await countOf("document_revision"),
	files: await countOf("file_object", `WHERE purpose = 'generated'`),
	generated: await countOf("generated_document"),
	audits: await countOf("audit_event", `WHERE action LIKE 'documents.%'`),
});
const stored = async (generatedId) =>
	(
		await rowsOf(
			sql`SELECT f.opaque_key, f.sha256, f.byte_count::int AS byte_count, f.state FROM generated_document g JOIN file_object f ON f.id = g.object_id WHERE g.id = ${generatedId}::uuid`,
		)
	)[0];
const bytesOf = async (generated) => {
	const file = await stored(generated.id);
	assert.equal(file.state, "ready");
	const bytes = client.objects.get(file.opaque_key);
	assert.ok(bytes, "the bytes are in private storage");
	assert.equal(file.sha256, generated.digest);
	assert.equal(file.byte_count, generated.byteCount);
	return bytes;
};
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const create = async (who, templateId, requestKey, mergeFields) =>
	documentsWriter.createFromTemplate(db, await authority(who), {
		templateId,
		requestKey,
		...(mergeFields ? { mergeFields } : {}),
	});
const save = async (who, documentId, expectedRevision, body) =>
	documentsWriter.saveNative(db, await authority(who), { documentId, expectedRevision, body });
const exportDoc = async (who, documentId, revision, format, requestKey) =>
	documentsWriter.exportNative(db, await authority(who), { documentId, revision, format, requestKey }, storage);

const logoPng = await sharp({ create: { width: 480, height: 120, channels: 4, background: "#1F4E79" } })
	.composite([{ input: { create: { width: 90, height: 90, channels: 4, background: "#C9A227" } }, left: 15, top: 15 }])
	.png()
	.toBuffer();

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
	await admin.execute(
		sql`INSERT INTO plant(id,name,timezone,warning_days,alert_days,digest_weekday,digest_hour,phase,material_revision) VALUES(${P},'Harvest Point','America/Chicago',7,14,1,8,1,1)`,
	);
	await admin.execute(
		sql`INSERT INTO plant(id,name,timezone,warning_days,alert_days,digest_weekday,digest_hour,phase,material_revision) VALUES(${Q},'Other Church','America/New_York',7,14,1,8,1,1)`,
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
	const pastor = randomUUID();
	await admin.execute(
		sql`INSERT INTO person(id,tenant_id,plant_id,display_name,source,stage,adult_classification,commitment_state,pipeline_position,state,created_at)
			VALUES(${pastor},${P},${P},'Pastor Ada','other','leader','adult','unknown',0,'live',clock_timestamp())`,
	);
	const team = randomUUID();
	const role = randomUUID();
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

const state = {};

describe("WP-037 Church Documents", { concurrency: 1 }, () => {
	test("AC:CASE-DOC-022 an Admin creates a bylaws Church Document with the merge values in revision 1", async () => {
		const before = await counts();
		const made = ok(await create(ADMIN, "bylaws", "CASE-DOC-022-create", { church_name: "Harvest Point" }));
		state.doc = made;
		assert.equal(made.tenantId, P, "owned by the church plant");
		assert.equal(made.revision, "1");
		assert.equal(made.templateId, "bylaws");
		assert.equal(made.templateVersion, 1);
		assert.equal(made.documentClass, "formal/legal");
		assert.equal(made.useChurchBranding, true);
		assert.equal(made.archived, false);
		const text = JSON.stringify(made.body);
		assert.ok(text.includes("Harvest Point"), "revision 1 holds the church name");
		assert.equal(text.includes("{church_name}"), false);
		assert.deepEqual(
			made.provenance,
			[
				{ key: "church_name", value: "Harvest Point", source: "override" },
				{ key: "pastor_name", value: "Pastor Ada", source: "pastor_name" },
			],
			"frozen input provenance",
		);
		const after = await counts();
		assert.equal(after.documents, before.documents + 1);
		assert.equal(after.revisions, before.revisions + 1);
		assert.equal(after.files, before.files, "creation makes no file");
		assert.equal(after.generated, before.generated, "creation makes no generated_document");
		const row = (
			await rowsOf(
				sql`SELECT d.kind, d.template_id, d.template_version, d.document_class, d.use_church_branding, d.revision::int AS revision, d.input_provenance, r.version_number, r.author_account_id, r.body, r.content_hash FROM document d JOIN document_revision r ON r.id = d.current_revision_id WHERE d.id = ${made.id}::uuid`,
			)
		)[0];
		assert.equal(row.kind, "church_document");
		assert.equal(row.version_number, 1);
		assert.equal(row.author_account_id, actors[ADMIN].id);
		assert.equal(row.content_hash, made.contentHash);
		assert.equal(sha256(row.body), made.contentHash);
		assert.deepEqual(JSON.parse(row.body), made.body);
		assert.equal(
			await countOf("audit_event", `WHERE action = 'documents.created_from_template' AND subject_id = '${made.id}'`),
			1,
		);
		// A retry with the same request key returns the same document and writes nothing.
		const again = ok(await create(ADMIN, "bylaws", "CASE-DOC-022-create", { church_name: "Harvest Point" }));
		assert.deepEqual(again, made);
		assert.deepEqual(await counts(), after);
		// The same key with other input is a conflict.
		refused(await create(ADMIN, "bylaws", "CASE-DOC-022-create", { church_name: "Elsewhere" }), "conflict");
		refused(await create(ADMIN, "prayer-letter", "CASE-DOC-022-create"), "conflict");
		assert.deepEqual(await counts(), after);
		// The owner of the same church plant makes a separate document from the stored plant name.
		const other = ok(await create(OWNER, "prayer-letter", "owner-letter"));
		state.letter = other;
		assert.equal(other.documentClass, "outward-facing");
		assert.ok(JSON.stringify(other.body).includes("Harvest Point"));
		assert.equal(other.provenance[0].source, "church_name");
		assert.notEqual(other.id, made.id);
	});

	test("AC:CASE-DOC-022 a Member, a fixed layout, a budget, an email and an unwritten template are refused and write nothing", async () => {
		const before = await counts();
		refused(await create(MEMBER, "bylaws", "CASE-DOC-022-member", { church_name: "Harvest Point" }), "access_denied");
		refused(await create(MEMBER, "commitment-card", "member-fixed"), "access_denied");
		refused(
			await create(ADMIN, "commitment-card", "CASE-DOC-022-fixed", { church_name: "Harvest Point" }),
			"template_not_editable",
		);
		refused(await create(ADMIN, "vision-meeting-agenda", "agenda"), "template_not_editable");
		refused(await create(ADMIN, "first-year-budget", "budget"), "template_not_editable");
		refused(await create(ADMIN, "vision-meeting-invitation", "email"), "template_not_editable");
		refused(await create(ADMIN, "support-letter", "pending"), "template_not_authored");
		refused(await create(ADMIN, "board-minutes", "pending-2"), "template_not_authored");
		refused(await create(ADMIN, "no-such-template", "unknown"), "unavailable");
		refused(await create(ADMIN, "bylaws", "foreign-field", { surprise: "x" }), "invalid_input");
		refused(await create(ADMIN, "bylaws", "", {}), "invalid_input");
		assert.deepEqual(await counts(), before);
		// An account with no seat is refused.
		const none = await RequestActor.resolve(db, actors[4].session);
		assert.ok(none instanceof RequestActor, "an account with no seat still resolves to an actor");
		refused(
			await documentsWriter.createFromTemplate(db, none, { templateId: "bylaws", requestKey: "no-seat" }),
			"access_denied",
		);
		assert.deepEqual(await counts(), before);
	});

	test("AC:CASE-DOC-020-EDIT AC:CASE-DOC-023 edit appends attributed revisions, a stale save conflicts and a dropped slot is refused", async () => {
		const doc = state.doc;
		const before = await counts();
		// A Member cannot save.
		refused(await save(MEMBER, doc.id, "1", doc.body), "access_denied");
		assert.deepEqual(await counts(), before);
		// slot-delete-refused: a body without the statement-of-faith node.
		const without = doc.body.filter((block) => block.kind !== "slot");
		const gone = refused(await save(ADMIN, doc.id, "1", without), "slot_not_deletable");
		assert.deepEqual(gone.details.slotIds, ["statement-of-faith"]);
		assert.deepEqual(await counts(), before);
		assert.equal(
			(await rowsOf(sql`SELECT revision::int AS r FROM document WHERE id = ${doc.id}::uuid`))[0].r,
			1,
			"the current revision stays 1",
		);
		// A slot id the template does not have is invalid input.
		refused(
			await save(ADMIN, doc.id, "1", [...doc.body, { kind: "slot", slotId: "other", text: "" }]),
			"invalid_input",
		);
		// Bodies beyond the limits are invalid input and write nothing.
		refused(
			await save(
				ADMIN,
				doc.id,
				"1",
				Array.from({ length: 1001 }, () => ({ kind: "paragraph", text: "x" })),
			),
			"invalid_input",
		);
		refused(
			await save(ADMIN, doc.id, "1", [...doc.body, { kind: "notice", text: "Template, not legal advice" }]),
			"invalid_input",
		);
		refused(await save(ADMIN, doc.id, "1", [...doc.body, { kind: "paragraph", text: "bad\u0000" }]), "invalid_input");
		assert.deepEqual(await counts(), before);
		// Revision 2 adds a paragraph and fills the slot.
		const body2 = doc.body.map((block) => (block.kind === "slot" ? { ...block, text: "Our own words." } : block));
		body2.push({ kind: "paragraph", text: "The board met on a Tuesday." });
		const r2 = ok(await save(ADMIN, doc.id, "1", body2));
		state.r2 = r2;
		assert.equal(r2.revision, "2");
		assert.deepEqual(r2.body, body2);
		// A stale revision gets a conflict and writes nothing.
		const mid = await counts();
		const stale = refused(await save(OWNER, doc.id, "1", doc.body), "conflict");
		assert.equal(stale.retry, "refresh");
		assert.deepEqual(await counts(), mid);
		// A save can clear a slot's text again.
		const r3 = ok(
			await save(
				OWNER,
				doc.id,
				"2",
				body2.map((block) => (block.kind === "slot" ? { ...block, text: "" } : block)),
			),
		);
		assert.equal(r3.revision, "3");
		state.r3 = r3;
		// The history lists each revision with its number, author and time.
		const list = ok(await documentsWriter["history.list"](db, await authority(MEMBER), { documentId: doc.id }));
		assert.deepEqual(
			list.revisions.map((r) => r.number),
			[1, 2, 3],
		);
		assert.deepEqual(
			list.revisions.map((r) => r.authorAccountId),
			[actors[ADMIN].id, actors[ADMIN].id, actors[OWNER].id],
		);
		const times = list.revisions.map((r) => Date.parse(r.recordedAt));
		assert.deepEqual(
			[...times].sort((a, b) => a - b),
			times,
		);
		assert.ok(times.every((t) => Number.isFinite(t)));
		// An earlier revision reads back exactly as saved.
		const one = ok(
			await documentsWriter["history.get"](db, await authority(MEMBER), { documentId: doc.id, revision: 1 }),
		);
		assert.deepEqual(one.body, doc.body);
		assert.equal(one.contentHash, doc.contentHash);
		assert.equal(one.authorAccountId, actors[ADMIN].id);
		const two = ok(
			await documentsWriter["history.get"](db, await authority(OWNER), { documentId: doc.id, revision: 2 }),
		);
		assert.deepEqual(two.body, body2);
		refused(
			await documentsWriter["history.get"](db, await authority(OWNER), { documentId: doc.id, revision: 9 }),
			"unavailable",
		);
		refused(await documentsWriter["history.list"](db, await authority(OTHER), { documentId: doc.id }), "unavailable");
		// The church plant's own saved-file history and plain native documents are unchanged.
		assert.deepEqual(ok(await documentsWriter["history.list"](db, await authority(OWNER), {})).entries, []);
		const owned = ok(await documentsWriter.listOwned(db, await authority(OWNER), {}));
		assert.equal(
			owned.documents.some((d) => d.id === doc.id),
			false,
			"a Church Document is not a plain native document",
		);
		refused(
			await documentsWriter.saveNative(db, await authority(OWNER), {
				title: "Plain",
				body: "text",
				documentId: doc.id,
				expectedRevision: "3",
			}),
			"unavailable",
		);
	});

	test("AC:CASE-DOC-022 the branding toggle is one audited write that makes no revision", async () => {
		const doc = state.doc;
		const before = await counts();
		const audits = await countOf("audit_event", `WHERE action = 'documents.branding_changed'`);
		refused(
			await documentsWriter.setBranding(db, await authority(MEMBER), { documentId: doc.id, useChurchBranding: false }),
			"access_denied",
		);
		refused(
			await documentsWriter.setBranding(db, await authority(OTHER), { documentId: doc.id, useChurchBranding: false }),
			"unavailable",
		);
		assert.equal(await countOf("audit_event", `WHERE action = 'documents.branding_changed'`), audits);
		const off = ok(
			await documentsWriter.setBranding(db, await authority(ADMIN), { documentId: doc.id, useChurchBranding: false }),
		);
		assert.deepEqual(off, { documentId: doc.id, useChurchBranding: false });
		const row = (
			await rowsOf(sql`SELECT use_church_branding, revision::int AS revision FROM document WHERE id = ${doc.id}::uuid`)
		)[0];
		assert.equal(row.use_church_branding, false);
		assert.equal(row.revision, 3, "no new revision");
		const after = await counts();
		assert.equal(after.revisions, before.revisions);
		assert.equal(await countOf("audit_event", `WHERE action = 'documents.branding_changed'`), audits + 1);
		// The change is on the document and not in the body: the next save still succeeds from revision 3.
		ok(await documentsWriter.setBranding(db, await authority(OWNER), { documentId: doc.id, useChurchBranding: true }));
		assert.equal(await countOf("audit_event", `WHERE action = 'documents.branding_changed'`), audits + 2);
		refused(
			await documentsWriter.setBranding(db, await authority(ADMIN), {
				documentId: randomUUID(),
				useChurchBranding: true,
			}),
			"unavailable",
		);
	});

	test("AC:CASE-DOC-023 a reader exports one named revision as a tagged PDF with the neutral theme when the church has no brand kit", async () => {
		const doc = state.doc;
		const before = await counts();
		const pdf = ok(await exportDoc(MEMBER, doc.id, 1, "pdf", "neutral-pdf-r1"));
		assert.equal(pdf.format, "pdf");
		assert.deepEqual(pdf.source, { documentId: doc.id, revisionId: doc.revisionId, revision: 1 });
		assert.deepEqual(pdf.theme, { kind: "everyfield-neutral", primary: null });
		assert.equal(pdf.templateId, "bylaws");
		assert.equal(pdf.templateVersion, "1");
		assert.equal(pdf.creatorAccountId, actors[MEMBER].id);
		assert.equal(pdf.plantId, P);
		const bytes = await bytesOf(pdf);
		assert.equal(sha256(bytes), pdf.digest);
		assert.ok(Buffer.from(bytes).subarray(0, 5).toString() === "%PDF-");
		assert.ok(Buffer.from(bytes).includes("pdfuaid:part"), "PDF/UA identification");
		const after = await counts();
		assert.equal(after.generated, before.generated + 1);
		assert.equal(after.files, before.files + 1);
		const ready = await rowsOf(
			sql`SELECT g.source_document_id, g.source_revision_id, f.state FROM generated_document g JOIN file_object f ON f.id = g.object_id WHERE g.id = ${pdf.id}::uuid`,
		);
		assert.equal(ready[0].state, "ready");
		assert.equal(ready[0].source_document_id, doc.id);
		// A retry with the same key returns the same record and writes nothing.
		const again = ok(await exportDoc(MEMBER, doc.id, 1, "pdf", "neutral-pdf-r1"));
		assert.deepEqual(again, pdf);
		assert.deepEqual(await counts(), after);
		refused(await exportDoc(MEMBER, doc.id, 2, "pdf", "neutral-pdf-r1"), "conflict");
		refused(await exportDoc(MEMBER, doc.id, 1, "docx", "neutral-pdf-r1"), "conflict");
		// A revision that does not exist, a foreign church plant and an unsupported format leave no record.
		refused(await exportDoc(MEMBER, doc.id, 9, "pdf", "no-revision"), "unavailable");
		refused(await exportDoc(OTHER, doc.id, 1, "pdf", "foreign"), "unavailable");
		refused(await exportDoc(MEMBER, doc.id, 1, "xlsx", "bad-format"), "invalid_input");
		refused(await exportDoc(MEMBER, randomUUID(), 1, "pdf", "no-document"), "unavailable");
		assert.deepEqual(await counts(), after);
		const text = (await pdfPages(bytes)).join(" ");
		assert.ok(text.includes("Template, not legal advice"));
		assert.ok(text.includes("Harvest Point"));
		// The account of an Owner and an Admin can read too.
		ok(await exportDoc(OWNER, doc.id, 1, "pdf", "owner-pdf-r1"));
		ok(await exportDoc(ADMIN, doc.id, 1, "docx", "admin-docx-r1"));
	});

	test("AC:CASE-DOC-023 the church theme: a brand kit gives the PDF and the Word file the church colors, letterhead and logo", async () => {
		const owner = await authority(OWNER);
		const kit = ok(
			await brandWriter.saveSettings(db, owner, {
				expectedRevision: "0",
				patch: {
					primaryColor: "#1F4E79",
					accentColor: "#C9A227",
					legalName: "Harvest Point Church",
					ein: "12-3456789",
					address: "1 Main Street, Austin, TX 78701",
				},
			}),
		);
		const ticket = ok(
			await brandWriter.requestUpload(db, owner, {
				slot: "full_logo",
				mediaType: "image/png",
				byteLength: logoPng.length,
				altText: "Harvest Point Church logo",
			}),
		);
		ok(await uploadBrandAsset(db, storage, owner, { uploadId: ticket.uploadId, bytes: logoPng }));
		ok(
			await brandWriter.finalizeUpload(db, owner, {
				uploadId: ticket.uploadId,
				slot: "full_logo",
				altText: "Harvest Point Church logo",
				expectedRevision: kit.revision,
			}),
		);
		const doc = state.doc;
		const r2pdf = ok(await exportDoc(ADMIN, doc.id, 2, "pdf", "CASE-DOC-023-pdf-r2"));
		state.r2pdf = r2pdf;
		assert.deepEqual(r2pdf.theme, { kind: "church", primary: "#1F4E79" });
		assert.deepEqual(r2pdf.source.revision, 2);
		const r2docx = ok(await exportDoc(ADMIN, doc.id, 2, "docx", "CASE-DOC-023-docx-r2"));
		state.r2docx = r2docx;
		assert.deepEqual(r2docx.theme, { kind: "church", primary: "#1F4E79" });
		assert.equal(r2docx.format, "docx");
		const pdfBytes = await bytesOf(r2pdf);
		const docxBytes = await bytesOf(r2docx);
		// export-docx: a Word file that a reader other than its writer opens, with headings, tables and the logo's alt text.
		const parts = docxParts(docxBytes);
		assert.match(parts["word/document.xml"], /<w:pStyle w:val="Heading1"\/>/);
		assert.ok(parts["word/document.xml"].includes("<w:tbl>"));
		assert.match(parts["word/header1.xml"], /descr="Harvest Point Church logo"/);
		assert.ok(parts["word/media/logo.png"]);
		assert.ok(parts["word/styles.xml"].includes('w:val="1F4E79"'));
		assert.ok(wordText(parts["word/footer1.xml"]).includes("Harvest Point Church"));
		assert.ok(wordText(parts["word/footer1.xml"]).includes("EIN 12-3456789"));
		assert.ok(wordText(parts["word/document.xml"]).includes("The board met on a Tuesday."), "revision 2 text");
		assert.ok((await pdfPages(pdfBytes)).join(" ").includes("The board met on a Tuesday."));
		// With the toggle off the same revision exports in the Everyfield-neutral theme.
		ok(await documentsWriter.setBranding(db, await authority(ADMIN), { documentId: doc.id, useChurchBranding: false }));
		const plain = ok(await exportDoc(ADMIN, doc.id, 2, "pdf", "toggle-off-pdf-r2"));
		assert.deepEqual(plain.theme, { kind: "everyfield-neutral", primary: null });
		assert.notEqual(plain.digest, r2pdf.digest);
		ok(await documentsWriter.setBranding(db, await authority(ADMIN), { documentId: doc.id, useChurchBranding: true }));
	});

	test("AC:CASE-DOC-023 download after an edit and a brand kit change returns the exact saved bytes, and a new export uses the new theme", async () => {
		const doc = state.doc;
		const savedPdf = Buffer.from(await bytesOf(state.r2pdf));
		const savedDocx = Buffer.from(await bytesOf(state.r2docx));
		// Revision 3 is already saved (clearing the slot). Change the primary color.
		const owner = await authority(OWNER);
		const current = ok(await brandReader.get(db, owner, {}));
		ok(
			await brandWriter.saveSettings(db, owner, {
				expectedRevision: current.revision,
				patch: { primaryColor: "#8B1E3F" },
			}),
		);
		for (const generated of [state.r2pdf, state.r2docx]) {
			const link = ok(
				await documentsWriter.download(db, await authority(MEMBER), { documentId: generated.id }, storage),
			);
			const file = await stored(generated.id);
			assert.ok(link.url.includes(file.opaque_key));
			const bytes = client.objects.get(file.opaque_key);
			assert.equal(sha256(bytes), generated.digest, "SHA-256 equals the saved value");
			assert.equal(bytes.length, generated.byteCount, "byte length equals the saved value");
		}
		assert.deepEqual(client.objects.get((await stored(state.r2pdf.id)).opaque_key), savedPdf);
		assert.deepEqual(client.objects.get((await stored(state.r2docx.id)).opaque_key), savedDocx);
		const r3pdf = ok(await exportDoc(ADMIN, doc.id, 3, "pdf", "CASE-DOC-023-pdf-r3"));
		assert.deepEqual(r3pdf.theme, { kind: "church", primary: "#8B1E3F" });
		assert.notEqual(r3pdf.digest, state.r2pdf.digest);
		// The same revision under the new color also differs from its earlier export.
		const r2again = ok(await exportDoc(ADMIN, doc.id, 2, "pdf", "r2-after-kit-change"));
		assert.notEqual(r2again.digest, state.r2pdf.digest);
		assert.deepEqual(r2again.theme, { kind: "church", primary: "#8B1E3F" });
		// The record keeps the revision 2 bytes after later edits to the document.
		const list = ok(await documentsWriter["history.list"](db, await authority(OWNER), {}));
		const listed = list.entries.find((entry) => entry.id === state.r2pdf.id);
		assert.deepEqual(listed.source.revision, 2);
		assert.equal(listed.digest, state.r2pdf.digest);
		assert.deepEqual(
			ok(await documentsWriter["history.get"](db, await authority(OWNER), { documentId: state.r2pdf.id })).theme,
			{ kind: "church", primary: "#1F4E79" },
		);
	});

	test("AC:CASE-DOC-019-EDIT AC:CASE-DOC-020-EDIT the notice and the blank slot stay in both exports after the text is deleted", async () => {
		const doc = state.doc;
		const empty = state.r3.body.filter((block) => block.kind === "slot");
		const r4 = ok(await save(OWNER, doc.id, "3", empty));
		assert.equal(r4.revision, "4");
		assert.equal(JSON.stringify(r4.body).includes("legal advice"), false, "the notice is not in the body");
		const pdf = ok(await exportDoc(MEMBER, doc.id, 4, "pdf", "CASE-DOC-019-EDIT-pdf"));
		const docx = ok(await exportDoc(MEMBER, doc.id, 4, "docx", "CASE-DOC-019-EDIT-docx"));
		const pdfText = (await pdfPages(await bytesOf(pdf))).join(" ");
		const parts = docxParts(await bytesOf(docx));
		assert.ok(pdfText.includes("Template, not legal advice"), "notice in the PDF text");
		assert.ok(wordText(parts["word/footer1.xml"]).includes("Template, not legal advice"), "notice in the DOCX text");
		assert.equal(wordText(parts["word/document.xml"]).includes("legal advice"), false, "outside the editable body");
		// The slot is a visible, marked blank in both, with no default text.
		for (const text of [pdfText, wordText(parts["word/document.xml"])]) {
			assert.ok(/statement of faith/i.test(text));
			assert.ok(text.includes("Not filled in yet"));
		}
		const template = churchTemplate("bylaws");
		assert.deepEqual(
			template.body.find((b) => b.kind === "slot"),
			{ kind: "slot", slotId: "statement-of-faith", text: "" },
		);
		// Revision 1 shows the same blank.
		const first = ok(await exportDoc(MEMBER, doc.id, 1, "docx", "CASE-DOC-020-EDIT-docx"));
		assert.ok(wordText(docxParts(await bytesOf(first))["word/document.xml"]).includes("Not filled in yet"));
		// An outward-facing export holds no notice.
		const letter = state.letter;
		const lpdf = ok(await exportDoc(OWNER, letter.id, 1, "pdf", "CASE-DOC-019-EDIT-letter"));
		assert.equal((await pdfPages(await bytesOf(lpdf))).join(" ").includes("legal advice"), false);
		assert.equal(lpdf.theme.kind, "church");
		const ldocx = ok(await exportDoc(OWNER, letter.id, 1, "docx", "CASE-DOC-019-EDIT-letter-docx"));
		for (const part of Object.values(docxParts(await bytesOf(ldocx))))
			assert.equal(part.includes("legal advice"), false);
	});

	test("AC:CASE-DOC-023 a body over the limits or a failed render leaves no ready record", async () => {
		const doc = state.letter;
		const before = await counts();
		const insertRevision = async (body, number) => {
			const id = randomUUID();
			await admin.execute(
				sql`INSERT INTO document_revision(id,tenant_id,document_id,version_number,body,content_hash,published_at,recorded_at) VALUES(${id}::uuid,${P}::uuid,${doc.id}::uuid,${number},${body},${sha(body)},clock_timestamp(),clock_timestamp())`,
			);
		};
		await insertRevision(JSON.stringify(Array.from({ length: 1001 }, () => ({ kind: "paragraph", text: "x" }))), 2);
		await insertRevision(JSON.stringify([{ kind: "paragraph", text: "bad\u0000char" }]), 3);
		await insertRevision("not json", 4);
		for (const [number, key] of [
			[2, "too-many"],
			[3, "nul"],
			[4, "garbage"],
		])
			for (const format of ["pdf", "docx"])
				refused(await exportDoc(OWNER, doc.id, number, format, `${key}-${format}`), "render_failed");
		const after = await counts();
		assert.equal(after.generated, before.generated);
		assert.equal(after.files, before.files);
		assert.equal(await countOf("file_object", `WHERE purpose = 'generated' AND state <> 'ready'`), 0);
	});

	test("AC:CASE-DOC-023 a seat that ended cannot export or save, and saved exports pin their document, revision and template", async () => {
		const doc = state.doc;
		await admin.execute(
			sql`UPDATE seat SET ended_at = clock_timestamp() WHERE account_id = ${actors[ADMIN].id}::uuid AND ended_at IS NULL`,
		);
		const stale = await RequestActor.resolve(db, actors[ADMIN].session);
		assert.ok(stale instanceof RequestActor, "an ended seat still resolves to an actor");
		refused(
			await documentsWriter.exportNative(
				db,
				stale,
				{ documentId: doc.id, revision: 1, format: "pdf", requestKey: "ended-seat" },
				storage,
			),
			"access_denied",
		);
		refused(await save(ADMIN, doc.id, "4", doc.body), "access_denied");
		await admin.execute(sql`UPDATE seat SET ended_at = NULL WHERE account_id = ${actors[ADMIN].id}::uuid`);
		// Exports reference their document and revision: the tables cannot drop them from under a record.
		await assert.rejects(
			admin.execute(sql`DELETE FROM document_revision WHERE document_id = ${doc.id}::uuid AND version_number = 2`),
		);
		await assert.rejects(
			admin.execute(
				sql`UPDATE generated_document SET source_revision_id = NULL, source_document_id = NULL, theme_kind = NULL WHERE source_document_id = ${doc.id}::uuid`,
			),
		);
		await assert.rejects(admin.execute(sql`UPDATE document SET template_id = 'bylaws-2' WHERE id = ${doc.id}::uuid`));
	});
});
