import "../../../platform/setup.mts";
import test, { after, before, mock } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { sql, type SQL } from "../../../../../packages/db/src/query.ts";
import { RequestActor } from "../../../../../packages/domain/src/access/session.ts";
import {
	communicationWriter,
	type DeliveryTransport,
	runDueScheduled,
	withCommunicationWrite,
} from "../../../../../packages/domain/src/communication/index.ts";
import { feedbackWriter } from "../../../../../packages/domain/src/feedback/index.ts";
import { runDueFeedbackPublication } from "../../../../../packages/domain/src/jobs/feedback-publication.ts";
import { createMailService, MAIL_PASSES, runDueMail } from "../../../../../packages/domain/src/jobs/mail.ts";
import { queueJobs } from "../../../../../packages/domain/src/jobs/queue.ts";
import { gatedTransaction } from "../../../../../packages/domain/src/operations/writes.ts";
import { createLifecycleCleanup, deletionOperations } from "../../../../../packages/domain/src/settings/index.ts";
import { issueRestrictedDeletionSession } from "../../../../../packages/domain/src/settings/deletion.ts";
import { tenantId } from "../../../../../packages/contracts/src/common/values.ts";
import { captureSnapshot } from "../../../../../ops/maintenance/capture.mts";
import { checkDeletion } from "../../../../../ops/maintenance/deletion.mts";
import { openDrillTarget } from "../../../../../ops/maintenance/drill.mts";
import {
	readCurrentManifest,
	restoreWithCurrentManifest,
	type Snapshot,
} from "../../../../../ops/maintenance/restore.mts";
import {
	allowSource,
	type FileSource,
	historyPoint,
	type Neon,
	sourceClass,
} from "../../../../../ops/maintenance/source.mts";
import { openedDeletion } from "../../../../support/deletion-cookie.mts";
import { testDatabase } from "../../../../support/test-database.mts";
import { type Actor, ok, seeds, type Workspace } from "../../../../support/fixture.mts";
import { MAILING } from "../../../communication/church-address.mts";
import { dropTarget, freezeClock, objectStore, operator, readyFile, type Store } from "./support.mts";

const START = new Date("2026-10-13T16:00:00.000Z");
const DEADLINE = new Date("2026-11-12T16:00:00.000Z");
const PURGED = new Date("2026-11-12T17:00:00.000Z");
const COPY_EXPIRY = "2026-11-19T17:00:00.000Z";
const drillOperator = {
	authority: "authorized_restricted_recovery_operator",
	verified: true,
	operation_ids: ["maintenance.openDrillTarget"],
	environment: "isolated-drill",
} as const;
const LOOPBACK = new URL("postgres://ci@127.0.0.1:5432/everyfield_ci");
const noNeon = (): Neon => ({ endpoints: [], branches: [] });

const database = await testDatabase({
	prefix: "wp095drl",
	roles: { runtime: ["runtime"], cleanup: ["cleanup"] },
	max: 6,
	clock: START,
});
const { admin, schema } = database;
const { runtime: db, cleanup } = database.pools;
const seed = seeds(admin);
const live: Store = new Map();
const targets: string[] = [];
const rows = async <R extends Record<string, unknown> = Record<string, unknown>>(query: SQL) =>
	(await admin.execute<R>(query)).rows;
const files = (store: Store): FileSource => ({
	read: async (key) => (store.has(key) ? { bytes: store.get(key)!, version: "1" } : null),
	keys: async (prefix) => [...store.keys()].filter((key) => key.startsWith(prefix)),
});
const capture = () => captureSnapshot({ db: admin, schema, files: files(live), sourceCommit: "a".repeat(40) });
async function at(when: Date) {
	await freezeClock(admin, schema, when);
	mock.timers.setTime(when.getTime());
}

const keys = {
	encryptionKey: Buffer.alloc(32, 7),
	addressKey: Buffer.alloc(32, 9),
	from: "news@example.test",
	origin: "https://app.example.test",
};
type Sent = { mail: string[]; batches: string[]; issues: string[] };
function captureOnly(pool: typeof db) {
	const sent: Sent = { mail: [], batches: [], issues: [] };
	const service = createMailService({
		db: pool,
		...keys,
		authorize: async (_tx, mails) => new Set(mails.map((m) => m.id)),
		transport: {
			send: async (payload) => {
				sent.mail.push(payload.to);
				return { kind: "accepted", id: "cap-" + randomUUID() };
			},
			lookup: async () => ({ kind: "unknown" }),
		},
	});
	const delivery: DeliveryTransport = {
		paused: false,
		async send(batch) {
			sent.batches.push(...batch.messages.map((m) => m.to));
			return { outcome: "ids", ids: batch.messages.map(() => "cap-" + randomUUID()) };
		},
		cancel: async (ids) => ids.map(() => ({ outcome: "unknown" })),
		reschedule: async () => {
			throw new Error("provider_timeout");
		},
	};
	const run = async () => {
		const until = Number.MAX_SAFE_INTEGER;
		for (let pass = 0; pass < 2; pass++) {
			for (const prefixes of Object.values(MAIL_PASSES)) await runDueMail(pool, service, prefixes, 50, until);
			await runDueScheduled(pool, delivery, keys, 50, until);
			await runDueFeedbackPublication(
				pool,
				{
					repository: { id: "10", name: "everyfield-test/feedback" },
					operatorMail: null,
					issues: {
						create: async (_repository, issue) => {
							sent.issues.push(`${issue.title}\n${issue.body}`);
							return { kind: "created", issue: { number: 90, url: "https://example.test/issues/90" } };
						},
						search: async () => ({ kind: "found", issues: [] }),
					},
				},
				50,
				until,
			);
		}
		return sent;
	};
	return { run, service };
}

const deletions = deletionOperations({
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

async function restored(snapshot: Snapshot, when: Date) {
	const target = `${schema}_d${targets.length}`;
	targets.push(target);
	const store: Store = new Map();
	const result = await restoreWithCurrentManifest(
		{ admin, source: schema, targetSchema: target, objects: objectStore(store), clock: () => when },
		{ capability: operator, target: "isolated", snapshot, current: () => readCurrentManifest(admin) },
	);
	assert.equal(result.restore_success, true, JSON.stringify(result));
	assert.equal(result.service_opened, false);
	return { target, store };
}
async function readable(pool: typeof db, target: string) {
	try {
		await pool.execute(sql.raw(`SELECT count(*) FROM ${target}.meeting`));
		return true;
	} catch (error) {
		assert.equal((error as { cause?: { code?: string } }).cause?.code, "42501");
		return false;
	}
}
const openTarget = (target: string, connection = LOOPBACK, neon = noNeon) =>
	openDrillTarget({ admin, connection, neon }, { capability: drillOperator, target });

let plant: Workspace;
before(async () => {
	mock.timers.enable({ apis: ["Date"], now: START.getTime() });
	await at(START);
	plant = await seed.plant({ name: "Harvest Point", ...MAILING });
	await seed.actor(plant, "owner");
});
after(async () => {
	mock.timers.reset();
	for (const name of targets) await dropTarget(admin, name);
	await database.close();
});
const actorOf = async (who: Actor) => {
	const actor = await RequestActor.resolve(db, who.session);
	assert.ok(actor instanceof RequestActor);
	return actor;
};

test("INV-recovery: only an explicit operator step opens a restored target, and only an isolated drill target", async (step) => {
	const { target } = await restored(await capture(), START);
	const runtime = database.connect("runtime", { schema: target, max: 1 });

	await step.test("the default restore stays closed, and every other way to open it is refused", async () => {
		const neon = (): Neon => ({
			endpoints: [
				{ id: "ep-autumn-dew-b8ltidky", branch_id: "br-dev" },
				{ id: "ep-drill-one", branch_id: "br-drill" },
				{ id: "ep-drill-prod", branch_id: "br-drill-prod" },
				{ id: "ep-qa-one", branch_id: "br-qa" },
			],
			branches: [
				{ id: "br-main", name: "main", default: true },
				{ id: "br-dev", name: "development", parent_id: "br-main" },
				{ id: "br-drill", name: "drill-live", parent_id: "br-dev", parent_timestamp: "2026-10-13T15:00:00Z" },
				{ id: "br-drill-prod", name: "drill-of-production", parent_id: "br-main" },
				{ id: "br-qa", name: "qa-main-1", parent_id: "br-dev" },
			],
		});
		const host = (name: string) => new URL(`postgres://neondb_owner@${name}.c-14.us-east-1.aws.neon.tech/neondb`);
		for (const connection of [
			host("ep-gentle-dust-12345678"),
			host("ep-autumn-dew-b8ltidky"),
			host("ep-drill-prod"),
			host("ep-qa-one"),
			host("ep-unknown"),
			new URL("postgres://ci@127.0.0.1:5432/everyfield"),
			new URL("postgres://ci@db.example.test/everyfield_ci"),
		])
			assert.equal((await openTarget(target, connection, neon)).refusal, "target_not_isolated_drill", connection.host);
		for (const name of [schema, "public", `${target}_missing`])
			assert.equal((await openTarget(name)).refusal, "target_not_isolated_drill", name);
		for (const capability of [undefined, operator, { ...drillOperator, verified: false }])
			assert.equal(
				(await openDrillTarget({ admin, connection: LOOPBACK, neon: noNeon }, { capability, target })).refusal,
				"operator_unavailable",
			);
		assert.equal(await readable(runtime, target), false);
		assert.equal(sourceClass(host("ep-drill-one"), neon), "drill");
		assert.equal(historyPoint(host("ep-drill-one"), neon), "2026-10-13T15:00:00.000Z");
		assert.throws(
			() => allowSource(host("ep-gentle-dust-1"), "everyfield", undefined, neon),
			/production_source_refused/,
		);
		assert.throws(() => allowSource(host("ep-drill-prod"), "drill", undefined, neon), /production_source_refused/);
		assert.throws(() => allowSource(host("ep-drill-one"), "everyfield", undefined, neon), /production_source_refused/);
		assert.throws(
			() => allowSource(host("ep-drill-one"), "everyfield-backup", undefined, neon),
			/source_bucket_refused/,
		);
		const approved = {
			host: host("ep-gentle-dust-1").hostname,
			bucket: "everyfield",
			approvedBy: "owner",
			approvedAt: "2026-10-13T15:00:00Z",
		};
		assert.equal(allowSource(host("ep-gentle-dust-1"), "everyfield", approved, neon), "production");
		assert.throws(
			() => allowSource(host("ep-gentle-dust-2"), "everyfield", approved, neon),
			/production_source_refused/,
		);
	});

	await step.test("opening ends every restored session and lets the app login in", async () => {
		const [before] = await rows<{ n: number }>(
			sql`SELECT count(*)::int AS n FROM ${sql.raw(`${target}.auth_session`)}`,
		);
		assert.ok(before!.n > 0);
		const opened = await openTarget(target);
		assert.equal(opened.opened && opened.sessions_removed, before!.n);
		assert.equal(await readable(runtime, target), true);
		assert.equal((await openTarget(target)).opened, false);
	});
});

test("INV-recovery: a deleted login and its private text stay gone on an opened target, whichever side of the backup the deletion fell", async () => {
	const requestDeletion = async (who: Actor) => {
		const subject = { kind: "account" as const, id: who.id as never };
		const [account] = await rows<{ revision: string }>(
			sql`SELECT revision::text FROM account WHERE id=${who.id}::uuid`,
		);
		const requested = ok(
			await gatedTransaction(db, (tx) =>
				deletions.requestAccountDeletion(
					tx,
					{ session: who.session, selected: subject },
					{ input: { confirmed: true }, expectedRevision: account!.revision, requestKey: randomUUID() },
				),
			),
		);
		return { subject, requestId: requested.requestId, revision: requested.revision };
	};
	const purge = createLifecycleCleanup(cleanup, {
		authorize: async () => true,
		removeOwnedResources: async () => true,
	});
	const withNote = async (name: string) => {
		const who = await seed.actor(plant, "admin", { email: `${name}@example.test` });
		ok(
			await feedbackWriter.submit(
				db,
				await actorOf(who),
				{
					requestKey: randomUUID(),
					category: "bug",
					description: `private to ${name}`,
					page: "Documents",
					address: "/documents",
				},
				{ appVersion: null },
			),
		);
		return who;
	};
	const early = await withNote("early");
	const later = await withNote("later");
	const requests = { early: await requestDeletion(early), later: await requestDeletion(later) };
	await at(PURGED);
	assert.equal((await purge(requests.early)).status, "purged");
	const copy = await capture();
	assert.ok(copy.image.includes("private to later"));
	assert.equal(copy.image.includes("private to early"), false);
	assert.equal((await purge(requests.later)).status, "purged");

	const { target } = await restored(copy, PURGED);
	assert.equal((await openTarget(target)).opened, true);
	const runtime = database.connect("runtime", { schema: target, max: 2 });
	for (const who of [early, later]) {
		assert.equal((await RequestActor.resolve(runtime, who.session)) instanceof RequestActor, false);
		const [login] = (
			await database.connect("admin", { schema: target, max: 1 })
				.execute(sql`SELECT (SELECT count(*)::int FROM auth_user WHERE email=${who.email}) AS users,
					(SELECT count(*)::int FROM auth_account WHERE user_id=${who.user}::uuid) AS passwords,
					(SELECT count(*)::int FROM feedback WHERE description LIKE 'private to %') AS notes`)
		).rows;
		assert.deepEqual(login, { users: 0, passwords: 0, notes: 0 });
	}
});

test("INV-recovery: an opened target repeats no accepted, scheduled or unknown mail and no published issue, and still sends what should go out", async () => {
	await at(PURGED);
	const author = await actorOf(await seed.actor(plant, "admin"));
	const sender = captureOnly(db).service;
	const enqueue = (pool: typeof db, service: typeof sender, name: string, logicalKey: string) =>
		gatedTransaction(pool, (tx) =>
			service.enqueue(tx, {
				owner: { kind: "plant", id: plant.id },
				purpose: "relationship_receipt",
				logicalKey,
				recipient: null,
				address: `${name}@example.test`,
				content: { subject: name, text: name },
				operation: null,
				notice: null,
				eligibleAt: PURGED.toISOString(),
			}),
		);
	const mail: Record<string, string> = {};
	for (const name of ["accepted", "unknown", "refused", "control"])
		mail[name] = await enqueue(db, sender, name, "onboarding/" + randomUUID());
	await admin.execute(sql`UPDATE mail SET state='refused' WHERE id=${mail.refused}::uuid`);

	const schedule = async (name: string) => {
		const personId = randomUUID();
		await admin.execute(sql`INSERT INTO person(id,tenant_id,plant_id,display_name,email,source,stage,adult_classification,
			commitment_state,pipeline_position,state,created_at)
			VALUES(${personId},${plant.id},${plant.id},${name},${`${name}@example.test`},'other','prospect','unknown','unknown',0,
			'live',clock_timestamp())`);
		const sendAt = new Date(PURGED.getTime() + 86_400_000).toISOString();
		const saved = ok(
			await withCommunicationWrite(db, author, (tx, ctx) =>
				communicationWriter.saveDraft(tx, ctx, {
					requestKey: randomUUID(),
					input: {
						subject: "Welcome",
						bodyHtml: "<p>Welcome.</p>",
						audience: { groups: [], teamIds: [], personIds: [personId] },
					},
				}),
			),
		);
		const accepted = ok(
			await withCommunicationWrite(db, author, (tx, ctx) =>
				communicationWriter.scheduleReviewed(tx, ctx, {
					requestKey: randomUUID(),
					expectedRevision: saved.revision,
					input: { communicationId: saved.communicationId, scheduledAt: sendAt },
				}),
			),
		);
		ok(
			await communicationWriter.handOffScheduled(
				db,
				author,
				{
					requestKey: randomUUID(),
					expectedRevision: accepted.revision,
					input: { communicationId: saved.communicationId },
				},
				{
					paused: false,
					send: async () => ({ outcome: "unknown" }),
					cancel: async () => [],
					reschedule: async () => {},
				} as never,
				keys,
			),
		);
		return saved.communicationId;
	};
	const scheduled = { gone: await schedule("scheduled-gone"), due: await schedule("scheduled-due") };
	const like = (id: string) => `communication/${id}/%`;
	await admin.execute(sql`UPDATE mail SET scheduled_at='2026-11-12T16:30:00Z' WHERE purpose='communication'
		AND (logical_key LIKE ${like(scheduled.gone)} OR logical_key LIKE ${like(scheduled.due)})`);

	const issues: Record<string, string> = {};
	for (const name of ["published", "unknown", "control"])
		issues[name] = ok(
			await feedbackWriter.submit(
				db,
				author,
				{
					requestKey: randomUUID(),
					category: "suggestion",
					description: name,
					page: "Documents",
					address: "/documents",
				},
				{ appVersion: null },
			),
		).id;
	const copy = await capture();

	for (const name of ["accepted", "refused"])
		await admin.execute(sql`UPDATE mail SET state='accepted', provider_message_id=${"prov-" + name},
			accepted_at=clock_timestamp() WHERE id=${mail[name]}::uuid`);
	await admin.execute(sql`UPDATE mail SET state='unknown' WHERE id=${mail.unknown}::uuid`);
	await admin.execute(sql`UPDATE mail SET state='accepted', provider_message_id='prov-scheduled', scheduled_at=NULL,
		accepted_at=clock_timestamp() WHERE logical_key LIKE ${like(scheduled.gone)}`);
	const lateKey = "onboarding/" + randomUUID();
	const late = await enqueue(db, sender, "late", lateKey);
	await admin.execute(sql`UPDATE mail SET state='accepted', provider_message_id='prov-late', accepted_at=clock_timestamp()
		WHERE id=${late}::uuid`);
	const publication = sql`publication_payload='{"title":"t","body":"b"}', publication_hash='h', repository_id=10,
		repository_name='everyfield-test/feedback'`;
	await admin.execute(sql`UPDATE feedback SET publication_state='published', ${publication}, issue_number=7,
		issue_url='https://example.test/issues/7', published_at=clock_timestamp() WHERE id=${issues.published}::uuid`);
	await admin.execute(
		sql`UPDATE feedback SET publication_state='unknown', ${publication} WHERE id=${issues.unknown}::uuid`,
	);

	const { target } = await restored(copy, PURGED);
	assert.equal((await openTarget(target)).opened, true);
	const runtime = database.connect("runtime", { schema: target, max: 3 });
	const jobs = captureOnly(runtime);
	const sent = await jobs.run();
	assert.deepEqual(sent.mail, ["control@example.test"]);
	assert.deepEqual(sent.batches, ["scheduled-due@example.test"]);
	const references = await rows<{ id: string; reference: string }>(sql`SELECT id, reference FROM feedback`);
	const filed = references.filter((r) => sent.issues.some((text) => text.includes(r.reference))).map((r) => r.id);
	assert.ok(filed.includes(issues.control!));
	assert.equal(filed.includes(issues.published!) || filed.includes(issues.unknown!), false);
	assert.equal(sent.issues.length, filed.length);
	assert.equal(await enqueue(runtime, jobs.service, "late", lateKey), late);
	assert.deepEqual((await jobs.run()).mail, ["control@example.test"]);
});

test("INV-recovery: the deletion check reads real rows and files, and no cancel works at or after the deadline, live or restored", async (step) => {
	await at(START);
	const request = async (name: string) => {
		const church = await seed.plant({ name });
		const its = await seed.actor(church, "owner");
		const file = await readyFile(admin, live, church.id, Buffer.from(`file of ${name}`));
		await admin.execute(sql`INSERT INTO message_template (plant_id, name, category, subject, body_html, body_text)
			VALUES (${church.id}::uuid, 'Welcome', 'announcement', 'Welcome', '<p>Private</p>', 'Private')`);
		await admin.execute(sql`INSERT INTO communication (id, plant_id, state, audience, subject, body_html, body_text)
			VALUES (gen_random_uuid(), ${church.id}::uuid, 'draft', '{}', 'Private message', '<p>Private</p>', 'Private')`);
		const [plantRow] = await rows<{ revision: string }>(
			sql`SELECT revision::text FROM plant WHERE id=${church.id}::uuid`,
		);
		const subject = { kind: "plant" as const, id: tenantId.parse(church.id) };
		const requested = ok(
			await gatedTransaction(db, (tx) =>
				deletions.requestWorkspaceDeletion(
					tx,
					{ session: its.session, selected: subject },
					{ input: { plant: church, confirmed: true }, expectedRevision: plantRow!.revision, requestKey: randomUUID() },
				),
			),
		);
		return { church, its, file, subject, requestId: requested.requestId, revision: requested.revision };
	};
	type Request = Awaited<ReturnType<typeof request>>;
	const check = (r: Request, where = schema, store = live) =>
		checkDeletion({ db: admin, schema: where, files: files(store) }, r.church.id);
	const purge = (r: Request, removeFiles: boolean) =>
		createLifecycleCleanup(cleanup, {
			authorize: async () => true,
			async removeOwnedResources() {
				if (!removeFiles) return false;
				live.delete(r.file.key);
				for (const state of ["cleanup", "purged"])
					await admin.execute(sql`UPDATE file_object SET state=${state},
						purged_at=CASE WHEN ${state}='purged' THEN clock_timestamp() END WHERE tenant_id=${r.church.id}::uuid`);
				return true;
			},
		})({ subject: r.subject, requestId: r.requestId, revision: r.revision });
	const cancel = async (r: Request, where = schema) => {
		const pool = database.connect("admin", { schema: where, max: 1 });
		const { subject, requestId } = r;
		try {
			const proof = await openedDeletion(
				gatedTransaction(pool, (tx) =>
					issueRestrictedDeletionSession(tx, { subject, requestId }, async () => ({
						accountId: r.its.id,
						provenAt: new Date(),
					})),
				),
				{ subject, requestId },
			);
			const answer = await gatedTransaction(pool, (tx) =>
				deletions.cancelWorkspaceDeletion(tx, proof, {
					input: { subject, requestId },
					expectedRevision: r.revision,
					requestKey: randomUUID(),
				}),
			);
			return answer.status === "refused" ? answer.error.code : answer.status;
		} catch (error) {
			return (error as { code?: string }).code ?? "failed";
		}
	};
	const pending = await request("Pending church");
	const half = await request("Half church");
	const done = await request("Purged church");

	await step.test("pending: not purged, the rows and file are still there, cancel is still open", async () => {
		const report = await check(pending);
		assert.equal(report.verdict, "not_purged");
		assert.equal(report.state, "pending_deletion");
		assert.equal(report.cancel_allowed, true);
		assert.equal(report.remaining_files, 1);
		assert.equal(report.remaining_rows.communication, 1);
		assert.equal(report.remaining_rows.message_template, 1);
	});

	await at(DEADLINE);
	const copy = await capture();
	await step.test("every cancel is refused at the deadline, before any purge has run", async () => {
		assert.equal((await check(pending)).cancel_allowed, false);
		for (const r of [pending, half, done]) assert.equal(await cancel(r), "deadline_passed");
	});

	await at(PURGED);
	assert.equal((await purge(half, false)).status, "purging");
	assert.equal((await purge(done, true)).status, "purged");

	await step.test("half purged: not purged while one file remains", async () => {
		const report = await check(half);
		assert.equal(report.verdict, "not_purged");
		assert.equal(report.remaining_files, 1);
		assert.deepEqual(report.remaining_rows, { file_object: 1 });
	});

	await step.test("purged: no rows or files, the purge time, and copies that end within seven days", async () => {
		const report = await check(done);
		assert.deepEqual(report.remaining_rows, {});
		assert.equal(report.remaining_files, 0);
		assert.equal(report.live_purged_at, PURGED.toISOString());
		assert.equal(report.copy_expires_at, COPY_EXPIRY);
		assert.equal(report.copy_expiry_within_7_days, true);
		assert.equal(report.verdict, "purged");
		live.set(`private/${done.church.id}/left-behind`, Buffer.from("x"));
		assert.equal((await check(done)).verdict, "not_purged");
		live.delete(`private/${done.church.id}/left-behind`);
		await admin.execute(sql`INSERT INTO message_template (plant_id, name, category, subject, body_html, body_text)
			VALUES (${done.church.id}::uuid, 'Left', 'announcement', 'Left', '<p>x</p>', 'x')`);
		const left = await check(done);
		assert.equal(left.verdict, "not_purged");
		assert.deepEqual(left.remaining_rows, { message_template: 1 });
		await admin.execute(sql`DELETE FROM message_template WHERE plant_id=${done.church.id}::uuid`);
	});

	await step.test("after the purge, on live and on a restored copy from before it, no cancel works", async () => {
		const { target, store } = await restored(copy, PURGED);
		for (const where of [schema, target]) {
			for (const r of [done, half]) assert.ok(["unavailable", "proof_invalid"].includes(await cancel(r, where)));
			assert.equal(await cancel(pending, where), "deadline_passed");
		}
		const onCopy = await check(done, target, store);
		assert.equal(onCopy.verdict, "purged");
		assert.equal(onCopy.copy_expires_at, COPY_EXPIRY);
		const [w] = await rows<{ state: string }>(
			sql`SELECT state FROM ${sql.raw(`${target}.lifecycle_witness`)} WHERE opaque_subject_id=${done.church.id}::uuid`,
		);
		assert.equal(w!.state, "purged");
	});
});
