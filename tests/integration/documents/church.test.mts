import { createDatabase, closeDatabase } from "../../../packages/db/src/client.ts";
import { sql } from "../../../packages/db/node_modules/drizzle-orm/index.js";
import { migrate } from "../../../packages/db/src/schema/migrate.ts";
import { S3Client } from "../../../packages/db/node_modules/@aws-sdk/client-s3/dist-es/index.js";
import { RequestActor } from "../../../packages/domain/src/access/session.ts";
import { documentsReader, documentsWriter } from "../../../packages/domain/src/documents/index.ts";
import { brandReader, brandWriter } from "../../../packages/domain/src/branding/index.ts";
import { uploadBrandAsset } from "../../../packages/domain/src/branding/files.ts";
import sharp from "../../../packages/db/node_modules/sharp/dist/index.mjs";
import { docTemplateById } from "../../../packages/domain/src/documents/doc-templates.ts";
import { forkTemplate, templateHash } from "../../../packages/contracts/src/documents/format/index.ts";
import { pdfPages, docxParts, wordText } from "./fixtures/readers.mts";
import { documentFrom, editorContent } from "../../../apps/web/src/features/documents/church/editor/document-json.ts";
import { editorSchema } from "../../../apps/web/src/features/documents/church/editor/schema.ts";
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

const schema = "wp036c_" + randomUUID().replaceAll("-", "");
const roleName = "wp036c_" + randomBytes(8).toString("hex");
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
const fileOf = async (who, documentId, format, revision) =>
	documentsWriter.readChurchFile(
		db,
		await authority(who),
		{ documentId, format, ...(revision ? { revision } : {}) },
		storage,
	);
const bytesFrom = (file) => Buffer.from(file.bytes, "base64");
const policyText = async (file) => (await pdfPages(bytesFrom(file))).join(" ");

describe("WP-036 Church Documents on everyfield.doc/1", { concurrency: 1 }, () => {
	test("AC:CASE-DOC-022 New from template forks the policy, records its origin and freezes the church and brand kit values", async () => {
		const owner = await authority(OWNER);
		ok(
			await brandWriter.saveSettings(db, owner, {
				expectedRevision: "0",
				patch: {
					primaryColor: "#1F4E79",
					accentColor: "#C9A227",
					legalName: "Harvest Point Church, Inc.",
					tagline: "A church for the whole city.",
					website: "https://harvestpoint.church",
					phone: "(555) 010-0100",
				},
			}),
		);
		const before = await counts();
		const doc = ok(await create(ADMIN, "conflict-of-interest-policy", "wp036-policy"));
		const template = docTemplateById("conflict-of-interest-policy");
		assert.equal(doc.templateId, "conflict-of-interest-policy");
		assert.equal(doc.templateVersion, 1);
		assert.equal(doc.title, "Conflict of Interest Policy");
		assert.equal(doc.documentClass, "formal/legal");
		assert.equal(doc.revision, "1");
		assert.deepEqual(doc.formats, ["pdf", "docx"]);
		assert.equal(doc.body.kind, "document");
		assert.deepEqual(doc.body.origin, {
			template: "conflict-of-interest-policy",
			version: 1,
			hash: await templateHash(template),
		});
		assert.deepEqual(doc.body.data, { church_name: "Harvest Point", church_legal_name: "Harvest Point Church, Inc." });
		assert.deepEqual(doc.body.body, template.body, "the fork copies the template body");
		assert.deepEqual(doc.provenance, [
			{ key: "church_name", value: "Harvest Point", source: "church.name" },
			{ key: "church_legal_name", value: "Harvest Point Church, Inc.", source: "brand.legalName" },
		]);
		const after = await counts();
		assert.deepEqual(after, {
			...before,
			documents: before.documents + 1,
			revisions: before.revisions + 1,
			audits: before.audits + 1,
		});
		// The stored revision is the document, byte for byte.
		const [row] = await rowsOf(
			sql`SELECT r.body, r.content_hash FROM document_revision r WHERE r.document_id = ${doc.id}::uuid`,
		);
		assert.deepEqual(JSON.parse(row.body), doc.body);
		assert.equal(row.content_hash, sha(row.body));
		// The same request key returns the same document and writes once.
		const again = ok(await create(ADMIN, "conflict-of-interest-policy", "wp036-policy"));
		assert.deepEqual(again, doc);
		assert.deepEqual(await counts(), after);
		refused(await create(ADMIN, "budget-worksheet", "wp036-policy"), "conflict");
		assert.deepEqual(await counts(), after);
		state.policy = doc;
	});

	test("WP-036 the card, the sign-in sheet and the budget fork with their own fields; an unknown template is refused", async () => {
		const card = ok(await create(OWNER, "commitment-card", "wp036-card"));
		assert.deepEqual(card.body.data, {
			church_name: "Harvest Point",
			church_tagline: "A church for the whole city.",
			contact_line: "harvestpoint.church  ·  (555) 010-0100",
		});
		assert.deepEqual(card.body.page.tile, { across: 2, down: 2, padding: 14, cutMarks: true });
		const sign = ok(await create(OWNER, "guest-sign-in-sheet", "wp036-sign"));
		assert.equal(sign.body.origin.template, "guest-sign-in-sheet");
		const budget = ok(await create(OWNER, "budget-worksheet", "wp036-budget", { church_name: "Harvest Point Church" }));
		assert.deepEqual(budget.formats, ["pdf", "docx", "xlsx"]);
		assert.deepEqual(budget.body.data, { church_name: "Harvest Point Church" });
		assert.equal(budget.provenance[0].source, "override");
		state.card = card;
		state.budget = budget;
		const before = await counts();
		refused(await create(OWNER, "bylaws", "wp036-old"), "unavailable");
		refused(await create(OWNER, "not-a-template", "wp036-none"), "unavailable");
		refused(await create(OWNER, "budget-worksheet", "wp036-foreign", { pastor_name: "X" }), "invalid_input");
		assert.deepEqual(await counts(), before);
	});

	test("WP-036 save stores a valid everyfield.doc/1 document and refuses an old block list or a template with no write", async () => {
		const doc = state.policy;
		const before = await counts();
		const oldShape = [{ kind: "paragraph", text: "An old block list." }];
		const error = refused(await save(ADMIN, doc.id, "1", oldShape), "invalid_input");
		assert.match(error.details.issues[0].problem, /the file is not a JSON object/);
		refused(
			await save(ADMIN, doc.id, "1", { ...doc.body, kind: "template", origin: undefined, data: undefined }),
			"invalid_input",
		);
		const broken = structuredClone(doc.body);
		broken.body.content.push({ type: "paragraph", content: [{ type: "field", attrs: { key: "pastor_name" } }] });
		const fault = refused(await save(ADMIN, doc.id, "1", broken), "invalid_input");
		assert.match(fault.details.issues[0].problem, /the merge field "pastor_name" is not declared in "fields"/);
		assert.deepEqual(await counts(), before, "a refused save writes nothing");

		const edited = structuredClone(doc.body);
		edited.title = "Conflict of Interest Policy (2026)";
		edited.body.content.push({ type: "paragraph", content: [{ type: "text", text: "Adopted on a Tuesday." }] });
		const saved = ok(await save(ADMIN, doc.id, "1", edited));
		assert.equal(saved.revision, "2");
		assert.equal(saved.title, "Conflict of Interest Policy (2026)");
		assert.deepEqual(saved.body, edited);
		assert.deepEqual(ok(await documentsWriter.readChurch(db, await authority(MEMBER), { documentId: doc.id })), saved);
		refused(await save(ADMIN, doc.id, "1", edited), "conflict");
		assert.deepEqual(await counts(), { ...before, revisions: before.revisions + 1, audits: before.audits + 1 });
		const one = ok(
			await documentsWriter["history.get"](db, await authority(MEMBER), { documentId: doc.id, revision: 1 }),
		);
		assert.deepEqual(one.body, doc.body);
		state.policy = saved;
	});

	test("WP-036 slice 2: a body the editor builds saves as one revision; a Member's save writes nothing", async () => {
		const doc = state.policy;
		// The editor holds the body in its own schema and builds the stored document with documentFrom. Edit it the way
		// the toolbar does (a tag, a link, a hard break, a page break) and save what comes out.
		const schema = editorSchema();
		const json: any = schema.nodeFromJSON(editorContent(doc.body)).toJSON();
		json.content.push(
			{ type: "pageBreak" },
			{
				type: "paragraph",
				content: [
					{ type: "text", marks: [{ type: "tag" }], text: "GROW" },
					{ type: "text", text: " and " },
					{ type: "text", marks: [{ type: "link", attrs: { href: "https://example.com/policy" } }], text: "read" },
					{ type: "hardBreak" },
					{ type: "text", marks: [{ type: "bold" }, { type: "italic" }], text: "more" },
				],
			},
		);
		schema.nodeFromJSON(json).check();
		const edited = documentFrom(doc.body, json);
		const before = await counts();
		refused(await save(MEMBER, doc.id, doc.revision, edited), "access_denied");
		assert.deepEqual(await counts(), before, "a Member's save writes nothing");
		const saved = ok(await save(ADMIN, doc.id, doc.revision, edited));
		assert.equal(saved.revision, String(Number(doc.revision) + 1));
		assert.deepEqual(saved.body, edited);
		assert.deepEqual(await counts(), { ...before, revisions: before.revisions + 1, audits: before.audits + 1 });
		state.policy = saved;
	});

	test("AC:CASE-DOC-019-EDIT a wiped formal/legal fork saves and its PDF still prints the legal notice", async () => {
		const doc = state.policy;
		const wiped = structuredClone(doc.body);
		wiped.body = { type: "doc", content: [] };
		wiped.page.header = { pages: "all", content: [] };
		wiped.page.footer = { pages: "all", content: [] };
		const saved = ok(await save(OWNER, doc.id, doc.revision, wiped));
		assert.deepEqual(saved.body.body, { type: "doc", content: [] });
		const pdf = ok(await fileOf(MEMBER, doc.id, "pdf"));
		assert.equal(pdf.revision, Number(saved.revision));
		assert.deepEqual(await pdfPages(bytesFrom(pdf)), ["Template, not legal advice"]);
		const word = docxParts(bytesFrom(ok(await fileOf(MEMBER, doc.id, "docx"))));
		assert.equal(wordText(word["word/footer1.xml"]), "Template, not legal advice");
		// The earlier revision still prints its own text.
		assert.match(await policyText(ok(await fileOf(MEMBER, doc.id, "pdf", 2))), /Adopted on a Tuesday\./);
		state.policy = saved;
	});

	test("AC:CASE-DOC-023 the preview, Download PDF and the saved export of one revision have the same sha256", async () => {
		const card = state.card;
		const preview = ok(await fileOf(MEMBER, card.id, "pdf"));
		const download = ok(await fileOf(OWNER, card.id, "pdf", 1));
		assert.equal(sha256(bytesFrom(preview)), sha256(bytesFrom(download)));
		assert.equal(preview.digest, sha256(bytesFrom(preview)));
		assert.equal(download.downloadName, "commitment-card-revision-1.pdf");
		assert.equal(download.mediaType, "application/pdf");
		const pages = await pdfPages(bytesFrom(preview));
		assert.equal(pages.length, 1, "four cards on one sheet");
		assert.equal(pages[0].split("My commitment").length - 1, 4);
		const saved = ok(await exportDoc(MEMBER, card.id, 1, "pdf", "wp036-card-export"));
		assert.equal(saved.digest, preview.digest, "the saved export is the same bytes");
		assert.deepEqual(saved.source.revision, 1);
		assert.equal(saved.savedTemplateName, docTemplateById("commitment-card").title);
	});

	test("WP-036 a Member reads, previews and downloads every offered format and cannot create, save or delete", async () => {
		const budget = state.budget;
		const library = ok(await documentsWriter.listChurch(db, await authority(MEMBER), {}));
		assert.deepEqual(library.documents.map((d) => d.templateId).sort(), [
			"budget-worksheet",
			"commitment-card",
			"conflict-of-interest-policy",
			"guest-sign-in-sheet",
		]);
		const read = ok(await documentsWriter.readChurch(db, await authority(MEMBER), { documentId: budget.id }));
		assert.deepEqual(read.formats, ["pdf", "docx", "xlsx"]);
		for (const format of ["pdf", "docx", "xlsx"]) {
			const file = ok(await fileOf(MEMBER, budget.id, format));
			assert.ok(bytesFrom(file).length > 1000, format);
			assert.equal(file.downloadName, `budget-worksheet-revision-1.${format}`);
		}
		refused(await fileOf(MEMBER, state.card.id, "xlsx"), "unavailable");
		const before = await counts();
		refused(await create(MEMBER, "budget-worksheet", "wp036-member"), "access_denied");
		refused(await save(MEMBER, budget.id, "1", budget.body), "access_denied");
		refused(
			await documentsWriter.deleteChurch(db, await authority(MEMBER), { documentId: budget.id, expectedRevision: "1" }),
			"access_denied",
		);
		assert.deepEqual(await counts(), before, "nothing is written");
		// Another church plant's seat cannot see the document at all.
		refused(await documentsWriter.readChurch(db, await authority(OTHER), { documentId: budget.id }), "unavailable");
		refused(await fileOf(OTHER, budget.id, "pdf"), "unavailable");
		assert.deepEqual(ok(await documentsWriter.listChurch(db, await authority(OTHER), {})).documents, []);
	});

	test("WP-036 an Owner deletes a Church Document with one audited statement and the library drops it", async () => {
		const sign = (await documentsWriter.listChurch(db, await authority(OWNER), {})).value.documents.find(
			(d) => d.templateId === "guest-sign-in-sheet",
		);
		const before = await counts();
		const deletes = () =>
			countOf("audit_event", `WHERE action = 'documents.archived' AND subject_id = '${sign.id}'::uuid`);
		const deletedBefore = await deletes();
		refused(
			await documentsWriter.deleteChurch(db, await authority(OWNER), { documentId: sign.id, expectedRevision: "7" }),
			"conflict",
		);
		assert.equal(await deletes(), deletedBefore);
		assert.deepEqual(
			ok(
				await documentsWriter.deleteChurch(db, await authority(OWNER), { documentId: sign.id, expectedRevision: "1" }),
			),
			{ documentId: sign.id, deleted: true },
		);
		assert.equal(await deletes(), deletedBefore + 1);
		assert.deepEqual(await counts(), { ...before, audits: before.audits + 1 });
		const library = ok(await documentsWriter.listChurch(db, await authority(MEMBER), {}));
		assert.equal(
			library.documents.some((d) => d.id === sign.id),
			false,
		);
		refused(await documentsWriter.readChurch(db, await authority(OWNER), { documentId: sign.id }), "unavailable");
		refused(
			await documentsWriter.deleteChurch(db, await authority(OWNER), { documentId: sign.id, expectedRevision: "1" }),
			"unavailable",
		);
	});

	test("AC:CASE-DOC-023 the church theme: a brand kit colors the PDF and Word file, and the toggle gives the neutral theme", async () => {
		const owner = await authority(OWNER);
		const current = ok(await brandReader.get(db, owner, {}));
		const kit = ok(
			await brandWriter.saveSettings(db, owner, {
				expectedRevision: current.revision,
				patch: { primaryColor: "#1F4E79", accentColor: "#C9A227" },
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
		const doc = ok(await create(OWNER, "conflict-of-interest-policy", "wp036-branded"));
		const pdf = ok(await exportDoc(ADMIN, doc.id, 1, "pdf", "wp036-branded-pdf"));
		assert.deepEqual(pdf.theme, { kind: "church", primary: "#1F4E79" });
		const word = docxParts(await bytesOf(ok(await exportDoc(ADMIN, doc.id, 1, "docx", "wp036-branded-docx"))));
		assert.ok(word["word/styles.xml"].includes('w:val="1F4E79"'));
		assert.match(word["word/document.xml"], /descr="Harvest Point Church logo"/);
		assert.ok(Object.keys(word).some((name) => /^word\/media\/image1\.png$/.test(name)));
		ok(await documentsWriter.setBranding(db, await authority(ADMIN), { documentId: doc.id, useChurchBranding: false }));
		const plain = ok(await exportDoc(ADMIN, doc.id, 1, "pdf", "wp036-plain-pdf"));
		assert.deepEqual(plain.theme, { kind: "everyfield-neutral", primary: null });
		assert.notEqual(plain.digest, pdf.digest);
		assert.equal(ok(await fileOf(MEMBER, doc.id, "pdf")).digest, plain.digest, "the preview follows the toggle");
	});
});
