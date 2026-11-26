import "../platform/setup.mts";
import test, { after, before, mock } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { accountId, sessionId } from "../../../packages/contracts/src/common/index.ts";
import { S3Client } from "../../../packages/db/src/schema/storage.ts";
import { sql, type SQL } from "../../../packages/db/src/query.ts";
import { RequestActor, readViewer } from "../../../packages/domain/src/access/session.ts";
import { archivedText } from "../../../apps/web/src/features/documents/church/labels.ts";
import { retainedAttribution, retainedHistoryReference } from "../../../packages/contracts/src/identity/index.ts";
import { listPeopleRequest } from "../../../packages/contracts/src/people/index.ts";
import { deletionStatus as deletionStatusContract } from "../../../packages/contracts/src/settings/native.ts";
import { documentsWriter } from "../../../packages/domain/src/documents/index.ts";
import { feedbackWriter } from "../../../packages/domain/src/feedback/index.ts";
import { nativeFromText } from "../../../packages/contracts/src/documents/native.ts";
import { createPrivateCare } from "../../../packages/domain/src/intelligence/index.ts";
import { runDuePurges } from "../../../packages/domain/src/jobs/lifecycle-purge.ts";
import { claimDue, finishJob, lockClaim, queueJobs, recoverLease } from "../../../packages/domain/src/jobs/queue.ts";
import { gatedTransaction } from "../../../packages/domain/src/operations/writes.ts";
import { getPlant, listPlants } from "../../../packages/domain/src/oversight/index.ts";
import { PeopleReadContext, peopleReader, readPersonPhotos } from "../../../packages/domain/src/people/index.ts";
import {
	createLifecycleCleanup,
	deletionOperations,
	readAvatar,
	type DeletionSubject,
	type WorkspaceDeletionNotice,
} from "../../../packages/domain/src/settings/index.ts";
import { issueRestrictedDeletionSession } from "../../../packages/domain/src/settings/deletion.ts";
import { readCurrentManifest, restoreWithCurrentManifest } from "../../../ops/maintenance/restore.mts";
import { openedDeletion } from "../../support/deletion-cookie.mts";
import { ok, raced, refused, seeds, type Actor, type Workspace } from "../../support/fixture.mts";
import { recorded, untouched } from "../../support/recorded.mts";
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
type Expected = { state: Record<string, unknown>; result: Record<string, unknown>; error_code?: string };
type RecoveryStep = {
	name: string;
	given: Record<string, Record<string, unknown>>;
	clock: { now: string };
	expected: Expected;
};
const recovery = JSON.parse(
	readFileSync(new URL("../../../docs/acceptance/recovery.json", import.meta.url), "utf8"),
) as { cases: (RecoveryStep & { id: string; subcases?: RecoveryStep[] })[] };
const recoveryCase = (id: string) => recovery.cases.find((c) => c.id === id) ?? assert.fail(`no case ${id}`);
const str = (value: unknown) => (typeof value === "string" ? value : assert.fail(JSON.stringify(value)));
const DAY = 86_400_000;
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
const provider = { down: false, timesOut: new Set<string>() };
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
			if (provider.down || provider.timesOut.has(key)) throw Error("provider_timeout");
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
const notices: WorkspaceDeletionNotice[] = [];
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
	workspaceNotice: async (_tx, notice) => void notices.push(notice),
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
	const A = await seed.actor(plant, role, { email, user: { name: "Alex Rivera" } });
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

async function churchAccess(who: Actor, plant: Workspace) {
	const seats = [];
	for (const session of [who.session, await freshSession(who)]) {
		const found = await RequestActor.resolve(db, session);
		if (!(found instanceof RequestActor)) continue;
		const { context } = found.actor;
		seats.push(context.kind === "seat" && context.owner.id === plant.id);
	}
	return seats.some(Boolean);
}
const own = (kind: "account" | "plant", id: string) => ({ kind, id }) as DeletionSubject;
const address = () => `${randomUUID()}@example.test`;
async function begin(when: string | Date) {
	await at(when);
	provider.down = false;
	provider.timesOut.clear();
	await admin.execute(sql`UPDATE job SET state='cancelled',lease_owner=NULL,lease_until=NULL,next_attempt_at=NULL
		WHERE kind='lifecycle_purge' AND state IN ('ready','retry_wait','claimed')`);
}
const accountRevision = async (who: Actor) =>
	String((await one(sql`SELECT revision::text AS revision FROM account WHERE id=${who.id}`)).revision);
const plantRevision = async (plant: Workspace) =>
	String((await one(sql`SELECT revision::text AS revision FROM plant WHERE id=${plant.id}`)).revision);
const askAccount = (session: Actor["session"], target: Actor, revision: string) =>
	gatedTransaction(db, (tx) =>
		api.requestAccountDeletion(tx, { session, selected: subjectOf(target) }, command({ confirmed: true }, revision)),
	);
const askWorkspace = (who: Actor, plant: Church["plant"], revision: string, selected: Workspace = plant) =>
	gatedTransaction(db, (tx) =>
		api.requestWorkspaceDeletion(
			tx,
			{ session: who.session, selected: selected as unknown as ReturnType<typeof subjectOf> },
			command({ plant, confirmed: true }, revision),
		),
	);
const purgeDue = () => runDuePurges(db, cleanup, storage, 10);
const retryNow = (subject: string) =>
	admin.execute(
		sql`UPDATE job SET next_attempt_at=clock_timestamp() WHERE kind='lifecycle_purge' AND tenant_id=${subject} AND state='retry_wait'`,
	);
const jobsOf = async (subject: string) =>
	(
		await admin.execute<{ state: string; error_code: string | null }>(
			sql`SELECT state,error_code FROM job WHERE kind='lifecycle_purge' AND tenant_id=${subject} ORDER BY eligible_at`,
		)
	).rows.map((j) => [j.state, j.error_code]);
const weeksBy = async (plant: Workspace) =>
	(
		await admin.execute<{ author_id: string; note: string | null }>(
			sql`SELECT author_id,note FROM private_week WHERE plant_id=${plant.id} AND answered_at IS NOT NULL`,
		)
	).rows;
const signedIn = async (who: Actor) => ({ ...who, session: await freshSession(who) });
const ownWeek = async (who: Actor) => JSON.stringify(ok(await care.readCurrent(db, await actorOf(who), {})));
async function proofFor(who: Actor, subject: DeletionSubject, provenAt = new Date()) {
	const witness = await one(sql`SELECT request_id FROM lifecycle_witness WHERE opaque_subject_id=${subject.id}`);
	const request = { subject, requestId: String(witness.request_id) };
	const proof = await openedDeletion(
		gatedTransaction(admin, (tx) =>
			issueRestrictedDeletionSession(tx, request, async () => ({ accountId: who.id, provenAt })),
		),
		request,
	);
	return { proof, request };
}

test("AC:DEL58-001 a login deletes only itself, only the Owner deletes the church workspace, and a request closes access before any later read", async (t) => {
	const c = recoveryCase("DEL58-001");
	const { result } = c.expected;
	await t.test("the login's own request, raced by a second request and by reads", async () => {
		await begin(c.clock.now);
		const church1 = await church("admin", address());
		const { A } = church1;
		const revision = await accountRevision(A);
		const second = await freshSession(A);
		const { value, added } = await recorded(admin, () =>
			raced(admin, db, sql`SELECT 1 FROM account WHERE id=${A.id} FOR UPDATE`, [
				() => askAccount(A.session, A, revision),
				async () => ({
					seen: await readViewer(db, second),
					files: ok(await documentsWriter.listOwned(db, church1.author, {})).documents.length,
					answer: await askAccount(second, A, revision),
				}),
			]),
		);
		const [first, concurrent] = value;
		assert.equal(first.status === "ok", result.personal_allowed);
		const pending = ok(first);
		assert.equal(pending.status, "pending_deletion");
		assert.deepEqual(pending.subject, subjectOf(A));
		assert.equal(Date.parse(pending.requestedAt), Date.parse(c.clock.now));
		assert.equal(Date.parse(pending.cancelUntil), Date.parse(str(result.cancel_until)));
		assert.ok(concurrent.seen, "a read before the commit is still the person's own");
		assert.equal(concurrent.files, 1);
		refused(concurrent.answer);
		assert.deepEqual(added, {
			audits: ["account.deletion_requested"],
			jobs: ["lifecycle_purge"],
			notices: 0,
			mail: 0,
		});
		const witness = await witnessOf(A);
		assert.deepEqual([witness.state, witness.revision], ["pending_deletion", "1"]);
		for (const session of [A.session, second]) {
			assert.equal(await readViewer(db, session), null);
			assert.equal((await RequestActor.resolve(db, session)) instanceof RequestActor, false);
		}
		assert.equal(await normalAccess(A), result.normal_access);
		refused(await documentsWriter.listOwned(db, church1.author, {}));
		refused(await care.readCurrent(db, church1.author, {}), "access_denied");
		refused(await feedbackWriter.listOwn(db, church1.author), "access_denied");
		assert.equal(await normalAccess(church1.B), true);
	});
	const names = [
		"Owner-cannot-delete-another-account",
		"Admin-cannot-delete-another-account",
		"foreign-cannot-delete-another-account",
		"Owner-workspace-request",
		"Admin-workspace-request",
		"foreign-workspace-request",
	];
	const subcases = c.subcases ?? [];
	assert.deepEqual(
		subcases.map(({ name }) => name),
		names,
	);
	for (const sub of subcases.slice(0, 3))
		await t.test(sub.name, async () => {
			await begin(sub.clock.now);
			const x = await church("admin", address());
			const seat = sub.given["seat-B"] ?? assert.fail("no seat");
			const at = seat.tenant === "P" ? x.plant : await seed.plant({ name: "Grace Hill" });
			const B = seat.role === "Owner" ? x.B : await seed.actor(at, "admin");
			const revision = await accountRevision(x.A);
			await untouched(admin, async () => {
				refused(await askAccount(B.session, x.A, revision));
				refused(
					await gatedTransaction(db, (tx) =>
						api.requestAccountDeletion(
							tx,
							{ session: B.session, selected: subjectOf(B) },
							command({ confirmed: true, account: x.A.id }, revision),
						),
					),
					"invalid_input",
				);
			});
			assert.equal(sub.expected.error_code, "access_denied");
			assert.equal(await normalAccess(x.A), true);
			assert.equal(await normalAccess(B), true);
		});
	for (const sub of subcases.slice(3))
		await t.test(sub.name, async () => {
			await begin(sub.clock.now);
			const seat = sub.given["seat-A"] ?? assert.fail("no seat");
			const x = await church(seat.role === "Owner" ? "owner" : "admin", address());
			const Q = await seed.plant({ name: "Grace Hill" });
			const A = seat.tenant === "P" ? x.A : await seed.actor(Q, "admin");
			const revision = await plantRevision(x.plant);
			notices.length = 0;
			if (sub.expected.error_code) {
				assert.equal(sub.expected.error_code, "access_denied");
				await untouched(admin, async () => {
					refused(await askWorkspace(A, x.plant, revision));
					if (seat.tenant === "Q") refused(await askWorkspace(A, x.plant, revision, Q));
				});
				assert.deepEqual(notices, []);
				for (const who of [A, x.A, x.B]) assert.equal(await normalAccess(who), true);
				return;
			}
			const member = await seed.actor(x.plant, "member");
			for (const who of [A, x.B, member]) assert.equal(await churchAccess(who, x.plant), true);
			const { value, added } = await recorded(admin, () => askWorkspace(A, x.plant, revision));
			assert.equal(value.status === "ok", sub.expected.result.workspace_allowed);
			const pending = ok(value);
			assert.deepEqual([pending.status, pending.subject], ["pending_deletion", { kind: "plant", id: x.plant.id }]);
			assert.equal(Date.parse(pending.cancelUntil), Date.parse(str(sub.expected.result.cancel_until)));
			assert.deepEqual(added, {
				audits: ["plant.deletion_requested"],
				jobs: ["lifecycle_purge"],
				notices: 0,
				mail: 0,
			});
			assert.deepEqual(
				notices.map((n) => [n.kind, new Set(n.recipients.map((r) => r.accountId))]),
				[["requested", new Set([A.id, x.B.id, member.id])]],
			);
			for (const who of [A, x.B, member]) {
				assert.equal(await readViewer(db, who.session), null);
				assert.equal(await churchAccess(who, x.plant), sub.expected.result.normal_access);
			}
			refused(await documentsWriter.listOwned(db, x.author, {}));
		});
});

test("AC:DEL58-002 a pending deletion shows only its status to a fresh restricted proof, which can cancel it; ordinary sessions stay revoked", async () => {
	const c = recoveryCase("DEL58-002");
	const { result } = c.expected;
	await begin(c.clock.now);
	const { A, B, plant, author } = await church("admin", address());
	const stranger = await seed.actor(plant, "member");
	const asked = ok(await requestDeletion(A));
	const subject = own("account", A.id);
	const { proof, request } = await proofFor(A, subject);
	const before = await sent();
	const answer = ok(await gatedTransaction(db, (tx) => api.getAccountDeletionStatus(tx, proof, request)));
	assert.deepEqual(await sent(), before);
	assert.equal(answer.status, `${str(result.status_visible)}_deletion`);
	assert.deepEqual(answer, asked);
	assert.equal(Date.parse(answer.requestedAt), Date.parse(str(c.given["delete-A"]?.requested_at)));
	assert.equal(Date.parse(answer.cancelUntil), Date.parse(str(c.given["delete-A"]?.cancel_until)));
	assert.deepEqual(Object.keys(answer).sort(), [
		"cancelUntil",
		"requestId",
		"requestedAt",
		"revision",
		"status",
		"subject",
	]);
	const note = str(c.given.input?.private_note);
	assert.equal(JSON.stringify(answer).includes(note) ? note : null, result.private_note);
	const read = await care.readCurrent(db, author, {});
	assert.equal(read.status === "ok" ? JSON.stringify(read.value.week) : null, result.private_note);
	assert.deepEqual(await weeksBy(plant), [{ author_id: A.id, note }], "held privately for the cancellation");
	assert.equal((await ownWeek(await signedIn(B))).includes(note), false);
	assert.equal(await normalAccess(A), result.ordinary_access);

	refused(
		await gatedTransaction(db, (tx) =>
			api.getAccountDeletionStatus(tx, proof, { ...request, subject: own("account", stranger.id) }),
		),
		"proof_invalid",
	);
	refused(
		await gatedTransaction(db, (tx) => api.getAccountDeletionStatus(tx, { ...proof, handle: A.session }, request)),
		"proof_invalid",
	);
	for (const [who, provenAt] of [
		[A, new Date(Date.parse(c.clock.now) - 5 * 60_000 - 1)],
		[stranger, new Date(c.clock.now)],
		[B, new Date(c.clock.now)],
	] as const)
		await assert.rejects(proofFor(who, subject, provenAt), { code: "proof_invalid" });
	await at(new Date(Date.parse(c.clock.now) + 10 * 60_000));
	refused(await gatedTransaction(db, (tx) => api.cancelAccountDeletion(tx, proof, command(request))), "proof_invalid");

	const done = await cancelled(A);
	assert.equal(done.status === "ok" && done.value.status === "cancelled", result.cancel_allowed);
	assert.equal(await readViewer(db, A.session), null, "the revoked session stays ended");
	const again = await signedIn(A);
	assert.ok(await readViewer(db, again.session));
	assert.ok((await ownWeek(again)).includes(note));
});

test("AC:DEL58-004 the purge of a login removes its own document and keeps the church's document, export, message and person under a former member", async () => {
	const c = recoveryCase("DEL58-004");
	const { result } = c.expected;
	await begin(c.clock.now);
	const { A, B, plant, author, person, churchDoc, privateDoc } = await church("admin", address());
	const stored = randomUUID();
	await admin.execute(sql`INSERT INTO document_revision(id,tenant_id,document_id,version_number,body,content_hash,recorded_at)
		VALUES(${stored},${A.id},${privateDoc},1,'Private body',${"a".repeat(64)},clock_timestamp())`);
	await admin.execute(sql`UPDATE document SET current_revision_id=${stored} WHERE id=${privateDoc}`);
	const create = async (templateId: string) =>
		ok(await documentsWriter.createFromTemplate(db, author, { templateId, requestKey: randomUUID() }));
	const exported = await create("conflict-of-interest-policy"),
		archived = await create("conflict-of-interest-policy");
	const file = await readyFile(admin, bytes, plant.id, Buffer.from("%PDF-1.7 policy"));
	const saved = randomUUID();
	await admin.execute(sql`INSERT INTO generated_document(id,tenant_id,creator_account_id,template_id,template_version,
			saved_template_name,renderer_version,format,object_id,inputs,download_name,generated_at,source_document_id,
			source_revision_id,theme_kind)
		SELECT ${saved},${plant.id},${A.id},d.template_id,d.template_version::text,'Policy','1','pdf',${file.id},'{}',
			'policy.pdf',clock_timestamp(),d.id,d.current_revision_id,'everyfield-neutral' FROM document d WHERE d.id=${exported.id}`);
	const message = randomUUID();
	await admin.execute(sql`INSERT INTO communication(id,plant_id,author_id,state,subject,body_html,body_text)
		VALUES(${message},${plant.id},${A.id},'draft','Welcome','<p>Welcome.</p>','Welcome.')`);
	ok(await documentsWriter.archiveChurch(db, author, { documentId: archived.id, expectedRevision: archived.revision }));
	const shared = async () => {
		const reader = await actorOf(await signedIn(B));
		const [read, exports, history] = [
			ok(await documentsWriter.readChurch(db, reader, { documentId: archived.id })),
			ok(await documentsWriter.listExports(db, reader, { documentId: exported.id })).exports,
			ok(await documentsWriter["history.list"](db, reader, { documentId: exported.id })),
		];
		const people = ok(
			await gatedTransaction(db, (tx) =>
				peopleReader.listPeople(tx, new PeopleReadContext(reader), listPeopleRequest.parse({ page: 1, limit: 100 })),
			),
		);
		return {
			archived: archivedText(read.archived?.at ?? assert.fail("not archived"), read.archived?.by ?? null),
			exports: exports.map((x) => [x.id, x.creatorName]),
			native: ok(await documentsWriter.read(db, reader, { documentId: churchDoc })).title,
			message: await one(sql`SELECT subject FROM communication WHERE id=${message}`),
			people: people.items.filter(({ id }) => id === person).map((p) => p.displayName),
			all: JSON.stringify([read, exports, history]),
		};
	};
	const before = await shared();
	assert.match(before.archived, /by Alex Rivera$/);
	assert.deepEqual(before.exports, [[saved, "Alex Rivera"]]);

	const { requestId } = ok(await requestDeletion(A));
	assert.equal(await purgeDue(), 0, "nothing is eligible before the deadline");
	assert.equal((await witnessOf(A)).state, "pending_deletion");
	await at("2026-11-12T16:00:00Z");
	assert.equal(await purgeDue(), 1);
	const witness = await witnessOf(A);
	assert.deepEqual([witness.state, witness.request_id], ["purged", requestId]);

	const rows = await one(sql`SELECT (SELECT count(*)::int FROM document WHERE id=${privateDoc}) AS docs,
		(SELECT count(*)::int FROM document_revision WHERE tenant_id=${A.id}) AS revisions,
		(SELECT count(*)::int FROM private_week WHERE author_id=${A.id}) AS weeks,
		(SELECT count(*)::int FROM document WHERE tenant_id<>${plant.id} AND id IN (${churchDoc},${archived.id},${exported.id})) AS moved,
		(SELECT linked_account_id FROM person WHERE id=${person}) AS linked,
		(SELECT count(*)::int FROM audit_event WHERE actor_id=${A.id}) AS named,
		(SELECT count(*)::int FROM audit_event WHERE subject_id=${archived.id} AND actor_token IS NOT NULL) AS tokens`);
	assert.equal(rows.docs === 0 && rows.revisions === 0 && rows.weeks === 0, result.DA_purged);
	const after = await shared();
	assert.equal(
		after.native === "Launch plan" &&
			after.exports.length === 1 &&
			rows.moved === 0 &&
			bytes.has(file.key) &&
			after.message.subject === "Welcome",
		result.DP_retained,
	);
	assert.equal(after.people.join() === str(c.given.input?.shared_person), result.Alex_retained);
	assert.deepEqual([rows.linked, rows.named], [null, 0]);
	assert.deepEqual(
		await one(sql`SELECT (SELECT display_name FROM seat_identity(${A.id})) AS shown,
			(SELECT u.name FROM auth_user u JOIN account a ON a.auth_user_id=u.id WHERE a.id=${A.id}) AS kept,
			(SELECT count(*)::int FROM auth_user WHERE email=${A.email}) AS logins`),
		{ shown: "Removed account", kept: "Removed account", logins: 0 },
	);
	assert.ok(Number(rows.tokens) > 0, "the history keeps its event without the login");
	assert.deepEqual(after.exports, [[saved, null]]);
	assert.equal(
		after.archived,
		before.archived.replace("Alex Rivera", `a ${str(result.shared_attribution).toLowerCase()}`),
	);
	for (const secret of ["Alex Rivera", A.email]) assert.equal(after.all.includes(secret), false, secret);
	assert.equal(await normalAccess(A), false);
});

test("AC:DEL58-005 a workspace deletion hides that church from its seats and both organizations, leaves the other church and organizations, and gives the author's check-in to no one", async () => {
	const c = recoveryCase("DEL58-005");
	const { result } = c.expected;
	await begin(c.clock.now);
	const { A, B, plant: P, author, churchDoc } = await church("owner", address());
	const Q = await seed.plant({ name: "Grace Hill", timezone: "America/New_York" });
	const ownerQ = await seed.actor(Q, "owner");
	const fileQ = await readyFile(admin, bytes, Q.id, Buffer.from("Q's file"));
	const fileP = await readyFile(admin, bytes, P.id, Buffer.from("P's file"));
	const organizations = {
		S1: await seed.organization("sending_church", { name: "Sending One" }),
		N1: await seed.organization("sending_network", { name: "Network One" }),
	};
	const files: Record<string, string> = {};
	const heads: Record<string, Actor> = {};
	for (const [name, o] of Object.entries(organizations)) {
		heads[name] = await seed.actor(o, "owner");
		files[name] = (await readyFile(admin, bytes, o.id, Buffer.from(`${name}'s file`))).key;
		for (const p of [P, Q])
			await admin.execute(sql`INSERT INTO affiliation(plant_id,organization_id,accepted_at,share_people,share_meetings,
				share_tasks,share_ministry_teams,share_wiki,share_activity,shared_findings)
				VALUES(${p.id},${o.id},clock_timestamp(),true,true,true,true,true,true,true)`);
	}
	const network = async () => {
		const seen: Record<string, { plants: string[]; page: boolean; home: boolean }> = {};
		for (const [name, head] of Object.entries(heads)) {
			const reader = await actorOf(head);
			const directory = await listPlants(db, reader);
			seen[name] = {
				plants: (directory?.plants ?? []).map((p) => p.name).sort(),
				page: (await getPlant(db, reader, P.id)) !== null,
				home: directory !== null,
			};
		}
		return seen;
	};
	const visible = { plants: ["Grace Hill", "Harvest Point"], page: true, home: true };
	assert.deepEqual(await network(), { S1: visible, N1: visible });
	const note = "CARE-CANARY";
	const noteOwner = async () => assert.deepEqual(await weeksBy(P), [{ author_id: A.id, note }]);

	const revision = await plantRevision(P);
	assert.equal((await untouched(admin, () => askWorkspace(A, P, revision + "0"))).status, "refused");
	const pending = ok(await askWorkspace(A, P, revision));
	const hidden = async () => {
		const viewers = [await churchAccess(A, P), await churchAccess(B, P)];
		refused(await documentsWriter.listOwned(db, author, {}));
		refused(await care.readCurrent(db, author, {}), "access_denied");
		const seen = await network();
		assert.equal(
			viewers.some(Boolean) || Object.values(seen).some((s) => s.page || s.plants.includes("Harvest Point")),
			result.P_visible,
		);
		assert.equal(
			(await churchAccess(ownerQ, Q)) && Object.values(seen).every((s) => s.plants.includes("Grace Hill")),
			result.Q_visible,
		);
		assert.deepEqual(
			Object.keys(seen).filter((name) => seen[name]?.home && bytes.has(files[name] ?? "")),
			result.organizations_retained,
		);
		assert.ok(ok(await documentsWriter.listOwned(db, await actorOf(ownerQ), {})));
		assert.ok(bytes.has(fileQ.key));
	};
	await hidden();
	await noteOwner();
	const links = async () =>
		(
			await admin.execute(sql`SELECT plant_id,organization_id FROM affiliation
				WHERE plant_id=${Q.id} AND ended_at IS NULL ORDER BY organization_id`)
		).rows;
	const kept = await links();
	assert.equal(kept.length, 2);

	const subject = own("plant", P.id);
	const { proof, request } = await proofFor(A, subject);
	ok(await gatedTransaction(db, (tx) => api.cancelWorkspaceDeletion(tx, proof, command(request, pending.revision))));
	const back = { A: await signedIn(A), B: await signedIn(B) };
	assert.ok((await ownWeek(back.A)).includes(note));
	assert.equal((await ownWeek(back.B)).includes(note), result.private_author_transferred);
	await noteOwner();

	ok(await askWorkspace(back.A, P, revision));
	await hidden();
	await at("2026-11-12T16:00:00Z");
	assert.equal(await purgeDue(), 1);
	const { state } = await one(sql`SELECT state FROM lifecycle_witness WHERE opaque_subject_id=${P.id}`);
	assert.equal(state, "purged");
	const sessions = [];
	for (const who of [ownerQ, ...Object.values(heads)]) sessions.push(await signedIn(who));
	const [q, ...rest] = sessions;
	ownerQ.session = (q ?? assert.fail("no session")).session;
	for (const [n, name] of Object.keys(heads).entries()) heads[name] = rest[n] ?? assert.fail("no session");
	await hidden();
	assert.deepEqual(await links(), kept);
	assert.equal(bytes.has(fileP.key), false);
	assert.deepEqual(
		await one(sql`SELECT (SELECT count(*)::int FROM private_week WHERE note=${note} AND plant_id=${P.id}) AS notes,
			(SELECT count(*)::int FROM document WHERE id=${churchDoc}) AS documents,
			(SELECT count(*)::int FROM organization WHERE name IN ('Sending One','Network One')) AS organizations`),
		{ notes: 0, documents: 0, organizations: 2 },
	);
});

test("AC:DEL58-007 a purge whose file deletion times out halfway stays purging and closed, and the same request's retry completes it once", async () => {
	const c = recoveryCase("DEL58-007");
	const { result } = c.expected;
	const deadline = str(c.given.execution?.deadline);
	await begin(c.clock.now);
	const { A, avatar, churchDoc, plant } = await church("admin", address());
	const second = await readyFile(admin, bytes, A.id, Buffer.from("A's other photo"), "avatar");
	const asked = ok(await requestDeletion(A));
	assert.equal(Date.parse(asked.cancelUntil), Date.parse(deadline));
	await at(new Date(Date.parse(deadline) - 1));
	assert.equal(await untouched(admin, purgeDue), 0);

	await at(deadline);
	provider.timesOut.add(second.key);
	const before = await sent();
	assert.equal(await purgeDue(), 0);
	const first = await witnessOf(A);
	assert.equal(first.state, result.first_state);
	assert.equal(first.live_purged_at, result.first_livePurgedAt);
	assert.equal(first.copy_expires_at, null);
	assert.equal((await deletionStatus(A)).status, result.first_state);
	assert.deepEqual([bytes.has(avatar.key), bytes.has(second.key)], [false, true], "half the files are gone");
	assert.deepEqual(
		await one(sql`SELECT (SELECT count(*)::int FROM private_week WHERE author_id=${A.id}) AS weeks,
		(SELECT count(*)::int FROM document WHERE tenant_id=${A.id}) AS documents`),
		{ weeks: 0, documents: 0 },
	);
	assert.equal(await normalAccess(A), result.ordinary_access);
	refused(await cancelled(A), "deadline_passed");
	assert.deepEqual(await jobsOf(A.id), [["retry_wait", "removal_unconfirmed"]]);
	assert.equal(await untouched(admin, purgeDue), 0, "nothing runs again before its retry time");

	provider.timesOut.clear();
	await at(new Date(Date.parse(deadline) + 5 * 60_000));
	assert.equal(await purgeDue(), 1);
	const done = await witnessOf(A);
	assert.deepEqual(
		{ request: done.request_id, revision: done.revision },
		{ request: first.request_id, revision: first.revision },
	);
	assert.equal(done.request_id, asked.requestId);
	assert.equal(
		done.state === "purged" &&
			instantOf(done.live_purged_at) === "2026-11-12T16:05:00.000Z" &&
			instantOf(done.copy_expires_at) === "2026-11-19T16:05:00.000Z" &&
			!bytes.has(second.key),
		result.retry_coherent_complete,
	);
	assert.deepEqual(
		await one(sql`SELECT (SELECT count(*)::int FROM file_object WHERE tenant_id=${A.id} AND state<>'purged') AS files,
		(SELECT count(*)::int FROM document WHERE id=${churchDoc} AND tenant_id=${plant.id}) AS church`),
		{
			files: 0,
			church: 1,
		},
	);
	assert.deepEqual(await jobsOf(A.id), [["succeeded", null]]);
	assert.equal(await normalAccess(A), result.ordinary_access);
	assert.equal(await purgeDue(), 0);
	assert.deepEqual(await witnessOf(A), done);
	const { mail, notices: told } = await sent();
	assert.deepEqual([mail, told], [before.mail, before.notices]);
});

test("AC:DEL58-009 the deletion status gives 30 days to cancel and 7 days of recovery after the real purge, hides the person's feedback and claims no erasure day", async () => {
	const c = recoveryCase("DEL58-009");
	const { result } = c.expected;
	await begin(c.clock.now);
	const { A, author } = await church("admin", address());
	const F1 = ok(
		await feedbackWriter.submit(
			db,
			author,
			{
				requestKey: randomUUID(),
				category: "bug",
				description: "The calendar is empty",
				page: "Documents",
				address: "/documents",
			},
			{ appVersion: null },
		),
	).id;
	assert.equal(ok(await feedbackWriter.getOwnStatus(db, author, { feedbackId: F1 })).id, F1);
	assert.deepEqual(
		ok(await feedbackWriter.listOwn(db, author)).items.map((f) => f.id),
		[F1],
	);
	const closed = async () => {
		const answers = [
			await feedbackWriter.listOwn(db, author),
			await feedbackWriter.getOwnStatus(db, author, { feedbackId: F1 }),
		];
		for (const answer of answers)
			assert.equal(answer.status === "ok" ? answer.value : null, result.normal_feedback_body);
		return answers.map((answer) => (answer.status === "refused" ? answer.error.code : answer.status));
	};
	ok(await requestDeletion(A));
	const pending = await deletionStatus(A);
	assert.equal(pending.status, "pending_deletion");
	assert.equal((Date.parse(pending.cancelUntil) - Date.parse(pending.requestedAt)) / DAY, result.cancellation_days);
	assert.deepEqual(await closed(), ["access_denied", "unavailable"]);

	const claims = (status: object) => Object.keys(status).some((key) => /purged|expires|erase|copy/i.test(key));
	assert.equal(claims(pending), result.physical_day37_claim);
	const day37 = new Date(Date.parse(pending.requestedAt) + 37 * DAY).toISOString();
	await at("2026-11-14T16:00:00Z");
	provider.down = true;
	assert.equal(await purgeDue(), 0);
	const purging = await deletionStatus(A);
	assert.equal(purging.status, "purging");
	assert.equal(claims(purging), result.physical_day37_claim);
	assert.deepEqual(await closed(), ["access_denied", "unavailable"]);
	provider.down = false;
	await at("2026-11-15T16:00:00Z");
	await retryNow(A.id);
	assert.equal(await purgeDue(), 1);
	const purged = await deletionStatus(A);
	assert.ok(purged.status === "purged");
	assert.equal(purged.livePurgedAt, "2026-11-15T16:00:00.000Z");
	assert.equal(
		(Date.parse(purged.copyExpiresAt) - Date.parse(purged.livePurgedAt)) / DAY,
		result.recovery_days_after_live_purge,
	);
	assert.equal(purged.copyExpiresAt <= day37, result.physical_day37_claim, "the expiry follows the real purge");
	assert.deepEqual(await closed(), ["access_denied", "unavailable"]);
	assert.equal((await one(sql`SELECT count(*)::int AS n FROM feedback WHERE id=${F1}`)).n, 0);

	const { shared } = JSON.parse(
		readFileSync(new URL("../../../design/marketing-copy.json", import.meta.url), "utf8"),
	) as { shared: { privacy_page: { sections: { paragraphs: string[]; items?: string[] }[] } } };
	const lines = shared.privacy_page.sections.flatMap((s) => [...s.paragraphs, ...(s.items ?? [])]);
	assert.ok(lines.some((line) => /removed from our backups as they roll over/.test(line)));
	assert.ok(lines.some((line) => /providers may keep .* under their own retention policies/.test(line)));
	assert.equal(
		lines.some((line) => /\b\d+[ -]days?\b|thirty[ -]seven|\bphysical|\bpermanently\b|\brecall/i.test(line)),
		result.physical_day37_claim,
	);
});

test("AC:OUTBOX-PURGE-001 a purge worker that crashed is fenced by its lease: its job waits to retry, only the current request resumes, and no late worker completes", async () => {
	const c = recoveryCase("OUTBOX-PURGE-001");
	const { state, result } = c.expected;
	const now = Date.parse(c.clock.now);
	const minutes = (n: number) => new Date(now + n * 60_000);
	await begin(minutes(-40 * 1440));
	const { A, avatar } = await church("admin", address());
	const older = ok(await requestDeletion(A));
	ok(await cancelled(A));
	await at(new Date(minutes(-6).getTime() - 30 * DAY));
	const current = ok(await requestDeletion(await signedIn(A)));
	assert.equal(current.revision, String(c.given.job?.source_revision));
	await at(minutes(-7));
	assert.equal(await purgeDue(), 0);
	assert.deepEqual(await jobsOf(A.id), [
		["superseded", "not_current"],
		["ready", null],
	]);

	await at(minutes(-6));
	const [claim] = await claimDue(db, ["lifecycle_purge"]);
	assert.ok(claim);
	assert.equal(claim.source_revision, String(c.given.job?.source_revision));
	const { lease } = await one(sql`SELECT lease_until AS lease FROM job WHERE id=${claim.id}`);
	assert.equal(instantOf(lease), "2026-10-18T11:59:00.000Z");
	assert.equal(Date.parse(str(c.given.job?.lease_until)), Date.parse(String(instantOf(lease))));
	const subject = subjectOf(A);
	const worker = (held: typeof claim, remove: () => Promise<boolean>) =>
		createLifecycleCleanup(cleanup, { authorize: (tx) => lockClaim(tx, held), removeOwnedResources: remove });
	const request = { subject, requestId: current.requestId, revision: current.revision };
	await assert.rejects(
		worker(claim, async () => {
			throw Error("worker crashed");
		})(request),
		/worker crashed/,
	);
	const crashed = await witnessOf(A);
	assert.equal(crashed.state, c.given.witness?.state);
	assert.equal(crashed.live_purged_at, c.given.witness?.live_purged_at);
	assert.equal(await purgeDue(), 0, "the live lease keeps every other worker off");

	await at(c.clock.now);
	const before = await sent();
	assert.equal(await recoverLease(db), 1);
	const { job_state, live_purged_at } = await one(sql`SELECT j.state AS job_state,w.live_purged_at
		FROM job j JOIN lifecycle_witness w ON w.id=j.subject_record_id WHERE j.id=${claim.id}`);
	assert.deepEqual({ job_state, live_purged_at }, state);
	assert.deepEqual(await sent(), before);

	const lateWorker = async () => {
		const late = [
			await finishJob(db, claim, { state: "succeeded" }),
			await worker(
				claim,
				async () => true,
			)(request).then(
				() => true,
				(error: { code?: string }) => {
					assert.equal(error.code, "unavailable");
					return false;
				},
			),
			await worker(
				claim,
				async () => true,
			)({ ...request, requestId: older.requestId, revision: older.revision }).then(
				() => true,
				() => false,
			),
		];
		for (const completed of late) assert.equal(completed, result.late_generation_can_complete);
	};
	await lateWorker();
	const after = await witnessOf(A);
	assert.deepEqual([after.state, after.live_purged_at], ["purging", null]);
	assert.equal(await normalAccess(A), result.normal_access);
	assert.ok(bytes.has(avatar.key));

	await at(minutes(5));
	const [second] = await claimDue(db, ["lifecycle_purge"]);
	assert.ok(second);
	assert.deepEqual([second.id, second.source_revision], [claim.id, claim.source_revision]);
	await lateWorker();
	assert.equal((await witnessOf(A)).state, "purging");
	assert.equal(await finishJob(db, second, { state: "retry_wait", code: "removal_unconfirmed" }), true);
	await at(minutes(15));
	assert.equal(await purgeDue(), 1);
	const done = await witnessOf(A);
	assert.deepEqual([done.state, done.request_id], ["purged", current.requestId]);
	assert.equal(instantOf(done.live_purged_at), minutes(15).toISOString());
	assert.equal(bytes.has(avatar.key), false);
	assert.equal(await normalAccess(A), result.normal_access);
});

test("AC:WP005-KNOW-069 the identity contract keeps a removed account as attribution only: no credential, no account id and no account as the owner", () => {
	const { result } = recoveryCase("WP005-KNOW-069").expected;
	assert.deepEqual(retainedAttribution.parse({ kind: "removed_account" }), result.retained_attribution);
	const plant = { kind: "plant", id: randomUUID() };
	const attribution = { kind: "removed_account" };
	assert.deepEqual(retainedHistoryReference.parse({ owner: plant, attribution }), { owner: plant, attribution });
	const credentials = [
		{ email: "alex@example.test" },
		{ name: "Alex" },
		{ passwordHash: "x" },
		{ sessionId: randomUUID() },
		{ token: "x" },
		{ accountId: randomUUID() },
		{ authUserId: randomUUID() },
	];
	for (const extra of credentials) {
		const accepted = [
			retainedAttribution.safeParse({ ...attribution, ...extra }).success,
			retainedHistoryReference.safeParse({ owner: plant, attribution, ...extra }).success,
			retainedHistoryReference.safeParse({ owner: plant, attribution: { ...attribution, ...extra } }).success,
		];
		for (const allowed of accepted) assert.equal(allowed, result.credential_fields_allowed, JSON.stringify(extra));
	}
	const account = { kind: "account", id: randomUUID() };
	for (const owner of [account, randomUUID(), null])
		assert.equal(retainedHistoryReference.safeParse({ owner, attribution }).success, result.creator_as_owner_allowed);
	assert.equal(
		retainedHistoryReference.safeParse({ creator: account, attribution }).success,
		result.creator_as_owner_allowed,
	);
});

test("AC:WP005-KNOW-072 the lifecycle contract refuses a completion time on a purge in progress and a completed purge without one", () => {
	const { result } = recoveryCase("WP005-KNOW-072").expected;
	const base = {
		subject: { kind: "account", id: randomUUID() },
		requestId: randomUUID(),
		revision: "1",
		requestedAt: "2026-10-13T16:00:00.000Z",
		cancelUntil: "2026-11-12T16:00:00.000Z",
	};
	const times = { livePurgedAt: "2026-11-12T17:00:00.000Z", copyExpiresAt: "2026-11-19T17:00:00.000Z" };
	const accepts = (value: object) => deletionStatusContract.safeParse({ ...base, ...value }).success;
	assert.equal(deletionStatusContract.parse({ ...base, status: result.incomplete_status }).status, "purging");
	for (const extra of [
		times,
		{ livePurgedAt: times.livePurgedAt },
		{ livePurgedAt: null },
		{ copyExpiresAt: times.copyExpiresAt },
	])
		for (const status of ["purging", "pending_deletion"])
			assert.equal(accepts({ status, ...extra }), result.incomplete_live_purged_at_allowed, JSON.stringify(extra));
	assert.equal(accepts({ status: "purged", ...times }), true);
	for (const extra of [
		{},
		{ copyExpiresAt: times.copyExpiresAt },
		{ ...times, livePurgedAt: null },
		{ ...times, livePurgedAt: "2026-11-12T15:59:59.000Z" },
	])
		assert.equal(!accepts({ status: "purged", ...extra }), result.complete_requires_live_purged_at);
	assert.equal(accepts({ status: "complete", ...times }), false);
});
