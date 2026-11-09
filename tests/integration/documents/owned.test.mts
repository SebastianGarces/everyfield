import { createDatabase, closeDatabase } from "../../../packages/db/src/client.ts";
import { sql } from "../../../packages/db/node_modules/drizzle-orm/index.js";
import { migrate } from "../../../packages/db/src/schema/migrate.ts";
import { S3Client } from "../../../packages/db/node_modules/@aws-sdk/client-s3/dist-es/index.js";
import { RequestActor } from "../../../packages/domain/src/access/session.ts";
import { library } from "../../../packages/domain/src/documents/catalog.ts";
import { documentsReader, documentsWriter } from "../../../packages/domain/src/documents/index.ts";
import { nativeFromText, nativeText, readNative } from "../../../packages/contracts/src/documents/native.ts";
import test, { after, before, describe } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { crc32 } from "node:zlib";

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

const schema = "wp037_" + randomUUID().replaceAll("-", "");
const roleName = "wp037_" + randomBytes(8).toString("hex");
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
/** A native body of one paragraph per line, as the editor saves it. */
const doc = (text) => nativeFromText(text);

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
	const leaked = JSON.stringify(result.error);
	assert.equal(leaked.includes("Harvest Point"), false, leaked);
	assert.equal(leaked.includes("Quinn Canary"), false, leaked);
	return result.error;
};
const authority = async (who = 0) => {
	const actor = await RequestActor.resolve(db, actors[who].session);
	assert.ok(actor instanceof RequestActor, JSON.stringify(actor));
	return actor;
};
const countOf = async (table, where = "") =>
	Number((await admin.execute(sql.raw(`SELECT count(*)::int AS n FROM ${table} ${where}`))).rows[0].n);
const fileKey = async (generatedId) =>
	(
		await admin.execute(
			sql`SELECT f.id AS file_id, f.opaque_key, f.state FROM generated_document g JOIN file_object f ON f.id = g.object_id WHERE g.id = ${generatedId}::uuid`,
		)
	).rows[0];
const currentOf = async (documentId) =>
	(
		await admin.execute(
			sql`SELECT d.revision::text AS revision, d.kind, d.current_revision_id AS revision_id, r.body, r.content_hash
			FROM document d LEFT JOIN document_revision r ON r.id = d.current_revision_id WHERE d.id = ${documentId}::uuid`,
		)
	).rows[0];
const endSeat = (accountId) =>
	admin.execute(
		sql`UPDATE seat SET ended_at = clock_timestamp() WHERE account_id = ${accountId}::uuid AND ended_at IS NULL`,
	);
const restoreSeat = (accountId) =>
	admin.execute(sql`UPDATE seat SET ended_at = NULL WHERE account_id = ${accountId}::uuid`);

function storedZip(entries) {
	const parts = [];
	for (const entry of entries) {
		const name = Buffer.from(entry.name);
		const data = Buffer.from(entry.data);
		const local = Buffer.alloc(30);
		local.writeUInt32LE(0x04034b50, 0);
		local.writeUInt16LE(20, 4);
		local.writeUInt16LE(0, 8);
		local.writeUInt32LE(crc32(data) >>> 0, 14);
		local.writeUInt32LE(data.length, 18);
		local.writeUInt32LE(data.length, 22);
		local.writeUInt16LE(name.length, 26);
		parts.push(local, name, data);
	}
	return Buffer.concat(parts);
}
const paragraph = (text) =>
	`<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>${text}</w:t></w:r></w:p></w:body></w:document>`;
const docx = (text, extra = []) =>
	storedZip([{ name: "word/document.xml", data: paragraph(text) }, ...extra]).toString("base64");
function zipBomb() {
	const name = Buffer.from("word/document.xml");
	const local = Buffer.alloc(30 + name.length + 1);
	local.writeUInt32LE(0x04034b50, 0);
	local.writeUInt16LE(20, 4);
	local.writeUInt32LE(1, 18);
	local.writeUInt32LE(40 * 1024 * 1024 + 1, 22);
	local.writeUInt16LE(name.length, 26);
	name.copy(local, 30);
	return local.toString("base64");
}

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
		sql`INSERT INTO plant(id,name,timezone,warning_days,alert_days,digest_weekday,digest_hour,phase,material_revision) VALUES(${Q},'Other Plant','America/New_York',7,14,1,8,1,1)`,
	);
	for (const [index, plant, seatRole] of [
		[0, P, "owner"],
		[1, P, "member"],
		[2, P, "admin"],
		[3, Q, "admin"],
	])
		await admin.execute(
			sql`INSERT INTO seat(account_id,plant_id,role,accepted_at) VALUES(${actors[index].id},${plant},${seatRole},clock_timestamp())`,
		);
	const pastor = randomUUID();
	await admin.execute(
		sql`INSERT INTO person(id,tenant_id,plant_id,display_name,source,stage,adult_classification,commitment_state,pipeline_position,state,created_at)
			VALUES(${pastor},${P},${P},'Pastor Ada','other','leader','adult','unknown',0,'live',clock_timestamp())`,
	);
	await admin.execute(
		sql`INSERT INTO person(id,tenant_id,plant_id,display_name,source,stage,adult_classification,commitment_state,pipeline_position,state,created_at)
			VALUES(${randomUUID()},${Q},${Q},'Quinn Canary','other','prospect','unknown','unknown',0,'live',clock_timestamp())`,
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
	await admin.execute(sql`INSERT INTO launch(plant_id,target_date,status) VALUES(${P},'2026-09-14','scheduled')`);
	foreignMeeting = randomUUID();
	await admin.execute(
		sql`INSERT INTO meeting(id,plant_id,type,title,local_date,local_time,timezone,starts_at,resolver_version,status,attendance_revision)
			VALUES(${foreignMeeting},${Q},'vision_meeting','Foreign','2026-03-10','18:00','America/New_York','2026-03-10T22:00:00Z','test','planning',1)`,
	);
	await admin.execute(sql`INSERT INTO document(tenant_id,kind,title) VALUES(${P},'native','Title only')`);
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

describe("WP-037/api generated files and owned documents", { concurrency: 1 }, () => {
	test("AC:CASE-DOC-003 AC:CASE-DOC-015 AC:PROVIDER48-002 AC:PROVIDER48-003 AC:TEN-004 saved renders match the preview and keep a private key", async () => {
		const owner = await authority(0);
		const loaded = await library();
		const gap = loaded.templates.flatMap((template) =>
			template.mergeFields
				.filter((field) => field.required && !field.autoFill)
				.map((field) => `${template.id}:${field.key}`),
		);
		assert.deepEqual(gap, []);
		const card = loaded.templates.find((template) => template.id === "commitment-card");
		const agenda = loaded.templates.find((template) => template.id === "vision-meeting-agenda");
		const budget = loaded.templates.find((template) => template.id === "first-year-budget");
		assert.ok(card && agenda && budget);
		const filesBefore = await countOf("file_object");
		refused(
			await documentsWriter.generate(
				db,
				owner,
				{ templateId: card.id, format: "pdf", requestKey: "foreign-subject", meetingId: foreignMeeting },
				storage,
			),
			"invalid_subject",
		);
		refused(
			await documentsWriter.generate(
				db,
				owner,
				{ templateId: card.id, format: "ppt", requestKey: "bad-format" },
				storage,
			),
			"invalid_input",
		);
		refused(
			await documentsWriter.generate(
				db,
				owner,
				{ templateId: "missing-template", format: "pdf", requestKey: "missing" },
				storage,
			),
			"unavailable",
		);
		assert.equal(await countOf("file_object"), filesBefore);

		const saved = {};
		for (const [template, format] of [
			[card, "pdf"],
			[budget, "xlsx"],
		]) {
			const preview = ok(await documentsReader.preview(db, owner, { templateId: template.id, format }));
			const made = ok(
				await documentsWriter.generate(
					db,
					owner,
					{ templateId: template.id, format, requestKey: `make-${format}` },
					storage,
				),
			);
			const bytes = Buffer.from(preview.artifact, "base64");
			const stored = await fileKey(made.id);
			assert.equal(made.plantId, P);
			assert.equal(made.savedTemplateName, template.name);
			assert.equal(made.digest, preview.digest);
			assert.equal(made.byteCount, bytes.length);
			assert.equal(made.downloadName, `${template.id}.${format}`);
			assert.equal(stored.state, "ready");
			assert.match(stored.opaque_key, new RegExp(`^private/${P}/[0-9a-f-]{36}$`));
			assert.notEqual(stored.opaque_key.split("/")[2], stored.file_id);
			assert.deepEqual(client.objects.get(stored.opaque_key), bytes);
			const again = ok(
				await documentsWriter.generate(
					db,
					owner,
					{ templateId: template.id, format, requestKey: `make-${format}` },
					storage,
				),
			);
			assert.equal(again.id, made.id);
			assert.equal(await countOf("file_object", `WHERE upload_key = 'generated:${P}:make-${format}'`), 1);
			saved[format] = { made, stored };
		}
		// No template offers Word now; the old request is refused with the existing message.
		const refusal = refused(
			await documentsWriter.generate(
				db,
				owner,
				{ templateId: agenda.id, format: "docx", requestKey: "no-word" },
				storage,
			),
			"invalid_input",
		);
		assert.equal(refusal.details.issues[0].problem, "Format is not on this template.");
		// A DOCX record saved before the Forme renderer keeps its exact bytes and its old renderer version.
		const legacyBytes = docx("Saved by the hand-written writer");
		const legacyFile = randomUUID();
		const legacyKey = `private/${P}/${randomUUID()}`;
		await admin.execute(sql`
			INSERT INTO file_object (id, tenant_id, purpose, opaque_key, media_type, max_bytes, byte_count, sha256, state, upload_key, claim_generation)
			VALUES (${legacyFile}::uuid, ${P}::uuid, 'generated', ${legacyKey},
				'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 8388608, ${legacyBytes.length},
				${createHash("sha256").update(legacyBytes).digest("hex")}, 'ready', 'legacy-docx', 0)
		`);
		const legacyRow = await admin.execute(sql`
			INSERT INTO generated_document (tenant_id, template_id, template_version, saved_template_name, renderer_version, format, object_id, inputs, download_name, generated_at)
			VALUES (${P}::uuid, 'vision-meeting-agenda', ${"ef".repeat(32)}, 'Vision Meeting Agenda', 'hand-written-writer', 'docx', ${legacyFile}::uuid, '[]'::jsonb, 'vision-meeting-agenda.docx', clock_timestamp())
			RETURNING id
		`);
		client.objects.set(legacyKey, legacyBytes);
		const legacyId = legacyRow.rows[0].id;
		const legacy = ok(await documentsWriter.download(db, owner, { documentId: legacyId }, storage));
		assert.equal(legacy.url.includes(legacyKey), true);
		assert.deepEqual(client.objects.get(legacyKey), legacyBytes);
		assert.equal(ok(await documentsWriter["history.get"](db, owner, { documentId: legacyId })).format, "docx");
		const generatedAudits = await countOf("audit_event", `WHERE action = 'documents.generated' AND tenant_id = '${P}'`);
		assert.equal(generatedAudits, 2);
		const conflict = refused(
			await documentsWriter.generate(
				db,
				owner,
				{ templateId: card.id, format: "pdf", requestKey: "make-pdf", overrides: { pastor_name: "Other Pastor" } },
				storage,
			),
			"conflict",
		);
		assert.equal(conflict.retry, "refresh");
		assert.equal(await countOf("audit_event", `WHERE action = 'documents.generated' AND tenant_id = '${P}'`), 2);

		const member = await authority(1);
		const memberFile = ok(
			await documentsWriter.generate(
				db,
				member,
				{ templateId: card.id, format: "pdf", requestKey: "member-pdf" },
				storage,
			),
		);
		assert.equal(memberFile.plantId, P);
		await endSeat(actors[1].id);
		refused(
			await documentsWriter.download(db, await authority(1), { documentId: memberFile.id }, storage),
			"unavailable",
		);
		await restoreSeat(actors[1].id);
		const memberDownload = ok(
			await documentsWriter.download(db, await authority(1), { documentId: memberFile.id }, storage),
		);
		assert.equal(memberDownload.expiresInSeconds, 300);
		assert.equal(memberDownload.url.includes((await fileKey(memberFile.id)).opaque_key), true);

		const other = await authority(3);
		const otherFile = ok(
			await documentsWriter.generate(
				db,
				other,
				{ templateId: card.id, format: "pdf", requestKey: "other-pdf" },
				storage,
			),
		);
		assert.equal(otherFile.plantId, Q);
		refused(await documentsWriter.download(db, other, { documentId: saved.pdf.made.id }, storage), "unavailable");
		refused(
			await documentsWriter.generate(
				db,
				await authority(4),
				{ templateId: card.id, format: "pdf", requestKey: "account" },
				storage,
			),
			"unavailable",
		);
		refused(await documentsWriter.download(db, owner, { documentId: randomUUID() }, storage), "unavailable");

		const listed = ok(await documentsWriter["history.list"](db, owner, {}));
		assert.equal(
			listed.entries.some((entry) => entry.id === saved.pdf.made.id),
			true,
		);
		assert.equal(
			listed.entries.every((entry) => entry.plantId === P),
			true,
		);
		const one = ok(await documentsWriter["history.get"](db, owner, { documentId: saved.pdf.made.id }));
		assert.equal(one.digest, saved.pdf.made.digest);
		refused(await documentsWriter["history.get"](db, owner, { documentId: randomUUID() }), "unavailable");
		await admin.execute(sql`
			INSERT INTO file_object (id, tenant_id, purpose, opaque_key, media_type, max_bytes, byte_count, sha256, state, upload_key, claim_generation)
			SELECT gen_random_uuid(), ${P}::uuid, 'generated', 'private/' || ${P}::text || '/' || gen_random_uuid()::text,
				'application/pdf', 1, 1, ${"ab".repeat(32)}, 'ready', 'hist-' || g::text, 0
			FROM generate_series(1, 100) g
		`);
		await admin.execute(sql`
			INSERT INTO generated_document (
				tenant_id, template_id, template_version, saved_template_name, renderer_version, format, object_id, inputs, download_name, generated_at
			)
			SELECT ${P}::uuid, 'commitment-card', ${"cd".repeat(32)}, 'History', 'renderer', 'pdf', f.id, '[]'::jsonb, 'history.pdf', clock_timestamp()
			FROM file_object f WHERE f.upload_key LIKE 'hist-%'
		`);
		const capped = ok(await documentsWriter["history.list"](db, owner, {}));
		assert.equal(capped.entries.length, 100);
		assert.equal(
			(await countOf("generated_document", `WHERE tenant_id = '${P}' AND request_key IS NULL`)) >= 100,
			true,
		);

		const expired = randomUUID();
		const fresh = randomUUID();
		const orphan = randomUUID();
		await admin.execute(sql`
			INSERT INTO file_object (id, tenant_id, purpose, opaque_key, media_type, max_bytes, state, upload_key, claim_generation, expires_at)
			VALUES
				(${expired}::uuid, ${P}::uuid, 'generated', ${`private/${P}/${randomUUID()}`}, 'application/pdf', 10, 'pending', ${randomUUID()}, 0, clock_timestamp() - interval '1 hour'),
				(${fresh}::uuid, ${P}::uuid, 'generated', ${`private/${P}/${randomUUID()}`}, 'application/pdf', 10, 'pending', ${randomUUID()}, 0, clock_timestamp() + interval '1 hour')
		`);
		await admin.execute(sql`
			INSERT INTO file_object (id, tenant_id, purpose, opaque_key, media_type, max_bytes, byte_count, sha256, state, upload_key, claim_generation)
			VALUES (${orphan}::uuid, ${P}::uuid, 'generated', ${`private/${P}/${randomUUID()}`}, 'application/pdf', 1, 1, ${"ab".repeat(32)}, 'ready', ${randomUUID()}, 0)
		`);
		const cleaned = ok(await documentsWriter.reconcileOrphans(db, storage));
		assert.equal(cleaned.purged >= 2, true);
		const stateOf = async (id) =>
			(await admin.execute(sql`SELECT state FROM file_object WHERE id = ${id}::uuid`)).rows[0].state;
		assert.equal(await stateOf(expired), "purged");
		assert.equal(await stateOf(orphan), "purged");
		assert.equal(await stateOf(fresh), "pending");
		assert.equal(await stateOf(saved.pdf.stored.file_id), "ready");
		assert.equal(client.objects.has(saved.pdf.stored.opaque_key), true);
		const second = ok(await documentsWriter.reconcileOrphans(db, storage));
		assert.equal(second.purged, 0);
		const signed = ok(await documentsWriter.download(db, owner, { documentId: saved.pdf.made.id }, storage));
		assert.equal(signed.expiresInSeconds, 300);
		assert.equal(signed.url.includes(saved.pdf.stored.opaque_key), true);
		const ttl = Date.parse(signed.expiresAt) - Date.now();
		assert.equal(ttl > 240_000 && ttl < 360_000, true);
	});

	test("AC:CASE-DOC-016 AC:SCHEMA-008 AC:WIKI52-003 one owner, unsafe imports stay out, and the church copy survives purge", async () => {
		const owner = await authority(0);
		const member = await authority(1);
		refused(
			await documentsWriter.saveNative(db, member, { title: "No", body: doc("Member text"), expectedRevision: "0" }),
			"unavailable",
		);
		refused(
			await documentsWriter.saveNative(db, owner, { title: "Empty", body: doc("   "), expectedRevision: "0" }),
			"invalid_input",
		);
		const race = ok(
			await documentsWriter.saveNative(db, owner, { title: "Race", body: doc("one"), expectedRevision: "0" }),
		);
		const pair = await Promise.all([
			documentsWriter.saveNative(db, owner, {
				title: "Race",
				body: doc("two"),
				documentId: race.id,
				expectedRevision: race.revision,
			}),
			documentsWriter.saveNative(db, owner, {
				title: "Race",
				body: doc("three"),
				documentId: race.id,
				expectedRevision: race.revision,
			}),
		]);
		assert.deepEqual(pair.map((item) => item.status).sort(), ["ok", "refused"]);
		const lost = pair.find((item) => item.status === "refused");
		assert.equal(lost.error.code, "conflict");
		assert.equal(lost.error.retry, "refresh");

		const values = ok(
			await documentsWriter.saveNative(db, owner, {
				title: "Core values",
				body: doc("We serve our community."),
				expectedRevision: "0",
			}),
		);
		const listed = ok(await documentsWriter.listOwned(db, member, {}));
		assert.equal(
			listed.documents.some((item) => item.id === values.id),
			true,
		);
		assert.equal(
			listed.documents.some((item) => item.title === "Title only"),
			false,
		);
		const read = ok(await documentsWriter.getAuthorized(db, member, { documentId: values.id }));
		assert.deepEqual(read.body, doc("We serve our community."));
		refused(
			await documentsWriter.saveNative(db, owner, {
				title: "Core values",
				body: doc("Changed"),
				documentId: values.id,
				expectedRevision: "999",
			}),
			"conflict",
		);

		const emptyDoc = ok(
			await documentsWriter.saveNative(db, owner, { title: "Empty shell", body: doc("temp"), expectedRevision: "0" }),
		);
		const emptyRevision = randomUUID();
		await admin.execute(sql`
			INSERT INTO document_revision (id, tenant_id, document_id, version_number, body, content_hash, recorded_at)
			VALUES (${emptyRevision}::uuid, ${P}::uuid, ${emptyDoc.id}::uuid, 2, '   ', ${sha("   ")}, clock_timestamp())
		`);
		await admin.execute(
			sql`UPDATE document SET current_revision_id = ${emptyRevision}::uuid WHERE id = ${emptyDoc.id}::uuid`,
		);
		refused(
			await documentsWriter.designateCoreValues(db, owner, {
				documentId: emptyDoc.id,
				expectedRevision: emptyDoc.revision,
			}),
			"unavailable",
		);
		assert.equal((await currentOf(emptyDoc.id)).kind, "native");
		const failedDoc = ok(
			await documentsWriter.saveNative(db, owner, { title: "Failed import", body: doc("kept"), expectedRevision: "0" }),
		);
		const failedRevision = randomUUID();
		await admin.execute(sql`
			INSERT INTO document_revision (id, tenant_id, document_id, version_number, body, content_hash, import_state, recorded_at)
			VALUES (${failedRevision}::uuid, ${P}::uuid, ${failedDoc.id}::uuid, 2, 'kept', ${sha("kept")}, 'failed', clock_timestamp())
		`);
		await admin.execute(
			sql`UPDATE document SET current_revision_id = ${failedRevision}::uuid WHERE id = ${failedDoc.id}::uuid`,
		);
		refused(
			await documentsWriter.designateCoreValues(db, owner, {
				documentId: failedDoc.id,
				expectedRevision: failedDoc.revision,
			}),
			"unavailable",
		);

		const designated = ok(
			await documentsWriter.designateCoreValues(db, owner, {
				documentId: values.id,
				expectedRevision: values.revision,
			}),
		);
		assert.equal(designated.kind, "core_values");
		const evidence = ok(await documentsWriter.readCoreValuesEvidence(db, member, {}));
		assert.equal(evidence.documentId, values.id);
		assert.equal(evidence.text, "We serve our community.");
		const archived = ok(
			await documentsWriter.archive(db, owner, { documentId: values.id, expectedRevision: designated.revision }),
		);
		assert.equal(archived.archived, true);
		const archivedAudits = await countOf(
			"audit_event",
			`WHERE action = 'documents.archived' AND subject_id = '${values.id}'`,
		);
		const again = ok(
			await documentsWriter.archive(db, owner, { documentId: values.id, expectedRevision: archived.revision }),
		);
		assert.equal(again.archived, true);
		assert.equal(
			await countOf("audit_event", `WHERE action = 'documents.archived' AND subject_id = '${values.id}'`),
			archivedAudits,
		);
		refused(
			await documentsWriter.archive(db, owner, { documentId: values.id, expectedRevision: designated.revision }),
			"conflict",
		);
		assert.deepEqual(ok(await documentsWriter.readCoreValuesEvidence(db, member, {})), {
			documentId: null,
			text: null,
		});
		refused(
			await documentsWriter.archive(db, member, { documentId: values.id, expectedRevision: archived.revision }),
			"unavailable",
		);

		const kept = ok(
			await documentsWriter.saveNative(db, owner, {
				title: "Imported",
				body: doc("Keep this text."),
				expectedRevision: "0",
			}),
		);
		const rejects = [
			["text", Buffer.from("   ").toString("base64")],
			["text", Buffer.from("hello\u0000").toString("base64")],
			["text", Buffer.from([0xd0, 0xcf, 0x11, 0xe0]).toString("base64")],
			["docx", zipBomb()],
			["docx", docx("macro", [{ name: "word/vbaProject.bin", data: "macro" }])],
			[
				"docx",
				docx("outside", [
					{
						name: "word/_rels/document.xml.rels",
						data: '<Relationships><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/oleObject" Target="http://evil.example/x" TargetMode="External"/></Relationships>',
					},
				]),
			],
			["docx", docx("")],
		];
		for (const [format, bytes] of rejects) {
			refused(
				await documentsWriter.importTextOrWord(
					db,
					owner,
					{
						title: "Imported",
						format,
						bytes,
						documentId: kept.id,
						expectedRevision: kept.revision,
						requestKey: `bad-${format}-${bytes.length}`,
					},
					storage,
				),
				"invalid_input",
			);
			assert.deepEqual(readNative((await currentOf(kept.id)).body).body, doc("Keep this text."));
		}
		const imported = ok(
			await documentsWriter.importTextOrWord(
				db,
				owner,
				{
					title: "From Word",
					format: "docx",
					bytes: docx("We serve our community."),
					expectedRevision: "0",
					requestKey: "docx-1",
				},
				storage,
			),
		);
		assert.deepEqual(imported.body, doc("We serve our community."));
		const replay = ok(
			await documentsWriter.importTextOrWord(
				db,
				owner,
				{
					title: "From Word",
					format: "docx",
					bytes: docx("We serve our community."),
					expectedRevision: "0",
					requestKey: "docx-1",
				},
				storage,
			),
		);
		assert.equal(replay.id, imported.id);
		assert.equal(replay.revision, imported.revision);
		const edited = ok(
			await documentsWriter.saveNative(db, owner, {
				title: "From Word",
				body: doc("Edited after import"),
				documentId: imported.id,
				expectedRevision: imported.revision,
			}),
		);
		const drifted = refused(
			await documentsWriter.importTextOrWord(
				db,
				owner,
				{
					title: "From Word",
					format: "docx",
					bytes: docx("We serve our community."),
					documentId: imported.id,
					expectedRevision: edited.revision,
					requestKey: "docx-1",
				},
				storage,
			),
			"conflict",
		);
		assert.equal(drifted.retry, "refresh");
		assert.deepEqual(readNative((await currentOf(imported.id)).body).body, doc("Edited after import"));

		const privateOwner = await authority(4);
		const secret = ok(
			await documentsWriter.saveNative(db, privateOwner, {
				title: "Private",
				body: doc("Only for me"),
				expectedRevision: "0",
			}),
		);
		assert.equal(secret.tenantId, actors[4].id);
		assert.equal(
			ok(await documentsWriter.listOwned(db, owner, {})).documents.some((item) => item.id === secret.id),
			false,
		);
		refused(await documentsWriter.read(db, owner, { documentId: secret.id }), "unavailable");
		const beforeCopy = await countOf("document", `WHERE tenant_id = '${P}'`);
		refused(
			await documentsWriter.useForChurch(db, owner, {
				documentId: secret.id,
				revisionId: (await currentOf(secret.id)).revision_id,
				requestKey: "copy-secret",
			}),
			"unavailable",
		);
		assert.equal(await countOf("document", `WHERE tenant_id = '${P}'`), beforeCopy);

		await endSeat(actors[0].id);
		const accountActor = await authority(0);
		assert.equal(accountActor.actor.context.kind, "account");
		const sourceDoc = ok(
			await documentsWriter.saveNative(db, accountActor, {
				title: "Personal values",
				body: doc("We serve our community."),
				expectedRevision: "0",
			}),
		);
		assert.equal(sourceDoc.tenantId, actors[0].id);
		const sourceRevision = await currentOf(sourceDoc.id);
		await restoreSeat(actors[0].id);
		const planted = await authority(0);
		assert.equal(planted.actor.context.kind, "seat");
		refused(
			await documentsWriter.useForChurch(db, member, {
				documentId: sourceDoc.id,
				revisionId: sourceRevision.revision_id,
				requestKey: "copy-member",
			}),
			"unavailable",
		);
		const copy = ok(
			await documentsWriter.useForChurch(db, planted, {
				documentId: sourceDoc.id,
				revisionId: sourceRevision.revision_id,
				requestKey: "copy-1",
			}),
		);
		assert.equal(copy.tenantId, P);
		assert.deepEqual(copy.body, doc("We serve our community."));
		assert.equal(copy.copiedFromRevisionId, sourceRevision.revision_id);
		assert.equal(copy.copiedFromHash, sourceRevision.content_hash);
		await endSeat(actors[0].id);
		ok(
			await documentsWriter.saveNative(db, await authority(0), {
				title: "Personal values",
				body: doc("Later private edit"),
				documentId: sourceDoc.id,
				expectedRevision: sourceDoc.revision,
			}),
		);
		await restoreSeat(actors[0].id);
		assert.deepEqual(
			ok(await documentsWriter.read(db, await authority(2), { documentId: copy.id })).body,
			doc("We serve our community."),
		);

		const generated = ok(
			await documentsWriter.generate(
				db,
				await authority(2),
				{ templateId: "commitment-card", format: "pdf", requestKey: "survives-purge" },
				storage,
			),
		);
		const witness = (
			await admin.execute(sql`
				INSERT INTO lifecycle_witness (
					kind, opaque_subject_id, account_id, request_id, requester_id, requester_opaque_id, request_revision, state,
					witness_checkpoint, cleanup_state, requested_at, cancel_until
				)
				SELECT 'account', ${actors[0].id}::uuid, ${actors[0].id}::uuid, ${randomUUID()}::uuid, ${actors[2].id}::uuid,
					${actors[2].id}::uuid, 1, 'purging', 1, 'not_started',
					stamp.requested_at, stamp.requested_at + interval '720 hours'
				FROM (SELECT clock_timestamp() - interval '744 hours' AS requested_at) stamp
				RETURNING id
			`)
		).rows[0].id;
		const removed = ok(await documentsWriter.purgeOwnedForDeletion(db, { witnessId: witness }));
		assert.equal(removed.removed >= 1, true);
		assert.equal(await countOf("document", `WHERE tenant_id = '${actors[0].id}'`), 0);
		assert.equal(await countOf("document_revision", `WHERE tenant_id = '${actors[0].id}'`), 0);
		const surviving = ok(await documentsWriter.read(db, await authority(2), { documentId: copy.id }));
		assert.deepEqual(surviving.body, doc("We serve our community."));
		assert.equal(surviving.copiedFromRevisionId, null);
		assert.equal(surviving.copiedFromHash, sourceRevision.content_hash);
		assert.equal((await fileKey(generated.id)).state, "ready");
		assert.equal(ok(await documentsWriter.purgeOwnedForDeletion(db, { witnessId: witness })).removed, 0);
		refused(await documentsWriter.purgeOwnedForDeletion(db, { witnessId: randomUUID() }), "unavailable");
	});

	test("AC:CASE-DOC-016 INV-documents: a native body is checked at the boundary, old text opens intact, and Use for this church writes one copy", async () => {
		const owner = await authority(2);
		const member = await authority(1);
		const text = (value, marks) => ({ type: "text", text: value, ...(marks ? { marks } : {}) });
		const para = (...content) => ({ type: "paragraph", ...(content.length ? { content } : {}) });
		const body = {
			type: "doc",
			content: [
				{ type: "heading", attrs: { level: 1 }, content: [text("Our values")] },
				para(
					text("We "),
					text("serve", [{ type: "bold" }]),
					text(" "),
					text("Austin", [{ type: "link", attrs: { href: "https://austin.example" } }]),
				),
				{
					type: "bulletList",
					content: [
						{ type: "listItem", content: [para(text("Pray first"))] },
						{ type: "listItem", content: [para(text("Go together"))] },
					],
				},
				{ type: "quote", content: [para(text("Love your neighbor"))] },
				{ type: "divider" },
				para(),
			],
		};
		const revisions = () => countOf("document_revision", `WHERE tenant_id = '${P}'`);
		const audits = () => countOf("audit_event", `WHERE tenant_id = '${P}' AND action LIKE 'documents.%'`);

		// Criterion 5: the stored row is the body node; any other shape, an unsafe link or a block outside the set writes nothing.
		const saved = ok(
			await documentsWriter.saveNative(db, owner, { title: "Values draft", body, expectedRevision: "0" }),
		);
		const stored = await currentOf(saved.id);
		assert.deepEqual(JSON.parse(stored.body), body);
		assert.equal(stored.content_hash, sha(JSON.stringify(body)));
		assert.equal(saved.revisionId, stored.revision_id);
		assert.equal(saved.textRevision, false);
		const church = ok(
			await documentsWriter.createFromTemplate(db, owner, {
				templateId: "conflict-of-interest-policy",
				requestKey: randomUUID(),
			}),
		);
		const refusals = [
			"Plain text from before",
			{ type: "doc", content: [{ type: "slot", content: [para(text("Statement"))] }] },
			{ type: "doc", content: [para({ type: "field", attrs: { key: "church_name" } })] },
			{ type: "doc", content: [{ type: "image", attrs: { source: "logo" } }] },
			{
				type: "doc",
				content: [
					{ type: "table", attrs: { columns: [{ id: "a", label: "A", type: "text", width: 1 }] }, content: [] },
				],
			},
			{ type: "doc", content: [para(text("Click", [{ type: "link", attrs: { href: "javascript:alert(1)" } }]))] },
			{ type: "doc", content: [para(text("Tagged", [{ type: "tag" }]))] },
			{ type: "doc", content: [para(), { type: "heading", attrs: { level: 2 } }] },
		];
		const [beforeRevisions, beforeAudits] = [await revisions(), await audits()];
		for (const bad of refusals) {
			refused(
				await documentsWriter.saveNative(db, owner, { title: "Bad", body: bad, expectedRevision: "0" }),
				"invalid_input",
			);
			refused(
				await documentsWriter.saveNative(db, owner, {
					title: "Bad",
					body: bad,
					documentId: saved.id,
					expectedRevision: saved.revision,
				}),
				"invalid_input",
			);
		}
		// The stored kind decides: a plain save on a Church Document, or a Church Document save on a plain one, writes nothing.
		refused(
			await documentsWriter.saveNative(db, owner, {
				title: "Policy",
				body,
				documentId: church.id,
				expectedRevision: church.revision,
			}),
			"unavailable",
		);
		const churchBody = ok(await documentsWriter.readChurch(db, owner, { documentId: church.id })).body;
		refused(
			await documentsWriter.saveNative(db, owner, {
				documentId: saved.id,
				expectedRevision: saved.revision,
				body: churchBody,
			}),
			"unavailable",
		);
		assert.equal(await revisions(), beforeRevisions);
		assert.equal(await audits(), beforeAudits);
		assert.deepEqual(JSON.parse((await currentOf(saved.id)).body), body);

		// Criterion 1: the page read returns the plain document of the current owner, and nothing for anyone else.
		assert.deepEqual(ok(await documentsWriter.read(db, member, { documentId: saved.id })).body, body);
		refused(await documentsWriter.read(db, owner, { documentId: randomUUID() }), "unavailable");
		refused(await documentsWriter.read(db, owner, { documentId: church.id }), "unavailable");
		refused(await documentsWriter.read(db, await authority(3), { documentId: saved.id }), "unavailable");
		refused(await documentsWriter.read(db, await authority(4), { documentId: saved.id }), "unavailable");
		await endSeat(actors[1].id);
		refused(await documentsWriter.read(db, await authority(1), { documentId: saved.id }), "unavailable");
		await restoreSeat(actors[1].id);

		// Criterion 6: a text revision saved before this change opens as its lines, and a save adds the body after it.
		const old = randomUUID();
		const oldRevision = randomUUID();
		const oldText = "First line\nSecond line\n\nFourth line";
		await admin.execute(
			sql`INSERT INTO document (id, tenant_id, kind, title, revision) VALUES (${old}::uuid, ${P}::uuid, 'native', 'Old notes', 1)`,
		);
		await admin.execute(sql`
			INSERT INTO document_revision (id, tenant_id, document_id, version_number, body, content_hash, recorded_at)
			VALUES (${oldRevision}::uuid, ${P}::uuid, ${old}::uuid, 1, ${oldText}, ${sha(oldText)}, clock_timestamp())
		`);
		await admin.execute(sql`UPDATE document SET current_revision_id = ${oldRevision}::uuid WHERE id = ${old}::uuid`);
		const opened = ok(await documentsWriter.read(db, owner, { documentId: old }));
		assert.equal(opened.textRevision, true);
		assert.deepEqual(opened.body, {
			type: "doc",
			content: [para(text("First line")), para(text("Second line")), para(), para(text("Fourth line"))],
		});
		const resaved = ok(
			await documentsWriter.saveNative(db, owner, {
				title: "Old notes",
				body: opened.body,
				documentId: old,
				expectedRevision: opened.revision,
			}),
		);
		const rows = (
			await admin.execute(
				sql`SELECT version_number, body FROM document_revision WHERE document_id = ${old}::uuid ORDER BY version_number`,
			)
		).rows;
		assert.deepEqual(
			rows.map((row) => row.version_number),
			[1, 2],
		);
		assert.equal(rows[0].body, oldText);
		assert.deepEqual(JSON.parse(rows[1].body), opened.body);
		assert.equal(resaved.textRevision, false);

		// Criterion 7: an imported file lands as paragraphs and saves as a body; a refused one leaves the document as it was.
		const imported = ok(
			await documentsWriter.importTextOrWord(
				db,
				owner,
				{
					title: "Imported notes",
					format: "text",
					bytes: Buffer.from("One\nTwo").toString("base64"),
					documentId: old,
					expectedRevision: resaved.revision,
					requestKey: randomUUID(),
				},
				storage,
			),
		);
		assert.deepEqual(JSON.parse((await currentOf(old)).body), {
			type: "doc",
			content: [para(text("One")), para(text("Two"))],
		});
		refused(
			await documentsWriter.importTextOrWord(
				db,
				owner,
				{
					title: "Imported notes",
					format: "text",
					bytes: Buffer.from(" \n ").toString("base64"),
					documentId: old,
					expectedRevision: imported.revision,
					requestKey: randomUUID(),
				},
				storage,
			),
			"invalid_input",
		);
		assert.equal((await currentOf(old)).revision, imported.revision);

		// Criterion 8: the core-values evidence is the body's plain text in reading order; a body of empty blocks never qualifies.
		const designated = ok(
			await documentsWriter.designateCoreValues(db, owner, { documentId: saved.id, expectedRevision: saved.revision }),
		);
		assert.equal(
			ok(await documentsWriter.readCoreValuesEvidence(db, member, {})).text,
			"Our values\nWe serve Austin\nPray first\nGo together\nLove your neighbor",
		);
		const blank = ok(
			await documentsWriter.saveNative(db, owner, { title: "Blank later", body: doc("temp"), expectedRevision: "0" }),
		);
		const blankRevision = randomUUID();
		const blankBody = JSON.stringify({ type: "doc", content: [para(), { type: "heading", attrs: { level: 2 } }] });
		await admin.execute(sql`
			INSERT INTO document_revision (id, tenant_id, document_id, version_number, body, content_hash, recorded_at)
			VALUES (${blankRevision}::uuid, ${P}::uuid, ${blank.id}::uuid, 2, ${blankBody}, ${sha(blankBody)}, clock_timestamp())
		`);
		await admin.execute(
			sql`UPDATE document SET current_revision_id = ${blankRevision}::uuid WHERE id = ${blank.id}::uuid`,
		);
		refused(
			await documentsWriter.designateCoreValues(db, owner, { documentId: blank.id, expectedRevision: blank.revision }),
			"unavailable",
		);
		assert.equal((await currentOf(blank.id)).kind, "native");

		// Criterion 9: archive takes the document out of the list and the evidence; its revisions stay stored.
		ok(await documentsWriter.archive(db, owner, { documentId: saved.id, expectedRevision: designated.revision }));
		assert.equal(
			ok(await documentsWriter.listOwned(db, owner, {})).documents.some((item) => item.id === saved.id),
			false,
		);
		assert.deepEqual(ok(await documentsWriter.readCoreValuesEvidence(db, owner, {})), { documentId: null, text: null });
		assert.equal(await countOf("document_revision", `WHERE document_id = '${saved.id}'`), 1);

		// Criteria 11 and 12: the picker lists the Owner's own live account documents with text, and one key makes one copy.
		await endSeat(actors[2].id);
		const mine = await authority(2);
		const source = ok(
			await documentsWriter.saveNative(db, mine, { title: "Prayer plan", body, expectedRevision: "0" }),
		);
		const gone = ok(
			await documentsWriter.saveNative(db, mine, { title: "Old plan", body: doc("Retired"), expectedRevision: "0" }),
		);
		ok(await documentsWriter.archive(db, mine, { documentId: gone.id, expectedRevision: gone.revision }));
		const empty = ok(
			await documentsWriter.saveNative(db, mine, { title: "Shell", body: doc("temp"), expectedRevision: "0" }),
		);
		const emptyRevision = randomUUID();
		await admin.execute(sql`
			INSERT INTO document_revision (id, tenant_id, document_id, version_number, body, content_hash, recorded_at)
			VALUES (${emptyRevision}::uuid, ${actors[2].id}::uuid, ${empty.id}::uuid, 2, '   ', ${sha("   ")}, clock_timestamp())
		`);
		await admin.execute(
			sql`UPDATE document SET current_revision_id = ${emptyRevision}::uuid WHERE id = ${empty.id}::uuid`,
		);
		refused(await documentsWriter.listCopySources(db, mine, {}), "unavailable");
		await restoreSeat(actors[2].id);
		const theirs = ok(
			await documentsWriter.saveNative(db, await authority(4), {
				title: "Private notes",
				body: doc("Mine"),
				expectedRevision: "0",
			}),
		);
		const seated = await authority(2);
		const offered = ok(await documentsWriter.listCopySources(db, seated, {})).documents;
		assert.deepEqual(
			offered.map((item) => item.title),
			["Prayer plan"],
		);
		assert.equal(offered[0].revisionId, source.revisionId);
		refused(await documentsWriter.listCopySources(db, member, {}), "unavailable");

		const copies = () => countOf("audit_event", `WHERE tenant_id = '${P}' AND action = 'documents.copied'`);
		const churchDocs = () => countOf("document", `WHERE tenant_id = '${P}'`);
		const [docsBefore, copiesBefore] = [await churchDocs(), await copies()];
		const key = randomUUID();
		const request = { documentId: source.id, revisionId: source.revisionId, requestKey: key };
		const pair = await Promise.all([
			documentsWriter.useForChurch(db, seated, request),
			documentsWriter.useForChurch(db, seated, request),
		]);
		const [first, second] = pair.map(ok);
		assert.equal(first.id, second.id);
		const replay = ok(await documentsWriter.useForChurch(db, seated, request));
		assert.equal(replay.id, first.id);
		assert.equal(await churchDocs(), docsBefore + 1);
		assert.equal(await copies(), copiesBefore + 1);
		assert.equal(first.tenantId, P);
		assert.equal(first.kind, "native");
		assert.deepEqual(first.body, body);
		assert.equal(first.copiedFromRevisionId, source.revisionId);
		refused(
			await documentsWriter.useForChurch(db, seated, {
				documentId: theirs.id,
				revisionId: theirs.revisionId,
				requestKey: key,
			}),
			"conflict",
		);
		for (const [what, input, who] of [
			["another person's document", { documentId: theirs.id, revisionId: theirs.revisionId }, seated],
			["an archived document", { documentId: gone.id, revisionId: gone.revisionId }, seated],
			["an empty document", { documentId: empty.id, revisionId: emptyRevision }, seated],
			["a revision that is not current", { documentId: empty.id, revisionId: empty.revisionId }, seated],
			["a Member", { documentId: source.id, revisionId: source.revisionId }, member],
		])
			assert.equal(
				(await documentsWriter.useForChurch(db, who, { ...input, requestKey: randomUUID() })).status,
				"refused",
				what,
			);
		assert.equal(await churchDocs(), docsBefore + 1);
		assert.equal(await copies(), copiesBefore + 1);

		// A later edit of the original does not reach the copy, and the original stays in your documents.
		await endSeat(actors[2].id);
		ok(
			await documentsWriter.saveNative(db, await authority(2), {
				title: "Prayer plan",
				body: doc("Changed later"),
				documentId: source.id,
				expectedRevision: source.revision,
			}),
		);
		assert.equal(
			ok(await documentsWriter.listOwned(db, await authority(2), {})).documents.some((item) => item.id === source.id),
			true,
		);
		await restoreSeat(actors[2].id);
		assert.deepEqual(ok(await documentsWriter.read(db, member, { documentId: first.id })).body, body);
	});
});
