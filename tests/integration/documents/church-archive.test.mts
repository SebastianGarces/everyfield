import { fixture, ok, refused } from "../../support/fixture.mts";
import { sql } from "../../../packages/db/node_modules/drizzle-orm/index.js";
import { S3Client } from "../../../packages/db/node_modules/@aws-sdk/client-s3/dist-es/index.js";
import { RequestActor } from "../../../packages/domain/src/access/session.ts";
import { documentsWriter } from "../../../packages/domain/src/documents/index.ts";
import test, { after, describe } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";

// T-9: an Owner or Admin archives a Church Document. It leaves the library and every write; its page, revisions and
// saved exports stay readable and downloadable for every seat. Archive is not delete (D-935).

const database = await fixture({ prefix: "t9arch", plant: { name: "Harvest Point" } });
const { admin } = database;
const db = database.pools.runtime;
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
const SEATS = [OWNER, ADMIN, MEMBER];

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
const storage = { bucket: "synthetic-only", client: new MemoryClient() };

const authority = async (who) => {
	const actor = await RequestActor.resolve(db, actors[who].session);
	assert.ok(actor instanceof RequestActor, JSON.stringify(actor));
	return actor;
};
const rowsOf = async (query) => (await admin.execute(query)).rows;
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const bytesFrom = (file) => Buffer.from(file.bytes, "base64");

/** Everything the church plant has stored: every document row, revision, saved export and audit row, as one hash. */
const stored = async () => {
	const tenant = database.tenant.id;
	const parts = await Promise.all([
		rowsOf(sql`SELECT * FROM document WHERE tenant_id = ${tenant}::uuid ORDER BY id`),
		rowsOf(sql`SELECT id, version_number, content_hash FROM document_revision WHERE tenant_id = ${tenant}::uuid ORDER BY id`),
		rowsOf(sql`SELECT id FROM generated_document WHERE tenant_id = ${tenant}::uuid ORDER BY id`),
		rowsOf(sql`SELECT id FROM audit_event WHERE tenant_id = ${tenant}::uuid ORDER BY id`),
	]);
	return createHash("sha256").update(JSON.stringify(parts)).digest("hex");
};
const audits = async (id) =>
	rowsOf(
		sql`SELECT action, kind, actor_id::text AS actor FROM audit_event WHERE subject_id = ${id}::uuid
			AND action IN ('documents.church_archived', 'documents.archived') ORDER BY occurred_at`,
	);

const create = async (who, templateId = "conflict-of-interest-policy") =>
	ok(
		await documentsWriter.createFromTemplate(db, await authority(who), { templateId, requestKey: randomUUID() }),
	);
const save = async (doc, text) => {
	const body = structuredClone(doc.body);
	body.body.content.push({ type: "paragraph", content: [{ type: "text", text }] });
	return ok(
		await documentsWriter.saveNative(db, await authority(OWNER), {
			documentId: doc.id,
			expectedRevision: doc.revision,
			body,
		}),
	);
};
const archive = async (who, documentId, expectedRevision) =>
	documentsWriter.archiveChurch(db, await authority(who), { documentId, expectedRevision });
const remove = async (who, documentId, expectedRevision) =>
	documentsWriter.deleteChurch(db, await authority(who), { documentId, expectedRevision });
const exportDoc = async (who, documentId, revision, format = "pdf") =>
	ok(
		await documentsWriter.exportNative(
			db,
			await authority(who),
			{ documentId, revision, format, requestKey: randomUUID() },
			storage,
		),
	);
const exportFile = async (who, documentId, exportId) =>
	documentsWriter.readExportFile(db, await authority(who), { documentId, exportId }, storage);
const listExports = async (who, documentId) => documentsWriter.listExports(db, await authority(who), { documentId });
const listed = async (who) => ok(await documentsWriter.listChurch(db, await authority(who), {})).documents.map((d) => d.id);

after(async () => {
	await database.close();
});

describe("AC:DOC-022 archive a Church Document (T-9)", { concurrency: 1 }, () => {
	test("AC:DOC-016 only an Owner or Admin archives, once, with the current revision, and one audit row tells it from a delete", async () => {
		const doc = await create(OWNER);
		const before = await stored();
		refused(await archive(MEMBER, doc.id, doc.revision), "access_denied");
		refused(await archive(OTHER, doc.id, doc.revision), "unavailable");
		refused(await archive(OWNER, randomUUID(), "1"), "unavailable");
		refused(await archive(OWNER, doc.id, "7"), "conflict");
		assert.equal(await stored(), before, "no refusal writes anything");

		const deleted = await create(OWNER);
		ok(await remove(OWNER, deleted.id, deleted.revision));
		const afterDelete = await stored();
		refused(await archive(ADMIN, deleted.id, deleted.revision), "unavailable");
		assert.equal(await stored(), afterDelete, "a deleted document is not archived");

		assert.deepEqual(ok(await archive(ADMIN, doc.id, doc.revision)), { documentId: doc.id, archived: true });
		assert.deepEqual(
			await audits(doc.id),
			[{ action: "documents.church_archived", kind: "archive", actor: database.actors.admin.id }],
			"one audit row, not a delete's documents.archived",
		);

		const once = await stored();
		assert.deepEqual(ok(await archive(OWNER, doc.id, doc.revision)), { documentId: doc.id, archived: true });
		assert.deepEqual(ok(await archive(ADMIN, doc.id, "7")), { documentId: doc.id, archived: true });
		assert.equal(await stored(), once, "archiving again writes nothing more");
		refused(await archive(MEMBER, doc.id, doc.revision), "access_denied");
	});

	test("AC:DOC-022 an archived document leaves the library for every seat and every write refuses it", async () => {
		const doc = await save(await create(OWNER), "Archived words");
		const source = await create(OWNER, "guest-sign-in-sheet");
		const template = ok(
			await documentsWriter.saveChurchTemplate(db, await authority(OWNER), {
				documentId: source.id,
				revision: 1,
				name: "Sign-in sheet",
				requestKey: randomUUID(),
			}),
		);
		for (const who of SEATS) assert.ok((await listed(who)).includes(doc.id), `seat ${who} lists it before`);
		ok(await archive(OWNER, doc.id, doc.revision));
		for (const who of SEATS) assert.equal((await listed(who)).includes(doc.id), false, `seat ${who} lists it after`);
		assert.ok((await listed(OWNER)).includes(source.id), "the other documents stay listed");

		const before = await stored();
		const owner = await authority(OWNER);
		refused(await documentsWriter.readChurchForEdit(db, owner, { documentId: doc.id }), "unavailable");
		refused(
			await documentsWriter.saveNative(db, owner, { documentId: doc.id, expectedRevision: doc.revision, body: doc.body }),
			"unavailable",
		);
		refused(
			await documentsWriter.setBranding(db, owner, { documentId: doc.id, useChurchBranding: false }),
			"unavailable",
		);
		refused(
			await documentsWriter.saveChurchTemplate(db, owner, {
				documentId: doc.id,
				revision: 2,
				name: "From an archived document",
				requestKey: randomUUID(),
			}),
			"unavailable",
		);
		refused(
			await documentsWriter.updateChurchTemplate(db, owner, {
				templateId: template.id,
				expectedVersion: 1,
				documentId: doc.id,
				revision: 2,
				requestKey: randomUUID(),
			}),
			"unavailable",
		);
		refused(await documentsWriter.readTemplateCompare(db, owner, { documentId: doc.id }), "unavailable");
		const key = `sha256:${"0".repeat(64)}`;
		refused(
			await documentsWriter.acceptTemplateChanges(db, owner, {
				documentId: doc.id,
				expectedRevision: doc.revision,
				templateHash: key,
				view: "all",
				key,
				accept: "all",
			}),
			"unavailable",
		);
		assert.equal(await stored(), before, "no write on an archived document stores anything");
	});

	test("AC:DOC-022 an archived document's page and revisions stay readable for every seat, and not outside the church plant", async () => {
		const first = await create(OWNER);
		const doc = await save(first, "The second revision");
		ok(await archive(ADMIN, doc.id, doc.revision));
		for (const who of SEATS) {
			const read = ok(await documentsWriter.readChurch(db, await authority(who), { documentId: doc.id }));
			assert.equal(read.revision, "2");
			assert.ok(read.archived, `seat ${who} sees the archive`);
			assert.equal(Number.isNaN(Date.parse(read.archived.at)), false);
			assert.equal(typeof read.archived.by, "string", "it names the Admin who archived it");
			const history = ok(await documentsWriter["history.list"](db, await authority(who), { documentId: doc.id }));
			assert.deepEqual(
				history.revisions.map((r) => r.number),
				[1, 2],
			);
			const older = ok(
				await documentsWriter["history.get"](db, await authority(who), { documentId: doc.id, revision: 1 }),
			);
			assert.deepEqual(older.body, first.body, "the older revision reads as it was saved");
			for (const format of ["pdf", "docx"]) {
				const file = ok(
					await documentsWriter.readChurchFile(
						db,
						await authority(who),
						{ documentId: doc.id, format, revision: 1 },
						storage,
					),
				);
				assert.ok(bytesFrom(file).length > 0);
				const saved = await exportDoc(who, doc.id, 1, format);
				assert.equal(saved.source.revision, 1, `seat ${who} exports revision 1 as ${format}`);
			}
		}
		refused(await documentsWriter.readChurch(db, await authority(OTHER), { documentId: doc.id }), "unavailable");
		refused(await documentsWriter["history.list"](db, await authority(OTHER), { documentId: doc.id }), "unavailable");
		refused(await listExports(OTHER, doc.id), "unavailable");
	});

	test("AC:DOC-023 saved exports made before the archive list and download the same bytes for every seat", async () => {
		const doc = await create(OWNER);
		const pdf = await exportDoc(MEMBER, doc.id, 1, "pdf");
		const word = await exportDoc(OWNER, doc.id, 1, "docx");
		const first = {};
		for (const saved of [pdf, word]) first[saved.id] = sha256(bytesFrom(ok(await exportFile(OWNER, doc.id, saved.id))));
		ok(await archive(OWNER, doc.id, doc.revision));
		for (const who of SEATS) {
			const list = ok(await listExports(who, doc.id));
			assert.deepEqual(new Set(list.exports.map((e) => e.id)), new Set([pdf.id, word.id]), `seat ${who} lists both`);
			for (const saved of [pdf, word]) {
				const file = ok(await exportFile(who, doc.id, saved.id));
				assert.equal(sha256(bytesFrom(file)), first[saved.id], `seat ${who} downloads the same ${saved.format}`);
				assert.equal(file.digest, saved.digest);
			}
		}
		// The page-level saved history still lists them, with the archived document as their source.
		const history = ok(await documentsWriter["history.list"](db, await authority(MEMBER), {}));
		for (const saved of [pdf, word]) {
			const entry = history.entries.find((e) => e.id === saved.id);
			assert.ok(entry, "the saved history lists it");
			assert.equal(entry.source.documentId, doc.id);
		}
	});

	test("AC:DOC-023 archive is not delete: a deleted document stays deleted, and deleting an archived one stops its exports", async () => {
		const deleted = await create(OWNER);
		const deletedExport = await exportDoc(OWNER, deleted.id, 1);
		ok(await remove(OWNER, deleted.id, deleted.revision));
		const archived = await create(OWNER);
		const archivedExport = await exportDoc(OWNER, archived.id, 1);
		ok(await archive(OWNER, archived.id, archived.revision));

		const marks = async (id) =>
			(
				await rowsOf(
					sql`SELECT archived_at IS NOT NULL AS deleted, church_archived_at IS NOT NULL AS archived FROM document WHERE id = ${id}::uuid`,
				)
			)[0];
		assert.deepEqual(await marks(deleted.id), { deleted: true, archived: false }, "a delete marks only deletion");
		assert.deepEqual(await marks(archived.id), { deleted: false, archived: true }, "an archive marks only archive");
		// Every document deleted before this change is still deleted and none is archived: the migration adds empty columns.
		assert.deepEqual(
			(
				await rowsOf(
					sql`SELECT count(*)::int AS n FROM document WHERE archived_at IS NOT NULL AND church_archived_at IS NOT NULL
						AND tenant_id = ${database.tenant.id}::uuid`,
				)
			)[0].n,
			0,
		);

		for (const who of SEATS) {
			refused(await exportFile(who, deleted.id, deletedExport.id), "deleted");
			refused(await listExports(who, deleted.id), "deleted");
			ok(await exportFile(who, archived.id, archivedExport.id));
			ok(await listExports(who, archived.id));
		}

		ok(await remove(ADMIN, archived.id, archived.revision));
		const rows = await audits(archived.id);
		assert.deepEqual(
			rows.map((r) => r.action),
			["documents.church_archived", "documents.archived"],
			"the archive, then the delete",
		);
		for (const who of SEATS) {
			refused(await exportFile(who, archived.id, archivedExport.id), "deleted");
			refused(await listExports(who, archived.id), "deleted");
			refused(await documentsWriter.readChurch(db, await authority(who), { documentId: archived.id }), "unavailable");
		}
	});
});
