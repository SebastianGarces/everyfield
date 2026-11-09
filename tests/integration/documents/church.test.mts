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
import { DOCTRINAL } from "./fixtures/doctrinal.mts";
import { SLOT_BLANK_NOTE } from "../../../packages/domain/src/documents/templates/church.ts";
import { documentFrom, editorContent } from "../../../apps/web/src/features/documents/church/editor/document-json.ts";
import { editorSchema } from "../../../apps/web/src/features/documents/church/editor/schema.ts";
import { refusedWith } from "../../../apps/web/src/features/documents/church/refusal.ts";
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
		// The page footer is the last child of the editor's document, so the new blocks go in before it.
		const body = json.content.at(-1)?.type === "pageFooter" ? json.content.slice(0, -1) : json.content;
		const tail = json.content.at(-1)?.type === "pageFooter" ? [json.content.at(-1)] : [];
		json.content = [
			...body,
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
			...tail,
		];
		schema.nodeFromJSON(json).check();
		const edited = documentFrom(doc.body, json);
		const before = await counts();
		refused(await save(MEMBER, doc.id, doc.revision, edited), "access_denied");
		assert.deepEqual(await counts(), before, "a Member's save writes nothing");
		assert.equal(
			refusedWith("access_denied").message,
			"Only an Owner or Admin of the church plant can do this.",
			"the save action shows the access message for a Member",
		);
		const saved = ok(await save(ADMIN, doc.id, doc.revision, edited));
		assert.equal(saved.revision, String(Number(doc.revision) + 1));
		assert.deepEqual(saved.body, edited);
		assert.deepEqual(await counts(), { ...before, revisions: before.revisions + 1, audits: before.audits + 1 });
		state.policy = saved;
	});

	test("WP-036 slice 3: the editor read carries the palette the PDF paints; a Member's call is refused", async () => {
		const doc = state.policy;
		const edit = ok(await documentsWriter.readChurchForEdit(db, await authority(ADMIN), { documentId: doc.id }));
		assert.equal(edit.id, doc.id);
		assert.equal(edit.useChurchBranding, true);
		const church = edit.brands.church;
		assert.ok(church, "the kit has a primary color, so the church look exists");
		assert.equal(church.palette.themed, true);
		assert.equal(church.palette.primary, "#1F4E79");
		assert.equal(church.palette.accent, "#C9A227");
		assert.deepEqual(church.assets, { logo: null, mark: null, photo: null }, "this kit has no images");
		assert.equal(edit.brands.plain.palette.themed, false, "the plain look is the Everyfield-neutral theme");
		assert.deepEqual(edit.brands.plain.assets, { logo: null, mark: null, photo: null });
		// T-17: the church's current value of each merge field Insert offers; a field with no value now is left out.
		assert.deepEqual(edit.mergeValues, {
			church_name: "Harvest Point",
			pastor_name: "Pastor Ada",
			church_tagline: "A church for the whole city.",
			contact_line: "harvestpoint.church  ·  (555) 010-0100",
		});
		const { brands: _brands, mergeValues: _values, ...document } = edit;
		assert.deepEqual(
			document,
			ok(await documentsWriter.readChurch(db, await authority(ADMIN), { documentId: doc.id })),
		);
		refused(
			await documentsWriter.readChurchForEdit(db, await authority(MEMBER), { documentId: doc.id }),
			"access_denied",
		);
	});

	test("AC:DOC-EDIT-SLOT AC:DOC-EDIT-HISTORY a doctrinal section prints blank, then filled, then not at all; history names each saver", async () => {
		let doc = state.policy;
		const STATEMENT = "We believe in one God, Father, Son and Holy Spirit.";
		const headingText = (node: any) => (node.content ?? []).map((n: any) => n.text ?? "").join("");
		const original = doc.body;
		const withSlot = (content?: unknown[]) => {
			const body = structuredClone(original);
			const at = body.body.content.findIndex((n: any) => n.type === "heading" && headingText(n) === "Yearly statement");
			assert.ok(at > 0, "the policy has a Yearly statement heading");
			body.body.content.splice(at, 0, {
				type: "slot",
				attrs: { label: "Statement of faith" },
				...(content ? { content } : {}),
			});
			return body;
		};
		const texts = async (revision: string) => {
			const pdf = await policyText(ok(await fileOf(MEMBER, doc.id, "pdf", Number(revision))));
			const docx = docxParts(bytesFrom(ok(await fileOf(MEMBER, doc.id, "docx", Number(revision)))));
			return { pdf: pdf.replace(/\s+/g, " "), word: wordText(docx["word/document.xml"]) };
		};
		const BLANK = "Not filled in yet. Your church or its sending network adds this text. It stays blank until then.";

		// An empty section that was not deleted prints the marked blank, never default text.
		const empty = ok(await save(ADMIN, doc.id, doc.revision, withSlot()));
		let out = await texts(empty.revision);
		for (const text of [out.pdf, out.word]) {
			assert.match(text, /statement of faith/i);
			assert.ok(text.includes(BLANK), "the marked blank prints");
		}
		// Filled, it prints the church's statement in that section.
		doc = empty;
		const filled = ok(
			await save(
				OWNER,
				doc.id,
				doc.revision,
				withSlot([{ type: "paragraph", content: [{ type: "text", text: STATEMENT }] }]),
			),
		);
		out = await texts(filled.revision);
		assert.match(
			out.pdf,
			new RegExp(`statement of faith ${STATEMENT}`, "i"),
			"the PDF prints the statement in its section",
		);
		assert.ok(
			out.word.includes(STATEMENT) && !out.word.includes(BLANK),
			"the Word file prints the statement, no blank",
		);
		// Deleted, neither file has the section, its label or a blank; the text after it follows straight on.
		doc = filled;
		const gone = ok(await save(ADMIN, doc.id, doc.revision, original));
		out = await texts(gone.revision);
		for (const [name, text] of [
			["PDF", out.pdf],
			["Word", out.word],
		]) {
			assert.doesNotMatch(text, /statement of faith/i, `the ${name} has no section label`);
			assert.ok(!text.includes(STATEMENT) && !text.includes(BLANK), `the ${name} has no section and no blank`);
			assert.match(text, /left the room\. (08 )?Yearly statement/, `the ${name} runs straight on to the next heading`);
		}
		// The revision saved before the delete keeps its section.
		assert.ok((await texts(filled.revision)).word.includes(STATEMENT), "the earlier revision still prints it");

		// History lists every revision with who saved it (the auth user's name).
		const history = ok(await documentsWriter["history.list"](db, await authority(MEMBER), { documentId: doc.id }));
		const last = history.revisions.slice(-3);
		assert.deepEqual(
			last.map((r: any) => [String(r.number), r.authorName]),
			[
				[empty.revision, "Synthetic"],
				[filled.revision, "Synthetic"],
				[gone.revision, "Synthetic"],
			],
		);
		const one = ok(
			await documentsWriter["history.get"](db, await authority(MEMBER), {
				documentId: doc.id,
				revision: Number(filled.revision),
			}),
		);
		assert.equal(one.authorName, "Synthetic");
		state.policy = gone;
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

	test("AC:CASE-DOC-020-EDIT a doctrinal slot saves blank, takes the church's words and deletes; history keeps each revision", async () => {
		const doc = ok(await create(OWNER, "conflict-of-interest-policy", "doc020-slot"));
		const para = (text) => ({ type: "paragraph", content: [{ type: "text", text }] });
		const BEFORE = "The text before the section.";
		const AFTER = "The text after the section.";
		const OWN = "We hold these words as our own statement.";
		const withBody = (content) => {
			const next = structuredClone(doc.body);
			next.body = { type: "doc", content };
			return next;
		};
		const blankSlot = { type: "slot", attrs: { label: "Statement of faith" }, content: [] };
		const filledSlot = { type: "slot", attrs: { label: "Statement of faith" }, content: [para(OWN)] };
		const slotOf = (body) => body.body.content.find((n) => n.type === "slot");
		const files = async (who, revision, key) => {
			const pdf = await bytesOf(ok(await exportDoc(who, doc.id, revision, "pdf", `${key}-pdf`)));
			const word = docxParts(await bytesOf(ok(await exportDoc(who, doc.id, revision, "docx", `${key}-docx`))));
			return {
				pdf: (await pdfPages(pdf)).join(" "),
				docx: wordText(word["word/document.xml"]),
				xml: word["word/document.xml"],
			};
		};

		// 1. An unfilled slot reads back with its label and no content: the data the editor's marked blank needs.
		const blank = ok(await save(OWNER, doc.id, doc.revision, withBody([para(BEFORE), blankSlot, para(AFTER)])));
		assert.equal(blank.revision, "2");
		const read = ok(await documentsWriter.readChurch(db, await authority(OWNER), { documentId: doc.id }));
		assert.equal(slotOf(read.body).attrs.label, "Statement of faith");
		assert.equal(slotOf(read.body).content?.length ?? 0, 0);
		const two = ok(
			await documentsWriter["history.get"](db, await authority(OWNER), { documentId: doc.id, revision: 2 }),
		);
		assert.deepEqual(two.body, read.body);

		// 5. Anyone who reads it exports a visible, labelled blank and never default or doctrinal wording.
		const empty = await files(MEMBER, 2, "doc020-blank");
		for (const text of [empty.pdf, empty.docx]) {
			assert.match(text, /statement of faith/i);
			assert.ok(text.includes(SLOT_BLANK_NOTE), "the marked blank");
			assert.equal(DOCTRINAL.test(text), false, `doctrinal words: ${DOCTRINAL.exec(text)?.[0]}`);
		}

		// 2. The church's own statement prints under the label, with no blank note.
		const filled = ok(await save(OWNER, doc.id, "2", withBody([para(BEFORE), filledSlot, para(AFTER)])));
		assert.equal(filled.revision, "3");
		const own = await files(OWNER, 3, "doc020-filled");
		for (const text of [own.pdf, own.docx]) {
			assert.match(text, /statement of faith We hold these words as our own statement\./i);
			assert.equal(text.includes(SLOT_BLANK_NOTE), false);
		}

		// 3. Deleting the slot saves as one new revision; its files hold no label, no blank and no frame.
		const before = await counts();
		const deleted = ok(await save(OWNER, doc.id, "3", withBody([para(BEFORE), para(AFTER)])));
		assert.equal(deleted.revision, "4");
		assert.equal(slotOf(deleted.body), undefined);
		assert.deepEqual(await counts(), { ...before, revisions: before.revisions + 1, audits: before.audits + 1 });
		const gone = await files(OWNER, 4, "doc020-deleted");
		for (const text of [gone.pdf, gone.docx, gone.xml]) {
			assert.equal(/statement of faith/i.test(text), false);
			assert.equal(text.includes(SLOT_BLANK_NOTE), false);
			assert.equal(text.includes(OWN), false);
		}
		for (const text of [gone.pdf, gone.docx]) assert.ok(text.includes(`${BEFORE} ${AFTER}`), "the neighbours meet");
		const tables = (xml) => (xml.match(/<w:tbl>/g) ?? []).length;
		assert.equal(tables(gone.xml), tables(own.xml) - 1, "the slot's frame is gone from the Word file");

		// 4. The earlier revisions keep the slot in history and still export it as they were saved.
		const three = ok(
			await documentsWriter["history.get"](db, await authority(MEMBER), { documentId: doc.id, revision: 3 }),
		);
		assert.deepEqual(slotOf(three.body), filledSlot);
		assert.deepEqual(
			slotOf(
				ok(await documentsWriter["history.get"](db, await authority(MEMBER), { documentId: doc.id, revision: 2 })).body,
			),
			slotOf(read.body),
		);
		const again = await files(MEMBER, 3, "doc020-filled-again");
		assert.match(again.pdf, /statement of faith We hold these words as our own statement\./i);
		assert.ok(again.docx.includes(OWN));
		const blankAgain = await files(MEMBER, 2, "doc020-blank-again");
		for (const text of [blankAgain.pdf, blankAgain.docx]) assert.ok(text.includes(SLOT_BLANK_NOTE));
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
	// T-54: a Download saves one export (D-78); the page lists the saved exports and a list download is the stored bytes.
	const listExports = async (who, documentId) => documentsWriter.listExports(db, await authority(who), { documentId });
	const exportFile = async (who, documentId, exportId) =>
		documentsWriter.readExportFile(db, await authority(who), { documentId, exportId }, storage);
	const deleteExport = async (who, documentId, exportId) =>
		documentsWriter.deleteExport(db, await authority(who), { documentId, exportId });
	const exportDeletes = (id) =>
		countOf("audit_event", `WHERE action = 'documents.export_deleted' AND subject_id = '${id}'::uuid`);
	/** The object cleanup jobs a deleted export queued for its stored file. */
	const cleanups = (id) =>
		rowsOf(
			sql`SELECT j.subject_record_id::text AS object_id, j.state FROM job j
				WHERE j.kind = 'object_cleanup' AND j.producer_key = ${`export-deleted/${id}`}`,
		);
	const objectOf = async (id) =>
		(await rowsOf(sql`SELECT object_id::text FROM generated_document WHERE id = ${id}::uuid`))[0].object_id;

	test("AC:CASE-DOC-023 T-54 an export of revision 2 lists first with its revision, format, time and author", async () => {
		await admin.execute(sql`UPDATE auth_user SET name = 'Olivia Owner' WHERE id = ${actors[OWNER].user}::uuid`);
		await admin.execute(sql`UPDATE auth_user SET name = 'Max Member' WHERE id = ${actors[MEMBER].user}::uuid`);
		const doc = ok(await create(OWNER, "conflict-of-interest-policy", "t54-policy"));
		assert.deepEqual(ok(await listExports(MEMBER, doc.id)).exports, [], "no export yet");
		const edited = structuredClone(doc.body);
		edited.body.content.push({ type: "paragraph", content: [{ type: "text", text: "Revision two." }] });
		ok(await save(OWNER, doc.id, "1", edited));
		const before = await countOf("generated_document");
		const pdf = ok(await exportDoc(OWNER, doc.id, 2, "pdf", "t54-pdf"));
		const again = ok(await exportDoc(OWNER, doc.id, 2, "pdf", "t54-pdf"));
		assert.equal(again.id, pdf.id, "the same request key returns the same export");
		assert.equal(await countOf("generated_document"), before + 1, "a retry makes one saved export");
		const word = ok(await exportDoc(MEMBER, doc.id, 2, "docx", "t54-docx"));
		const listed = ok(await listExports(MEMBER, doc.id)).exports;
		assert.deepEqual(
			listed.map((e) => [e.id, e.revision, e.format, e.creatorName, e.digest]),
			[
				[word.id, 2, "docx", "Max Member", word.digest],
				[pdf.id, 2, "pdf", "Olivia Owner", pdf.digest],
			],
			"newest first, each with its own format",
		);
		assert.equal(listed[1].generatedAt, pdf.generatedAt);
		assert.equal(listed[1].downloadName, "conflict-of-interest-policy-revision-2.pdf");
		const file = ok(await exportFile(MEMBER, doc.id, pdf.id));
		assert.equal(sha256(bytesFrom(file)), pdf.digest, "the download is the saved bytes");
		assert.equal(file.mediaType, "application/pdf");
		assert.equal(file.revision, 2);
		const docx = ok(await exportFile(OWNER, doc.id, word.id));
		assert.equal(sha256(bytesFrom(docx)), word.digest);
		assert.equal(docx.downloadName, "conflict-of-interest-policy-revision-2.docx");
		state.saved = { doc, pdf, word };
	});

	test("AC:CASE-DOC-023 T-54 after a new revision, the branding switch and a kit color change, a Member gets the identical file", async () => {
		const { doc, pdf } = state.saved;
		const owner = await authority(OWNER);
		const fresh = ok(await fileOf(MEMBER, doc.id, "pdf", 2));
		assert.equal(fresh.digest, pdf.digest, "before any change the fresh render and the saved export agree");
		const current = ok(await brandReader.get(db, owner, {}));
		ok(
			await brandWriter.saveSettings(db, owner, {
				expectedRevision: current.revision,
				patch: { primaryColor: "#7A1F4E" },
			}),
		);
		ok(await documentsWriter.setBranding(db, owner, { documentId: doc.id, useChurchBranding: false }));
		ok(await documentsWriter.setBranding(db, owner, { documentId: doc.id, useChurchBranding: true }));
		const latest = ok(await documentsWriter.readChurch(db, owner, { documentId: doc.id }));
		const third = structuredClone(latest.body);
		third.body.content.push({ type: "paragraph", content: [{ type: "text", text: "Revision three." }] });
		ok(await save(OWNER, doc.id, latest.revision, third));
		const rerendered = ok(await fileOf(MEMBER, doc.id, "pdf", 2));
		assert.notEqual(rerendered.digest, pdf.digest, "a fresh render of revision 2 now paints the new kit color");
		const file = ok(await exportFile(MEMBER, doc.id, pdf.id));
		assert.equal(sha256(bytesFrom(file)), pdf.digest, "the saved export keeps its first bytes, not a new render");
		assert.deepEqual(bytesFrom(file), await bytesOf(pdf), "they are the stored object, byte for byte");
		// Put the kit color back, so the later suites see the kit the theme test set.
		const changed = ok(await brandReader.get(db, owner, {}));
		ok(
			await brandWriter.saveSettings(db, owner, {
				expectedRevision: changed.revision,
				patch: { primaryColor: current.primaryColor },
			}),
		);
	});

	test("T-54 a saved-export download refuses another church plant, a seatless account and an unknown id", async () => {
		const { doc, pdf } = state.saved;
		refused(await exportFile(OTHER, doc.id, pdf.id), "unavailable");
		refused(await exportFile(4, doc.id, pdf.id), "access_denied");
		refused(await exportFile(MEMBER, doc.id, randomUUID()), "unavailable");
		refused(await exportFile(MEMBER, state.card.id, pdf.id), "unavailable", "the export belongs to another document");
		refused(await listExports(OTHER, doc.id), "unavailable");
		refused(await listExports(4, doc.id), "access_denied");
	});

	test("T-54 a Member's delete is refused and changes nothing; an Owner's delete writes one audit row and releases its file in the same statement", async () => {
		const { doc, pdf, word } = state.saved;
		const before = await counts();
		refused(await deleteExport(MEMBER, doc.id, pdf.id), "access_denied");
		refused(await deleteExport(OTHER, doc.id, pdf.id), "unavailable");
		assert.deepEqual(await counts(), before, "nothing is written");
		assert.equal(await exportDeletes(pdf.id), 0);
		assert.deepEqual(await cleanups(pdf.id), [], "a refused delete queues no cleanup");
		assert.ok(
			ok(await listExports(MEMBER, doc.id)).exports.some((e) => e.id === pdf.id),
			"the row is still listed",
		);

		const [pdfObject, wordObject] = [await objectOf(pdf.id), await objectOf(word.id)];
		assert.deepEqual(ok(await deleteExport(ADMIN, doc.id, word.id)), { exportId: word.id, deleted: true });
		assert.deepEqual(ok(await deleteExport(OWNER, doc.id, pdf.id)), { exportId: pdf.id, deleted: true });
		assert.equal(await exportDeletes(pdf.id), 1, "one audit row");
		assert.equal(await exportDeletes(word.id), 1);
		// The stored file is released in the same statement: one cleanup job each, which the worker runs once the row is gone.
		assert.deepEqual(await cleanups(pdf.id), [{ object_id: pdfObject, state: "ready" }], "one cleanup job");
		assert.deepEqual(await cleanups(word.id), [{ object_id: wordObject, state: "ready" }]);
		assert.deepEqual(await counts(), { ...before, generated: before.generated - 2, audits: before.audits + 2 });
		assert.deepEqual(ok(await listExports(MEMBER, doc.id)).exports, [], "the rows leave the list");
		refused(await exportFile(OWNER, doc.id, pdf.id), "unavailable", "its download stops working");
		refused(await deleteExport(OWNER, doc.id, pdf.id), "unavailable");
		assert.equal(await exportDeletes(pdf.id), 1, "a second delete writes nothing");
		assert.equal((await cleanups(pdf.id)).length, 1, "and queues no second cleanup");
	});

	test("T-54 a render failure saves no export and leaves the list unchanged", async () => {
		const { doc } = state.saved;
		// A revision whose stored body cannot render, written beside the editor's revisions.
		await admin.execute(
			sql`INSERT INTO document_revision (id, tenant_id, document_id, version_number, body, content_hash, published_at, recorded_at)
				VALUES (${randomUUID()}::uuid, ${P}::uuid, ${doc.id}::uuid, 99, 'not a document', ${sha("not a document")}, clock_timestamp(), clock_timestamp())`,
		);
		const before = await counts();
		refused(await exportDoc(OWNER, doc.id, 99, "pdf", "t54-broken"), "render_failed");
		refused(await exportDoc(OWNER, doc.id, 2, "xlsx", "t54-no-excel"), "unavailable");
		assert.deepEqual(await counts(), before, "no file and no saved export");
		assert.deepEqual(ok(await listExports(MEMBER, doc.id)).exports, []);
	});

	// Sebastian, 2026-11-04: "No, keep Save for your church alongside editable documents".
	const TEXT_TEMPLATES = [
		"member-expectations",
		"launch-team-commitment",
		"follow-up-letter",
		"bylaws",
		"prayer-letter",
	];

	test("T-56 Save for your church makes one saved file of each text template and no Church Document", async () => {
		const owner = await authority(OWNER);
		for (const templateId of TEXT_TEMPLATES) {
			const before = await counts();
			const saved = ok(
				await documentsWriter.generate(
					db,
					owner,
					{ templateId, format: "pdf", requestKey: `t56-save-${templateId}` },
					storage,
				),
			);
			const bytes = await bytesOf(saved);
			assert.equal(sha256(bytes), saved.digest, templateId);
			assert.ok((await pdfPages(bytes)).join(" ").includes("Harvest Point"), `${templateId} prints the church name`);
			const after = await counts();
			assert.equal(after.documents, before.documents, `${templateId} makes no Church Document`);
			assert.equal(after.revisions, before.revisions, templateId);
			assert.equal(after.generated, before.generated + 1, `${templateId} stores one saved file`);
			assert.equal(after.files, before.files + 1, templateId);
			// The same request key gives the same file and stores nothing more.
			const again = ok(
				await documentsWriter.generate(
					db,
					owner,
					{ templateId, format: "pdf", requestKey: `t56-save-${templateId}` },
					storage,
				),
			);
			assert.equal(again.id, saved.id, templateId);
			assert.deepEqual(await counts(), after, templateId);
		}
	});

	test("T-56 Create Church Document makes an editable Church Document of each text template with the church name", async () => {
		for (const templateId of TEXT_TEMPLATES) {
			const before = await counts();
			const doc = ok(await create(OWNER, templateId, `t56-create-${templateId}`));
			assert.equal(doc.templateId, templateId);
			assert.equal(doc.revision, "1");
			assert.equal(doc.title, docTemplateById(templateId).title);
			assert.deepEqual(doc.formats, ["pdf", "docx"]);
			assert.equal(doc.body.data.church_name, "Harvest Point");
			assert.equal(doc.body.data.pastor_name, "Pastor Ada");
			const after = await counts();
			assert.equal(after.documents, before.documents + 1, templateId);
			assert.equal(after.generated, before.generated, `${templateId} makes no saved file`);
			const text = (await pdfPages(bytesFrom(ok(await fileOf(OWNER, doc.id, "pdf"))))).join(" ");
			assert.ok(text.includes("Harvest Point"), `${templateId} prints the church name`);
			assert.ok(!text.includes("{church_name}"), templateId);
			// Editable: the Owner saves an edited body as revision 2.
			const edited = structuredClone(doc.body);
			edited.body.content.push({ type: "paragraph", content: [{ type: "text", text: "Edited by the church." }] });
			assert.equal(ok(await save(OWNER, doc.id, "1", edited)).revision, "2", templateId);
			const two = (await pdfPages(bytesFrom(ok(await fileOf(OWNER, doc.id, "pdf"))))).join(" ");
			assert.ok(two.includes("Edited by the church."), templateId);
		}
	});

	// D-129 (Sebastian, 2026-11-08): the Bylaws "Statement of faith" slot carries the key T-84 fills from the network.
	test("D-129 a Church Document from Bylaws keeps the keyed Statement of faith slot; Save and the export print the marked blank", async () => {
		const doc = ok(await create(OWNER, "bylaws", "d129-bylaws"));
		const slots = doc.body.body.content.filter((n) => n.type === "slot");
		assert.deepEqual(slots, [{ type: "slot", attrs: { label: "Statement of faith", key: "statement-of-faith" } }]);
		const one = ok(
			await documentsWriter["history.get"](db, await authority(OWNER), { documentId: doc.id, revision: 1 }),
		);
		assert.deepEqual(
			one.body.body.content.filter((n) => n.type === "slot"),
			slots,
			"revision 1 keeps the key",
		);

		const exported = await pdfPages(await bytesOf(ok(await exportDoc(OWNER, doc.id, 1, "pdf", "d129-pdf"))));
		const word = docxParts(await bytesOf(ok(await exportDoc(OWNER, doc.id, 1, "docx", "d129-docx"))));
		const saved = await pdfPages(
			await bytesOf(
				ok(
					await documentsWriter.generate(
						db,
						await authority(OWNER),
						{ templateId: "bylaws", format: "pdf", requestKey: "d129-save" },
						storage,
					),
				),
			),
		);
		for (const [name, text] of [
			["export pdf", exported.join(" ")],
			["export docx", wordText(word["word/document.xml"])],
			["saved file", saved.join(" ")],
		]) {
			assert.match(text, /statement of faith/i, name);
			assert.ok(text.includes(SLOT_BLANK_NOTE), `${name} prints the marked blank`);
			assert.equal(text.includes("statement-of-faith"), false, `${name} never prints the key`);
		}
	});

	test("AC:CASE-DOC-023 T-83 an older revision exports its own content once, keeps its bytes and refuses a revision it lacks", async () => {
		const owner = await authority(OWNER);
		const doc = ok(await create(OWNER, "conflict-of-interest-policy", "t83-policy"));
		// Revision 2 rewrites the first line of text, so its first words are only in revision 1; revision 3 adds a line.
		const second = structuredClone(doc.body);
		const firstText = (function find(node) {
			if (node.type === "text" && node.text.trim().split(/\s+/).length >= 3) return node;
			for (const child of node.content ?? []) {
				const hit = find(child);
				if (hit) return hit;
			}
			return null;
		})(second.body);
		assert.ok(firstText, "the template has a line of text");
		const onlyInOne = firstText.text.trim().split(/\s+/).slice(0, 3).join(" ");
		firstText.text = "Rewritten in revision two.";
		ok(await save(OWNER, doc.id, "1", second));
		const third = structuredClone(second);
		third.body.content.push({ type: "paragraph", content: [{ type: "text", text: "Only in revision three." }] });
		ok(await save(OWNER, doc.id, "2", third));
		const history = ok(await documentsWriter["history.list"](db, await authority(MEMBER), { documentId: doc.id }));
		assert.deepEqual(
			history.revisions.map((r) => r.number),
			[1, 2, 3],
			"a Member reads every revision",
		);

		const before = await countOf("generated_document");
		const [pdf, again] = await Promise.all([
			exportDoc(MEMBER, doc.id, 1, "pdf", "t83-pdf"),
			exportDoc(MEMBER, doc.id, 1, "pdf", "t83-pdf"),
		]);
		assert.equal(ok(again).id, ok(pdf).id, "a double click is one saved export");
		const saved = ok(pdf);
		assert.equal(await countOf("generated_document"), before + 1);
		assert.equal(saved.source.revision, 1);
		const text = (await pdfPages(await bytesOf(saved))).join(" ").replace(/\s+/g, " ");
		assert.ok(text.includes(onlyInOne), `revision 1's words "${onlyInOne}" are in the PDF`);
		assert.equal(text.includes("Rewritten in revision two."), false);
		assert.equal(text.includes("Only in revision three."), false, "the current revision's text is not");

		const word = ok(await exportDoc(OWNER, doc.id, 1, "docx", "t83-docx"));
		const words = wordText(docxParts(await bytesOf(word))["word/document.xml"]).replace(/\s+/g, " ");
		assert.ok(words.includes(onlyInOne));
		assert.equal(words.includes("Only in revision three."), false);
		const listed = ok(await listExports(MEMBER, doc.id)).exports;
		assert.deepEqual(
			listed.map((e) => [e.id, e.revision, e.format, e.digest]),
			[
				[word.id, 1, "docx", word.digest],
				[saved.id, 1, "pdf", saved.digest],
			],
		);
		assert.equal(listed[1].downloadName, "conflict-of-interest-policy-revision-1.pdf");

		// A kit change, the branding switch and a new revision later, the list download is still the first bytes.
		const kit = ok(await brandReader.get(db, owner, {}));
		ok(
			await brandWriter.saveSettings(db, owner, { expectedRevision: kit.revision, patch: { primaryColor: "#2E7A1F" } }),
		);
		ok(await documentsWriter.setBranding(db, owner, { documentId: doc.id, useChurchBranding: false }));
		const fourth = structuredClone(third);
		fourth.body.content.push({ type: "paragraph", content: [{ type: "text", text: "Revision four." }] });
		ok(await save(OWNER, doc.id, "3", fourth));
		const file = ok(await exportFile(MEMBER, doc.id, saved.id));
		assert.equal(sha256(bytesFrom(file)), saved.digest, "byte-identical to the first download");
		assert.equal(sha256(bytesFrom(ok(await exportFile(OWNER, doc.id, word.id)))), word.digest);
		assert.notEqual(ok(await fileOf(MEMBER, doc.id, "pdf", 1)).digest, saved.digest, "a fresh render differs now");

		// A revision the document lacks, and another church plant's document, are not found and save nothing.
		const counted = await counts();
		refused(await exportDoc(OWNER, doc.id, 42, "pdf", "t83-missing"), "unavailable");
		refused(await exportDoc(OTHER, doc.id, 1, "pdf", "t83-foreign"), "unavailable");
		assert.deepEqual(await counts(), counted, "nothing is written");
		const changed = ok(await brandReader.get(db, owner, {}));
		ok(
			await brandWriter.saveSettings(db, owner, {
				expectedRevision: changed.revision,
				patch: { primaryColor: kit.primaryColor },
			}),
		);
	});

	test("T-55 the branding switch: off and on again makes no revision, exports follow it, each change is audited", async () => {
		const doc = ok(await create(OWNER, "conflict-of-interest-policy", "t55-switch"));
		const read = async (who) => ok(await documentsWriter.readChurch(db, await authority(who), { documentId: doc.id }));
		const forEdit = async () =>
			ok(await documentsWriter.readChurchForEdit(db, await authority(OWNER), { documentId: doc.id }));
		const switched = () =>
			rowsOf(
				sql`SELECT actor_id, after_value FROM audit_event
					WHERE action = 'documents.branding_changed' AND subject_id = ${doc.id}::uuid ORDER BY recorded_at`,
			);
		const setBy = async (who, useChurchBranding) =>
			documentsWriter.setBranding(db, await authority(who), { documentId: doc.id, useChurchBranding });
		// A new document starts with church branding on, and a Member's read carries the value too.
		assert.equal((await forEdit()).useChurchBranding, true);
		assert.equal((await read(MEMBER)).useChurchBranding, true);
		assert.equal(ok(await exportDoc(OWNER, doc.id, 1, "pdf", "t55-branded-pdf")).theme.kind, "church");

		const before = await counts();
		assert.deepEqual(ok(await setBy(OWNER, false)), { documentId: doc.id, useChurchBranding: false });
		const off = await forEdit();
		assert.equal(off.useChurchBranding, false);
		assert.equal(off.revision, "1", "the switch makes no revision");
		assert.ok(off.brands.church, "the church look stays known, so the page can turn branding back on");
		assert.equal((await read(MEMBER)).useChurchBranding, false);
		assert.deepEqual(await counts(), { ...before, audits: before.audits + 1 }, "one audit row and nothing else");
		assert.deepEqual(await switched(), [{ actor_id: actors[OWNER].id, after_value: { useChurchBranding: false } }]);
		const plainPdf = ok(await exportDoc(OWNER, doc.id, 1, "pdf", "t55-plain-pdf"));
		assert.deepEqual(plainPdf.theme, { kind: "everyfield-neutral", primary: null });
		const plainWord = ok(await fileOf(OWNER, doc.id, "docx", 1));
		assert.equal(plainWord.downloadName, "conflict-of-interest-policy-revision-1.docx");
		const word = docxParts(bytesFrom(plainWord));
		assert.equal(word["word/styles.xml"].includes("1F4E79"), false, "no church color in the Word file");
		assert.equal(word["word/document.xml"].includes("Harvest Point Church logo"), false, "no church logo");

		// A Member can't change it: the write is refused and the stored value and the audit stay.
		const held = await counts();
		refused(await setBy(MEMBER, true), "access_denied");
		assert.equal((await read(OWNER)).useChurchBranding, false);
		assert.deepEqual(await counts(), held);

		assert.deepEqual(ok(await setBy(ADMIN, true)), { documentId: doc.id, useChurchBranding: true });
		const on = await forEdit();
		assert.equal(on.useChurchBranding, true);
		assert.equal(on.revision, "1");
		assert.deepEqual(
			(await switched()).map((r) => r.after_value),
			[{ useChurchBranding: false }, { useChurchBranding: true }],
		);
		assert.deepEqual(ok(await exportDoc(OWNER, doc.id, 1, "pdf", "t55-again-pdf")).theme, {
			kind: "church",
			primary: "#1F4E79",
		});
		assert.ok(docxParts(bytesFrom(ok(await fileOf(OWNER, doc.id, "docx", 1))))["word/styles.xml"].includes("1F4E79"));

		// A deleted document refuses the switch with the page's "not available" message.
		ok(await documentsWriter.deleteChurch(db, await authority(OWNER), { documentId: doc.id, expectedRevision: "1" }));
		refused(await setBy(OWNER, false), "unavailable");
		assert.equal(refusedWith("unavailable").message, "This is not available any more. Reload the page.");
	});

	test("T-55 a church with no brand kit has no church look; the document still starts with branding on", async () => {
		const doc = ok(await create(OTHER, "conflict-of-interest-policy", "t55-no-kit"));
		const edit = ok(await documentsWriter.readChurchForEdit(db, await authority(OTHER), { documentId: doc.id }));
		assert.equal(edit.useChurchBranding, true);
		assert.equal(edit.brands.church, null, "no brand kit, so the page shows the note and paints the plain look");
		assert.equal(edit.brands.plain.palette.themed, false);
	});
});
