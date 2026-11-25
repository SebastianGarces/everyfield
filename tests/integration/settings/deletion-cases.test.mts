import "../platform/setup.mts";
import test, { after, before, mock } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { accountId, sessionId } from "../../../packages/contracts/src/common/index.ts";
import { S3Client } from "../../../packages/db/src/schema/storage.ts";
import { sql, type SQL } from "../../../packages/db/src/query.ts";
import { RequestActor, readViewer } from "../../../packages/domain/src/access/session.ts";
import { documentsWriter } from "../../../packages/domain/src/documents/index.ts";
import { nativeFromText } from "../../../packages/contracts/src/documents/native.ts";
import { createPrivateCare } from "../../../packages/domain/src/intelligence/index.ts";
import { runDuePurges } from "../../../packages/domain/src/jobs/lifecycle-purge.ts";
import { queueJobs } from "../../../packages/domain/src/jobs/queue.ts";
import { gatedTransaction } from "../../../packages/domain/src/operations/writes.ts";
import { PeopleReadContext, readPersonPhotos } from "../../../packages/domain/src/people/index.ts";
import { deletionOperations, readAvatar } from "../../../packages/domain/src/settings/index.ts";
import { issueRestrictedDeletionSession } from "../../../packages/domain/src/settings/deletion.ts";
import { readCurrentManifest, restoreWithCurrentManifest } from "../../../ops/maintenance/restore.mts";
import { openedDeletion } from "../../support/deletion-cookie.mts";
import { ok, refused, seeds, type Actor, type Workspace } from "../../support/fixture.mts";
import { testDatabase } from "../../support/test-database.mts";
import {
	dropTarget,
	freezeClock,
	objectStore,
	operator,
	readyFile,
	schemaExists,
	snapshot,
	type Store,
} from "../target/sql/knowledge/support.mts";

type Witness = {
	requested_at: string;
	cancel_until: string;
	live_purged_at: string;
	copy_expires_at: string;
};
type Step = {
	name?: string;
	given: { A: { email: string }; "delete-A": Witness };
	clock: { now: string };
	expected: { result: Record<string, unknown> };
};
type Case = Step & { id: string; subcases: Step[] };
const { cases } = JSON.parse(
	readFileSync(new URL("../../../docs/acceptance/knowledge.json", import.meta.url), "utf8"),
) as { cases: Case[] };
const caseOf = (id: string) => cases.find((c) => c.id === id) ?? assert.fail(`no case ${id}`);
const deleted = caseOf("WP010-KNOW-069").given["delete-A"];
const REQUESTED = new Date(deleted.requested_at);

const database = await testDatabase({
	prefix: "deletioncases",
	roles: { runtime: ["runtime"], cleanup: ["cleanup"] },
	clock: REQUESTED,
});
const { admin, schema } = database;
const { runtime: db, cleanup } = database.pools;
const seed = seeds(admin);
const bytes: Store = new Map();
const provider = { down: false };
class Bucket extends S3Client {
	constructor() {
		super({
			region: "us-east-1",
			endpoint: "https://example.invalid",
			forcePathStyle: true,
			credentials: { accessKeyId: "test", secretAccessKey: "test" },
		});
	}
	override async send(command: { input: { Key?: string } }) {
		const key = String(command.input.Key);
		if (command.constructor.name === "DeleteObjectCommand") {
			if (provider.down) throw Error("provider_timeout");
			bytes.delete(key);
			return {};
		}
		assert.equal(command.constructor.name, "GetObjectCommand");
		const body = bytes.get(key) ?? assert.fail("missing object");
		return { ContentLength: body.length, Body: { transformToByteArray: async () => body } };
	}
}
const storage = { bucket: "synthetic-only", client: new Bucket() };
const care = createPrivateCare();
const api = deletionOperations({
	queue: (tx, i) =>
		queueJobs(tx, [
			{
				tenant: i.subject.id,
				kind: "lifecycle_purge",
				subject: i.witnessId,
				key: "purge/" + i.requestId,
				revision: i.revision,
				eligibleAt: i.eligibleAt,
			},
		]),
	workspaceNotice: async () => {},
});

async function at(when: string | Date) {
	const instant = new Date(when);
	await freezeClock(admin, schema, instant);
	mock.timers.setTime(instant.getTime());
}
before(() => mock.timers.enable({ apis: ["Date"], now: REQUESTED.getTime() }));
after(async () => {
	mock.timers.reset();
	await database.close();
});

const one = async (query: SQL) => (await admin.execute(query)).rows[0] ?? assert.fail("the query returned no row");
const actorOf = async (who: Actor) => {
	const actor = await RequestActor.resolve(db, who.session);
	assert.ok(actor instanceof RequestActor);
	return actor;
};
const subjectOf = (who: Actor) => ({ kind: "account" as const, id: accountId.parse(who.id) });
const command = (input: object, expectedRevision = "1") => ({ input, expectedRevision, requestKey: randomUUID() });
const witnessOf = (who: Actor) =>
	one(sql`SELECT id,state,request_id,request_revision::text AS revision,requested_at,cancel_until,live_purged_at,copy_expires_at
		FROM lifecycle_witness WHERE opaque_subject_id=${who.id}`);
const instantOf = (value: unknown) => (value === null ? null : new Date(value as string | Date).toISOString());
const sent = () =>
	one(sql`SELECT (SELECT count(*)::int FROM mail) AS mail,(SELECT count(*)::int FROM notice) AS notices,
		(SELECT count(*)::int FROM audit_event) AS audits`);

async function freshSession(who: Actor) {
	const session = sessionId.parse(randomUUID());
	await admin.execute(sql`INSERT INTO auth_session(id,user_id,token,expires_at)
		VALUES(${session},${who.user},${randomUUID()},'2027-01-01T00:00:00Z')`);
	return session;
}
async function normalAccess(who: Actor) {
	const viewers = [];
	for (const session of [who.session, await freshSession(who)]) viewers.push(await readViewer(db, session));
	return viewers.some((viewer) => viewer !== null);
}
async function restrictedTo(who: Actor) {
	const { request_id } = await witnessOf(who);
	const request = { subject: subjectOf(who), requestId: String(request_id) };
	const proof = await openedDeletion(
		gatedTransaction(admin, (tx) =>
			issueRestrictedDeletionSession(tx, request, async () => ({ accountId: who.id, provenAt: new Date() })),
		),
		request,
	);
	return { proof, request };
}
async function deletionStatus(who: Actor) {
	const { proof, request } = await restrictedTo(who);
	return ok(await gatedTransaction(db, (tx) => api.getAccountDeletionStatus(tx, proof, request)));
}
async function cancelled(who: Actor) {
	const { proof, request } = await restrictedTo(who);
	return gatedTransaction(db, (tx) => api.cancelAccountDeletion(tx, proof, command(request)));
}

async function requestDeletion(who: Actor) {
	const { revision } = await one(sql`SELECT revision::text AS revision FROM account WHERE id=${who.id}`);
	return gatedTransaction(db, (tx) =>
		api.requestAccountDeletion(
			tx,
			{ session: who.session, selected: subjectOf(who) },
			command({ confirmed: true }, String(revision)),
		),
	);
}
async function givenDeletion(who: Actor, witness: Witness) {
	const requestId = randomUUID();
	const { id } = await one(sql`INSERT INTO lifecycle_witness(kind,opaque_subject_id,account_id,request_id,requester_id,
			requester_opaque_id,request_revision,state,requested_at,cancel_until,witness_checkpoint,cleanup_state)
		VALUES('account',${who.id},${who.id},${requestId},${who.id},${who.id},1,'pending_deletion',${witness.requested_at},
			${witness.cancel_until},1,'not_started') RETURNING id`);
	await admin.execute(sql`SELECT settings_suspend_subject(${id},${requestId})`);
	await gatedTransaction(admin, async (tx) => {
		await tx.execute(
			queueJobs(tx, [
				{
					tenant: who.id,
					kind: "lifecycle_purge",
					subject: String(id),
					key: "purge/" + requestId,
					revision: "1",
					eligibleAt: witness.cancel_until,
				},
			]).getSQL(),
		);
	});
}

async function church(role: "owner" | "admin", email: string) {
	const plant: Workspace & { kind: "plant" } = await seed.plant({ name: "Harvest Point" });
	const A = await seed.actor(plant, role, { email });
	const B = await seed.actor(plant, role === "owner" ? "admin" : "owner");
	await admin.execute(sql`UPDATE account SET personal_timezone='America/Chicago' WHERE id IN (${A.id},${B.id})`);
	const person = randomUUID();
	await admin.execute(sql`INSERT INTO person(id,tenant_id,plant_id,display_name,source,stage,adult_classification,
			commitment_state,pipeline_position,state,created_at,linked_account_id)
		VALUES(${person},${plant.id},${plant.id},'Alex','other','leader','adult','unknown',1,'live',clock_timestamp(),${A.id})`);
	const author = await actorOf(A);
	const churchDoc = ok(
		await documentsWriter.saveNative(db, author, {
			title: "Launch plan",
			body: nativeFromText("Church plan."),
			expectedRevision: "0",
		}),
	);
	const privateDoc = randomUUID();
	await admin.execute(
		sql`INSERT INTO document(id,tenant_id,kind,title) VALUES(${privateDoc},${A.id},'native','Private plan')`,
	);
	const avatar = await readyFile(admin, bytes, A.id, Buffer.from("A's photo"), "avatar");
	await admin.execute(sql`UPDATE account SET avatar_object_id=${avatar.id} WHERE id=${A.id}`);
	const week = ok(await care.readCurrent(db, author, {}));
	ok(
		await care.save(db, author, {
			requestKey: randomUUID(),
			expectedRevision: week.revision,
			input: {
				answers: { spiritual: "strained", family: "steady", financial: "steady", pace: "steady" },
				note: "CARE-CANARY",
			},
		}),
	);
	return { plant, A, B, author, person, churchDoc: churchDoc.id, privateDoc, avatar };
}
type Church = Awaited<ReturnType<typeof church>>;

async function seenBy(c: Church) {
	const session = await freshSession(c.B);
	const B = await RequestActor.resolve(db, session);
	assert.ok(B instanceof RequestActor);
	const photos = ok(await readPersonPhotos(db, new PeopleReadContext(B), { personIds: [c.person] })).photos;
	const photo = await readAvatar(
		db,
		storage,
		{ session, selected: subjectOf(c.B) },
		{ accountId: c.A.id, versionId: c.avatar.id },
	).then(
		(read) => Buffer.from(read).toString(),
		(error: Error) => error.message,
	);
	return {
		files: ok(await documentsWriter.listOwned(db, B, {})).documents.map(({ id, title }) => ({ id, title })),
		photos: photos.length,
		photo,
	};
}

test("AC:WP010-KNOW-069 a pending login deletion keeps the church's document and hides the login's document, photo and check-ins", async (t) => {
	const c069 = caseOf("WP010-KNOW-069");
	const { result } = c069.expected;
	for (const { role, name, request } of [
		{
			role: "owner",
			name: "the Owner whose deletion was arranged outside the product",
			request: (who: Actor) => givenDeletion(who, c069.given["delete-A"]),
		},
		{
			role: "admin",
			name: "an Admin who asked for it",
			request: async (who: Actor) => {
				const before = await sent();
				const pending = ok(await requestDeletion(who));
				assert.equal(pending.status, result.state);
				assert.equal(Date.parse(pending.cancelUntil), Date.parse(deleted.cancel_until));
				assert.deepEqual(await sent(), { ...before, audits: Number(before.audits) + 1 });
			},
		},
	] as const)
		await t.test(name, async () => {
			await at(REQUESTED);
			const c = await church(role, role === "owner" ? c069.given.A.email : `${randomUUID()}@example.test`);
			assert.deepEqual(await seenBy(c), {
				files: [{ id: c.churchDoc, title: "Launch plan" }],
				photos: 1,
				photo: "A's photo",
			});
			await request(c.A);
			await at(c069.clock.now);
			const witness = await witnessOf(c.A);
			assert.deepEqual(
				[witness.state, instantOf(witness.requested_at), instantOf(witness.cancel_until)],
				[result.state, "2026-10-13T16:00:00.000Z", "2026-11-12T16:00:00.000Z"],
			);
			assert.equal((await deletionStatus(c.A)).status, result.state);
			const before = await sent();
			refused(await requestDeletion({ ...c.A, session: await freshSession(c.A) }));
			assert.deepEqual(await witnessOf(c.A), witness);
			assert.deepEqual(await sent(), before);

			assert.equal(await normalAccess(c.A), false);
			const seen = await seenBy(c);
			assert.deepEqual(
				seen.files.some(({ id }) => id === c.churchDoc),
				result.church_document_retained,
			);
			const stored = await one(sql`SELECT d.tenant_id,(SELECT a.actor_id FROM audit_event a
				WHERE a.subject_id=d.id ORDER BY a.recorded_at LIMIT 1) AS creator FROM document d WHERE d.id=${c.churchDoc}`);
			assert.equal(stored.creator, c.A.id);
			assert.equal(stored.tenant_id === c.plant.id, result.creator_does_not_define_owner);
			assert.equal(
				!seen.files.some(({ id }) => id === c.privateDoc) &&
					(await documentsWriter.listOwned(db, c.author, {})).status === "refused",
				result.account_document_hidden,
			);
			assert.equal(seen.photos === 0 && seen.photo === "unavailable", result.avatar_hidden);
			const own = await care.readCurrent(db, c.author, {});
			assert.equal(own.status === "refused" && own.error.code === "access_denied", result.private_care_hidden);
			const session = await freshSession(c.B);
			const other = await RequestActor.resolve(db, session);
			assert.ok(other instanceof RequestActor);
			assert.equal(JSON.stringify(await care.readCurrent(db, other, {})).includes("CARE-CANARY"), false);
			assert.deepEqual(
				await one(sql`SELECT (SELECT count(*)::int FROM private_week WHERE author_id=${c.A.id}) AS weeks,
					(SELECT count(*)::int FROM private_week WHERE author_id=${c.B.id}) AS others,
					(SELECT count(*)::int FROM document WHERE id=${c.privateDoc} AND tenant_id=${c.A.id}) AS documents`),
				{ weeks: 1, others: 0, documents: 1 },
			);
			await admin.execute(sql`UPDATE job SET state='cancelled' WHERE kind='lifecycle_purge'`);
		});
});

test("AC:WP010-KNOW-072 a purge whose file removal fails stays purging, hidden and retryable, and a retry completes it once", async (t) => {
	const c072 = caseOf("WP010-KNOW-072");
	const { result } = c072.expected;
	await at(c072.given["delete-A"].requested_at);
	const c = await church("owner", `${randomUUID()}@example.test`);
	await givenDeletion(c.A, c072.given["delete-A"]);
	await at(c072.clock.now);
	provider.down = true;
	t.after(() => void (provider.down = false));
	assert.equal(await runDuePurges(db, cleanup, storage, 10), 0);
	const before = await sent();
	assert.equal((await deletionStatus(c.A)).status, result.state);
	const witness = await witnessOf(c.A);
	assert.deepEqual([witness.state, witness.live_purged_at], [result.state, result.live_purged_at]);
	assert.equal(witness.copy_expires_at, null);
	assert.equal(await normalAccess(c.A), result.normal_access);
	const job = () =>
		one(sql`SELECT state,error_code,attempt_count,next_attempt_at IS NOT NULL AS waits FROM job
			WHERE kind='lifecycle_purge' AND tenant_id=${c.A.id}`);
	const { state, error_code, waits } = await job();
	assert.deepEqual([state, error_code], ["retry_wait", "removal_unconfirmed"]);
	assert.equal(waits, result.retryable);
	assert.ok(bytes.has(c.avatar.key));
	assert.deepEqual(await sent(), before);

	await t.test("coherent-retry", async () => {
		const sub = c072.subcases.find((s) => s.name === "coherent-retry") ?? assert.fail("no subcase");
		const done = sub.expected.result;
		provider.down = false;
		await at(sub.clock.now);
		await admin.execute(
			sql`UPDATE job SET next_attempt_at=clock_timestamp() WHERE kind='lifecycle_purge' AND tenant_id=${c.A.id}`,
		);
		assert.equal(await runDuePurges(db, cleanup, storage, 10), 1);
		const status = await deletionStatus(c.A);
		assert.equal(status.status, done.state);
		assert.ok(status.status === "purged");
		assert.equal(status.livePurgedAt, "2026-11-12T16:00:00.000Z");
		assert.equal(Date.parse(status.livePurgedAt), Date.parse(String(done.live_purged_at)));
		assert.equal(status.copyExpiresAt, "2026-11-19T16:00:00.000Z");
		assert.equal(Date.parse(status.copyExpiresAt), Date.parse(String(done.copy_expires_at)));
		assert.equal((await job()).state, "succeeded");
		assert.equal(bytes.has(c.avatar.key), false);
		assert.deepEqual(
			await one(sql`SELECT (SELECT state FROM file_object WHERE id=${c.avatar.id}) AS file,
				(SELECT count(*)::int FROM document WHERE tenant_id=${c.A.id}) AS own,
				(SELECT count(*)::int FROM private_week WHERE author_id=${c.A.id}) AS weeks,
				(SELECT count(*)::int FROM document WHERE id=${c.churchDoc} AND tenant_id=${c.plant.id}) AS church`),
			{ file: "purged", own: 0, weeks: 0, church: 1 },
		);
		assert.equal(await normalAccess(c.A), false);
		assert.equal(await runDuePurges(db, cleanup, storage, 10), 0);
	});
});

test("AC:WP010-KNOW-073 at the copy expiry the purged login has no cancel and no access, and its recovery copy cannot come back", async (t) => {
	const c073 = caseOf("WP010-KNOW-073");
	const { result } = c073.expected;
	const given = c073.given["delete-A"];
	const target = `${schema}_r`;
	t.after(() => dropTarget(admin, target));
	await at(REQUESTED);
	const c = await church("owner", `${randomUUID()}@example.test`);
	await givenDeletion(c.A, { ...given, requested_at: deleted.requested_at, cancel_until: deleted.cancel_until });
	await at(given.live_purged_at);
	const copy = await snapshot(admin, bytes, {
		createdAt: new Date(given.live_purged_at),
		expiresAt: new Date(given.copy_expires_at),
		subjects: [{ id: c.A.id, expiresAt: given.copy_expires_at }],
	});
	assert.equal(await runDuePurges(db, cleanup, storage, 10), 1);
	const purged = await witnessOf(c.A);
	assert.equal(Date.parse(String(instantOf(purged.live_purged_at))), Date.parse(given.live_purged_at));
	await at(c073.clock.now);
	const before = await sent();
	const status = await deletionStatus(c.A);
	assert.equal(status.status, result.state);
	assert.ok(status.status === "purged");
	assert.equal(Date.parse(status.copyExpiresAt), Date.parse(String(result.copy_expires_at)));
	const answer = await cancelled(c.A);
	assert.equal(answer.status === "ok", result.cancel_allowed);
	refused(answer, "deadline_passed");
	assert.equal(await normalAccess(c.A), result.normal_access);
	const restore = await restoreWithCurrentManifest(
		{ admin, source: schema, targetSchema: target, objects: objectStore(new Map()), clock: () => new Date() },
		{ capability: operator, target: "isolated", snapshot: copy, current: () => readCurrentManifest(admin) },
	);
	assert.deepEqual([restore.restore_success, restore.service_opened], [false, false]);
	assert.equal(restore.refusal, "copy_expired_or_invalid");
	assert.equal(await schemaExists(admin, target), false);
	assert.deepEqual(await witnessOf(c.A), purged);
	assert.deepEqual(await sent(), before);
});
