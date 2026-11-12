import { fixture, ok, refusedWith } from "../../support/fixture.mts";
import { sql } from "../../../packages/db/node_modules/drizzle-orm/index.js";
import { S3Client } from "../../../packages/db/node_modules/@aws-sdk/client-s3/dist-es/index.js";
import { RequestActor } from "../../../packages/domain/src/access/session.ts";
import { library } from "../../../packages/domain/src/documents/catalog.ts";
import { documentsReader, documentsWriter } from "../../../packages/domain/src/documents/index.ts";
import { nativeFromText, nativeText, readNative } from "../../../packages/contracts/src/documents/native.ts";
import test, { after, before, describe } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import * as W from "./fixtures/word.mts";
import { syncBuiltinESMExports } from "node:module";
import zlib from "node:zlib";

const database = await fixture({ prefix: "wp037", plant: { name: "Harvest Point" } });
const { admin, schema } = database;
const db = database.pools.runtime;
const P = database.tenant.id;
const Q = (await database.plant({ name: "Other Plant", timezone: "America/New_York" })).id;
const actors = [
	database.actors.owner,
	database.actors.member,
	database.actors.admin,
	await database.actor({ kind: "plant", id: Q }, "admin"),
	await database.actor(null, "owner", { account: { registration_kind: "planter" } }),
];
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

const refusedPrivate = refusedWith({ hidden: ["Harvest Point", "Quinn Canary"] });
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

const { storedZip } = W;
const paragraph = (text) =>
	`<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>${text}</w:t></w:r></w:p></w:body></w:document>`;
const docx = (text, extra = []) => storedZip([{ name: "word/document.xml", data: paragraph(text) }, ...extra]);
/** A Word file whose one entry's header declares `declared` bytes while its deflate stream inflates to `inflated`. */
function lyingZip(declared, inflated) {
	const name = Buffer.from("word/document.xml");
	const data = zlib.deflateRawSync(Buffer.alloc(inflated));
	const local = Buffer.alloc(30 + name.length);
	local.writeUInt32LE(0x04034b50, 0);
	local.writeUInt16LE(20, 4);
	local.writeUInt16LE(8, 8);
	local.writeUInt32LE(data.length, 18);
	local.writeUInt32LE(declared, 22);
	local.writeUInt16LE(name.length, 26);
	name.copy(local, 30);
	return Buffer.concat([local, data]);
}
function zipBomb() {
	const name = Buffer.from("word/document.xml");
	const local = Buffer.alloc(30 + name.length + 1);
	local.writeUInt32LE(0x04034b50, 0);
	local.writeUInt16LE(20, 4);
	local.writeUInt32LE(1, 18);
	local.writeUInt32LE(40 * 1024 * 1024 + 1, 22);
	local.writeUInt16LE(name.length, 26);
	name.copy(local, 30);
	return local;
}

before(async () => {
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
	await database.close();
});

describe("AC:CASE-DOC-003 AC:CASE-DOC-016 api generated files and owned documents", { concurrency: 1 }, () => {
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
		refusedPrivate(
			await documentsWriter.generate(
				db,
				owner,
				{ templateId: card.id, format: "pdf", requestKey: "foreign-subject", meetingId: foreignMeeting },
				storage,
			),
			"invalid_subject",
		);
		refusedPrivate(
			await documentsWriter.generate(
				db,
				owner,
				{ templateId: card.id, format: "ppt", requestKey: "bad-format" },
				storage,
			),
			"invalid_input",
		);
		refusedPrivate(
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
		const refusal = refusedPrivate(
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
		const conflict = refusedPrivate(
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
		refusedPrivate(
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
		refusedPrivate(
			await documentsWriter.download(db, other, { documentId: saved.pdf.made.id }, storage),
			"unavailable",
		);
		refusedPrivate(
			await documentsWriter.generate(
				db,
				await authority(4),
				{ templateId: card.id, format: "pdf", requestKey: "account" },
				storage,
			),
			"unavailable",
		);
		refusedPrivate(await documentsWriter.download(db, owner, { documentId: randomUUID() }, storage), "unavailable");

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
		refusedPrivate(await documentsWriter["history.get"](db, owner, { documentId: randomUUID() }), "unavailable");
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
		// The link expires 300 s after the signing date it carries, read back from the URL, not from the wall clock.
		const query = new URL(signed.url).searchParams;
		assert.equal(query.get("X-Amz-Expires"), "300");
		const signedAt = Date.parse(
			query.get("X-Amz-Date").replace(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/, "$1-$2-$3T$4:$5:$6Z"),
		);
		const ttl = Date.parse(signed.expiresAt) - signedAt;
		assert.equal(ttl >= 300_000 && ttl < 301_000, true, String(ttl));
	});

	test("AC:CASE-DOC-002 generate with a meeting stores the bytes its preview showed: the meeting's date and its rows", async () => {
		const owner = await authority(0);
		const meeting = randomUUID();
		await admin.execute(
			sql`INSERT INTO meeting(id,plant_id,type,title,local_date,local_time,timezone,starts_at,resolver_version,status,attendance_revision,
					agenda,venue_name,venue_address,vision_number)
				VALUES(${meeting},${P},'vision_meeting',NULL,'2026-11-10','18:30','America/Chicago','2026-11-11T00:30:00Z','test','planning',1,
					${JSON.stringify([{ id: "a", title: "Greeting", minutes: 10 }])}::jsonb,'Harbor Hall','12 Dock Street',7)`,
		);
		const input = { templateId: "vision-meeting-agenda", format: "pdf", meetingId: meeting };
		const preview = ok(await documentsReader.preview(db, owner, input));
		assert.ok(preview.digest, "the preview renders from the meeting");
		const dated = preview.fields.find((field) => field.key === "meeting_date");
		assert.equal(dated.source, "meeting");
		// The same template with the meeting's date typed in, but no meeting, prints no meeting rows: other bytes.
		const unbound = ok(
			await documentsReader.preview(db, owner, {
				templateId: "vision-meeting-agenda",
				format: "pdf",
				overrides: { meeting_date: dated.value },
			}),
		);
		assert.notEqual(unbound.digest, preview.digest);

		const made = ok(await documentsWriter.generate(db, owner, { ...input, requestKey: "t124-meeting" }, storage));
		assert.equal(made.digest, preview.digest, "generate stores the preview's bytes");
		const stored = await fileKey(made.id);
		assert.equal(sha(client.objects.get(stored.opaque_key)), preview.digest);
		assert.deepEqual(client.objects.get(stored.opaque_key), Buffer.from(preview.artifact, "base64"));
		// A meeting of another kind is no subject for this agenda, as in the preview.
		const other = randomUUID();
		await admin.execute(
			sql`INSERT INTO meeting(id,plant_id,type,title,local_date,local_time,timezone,starts_at,resolver_version,status,attendance_revision)
				VALUES(${other},${P},'orientation',NULL,'2026-11-10','18:30','America/Chicago','2026-11-11T00:30:00Z','test','planning',1)`,
		);
		refusedPrivate(await documentsReader.preview(db, owner, { ...input, meetingId: other }), "invalid_subject");
		refusedPrivate(
			await documentsWriter.generate(db, owner, { ...input, meetingId: other, requestKey: "t124-other" }, storage),
			"invalid_subject",
		);
	});

	test("AC:CASE-DOC-016 AC:SCHEMA-008 AC:WIKI52-003 one owner, unsafe imports stay out, and the church copy survives purge", async () => {
		const owner = await authority(0);
		const member = await authority(1);
		refusedPrivate(
			await documentsWriter.saveNative(db, member, { title: "No", body: doc("Member text"), expectedRevision: "0" }),
			"unavailable",
		);
		refusedPrivate(
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
		refusedPrivate(
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
		refusedPrivate(
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
		refusedPrivate(
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
		refusedPrivate(
			await documentsWriter.archive(db, owner, { documentId: values.id, expectedRevision: designated.revision }),
			"conflict",
		);
		assert.deepEqual(ok(await documentsWriter.readCoreValuesEvidence(db, member, {})), {
			documentId: null,
			text: null,
		});
		refusedPrivate(
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
			["text", Buffer.from("   ")],
			["text", Buffer.from("hello\u0000")],
			["text", Buffer.from([0xd0, 0xcf, 0x11, 0xe0])],
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
		for (const [index, [format, bytes]] of rejects.entries()) {
			refusedPrivate(
				await documentsWriter.importTextOrWord(
					db,
					owner,
					{
						title: "Imported",
						format,
						bytes,
						documentId: kept.id,
						expectedRevision: kept.revision,
						requestKey: `bad-${format}-${index}`,
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
		const drifted = refusedPrivate(
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
		refusedPrivate(await documentsWriter.read(db, owner, { documentId: secret.id }), "unavailable");
		const beforeCopy = await countOf("document", `WHERE tenant_id = '${P}'`);
		refusedPrivate(
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
		refusedPrivate(
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
		refusedPrivate(await documentsWriter.purgeOwnedForDeletion(db, { witnessId: randomUUID() }), "unavailable");
	});

	test("AC:CASE-DOC-016 a Word entry that declares 10 bytes and inflates past 40 MiB is refused without inflating past its declared size", async () => {
		const owner = await authority(2);
		const bytes = lyingZip(10, 100 * 1024 * 1024);
		// Every inflate the import runs is watched for how much output it may make.
		const real = zlib.inflateRawSync;
		const limits = [];
		zlib.inflateRawSync = (input, options) => {
			limits.push(options?.maxOutputLength ?? Infinity);
			return real(input, options);
		};
		syncBuiltinESMExports();
		try {
			refusedPrivate(
				await documentsWriter.importTextOrWord(
					db,
					owner,
					{ title: "Lying header", format: "docx", bytes, expectedRevision: "0", requestKey: "t117-lying-header" },
					storage,
				),
				"invalid_input",
			);
		} finally {
			zlib.inflateRawSync = real;
			syncBuiltinESMExports();
		}
		assert.equal(limits.length, 1, "the one entry is inflated once");
		assert.ok(limits[0] <= 40 * 1024 * 1024, `the inflate may make at most the cap, not ${limits[0]} bytes`);
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
			refusedPrivate(
				await documentsWriter.saveNative(db, owner, { title: "Bad", body: bad, expectedRevision: "0" }),
				"invalid_input",
			);
			refusedPrivate(
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
		refusedPrivate(
			await documentsWriter.saveNative(db, owner, {
				title: "Policy",
				body,
				documentId: church.id,
				expectedRevision: church.revision,
			}),
			"unavailable",
		);
		const churchSave = ok(await documentsWriter.readChurch(db, owner, { documentId: church.id })).body;
		refusedPrivate(
			await documentsWriter.saveNative(db, owner, {
				documentId: saved.id,
				expectedRevision: saved.revision,
				body: churchSave,
			}),
			"unavailable",
		);
		assert.equal(await revisions(), beforeRevisions);
		assert.equal(await audits(), beforeAudits);
		assert.deepEqual(JSON.parse((await currentOf(saved.id)).body), body);

		// Criterion 1: the page read returns the plain document of the current owner, and nothing for anyone else.
		assert.deepEqual(ok(await documentsWriter.read(db, member, { documentId: saved.id })).body, body);
		refusedPrivate(await documentsWriter.read(db, owner, { documentId: randomUUID() }), "unavailable");
		refusedPrivate(await documentsWriter.read(db, owner, { documentId: church.id }), "unavailable");
		refusedPrivate(await documentsWriter.read(db, await authority(3), { documentId: saved.id }), "unavailable");
		refusedPrivate(await documentsWriter.read(db, await authority(4), { documentId: saved.id }), "unavailable");
		await endSeat(actors[1].id);
		refusedPrivate(await documentsWriter.read(db, await authority(1), { documentId: saved.id }), "unavailable");
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
					bytes: Buffer.from("One\nTwo"),
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
		// A Word file's paragraphs land as paragraphs too, one for each, not run together into one line.
		const words =
			'<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>' +
			"<w:p><w:r><w:t>Greeters welcome</w:t></w:r><w:r><w:t> every guest</w:t></w:r></w:p><w:p><w:r><w:t>Kids team</w:t></w:r></w:p>" +
			"</w:body></w:document>";
		const fromWord = ok(
			await documentsWriter.importTextOrWord(
				db,
				owner,
				{
					title: "Volunteer roles",
					format: "docx",
					bytes: storedZip([{ name: "word/document.xml", data: words }]),
					expectedRevision: "0",
					requestKey: randomUUID(),
				},
				storage,
			),
		);
		assert.deepEqual(fromWord.body, {
			type: "doc",
			content: [para(text("Greeters welcome every guest")), para(text("Kids team"))],
		});
		refusedPrivate(
			await documentsWriter.importTextOrWord(
				db,
				owner,
				{
					title: "Imported notes",
					format: "text",
					bytes: Buffer.from(" \n "),
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
		refusedPrivate(
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
		refusedPrivate(await documentsWriter.listCopySources(db, mine, {}), "unavailable");
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
		refusedPrivate(await documentsWriter.listCopySources(db, member, {}), "unavailable");

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
		refusedPrivate(
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

	test("AC:CASE-DOC-016 a Word file keeps its headings, lists and links as native nodes", async () => {
		const owner = await authority(2);
		const member = await authority(1);
		const text = (value, href) => ({
			type: "text",
			text: value,
			...(href ? { marks: [{ type: "link", attrs: { href } }] } : {}),
		});
		const para = (...content) => ({ type: "paragraph", ...(content.length ? { content } : {}) });
		const heading = (level, ...content) => ({ type: "heading", attrs: { level }, content });
		const items = (...texts) => texts.map((value) => ({ type: "listItem", content: [para(text(value))] }));
		const bullets = (...texts) => ({ type: "bulletList", content: items(...texts) });
		const ordered = (...texts) => ({ type: "orderedList", content: items(...texts) });
		const importWord = async (bytes, requestKey = randomUUID()) =>
			documentsWriter.importTextOrWord(
				db,
				owner,
				{ title: "From Word", format: "docx", bytes, expectedRevision: "0", requestKey },
				storage,
			);
		const stored = async (result) => {
			const value = ok(result);
			const body = JSON.parse((await currentOf(value.id)).body);
			assert.deepEqual(value.body, body);
			return body;
		};

		// Criterion 1: headings by style name (any style id, or a style based on one) or by outline level.
		const headingStyles = W.styles(
			W.style("Normal", "Normal"),
			W.style("Heading1", "heading 1"),
			W.style("berschrift2", "heading 2", '<w:basedOn w:val="Normal"/>'),
			W.style("Heading3", "heading 3"),
			W.style("Kapitel", "Kapitel", '<w:basedOn w:val="Heading3"/>'),
			W.style("Heading4", "heading 4"),
			W.style("Heading9", "heading 9"),
			W.style("Chapter", "Chapter", '<w:pPr><w:outlineLvl w:val="1"/></w:pPr>'),
			W.style("Loop", "Loop", '<w:basedOn w:val="Loop"/>'),
		);
		assert.deepEqual(
			await stored(
				await importWord(
					W.word(
						W.styled("Heading1", "Our values") +
							W.styled("berschrift2", "Gemeinde") +
							W.styled("Kapitel", "Based on heading 3") +
							W.styled("Heading4", "Four") +
							W.styled("Heading9", "Nine") +
							W.styled("Chapter", "Outline two") +
							W.p("Outline one", '<w:outlineLvl w:val="0"/>') +
							W.styled("Heading1", ["Line one", W.br, "line two"]) +
							W.styled("Normal", "Body text") +
							W.styled("Loop", "Cyclic style") +
							W.styled("Missing", "Unknown style"),
						{ styles: headingStyles },
					),
				),
			),
			{
				type: "doc",
				content: [
					heading(1, text("Our values")),
					heading(2, text("Gemeinde")),
					heading(3, text("Based on heading 3")),
					heading(3, text("Four")),
					heading(3, text("Nine")),
					heading(2, text("Outline two")),
					heading(1, text("Outline one")),
					heading(1, text("Line one"), { type: "hardBreak" }, text("line two")),
					para(text("Body text")),
					para(text("Cyclic style")),
					para(text("Unknown style")),
				],
			},
		);

		// Criteria 2 to 4: bulleted and numbered runs, the breaks between lists, nested levels and a list item's line break.
		const listParts = {
			styles: W.styles(
				W.style("ListBullet", "List Bullet", '<w:pPr><w:numPr><w:numId w:val="1"/></w:numPr></w:pPr>'),
				W.style("Heading1", "heading 1"),
			),
			numbering: W.numbering(
				["1", ["bullet", "bullet"]],
				["2", ["decimal", "lowerLetter"]],
				["3", ["bullet"]],
				["4", ["lowerRoman"]],
				["5", ["upperLetter"]],
				["6", ["decimal", "bullet"]],
				["7", ["bullet", "decimal"]],
			),
		};
		assert.deepEqual(
			await stored(
				await importWord(
					W.word(
						W.styled("ListBullet", "Bread") +
							W.numbered("1", "Cups") +
							W.numbered("1", "Nested cup", 1) +
							W.numbered("2", "First") +
							W.numbered("2", "Sub a", 1) +
							W.numbered("2", "Second") +
							W.numbered("4", "Roman i") +
							W.p("Between") +
							W.numbered("4", "Roman ii") +
							W.numbered("3", "Other bullets") +
							W.numbered("5", "Letter A") +
							W.p() +
							W.numbered("3", ["Two", W.br, "lines"]) +
							W.p("Not a list", '<w:numPr><w:ilvl w:val="0"/><w:numId w:val="0"/></w:numPr>') +
							W.p("Unknown list", '<w:numPr><w:ilvl w:val="0"/><w:numId w:val="77"/></w:numPr>') +
							W.numbered("6", "Step A") +
							W.numbered("6", "detail a1", 1) +
							W.numbered("6", "Step B") +
							W.numbered("7", "Point") +
							W.numbered("7", "sub 1", 1),
						listParts,
					),
				),
			),
			{
				type: "doc",
				content: [
					bullets("Bread", "Cups", "Nested cup"),
					ordered("First", "Sub a", "Second"),
					ordered("Roman i"),
					para(text("Between")),
					ordered("Roman ii"),
					bullets("Other bullets"),
					ordered("Letter A"),
					para(),
					{
						type: "bulletList",
						content: [{ type: "listItem", content: [para(text("Two"), { type: "hardBreak" }, text("lines"))] }],
					},
					para(text("Not a list")),
					para(text("Unknown list")),
					ordered("Step A", "detail a1", "Step B"),
					bullets("Point", "sub 1"),
				],
			},
		);
		const many = Array.from({ length: 250 }, (_, i) => `Step ${i + 1}`);
		assert.deepEqual(
			await stored(await importWord(W.word(many.map((step) => W.numbered("2", step)).join(""), listParts))),
			{ type: "doc", content: [ordered(...many.slice(0, 200)), ordered(...many.slice(200))] },
		);

		// Criterion 5: links to safe addresses keep their exact address; every other target stays plain text.
		const linkRels = W.rels(
			["rId1", "https://example.org/give?fund=1&amp;week=2"],
			["rId2", "mailto:team@example.org"],
			["rId3", "javascript:alert(1)"],
			["rId4", "notes/other.docx", false],
			["rId5", "relative/page.html"],
			["rId6", "http://example.org/plain"],
		);
		assert.deepEqual(
			await stored(
				await importWord(
					W.word(
						W.p(["Give ", W.link("rId1", "online"), " or ", W.link("rId2", "email us")]) +
							W.p([
								W.link("rId3", "script "),
								'<w:hyperlink w:anchor="top"><w:r><w:t>anchor </w:t></w:r></w:hyperlink>',
								W.link("rId4", "relative "),
								W.link("rId5", "external relative "),
								W.link("rId404", "missing"),
							]) +
							W.p([W.link("rId6", "first"), W.link("rId6", " same")]),
						{ rels: linkRels },
					),
				),
			),
			{
				type: "doc",
				content: [
					para(
						text("Give "),
						text("online", "https://example.org/give?fund=1&week=2"),
						text(" or "),
						text("email us", "mailto:team@example.org"),
					),
					para(text("script anchor relative external relative missing")),
					para(text("first same", "http://example.org/plain")),
				],
			},
		);
		const hyperlinkTo = (target) =>
			W.word(W.p("outside"), {
				rels: `<Relationships><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="${target}" TargetMode="External"/></Relationships>`,
			});
		for (const target of ["file:///etc/passwd", "../../outside.docx"])
			refusedPrivate(await importWord(hyperlinkTo(target)), "invalid_input");

		// documents/doc-11: a part target resolves from its own part's folder, so the `../docProps/meta.xml` that
		// macOS textutil writes stays inside the package and imports; a tab reads as a space and character references
		// decode, named ones as before.
		assert.deepEqual(
			await stored(
				await importWord(
					W.textutilWord([
						'<w:t xml:space="preserve">Name:</w:t><w:tab/><w:t xml:space="preserve">Jo&#8217;s</w:t>',
						'<w:t xml:space="preserve">Hex&#x2019;s &amp; more &#38;#38; &#1;</w:t>',
					]),
				),
			),
			{ type: "doc", content: [para(text("Name: Jo’s")), para(text("Hex’s & more &#38; &#1;"))] },
		);
		const partRel = (target) =>
			`<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/customXml" Target="${target}"/>`;
		for (const target of ["/docProps/meta.xml", "./theme/../../docProps/meta.xml"])
			ok(await importWord(W.textutilWord(["<w:t>Inside</w:t>"], partRel(target))));
		// A target that climbs out of the package is still refused, self-closed or not.
		for (const rel of [
			partRel("../../outside.xml"),
			partRel("theme/../../../outside.xml"),
			partRel("../../outside.xml").replace("/>", "></Relationship>"),
		])
			refusedPrivate(await importWord(W.textutilWord(["<w:t>Outside</w:t>"], rel)), "invalid_input");

		// Criterion 6: tables and text boxes stay paragraphs in reading order; the drawing's fallback copy is not repeated.
		const textBox = (inner) =>
			`<w:r><mc:AlternateContent xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006"><mc:Choice Requires="wps"><w:drawing><wps:txbx><w:txbxContent>${inner}</w:txbxContent></wps:txbx></w:drawing></mc:Choice><mc:Fallback><w:pict><v:textbox><w:txbxContent>${inner}</w:txbxContent></v:textbox></w:pict></mc:Fallback></mc:AlternateContent></w:r>`;
		const mixed = ok(
			await importWord(
				W.word(
					W.styled("Heading1", "Plan") +
						`<w:tbl><w:tr><w:tc>${W.styled("Heading1", "Cell heading")}</w:tc><w:tc>${W.numbered("1", "Cell item")}</w:tc></w:tr></w:tbl>` +
						W.p(["Before box ", textBox(W.p("Inside box")), "after box"]) +
						W.p() +
						W.p("Tom &amp; Ann &lt;3") +
						W.p() +
						W.p(),
					listParts,
				),
			),
		);
		assert.deepEqual(mixed.body, {
			type: "doc",
			content: [
				heading(1, text("Plan")),
				para(text("Cell heading")),
				para(text("Cell item")),
				para(text("Before box ")),
				para(text("Inside box")),
				para(text("after box")),
				para(),
				para(text("Tom & Ann <3")),
			],
		});
		assert.equal(
			nativeText(mixed.body),
			"Plan\nCell heading\nCell item\nBefore box \nInside box\nafter box\n\nTom & Ann <3",
		);

		// Criterion 7: one structured revision and one audit row; the same key replays it; a body past a format limit
		// writes nothing.
		const key = randomUUID();
		const bytes = W.word(
			W.styled("Heading1", "Values") + W.numbered("1", "Pray first") + W.numbered("1", "Go together"),
			listParts,
		);
		const first = ok(await importWord(bytes, key));
		const replay = ok(await importWord(bytes, key));
		assert.equal(replay.id, first.id);
		assert.equal(replay.revision, first.revision);
		assert.equal(await countOf("document_revision", `WHERE document_id = '${first.id}'`), 1);
		assert.equal(await countOf("audit_event", `WHERE action = 'documents.imported' AND request_key = '${key}'`), 1);
		const rows = async () => [
			await countOf("document"),
			await countOf("document_revision"),
			await countOf("file_object"),
			await countOf("audit_event"),
		];
		const before = await rows();
		const huge = Array.from({ length: 2600 }, (_, i) => W.p(`Line ${i}`)).join("");
		const tooLarge = refusedPrivate(await importWord(W.word(huge)), "invalid_input");
		assert.match(JSON.stringify(tooLarge), /too large/);
		assert.deepEqual(await rows(), before);

		// Criterion 9: the core-values evidence of a structured import is its plain text lines in reading order.
		ok(
			await documentsWriter.designateCoreValues(db, owner, { documentId: first.id, expectedRevision: first.revision }),
		);
		assert.equal(
			ok(await documentsWriter.readCoreValuesEvidence(db, member, {})).text,
			"Values\nPray first\nGo together",
		);

		// Criterion 10: no styles or numbering part, or a malformed one, leaves plain paragraphs; an unclosed paragraph keeps
		// its text.
		const structured = W.styled("Heading1", "Title") + W.numbered("1", "Item");
		const plain = { type: "doc", content: [para(text("Title")), para(text("Item"))] };
		assert.deepEqual(await stored(await importWord(W.word(structured))), plain);
		assert.deepEqual(
			await stored(
				await importWord(
					W.word(structured, {
						styles: '<w:styles><w:style w:styleId="Heading1"><w:name w:val=',
						numbering: "<w:numbering><w:abstractNum <<<>>> </w:num>",
						rels: "<Relationships><Relationship Id=",
					}),
				),
			),
			plain,
		);
		assert.deepEqual(
			await stored(
				await importWord(
					storedZip([
						{
							name: "word/document.xml",
							data: "<w:document><w:body><w:p><w:r><w:t>Cut off</w:t></w:r><w:p><w:r><w:t>mid",
						},
					]),
				),
			),
			{ type: "doc", content: [para(text("Cut off")), para(text("mid"))] },
		);
	});

	test("AC:CASE-DOC-016 INV-documents T-100: plain tables save at the boundary, read back, feed core values and survive Use for this church", async () => {
		const owner = await authority(2);
		const member = await authority(1);
		const text = (value, marks) => ({ type: "text", text: value, ...(marks ? { marks } : {}) });
		const para = (...content) => ({ type: "paragraph", ...(content.length ? { content } : {}) });
		const cell = (...content) => ({ type: "cell", ...(content.length ? { content } : {}) });
		const column = (id, label, type) => ({ id, label, type, width: 0 });
		const grid = {
			type: "table",
			attrs: {
				style: "grid",
				header: true,
				zebra: true,
				columns: [
					column("item", "Item", "text"),
					column("count", "Count", "number"),
					column("cost", "Cost", "money"),
					column("done", "Done", "check"),
					column("n", "No.", "index"),
				],
			},
			content: [
				{
					type: "row",
					content: [
						cell(text("Chairs", [{ type: "link", attrs: { href: "https://example.org" } }, { type: "bold" }])),
						{ type: "cell", attrs: { value: 1200 } },
						{ type: "cell", attrs: { value: 3000.5 } },
						{ type: "cell", attrs: { checked: true } },
						cell(),
					],
				},
				{ type: "row", content: [cell(text("Tables", [{ type: "italic" }])), cell(), cell(), cell(), cell()] },
			],
		};
		const checklist = {
			type: "table",
			attrs: {
				style: "rows",
				header: false,
				columns: [{ id: "done", label: "Done", type: "check", width: 18 }, column("commitment", "Commitment", "text")],
			},
			content: [
				{ type: "row", content: [cell(), cell(text("Pray"))] },
				{ type: "row", content: [{ type: "cell", attrs: { checked: true } }, cell(text("Invite"))] },
			],
		};
		const body = { type: "doc", content: [para(text("Setup plan")), grid, para(text("Then")), checklist] };
		const revisions = () => countOf("document_revision", `WHERE tenant_id = '${P}'`);
		const audits = () => countOf("audit_event", `WHERE tenant_id = '${P}' AND action LIKE 'documents.%'`);

		// Criterion 7: the plain table set saves as the stored body node and reads back the same, for a Member too.
		const saved = ok(await documentsWriter.saveNative(db, owner, { title: "Setup", body, expectedRevision: "0" }));
		assert.deepEqual(JSON.parse((await currentOf(saved.id)).body), body);
		assert.deepEqual(ok(await documentsWriter.read(db, owner, { documentId: saved.id })).body, body);
		assert.deepEqual(ok(await documentsWriter.read(db, member, { documentId: saved.id })).body, body);

		// Each part a plain table refuses: nothing is written, on a new document or a save of this one.
		const changed = (change) => {
			const next = structuredClone(body);
			change(next.content[1]);
			return next;
		};
		const firstCell = (t) => t.content[0].content[0];
		const refusals = {
			"a budget table": changed((t) => (t.attrs.style = "ledger")),
			"a formula column": changed(
				(t) => (t.attrs.columns[1] = { ...t.attrs.columns[1], type: "formula", formula: "cost" }),
			),
			"a header color": changed((t) => (t.attrs.headerFill = "primary")),
			"write-in rows": changed((t) => (t.attrs.writeInRows = 3)),
			"a list field": changed((t) => (t.attrs.source = "people")),
			"a group row": changed((t) => (t.content[0].attrs = { role: "group" })),
			"a total row": changed((t) => (t.content[1].attrs = { role: "total" })),
			"a tag in a cell": changed((t) => (firstCell(t).content = [text("Chairs", [{ type: "tag" }])])),
			"a field in a cell": changed((t) => (firstCell(t).content = [{ type: "field", attrs: { key: "church_name" } }])),
			"an image in a cell": changed((t) => (firstCell(t).content = [{ type: "image", attrs: { source: "logo" } }])),
		};
		const [beforeRevisions, beforeAudits] = [await revisions(), await audits()];
		for (const bad of Object.values(refusals)) {
			refusedPrivate(
				await documentsWriter.saveNative(db, owner, { title: "Bad", body: bad, expectedRevision: "0" }),
				"invalid_input",
			);
			refusedPrivate(
				await documentsWriter.saveNative(db, owner, {
					title: "Setup",
					body: bad,
					documentId: saved.id,
					expectedRevision: saved.revision,
				}),
				"invalid_input",
			);
		}
		assert.equal(await revisions(), beforeRevisions);
		assert.equal(await audits(), beforeAudits);
		assert.deepEqual(JSON.parse((await currentOf(saved.id)).body), body);

		// Criterion 9: the evidence writes each table as its lines, header labels first, in reading order with the prose.
		ok(
			await documentsWriter.designateCoreValues(db, owner, { documentId: saved.id, expectedRevision: saved.revision }),
		);
		const evidence = ok(await documentsWriter.readCoreValuesEvidence(db, member, {}));
		assert.equal(evidence.documentId, saved.id);
		assert.equal(
			evidence.text,
			[
				"Setup plan",
				"Item | Count | Cost | Done | No.",
				"Chairs | 1,200 | $3,000.50 | [x] | 1",
				"Tables |  |  | [ ] | 2",
				"Then",
				"[ ] | Pray",
				"[x] | Invite",
			].join("\n"),
		);

		// A body whose only content is an empty table, or a table of empty cells, never qualifies: no save, no core values.
		const emptyRows = { type: "row", content: grid.attrs.columns.map(() => cell()) };
		const emptyBodies = [
			{ type: "doc", content: [{ ...grid, content: [] }] },
			{ type: "doc", content: [para(), { ...grid, content: [emptyRows, emptyRows] }] },
		];
		for (const empty of emptyBodies)
			refusedPrivate(
				await documentsWriter.saveNative(db, owner, { title: "Empty", body: empty, expectedRevision: "0" }),
				"invalid_input",
			);
		const shell = ok(
			await documentsWriter.saveNative(db, owner, { title: "Shell", body: doc("temp"), expectedRevision: "0" }),
		);
		const shellRevision = randomUUID();
		const shellBody = JSON.stringify(emptyBodies[1]);
		await admin.execute(sql`
			INSERT INTO document_revision (id, tenant_id, document_id, version_number, body, content_hash, recorded_at)
			VALUES (${shellRevision}::uuid, ${P}::uuid, ${shell.id}::uuid, 2, ${shellBody}, ${sha(shellBody)}, clock_timestamp())
		`);
		await admin.execute(
			sql`UPDATE document SET current_revision_id = ${shellRevision}::uuid WHERE id = ${shell.id}::uuid`,
		);
		refusedPrivate(
			await documentsWriter.designateCoreValues(db, owner, { documentId: shell.id, expectedRevision: shell.revision }),
			"unavailable",
		);

		// Criterion 10: Use for this church copies the tables intact, and a later table edit of the original leaves the copy.
		await endSeat(actors[2].id);
		const source = ok(
			await documentsWriter.saveNative(db, await authority(2), { title: "Setup tables", body, expectedRevision: "0" }),
		);
		await restoreSeat(actors[2].id);
		const copy = ok(
			await documentsWriter.useForChurch(db, await authority(2), {
				documentId: source.id,
				revisionId: source.revisionId,
				requestKey: randomUUID(),
			}),
		);
		assert.deepEqual(copy.body, body);
		await endSeat(actors[2].id);
		const edited = changed((t) => (t.content[0].content[2] = { type: "cell", attrs: { value: 10 } }));
		ok(
			await documentsWriter.saveNative(db, await authority(2), {
				title: "Setup tables",
				body: edited,
				documentId: source.id,
				expectedRevision: source.revision,
			}),
		);
		assert.deepEqual(JSON.parse((await currentOf(source.id)).body), edited);
		await restoreSeat(actors[2].id);
		assert.deepEqual(ok(await documentsWriter.read(db, member, { documentId: copy.id })).body, body);
	});
});
