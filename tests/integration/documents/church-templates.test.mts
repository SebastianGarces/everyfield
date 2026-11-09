import { createDatabase, closeDatabase } from "../../../packages/db/src/client.ts";
import { sql } from "../../../packages/db/node_modules/drizzle-orm/index.js";
import { migrate } from "../../../packages/db/src/schema/migrate.ts";
import { S3Client } from "../../../packages/db/node_modules/@aws-sdk/client-s3/dist-es/index.js";
import { RequestActor } from "../../../packages/domain/src/access/session.ts";
import { documentsWriter } from "../../../packages/domain/src/documents/index.ts";
import { templateHash } from "../../../packages/contracts/src/documents/format/index.ts";
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

const schema = "t18tpl_" + randomUUID().replaceAll("-", "");
const roleName = "t18tpl_" + randomBytes(8).toString("hex");
const admin = createDatabase({
	connectionString: source.href,
	max: 4,
	options: `-c search_path=${schema},pg_catalog,pg_temp`,
});
const P = randomUUID();
const Q = randomUUID();
const actors = Array.from({ length: 5 }, () => ({ id: randomUUID(), user: randomUUID(), session: randomUUID() }));
let db;
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
	templates: await countOf("document", `WHERE kind = 'church_template'`),
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

const saveTemplate = async (who, input) => documentsWriter.saveChurchTemplate(db, await authority(who), input);
const deleteTemplate = async (who, templateId) =>
	documentsWriter.deleteChurchTemplate(db, await authority(who), { templateId });
const library = async (who) => ok(await documentsWriter.listChurch(db, await authority(who), {}));
/** Everything stored for one church template: its row and its revision, as one hash. */
const templateState = async (id) => {
	const [row] = await rowsOf(
		sql`SELECT t.title, t.kind, t.revision::text AS revision, t.archived_at, t.current_revision_id, t.copied_from_revision_id,
			t.copied_from_hash, r.version_number, r.body, r.content_hash
		FROM document t JOIN document_revision r ON r.id = t.current_revision_id WHERE t.id = ${id}::uuid`,
	);
	assert.ok(row, "the template row is stored");
	return sha(JSON.stringify(row));
};
const storedTemplate = async (id) =>
	JSON.parse(
		(
			await rowsOf(
				sql`SELECT r.body FROM document t JOIN document_revision r ON r.id = t.current_revision_id WHERE t.id = ${id}::uuid`,
			)
		)[0].body,
	);
/** A document body without what belongs to one copy: its id, title, description, origin and frozen merge values. */
const content = ({ id, title, description, origin, data, ...rest }) => rest;
const audits = async (action) =>
	rowsOf(
		sql`SELECT actor_id, subject_id, kind, request_key, after_value FROM audit_event WHERE action = ${action} ORDER BY recorded_at`,
	);

describe("T-18 Save as template: a church saves its own document as a template", { concurrency: 1 }, () => {
	test("a saved revision becomes the church's template; a document from it copies that revision with the church's current details", async () => {
		const doc = ok(await create(OWNER, "conflict-of-interest-policy", "t18-policy"));
		// The church edits its copy: a block goes and a paragraph with a placeholder comes in.
		const edited = structuredClone(doc.body);
		edited.body.content.splice(1, 1);
		edited.body.content.push({
			type: "paragraph",
			content: [{ type: "text", text: "Adopted by the board on [date], by a vote of [number]." }],
		});
		const saved = ok(await save(OWNER, doc.id, doc.revision, edited));
		const before = await counts();
		const template = ok(
			await saveTemplate(ADMIN, {
				documentId: doc.id,
				revision: Number(saved.revision),
				name: "Our conflict policy",
				description: "The board's own wording.",
				requestKey: "t18-save-1",
			}),
		);
		assert.equal(template.templateId, `church-${template.id}`);
		assert.equal(template.title, "Our conflict policy");
		assert.equal(template.description, "The board's own wording.");
		assert.equal(template.documentClass, "formal/legal");
		assert.deepEqual(template.formats, ["pdf", "docx"]);
		assert.deepEqual(template.source, { documentId: doc.id, revisionId: saved.revisionId, revision: 2 });
		assert.deepEqual(await counts(), {
			...before,
			templates: before.templates + 1,
			revisions: before.revisions + 1,
			audits: before.audits + 1,
		});

		const savedState = await templateState(template.id);
		// The template is the saved revision without origin and frozen values (Approach A).
		const body = await storedTemplate(template.id);
		assert.equal(body.kind, "template");
		assert.equal(body.id, template.templateId);
		assert.equal(body.version, 1);
		assert.equal(body.origin, undefined);
		assert.equal(body.data, undefined);
		assert.deepEqual(content({ ...body, kind: "document" }), content(saved.body));

		// The document stays open and unchanged.
		const same = ok(await documentsWriter.readChurch(db, await authority(OWNER), { documentId: doc.id }));
		assert.equal(same.revision, saved.revision);
		assert.equal(same.contentHash, saved.contentHash);

		// One audit row names the actor, the template and the source document and revision.
		const [audit] = await audits("documents.template_saved");
		assert.equal(audit.actor_id, actors[ADMIN].id);
		assert.equal(audit.subject_id, template.id);
		assert.equal(audit.kind, "create");
		assert.equal(audit.request_key, "t18-save-1");
		assert.equal(audit.after_value.sourceDocumentId, doc.id);
		assert.equal(audit.after_value.sourceRevisionId, saved.revisionId);
		assert.equal(audit.after_value.sourceRevision, 2);

		// The church's details change after the template was saved.
		await admin.execute(sql`UPDATE plant SET name = 'Harvest Point City' WHERE id = ${P}::uuid`);
		const copy = ok(await create(ADMIN, template.templateId, "t18-copy-1"));
		assert.equal(copy.templateId, template.templateId);
		assert.equal(copy.templateVersion, 1);
		assert.equal(copy.templateName, "Our conflict policy");
		assert.equal(copy.title, "Our conflict policy");
		assert.equal(copy.documentClass, "formal/legal");
		assert.equal(copy.revision, "1");
		assert.deepEqual(content(copy.body), content(saved.body), "page setup, blocks, text and placeholders match");
		assert.match(JSON.stringify(copy.body.body), /Adopted by the board on \[date\], by a vote of \[number\]\./);
		assert.equal(saved.body.data.church_name, "Harvest Point");
		assert.equal(copy.body.data.church_name, "Harvest Point City", "the merge field shows the church's current name");
		assert.deepEqual(copy.body.origin, {
			template: template.templateId,
			version: 1,
			hash: await templateHash(body),
		});
		const pdf = await policyText(ok(await fileOf(MEMBER, copy.id, "pdf")));
		assert.match(pdf, /Harvest Point City/);
		assert.match(pdf, /Adopted by the board on \[date\]/);

		// The library names the church template and its version; New from template lists the template.
		const lib = await library(OWNER);
		const line = lib.documents.find((d) => d.id === copy.id);
		assert.equal(line.templateName, "Our conflict policy");
		assert.equal(line.templateVersion, 1);
		assert.equal(
			lib.documents.find((d) => d.id === doc.id).templateName,
			null,
			"a built-in template has no church name",
		);
		assert.deepEqual(
			lib.templates.map((t) => t.id),
			[template.id],
		);
		// A church template is not a native document of the plant.
		const owned = ok(await documentsWriter.listOwned(db, await authority(OWNER), {}));
		assert.ok(!JSON.stringify(owned).includes(template.id), "the owned-documents list leaves church templates out");
		assert.equal(await templateState(template.id), savedState, "making a document from it leaves the template");
		Object.assign(state, { doc: saved, template, copy, templateBody: body, templateHash: savedState });
	});

	test("a template from a policy keeps the formal/legal class: Delete all content still prints the legal notice", async () => {
		const copy = state.copy;
		const wiped = structuredClone(copy.body);
		wiped.body = { type: "doc", content: [] };
		wiped.page.header = { pages: "all", content: [] };
		wiped.page.footer = { pages: "all", content: [] };
		const saved = ok(await save(OWNER, copy.id, copy.revision, wiped));
		assert.equal(saved.documentClass, "formal/legal");
		assert.deepEqual(await pdfPages(bytesFrom(ok(await fileOf(OWNER, copy.id, "pdf")))), [
			"Template, not legal advice",
		]);
		const word = docxParts(bytesFrom(ok(await fileOf(OWNER, copy.id, "docx"))));
		assert.equal(wordText(word["word/footer1.xml"]), "Template, not legal advice");
		state.copy = saved;
	});

	test("edits and deletes elsewhere leave the template exactly as it was, and New from template makes the same copy", async () => {
		const { template, doc } = state;
		const hash = state.templateHash;
		// The copy made from it was wiped and saved in the test before.
		assert.equal(await templateState(template.id), hash, "editing a copy leaves the template");
		// Edit the document it came from.
		const changed = structuredClone(doc.body);
		changed.body.content.push({ type: "paragraph", content: [{ type: "text", text: "A later edit." }] });
		const later = ok(await save(OWNER, doc.id, doc.revision, changed));
		assert.equal(await templateState(template.id), hash, "editing the source leaves the template");
		// Delete the document it came from.
		ok(
			await documentsWriter.deleteChurch(db, await authority(OWNER), {
				documentId: doc.id,
				expectedRevision: later.revision,
			}),
		);
		assert.equal(await templateState(template.id), hash, "deleting the source leaves the template");
		const second = ok(await create(OWNER, template.templateId, "t18-copy-2"));
		assert.deepEqual(
			content(second.body),
			content({ ...state.templateBody, kind: "document" }),
			"the same copy as before",
		);
		assert.deepEqual(second.body.data, state.copy.body.data, "the church details the first copy froze");
		assert.ok(!JSON.stringify(second.body).includes("A later edit."));
		assert.deepEqual(await library(OWNER).then((l) => l.templates.map((t) => t.id)), [template.id]);
		state.second = second;
	});

	test("the same request key makes one template, for a double click and for two racing requests", async () => {
		const { copy } = state;
		const input = {
			documentId: state.second.id,
			revision: 1,
			name: "Second policy",
			requestKey: "t18-retry",
		};
		const before = await counts();
		const first = ok(await saveTemplate(OWNER, input));
		const again = ok(await saveTemplate(OWNER, input));
		assert.equal(again.id, first.id);
		assert.deepEqual(again, first);
		assert.equal((await counts()).templates, before.templates + 1);
		// A different request under the same key is refused and writes nothing.
		const mid = await counts();
		refused(await saveTemplate(OWNER, { ...input, name: "Another name" }), "conflict");
		assert.deepEqual(await counts(), mid);

		const race = { documentId: copy.id, revision: Number(copy.revision), name: "Raced", requestKey: "t18-race" };
		const results = await Promise.all([saveTemplate(OWNER, race), saveTemplate(ADMIN, race)]);
		const [a, b] = results.map(ok);
		assert.equal(a.id, b.id);
		assert.equal((await counts()).templates, mid.templates + 1, "two racing requests make one template");
		assert.equal(
			(await rowsOf(sql`SELECT count(*)::int AS n FROM audit_event WHERE request_key = 't18-race'`))[0].n,
			1,
		);
		state.raced = a;
		state.retried = first;
	});

	test("deleting a template takes it out of New from template; documents made from it keep working", async () => {
		const { template, copy, second } = state;
		const before = await counts();
		const done = ok(await deleteTemplate(ADMIN, template.id));
		assert.deepEqual(done, { templateId: template.id, deleted: true });
		assert.deepEqual(
			await counts(),
			{ ...before, audits: before.audits + 1 },
			"it writes one audit row and deletes no content",
		);
		const [audit] = await audits("documents.template_deleted");
		assert.equal(audit.actor_id, actors[ADMIN].id);
		assert.equal(audit.subject_id, template.id);
		assert.equal(audit.kind, "archive");
		assert.equal(audit.after_value.sourceDocumentId, state.doc.id);
		assert.equal(audit.after_value.sourceRevisionId, template.source.revisionId);
		assert.equal(audit.after_value.sourceRevision, 2);
		const lib = await library(OWNER);
		assert.ok(!lib.templates.some((t) => t.id === template.id), "it leaves the picker");
		assert.equal(lib.documents.find((d) => d.id === second.id).templateName, "Our conflict policy");
		// It can no longer make a document, and a second delete finds nothing.
		const mid = await counts();
		refused(await create(OWNER, template.templateId, "t18-after-delete"), "unavailable");
		refused(await deleteTemplate(OWNER, template.id), "unavailable");
		assert.deepEqual(await counts(), mid);
		// The documents made from it still open, export and save.
		const read = ok(await documentsWriter.readChurch(db, await authority(MEMBER), { documentId: second.id }));
		assert.equal(read.templateName, "Our conflict policy");
		const exported = ok(await exportDoc(OWNER, second.id, 1, "pdf", "t18-export-after-delete"));
		assert.match((await pdfPages(await bytesOf(exported))).join(" "), /Adopted by the board on \[date\]/);
		const resaved = ok(await save(OWNER, second.id, second.revision, second.body));
		assert.equal(resaved.revision, "2");
		ok(await fileOf(OWNER, copy.id, "docx"));
	});

	test("a Member, another church's seat and another church's records are refused and write nothing", async () => {
		const { second, retried } = state;
		const before = await counts();
		const input = { documentId: second.id, revision: 1, name: "Not allowed", requestKey: "t18-refused" };
		refused(await saveTemplate(MEMBER, input), "access_denied");
		refused(await deleteTemplate(MEMBER, retried.id), "access_denied");
		refused(await create(MEMBER, retried.templateId, "t18-member-create"), "access_denied");
		// Another church plant's Admin names this church's document and template.
		refused(await saveTemplate(OTHER, input), "unavailable");
		refused(await create(OTHER, retried.templateId, "t18-other-create"), "unavailable");
		refused(await deleteTemplate(OTHER, retried.id), "unavailable");
		// A revision the document does not have.
		refused(await saveTemplate(OWNER, { ...input, revision: 99, requestKey: "t18-no-revision" }), "unavailable");
		assert.deepEqual(await counts(), before);
		// A Member's library and another church's library carry none of this church's templates.
		assert.deepEqual((await library(MEMBER)).templates, []);
		assert.deepEqual((await library(OTHER)).templates, []);
		assert.ok((await library(OWNER)).templates.some((t) => t.id === retried.id));
	});
});
