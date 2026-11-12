import { fixture, ok, refused } from "../../support/fixture.mts";
import { sql } from "../../../packages/db/node_modules/drizzle-orm/index.js";
import { S3Client } from "../../../packages/db/node_modules/@aws-sdk/client-s3/dist-es/index.js";
import { RequestActor } from "../../../packages/domain/src/access/session.ts";
import { documentsWriter } from "../../../packages/domain/src/documents/index.ts";
import test, { after, describe } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";

// T-284: an Owner or Admin lists the church plant's archived Church Documents and restores one. Restore is the reverse
// of archive only: the document returns to the library and every read and write with its revisions and saved exports
// as they were. It never brings back a deleted document.

const database = await fixture({ prefix: "t284rest", plant: { name: "Harvest Point" } });
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

/** Everything both church plants have stored: every document row, revision, saved export and audit row, as one hash. */
const stored = async () => {
	const parts = await Promise.all([
		rowsOf(sql`SELECT * FROM document ORDER BY id`),
		rowsOf(sql`SELECT id, version_number, content_hash FROM document_revision ORDER BY id`),
		rowsOf(sql`SELECT id FROM generated_document ORDER BY id`),
		rowsOf(sql`SELECT id FROM audit_event ORDER BY id`),
	]);
	return createHash("sha256").update(JSON.stringify(parts)).digest("hex");
};
const audits = async (id) =>
	rowsOf(
		sql`SELECT action, kind, actor_id::text AS actor FROM audit_event WHERE subject_id = ${id}::uuid
			AND action IN ('documents.church_archived', 'documents.church_restored', 'documents.archived') ORDER BY occurred_at`,
	);
const marks = async (id) =>
	(
		await rowsOf(
			sql`SELECT church_archived_at IS NULL AS at_clear, church_archived_by IS NULL AS by_clear, revision::text AS revision
				FROM document WHERE id = ${id}::uuid`,
		)
	)[0];

const create = async (who, templateId = "conflict-of-interest-policy") =>
	ok(await documentsWriter.createFromTemplate(db, await authority(who), { templateId, requestKey: randomUUID() }));
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
const archive = async (who, doc) =>
	ok(
		await documentsWriter.archiveChurch(db, await authority(who), {
			documentId: doc.id,
			expectedRevision: doc.revision,
		}),
	);
const restore = async (who, documentId) => documentsWriter.restoreChurch(db, await authority(who), { documentId });
const remove = async (who, doc) =>
	ok(
		await documentsWriter.deleteChurch(db, await authority(who), {
			documentId: doc.id,
			expectedRevision: doc.revision,
		}),
	);
const archivedList = async (who) => documentsWriter.listArchivedChurch(db, await authority(who), {});
const archivedIds = async (who) => ok(await archivedList(who)).documents.map((d) => d.id);
const listed = async (who) =>
	ok(await documentsWriter.listChurch(db, await authority(who), {})).documents.map((d) => d.id);
const exportDoc = async (who, documentId, revision, format = "pdf") =>
	ok(
		await documentsWriter.exportNative(
			db,
			await authority(who),
			{ documentId, revision, format, requestKey: randomUUID() },
			storage,
		),
	);
const downloadSha = async (who, documentId, exportId) =>
	sha256(
		bytesFrom(ok(await documentsWriter.readExportFile(db, await authority(who), { documentId, exportId }, storage))),
	);

/** What a reader sees of a document's history and saved exports: revisions, export list and each export's SHA-256. */
const snapshot = async (who, doc) => {
	const actor = await authority(who);
	const read = ok(await documentsWriter.readChurch(db, actor, { documentId: doc.id }));
	const history = ok(await documentsWriter["history.list"](db, actor, { documentId: doc.id }));
	const exports = ok(await documentsWriter.listExports(db, actor, { documentId: doc.id })).exports;
	const shas = {};
	for (const e of exports) shas[e.id] = await downloadSha(who, doc.id, e.id);
	return {
		revision: read.revision,
		contentHash: read.contentHash,
		revisions: history.revisions.map((r) => [r.number, r.contentHash, r.recordedAt]),
		exports: exports.map((e) => [e.id, e.format, e.digest, e.revision]).sort(),
		shas,
	};
};

after(async () => {
	await database.close();
});

describe("AC:DOC-022 archived Church Documents list and restore", { concurrency: 1 }, () => {
	test("AC:DOC-022 the archived list holds this church plant's archived documents only, newest archive first", async () => {
		const live = await create(OWNER);
		const older = await create(OWNER);
		const newer = await create(OWNER);
		const archivedThenDeleted = await create(OWNER);
		const deleted = await create(OWNER);
		const elsewhere = await create(OTHER);
		await archive(OWNER, older);
		await archive(ADMIN, newer);
		await archive(OWNER, archivedThenDeleted);
		await remove(OWNER, archivedThenDeleted);
		await remove(OWNER, deleted);
		await archive(OTHER, elsewhere);

		for (const who of [OWNER, ADMIN]) {
			const list = ok(await archivedList(who)).documents;
			assert.deepEqual(
				list.map((d) => d.id),
				[newer.id, older.id],
				`seat ${who}: archived only, not deleted, not another church plant's, newest archive first`,
			);
			const { archivedAt, archivedBy, ...row } = list[0];
			assert.deepEqual(row, { id: newer.id, title: newer.title, documentClass: newer.documentClass });
			assert.equal(typeof archivedBy, "string", "it names the Admin who archived it");
			assert.equal(Number.isNaN(Date.parse(archivedAt)), false);
			assert.ok(Date.parse(list[0].archivedAt) >= Date.parse(list[1].archivedAt));
		}
		assert.equal((await listed(OWNER)).includes(live.id), true);
		assert.deepEqual(await archivedIds(OTHER), [elsewhere.id], "the other church plant sees only its own");

		const before = await stored();
		refused(await archivedList(MEMBER), "access_denied");
		assert.equal(await stored(), before, "the list writes nothing");
	});

	test("AC:DOC-016 only an Owner or Admin restores, only an archived document, once, with one audit row", async () => {
		const doc = await create(OWNER);
		const notArchived = await create(OWNER);
		const deleted = await create(OWNER);
		const archivedThenDeleted = await create(OWNER);
		await archive(OWNER, doc);
		await remove(OWNER, deleted);
		await archive(OWNER, archivedThenDeleted);
		await remove(OWNER, archivedThenDeleted);

		const before = await stored();
		refused(await restore(MEMBER, doc.id), "access_denied");
		refused(await restore(OTHER, doc.id), "unavailable");
		refused(await restore(OWNER, randomUUID()), "unavailable");
		refused(await restore(OWNER, notArchived.id), "unavailable");
		refused(await restore(ADMIN, deleted.id), "unavailable");
		refused(await restore(ADMIN, archivedThenDeleted.id), "unavailable");
		refused(await restore(OWNER, "not-a-uuid"), "invalid_input");
		assert.equal(await stored(), before, "no refusal writes anything");
		assert.equal((await archivedIds(OWNER)).includes(doc.id), true);

		assert.deepEqual(ok(await restore(ADMIN, doc.id)), { documentId: doc.id, restored: true });
		assert.deepEqual(await marks(doc.id), { at_clear: true, by_clear: true, revision: doc.revision });
		assert.deepEqual(
			(await audits(doc.id)).map(({ action, kind, actor }) => [action, kind, actor]),
			[
				["documents.church_archived", "archive", database.actors.owner.id],
				["documents.church_restored", "restore", database.actors.admin.id],
			],
			"exactly one restore row, told apart from an archive's and a delete's",
		);

		const once = await stored();
		refused(await restore(OWNER, doc.id), "unavailable");
		refused(await restore(ADMIN, doc.id), "unavailable");
		assert.equal(await stored(), once, "restoring again writes nothing more");
		assert.equal(
			(await rowsOf(sql`SELECT count(*)::int AS n FROM audit_event WHERE action = 'documents.church_restored'`))[0].n,
			1,
		);
	});

	test("AC:DOC-023 revisions and saved exports are unchanged by archive and restore, and the document is live again", async () => {
		const doc = await save(await create(OWNER), "The second revision");
		await exportDoc(MEMBER, doc.id, 1, "pdf");
		await exportDoc(OWNER, doc.id, 2, "docx");
		const initial = await snapshot(OWNER, doc);
		assert.equal(initial.revisions.length, 2);
		assert.equal(initial.exports.length, 2);

		await archive(ADMIN, doc);
		const archived = await snapshot(OWNER, doc);
		assert.deepEqual(archived, initial, "archive changes no revision and no saved export");
		// An export made while it is archived is saved too, and stays after the restore.
		await exportDoc(MEMBER, doc.id, 2, "pdf");
		const during = await snapshot(OWNER, doc);
		assert.equal(during.exports.length, 3);
		assert.equal((await listed(OWNER)).includes(doc.id), false);

		ok(await restore(OWNER, doc.id));
		for (const who of SEATS) {
			assert.deepEqual(await snapshot(who, doc), during, `seat ${who}: same revisions, exports and bytes`);
			assert.equal((await listed(who)).includes(doc.id), true, `seat ${who} lists it in the library again`);
		}
		assert.equal((await archivedIds(OWNER)).includes(doc.id), false, "it leaves the archived list");

		// It is a document of the library again: the editor reads it, and it saves, brands, exports and updates a template.
		const owner = await authority(OWNER);
		const read = ok(await documentsWriter.readChurchForEdit(db, owner, { documentId: doc.id }));
		assert.equal(read.revision, "2");
		const edited = await save({ ...doc, revision: "2" }, "Edited after the restore");
		assert.equal(edited.revision, "3");
		ok(await documentsWriter.setBranding(db, owner, { documentId: doc.id, useChurchBranding: false }));
		assert.equal((await exportDoc(OWNER, doc.id, 3, "pdf")).source.revision, 3);
		const source = await create(OWNER, "guest-sign-in-sheet");
		const template = ok(
			await documentsWriter.saveChurchTemplate(db, owner, {
				documentId: source.id,
				revision: 1,
				name: "Sign-in sheet",
				requestKey: randomUUID(),
			}),
		);
		ok(
			await documentsWriter.updateChurchTemplate(db, owner, {
				templateId: template.id,
				expectedVersion: 1,
				documentId: doc.id,
				revision: 3,
				requestKey: randomUUID(),
			}),
		);
		const history = ok(await documentsWriter["history.list"](db, owner, { documentId: doc.id }));
		assert.deepEqual(
			history.revisions.map((r) => r.number),
			[1, 2, 3],
		);
	});
});
