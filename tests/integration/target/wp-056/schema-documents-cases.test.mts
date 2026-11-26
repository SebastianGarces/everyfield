import test, { after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { nativeFromText } from "../../../../packages/contracts/src/documents/native.ts";
import { sql, type SQL } from "../../../../packages/db/src/query.ts";
import { RequestActor } from "../../../../packages/domain/src/access/session.ts";
import { documentsWriter } from "../../../../packages/domain/src/documents/index.ts";
import { fixture, ok, refused, type Actor } from "../../../support/fixture.mts";
import { storedZip } from "../../documents/fixtures/word.mts";
import { MemoryClient } from "../../documents/storage.mts";

type Case = { id: string; expected: { result: Record<string, unknown>; event: null } };
const { cases } = JSON.parse(
	readFileSync(new URL("../../../../docs/acceptance/schema.json", import.meta.url), "utf8"),
) as { cases: Case[] };
const caseOf = (id: string) => cases.find((c) => c.id === id) ?? assert.fail(`no case ${id}`);

const database = await fixture({ prefix: "schema008" });
const { admin } = database;
const db = database.pools.runtime;
const P = database.tenant.id;
const Q = (await database.plant({ name: "Other Plant", timezone: "America/New_York" })).id;
const A = database.actors.owner;
const B = await database.actor({ kind: "plant", id: Q }, "admin", { email: "casey@example.test" });
const C = await database.actor(null, "owner", { account: { registration_kind: "planter" } });
const storage = { bucket: "synthetic-only", client: new MemoryClient() };
const CANARY = "CARE-CANARY-SCHEMA-008";
after(() => database.close());

type Row = Record<string, unknown>;
const one = async <R extends Row = Row>(query: SQL) => (await admin.execute<R>(query)).rows[0]!;
const count = async (query: SQL) => Number((await one<{ n: number }>(query)).n);
const authority = async (actor: Actor) => {
	const resolved = await RequestActor.resolve(db, actor.session);
	assert.ok(resolved instanceof RequestActor);
	return resolved;
};
const asAccount = async <T,>(actor: Actor, body: (authority: RequestActor) => Promise<T>) => {
	await admin.execute(
		sql`UPDATE seat SET ended_at=clock_timestamp() WHERE account_id=${actor.id} AND ended_at IS NULL`,
	);
	try {
		const signed = await authority(actor);
		assert.equal(signed.actor.context.kind, "account");
		return await body(signed);
	} finally {
		await admin.execute(sql`UPDATE seat SET ended_at=NULL WHERE account_id=${actor.id}`);
	}
};
const current = (documentId: string) =>
	one<{ tenant_id: string; revision_id: string; content_hash: string; import_object_id: string | null }>(
		sql`SELECT d.tenant_id, d.current_revision_id AS revision_id, r.content_hash, r.import_object_id
		FROM document d JOIN document_revision r ON r.id=d.current_revision_id WHERE d.id=${documentId}`,
	);
const refusal = async (query: SQL) => {
	try {
		await db.execute(query);
	} catch (error) {
		const cause = (error as { cause?: { code?: string; message?: string } }).cause;
		return `${cause?.code}:${cause?.message}`;
	}
	return "accepted";
};
const docx = (text: string) =>
	storedZip([
		{
			name: "word/document.xml",
			data: `<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>${text}</w:t></w:r></w:p></w:body></w:document>`,
		},
	]);

test("AC:SCHEMA-008 a private document keeps one owner, a selected copy needs the source read and a church Admin, forged revisions and owners are refused, and the church copy outlives the purge", async () => {
	const c = caseOf("SCHEMA-008");
	const { source, older, unselected } = await asAccount(A, async (own) => {
		const first = ok(
			await documentsWriter.saveNative(db, own, {
				title: "Personal values",
				body: nativeFromText("Draft values"),
				expectedRevision: "0",
			}),
		);
		const firstRevision = (await current(first.id)).revision_id;
		const imported = ok(
			await documentsWriter.importTextOrWord(
				db,
				own,
				{
					title: "Personal values",
					format: "docx",
					bytes: docx("We serve our community."),
					documentId: first.id,
					expectedRevision: first.revision,
					requestKey: "schema-008-import",
				},
				storage,
			),
		);
		const hidden = ok(
			await documentsWriter.saveNative(db, own, {
				title: "Care notes",
				body: nativeFromText(CANARY),
				expectedRevision: "0",
			}),
		);
		return { source: imported, older: firstRevision, unselected: hidden };
	});
	assert.equal(source.tenantId, A.id);
	const sourceRow = await current(source.id);
	assert.equal(sourceRow.tenant_id, A.id);
	assert.ok(sourceRow.import_object_id, "the import keeps its file on the private owner");
	assert.equal(
		(await one(sql`SELECT tenant_id FROM file_object WHERE id=${sourceRow.import_object_id}`)).tenant_id,
		A.id,
	);

	const bDoc = ok(
		await documentsWriter.saveNative(db, await authority(B), {
			title: "Q plan",
			body: nativeFromText("Q only"),
			expectedRevision: "0",
		}),
	);
	const cDoc = await asAccount(C, async (own) =>
		ok(
			await documentsWriter.saveNative(db, own, {
				title: "C private",
				body: nativeFromText("C only"),
				expectedRevision: "0",
			}),
		),
	);
	const pFile = randomUUID();
	await admin.execute(sql`INSERT INTO file_object(id,tenant_id,purpose,opaque_key,media_type,max_bytes,byte_count,sha256,state,upload_key,claim_generation)
		SELECT ${pFile},${P},purpose,${"private/" + P + "/" + pFile},media_type,max_bytes,byte_count,sha256,'ready',${"u-" + pFile},0
		FROM file_object WHERE id=${sourceRow.import_object_id}`);

	const forged = {
		foreign_owner_current_revision: await refusal(
			sql`UPDATE document SET current_revision_id=${(await current(bDoc.id)).revision_id} WHERE id=${source.id}`,
		),
		other_private_owner_current_revision: await refusal(
			sql`UPDATE document SET current_revision_id=${(await current(cDoc.id)).revision_id} WHERE id=${source.id}`,
		),
		same_owner_other_document_revision: await refusal(
			sql`UPDATE document SET current_revision_id=${(await current(unselected.id)).revision_id} WHERE id=${source.id}`,
		),
		foreign_owner_revision_row: await refusal(
			sql`INSERT INTO document_revision(id,tenant_id,document_id,version_number,body,content_hash,recorded_at)
			VALUES(${randomUUID()},${Q},${source.id},9,'x','x',clock_timestamp())`,
		),
		foreign_owner_import_object: await refusal(
			sql`UPDATE document_revision SET import_object_id=${pFile} WHERE id=${sourceRow.revision_id}`,
		),
		rebind_document_owner: await refusal(sql`UPDATE document SET tenant_id=${P} WHERE id=${source.id}`),
		rebind_revision_owner: await refusal(
			sql`UPDATE document_revision SET document_id=${unselected.id} WHERE id=${sourceRow.revision_id}`,
		),
	};
	for (const [name, outcome] of Object.entries(forged)) assert.notEqual(outcome, "accepted", name);
	assert.match(forged.foreign_owner_current_revision, /^23503:/);
	assert.match(forged.same_owner_other_document_revision, /foreign_document_revision/);
	assert.match(forged.foreign_owner_import_object, /^23503:/);
	assert.deepEqual(await current(source.id), sourceRow);

	const select = (documentId = source.id, revisionId = sourceRow.revision_id, requestKey: string = randomUUID()) => ({
		documentId,
		revisionId,
		requestKey,
	});
	const before = await count(sql`SELECT count(*)::int AS n FROM document WHERE tenant_id=${P}`);
	refused(await documentsWriter.useForChurch(db, await authority(database.actors.member), select()));
	refused(await documentsWriter.useForChurch(db, await authority(B), select()));
	refused(await documentsWriter.useForChurch(db, await authority(database.actors.admin), select()));
	const owner = await authority(A);
	refused(await documentsWriter.useForChurch(db, owner, select(cDoc.id, (await current(cDoc.id)).revision_id)));
	refused(await documentsWriter.useForChurch(db, owner, select(source.id, older)));
	refused(
		await documentsWriter.useForChurch(db, owner, {
			...select(),
			copiedFromRevisionId: (await current(bDoc.id)).revision_id,
		}),
		"invalid_input",
	);
	const witness = randomUUID();
	await admin.execute(sql`INSERT INTO lifecycle_witness(id,kind,opaque_subject_id,plant_id,request_id,requester_id,
		requester_opaque_id,request_revision,state,witness_checkpoint,cleanup_state,requested_at,cancel_until)
		SELECT ${witness},'plant',${P},${P},${randomUUID()},${A.id},${A.id},1,'pending_deletion',1,'not_started',
		stamp.at, stamp.at + interval '720 hours' FROM (SELECT clock_timestamp() AS at) stamp`);
	const pending = await documentsWriter.useForChurch(db, owner, select());
	await admin.execute(sql`DELETE FROM lifecycle_witness WHERE id=${witness}`);
	refused(pending);
	assert.equal(await count(sql`SELECT count(*)::int AS n FROM document WHERE tenant_id=${P}`), before);

	const copy = ok(
		await documentsWriter.useForChurch(
			db,
			await authority(A),
			select(source.id, sourceRow.revision_id, "schema-008-copy"),
		),
	);
	assert.equal(copy.tenantId, P);
	assert.equal(copy.copiedFromRevisionId, sourceRow.revision_id);
	assert.equal(copy.copiedFromHash, sourceRow.content_hash);
	assert.equal(
		await count(sql`SELECT count(*)::int AS n FROM document_revision r JOIN document d ON d.id=r.document_id
			WHERE d.tenant_id=${P} AND r.body LIKE ${"%" + CANARY + "%"}`),
		0,
		"only the selected document is copied",
	);
	const copied = await current(copy.id);
	assert.equal(copied.import_object_id, null, "the copy holds no reference to the private import object");
	assert.match(await refusal(sql`UPDATE document SET tenant_id=${A.id} WHERE id=${copy.id}`), /^23/);
	assert.notEqual(
		await refusal(sql`UPDATE document SET current_revision_id=${sourceRow.revision_id} WHERE id=${copy.id}`),
		"accepted",
	);

	const purge = randomUUID();
	await admin.execute(sql`INSERT INTO lifecycle_witness(id,kind,opaque_subject_id,account_id,request_id,requester_id,
		requester_opaque_id,request_revision,state,witness_checkpoint,cleanup_state,requested_at,cancel_until)
		SELECT ${purge},'account',${A.id},${A.id},${randomUUID()},${A.id},${A.id},1,'purging',1,'not_started',
		stamp.at, stamp.at + interval '720 hours' FROM (SELECT clock_timestamp() - interval '744 hours' AS at) stamp`);
	assert.ok(ok(await documentsWriter.purgeOwnedForDeletion(db, { witnessId: purge })).removed >= 2);
	const privateLeft = await one<{ documents: number; revisions: number; bodies: number; imports: number }>(
		sql`SELECT (SELECT count(*)::int FROM document WHERE tenant_id=${A.id}) AS documents,
		(SELECT count(*)::int FROM document_revision WHERE tenant_id=${A.id}) AS revisions,
		(SELECT count(*)::int FROM document_revision WHERE body LIKE ${"%" + CANARY + "%"}) AS bodies,
		(SELECT count(*)::int FROM file_object WHERE tenant_id=${A.id} AND state='ready'
			AND EXISTS(SELECT FROM document_revision r WHERE r.import_object_id=file_object.id)) AS imports`,
	);
	assert.deepEqual(privateLeft, { documents: 0, revisions: 0, bodies: 0, imports: 0 });
	const survivor = ok(await documentsWriter.read(db, await authority(database.actors.admin), { documentId: copy.id }));
	const stored = await one<{ tenant_id: string; copied_from_revision_id: string | null; copied_from_hash: string }>(
		sql`SELECT tenant_id, copied_from_revision_id, copied_from_hash FROM document WHERE id=${copy.id}`,
	);
	const sourceBody = await one<{ body: string | null }>(
		sql`SELECT (SELECT r.body FROM document_revision r WHERE r.id=${sourceRow.revision_id}) AS body`,
	);
	assert.deepEqual(survivor.body, nativeFromText("We serve our community."));
	assert.deepEqual(
		{
			destination_document_owner: stored.tenant_id === P ? "P" : stored.tenant_id,
			destination_copy_survives: survivor.id === copy.id,
			source_private_body: sourceBody.body,
			copied_from_revision_id: stored.copied_from_revision_id,
			source_hash_retained: stored.copied_from_hash === sourceRow.content_hash,
			foreign_current_revision_accepted: forged.foreign_owner_current_revision === "accepted",
		},
		c.expected.result,
	);
	assert.equal(c.expected.event, null);
	assert.equal((await RequestActor.resolve(db, A.session)) instanceof RequestActor, false);
});
