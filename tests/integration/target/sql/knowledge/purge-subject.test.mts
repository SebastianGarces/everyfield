import "../../../platform/setup.mts";
import { openedDeletion } from "../../../../support/deletion-cookie.mts";
import test, { after, before, mock } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { cronRoute } from "../../../../../apps/web/src/server/platform/cron.ts";
import { closeDatabase, createDatabase } from "../../../../../packages/db/src/client.ts";
import { S3Client } from "../../../../../packages/db/src/schema/storage.ts";
import { eq, sql } from "../../../../../packages/db/src/query.ts";
import * as t from "../../../../../packages/db/src/schema/tables.ts";
import { accountId, tenantId } from "../../../../../packages/contracts/src/common/values.ts";
import { RequestActor, readViewer } from "../../../../../packages/domain/src/access/session.ts";
import { feedbackWriter } from "../../../../../packages/domain/src/feedback/index.ts";
import { runDuePurges } from "../../../../../packages/domain/src/jobs/lifecycle-purge.ts";
import { claimDue, queueJobs } from "../../../../../packages/domain/src/jobs/queue.ts";
import { gatedTransaction } from "../../../../../packages/domain/src/operations/writes.ts";
import { peopleWriter, withPeopleWrite } from "../../../../../packages/domain/src/people/index.ts";
import { createLifecycleCleanup, deletionOperations } from "../../../../../packages/domain/src/settings/index.ts";
import { issueRestrictedDeletionSession } from "../../../../../packages/domain/src/settings/deletion.ts";
import { testDatabase } from "../../../../support/test-database.mts";
import { type Actor, ok, seeds, type Workspace } from "../../../../support/fixture.mts";
import { freezeClock, readyFile, type Store } from "./support.mts";

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const DAY = 86_400 * SECOND;
const NOW = new Date("2026-10-13T16:00:00.000Z");
const REQUESTED = new Date(NOW.getTime() - 30 * DAY);
const PRIVATE = "A's private note about the launch budget";

const database = await testDatabase({
	prefix: "wp056prg",
	roles: { runtime: ["runtime"], cleanup: ["cleanup"] },
	clock: REQUESTED,
});
const { admin, schema } = database;
const { runtime: db, cleanup } = database.pools;
const seed = seeds(admin);
const live: Store = new Map();
const provider = { calls: [] as string[], down: false };
class DeletingClient extends S3Client {
	constructor() {
		super({
			region: "us-east-1",
			endpoint: "https://example.invalid",
			forcePathStyle: true,
			credentials: { accessKeyId: "test", secretAccessKey: "test" },
		});
	}
	override async send(command: { input: { Key?: string } }) {
		assert.equal(command.constructor.name, "DeleteObjectCommand");
		provider.calls.push(String(command.input.Key));
		if (provider.down) throw Error("provider_timeout");
		live.delete(String(command.input.Key));
		return {};
	}
}
const storage = { bucket: "synthetic-only", client: new DeletingClient() };
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
const command = (input: object, expectedRevision = "1") => ({ input, expectedRevision, requestKey: randomUUID() });
async function at(when: Date) {
	await freezeClock(admin, schema, when);
	mock.timers.setTime(when.getTime());
}
const later = (ms: number) => at(new Date(NOW.getTime() + ms));
const actorOf = async (who: Actor) => {
	const actor = await RequestActor.resolve(db, who.session);
	assert.ok(actor instanceof RequestActor);
	return actor;
};
const work = () => runDuePurges(db, cleanup, storage, 10);

async function state() {
	const names = (
		await admin.execute<{ name: string }>(sql`SELECT c.relname AS name FROM pg_class c
			JOIN pg_namespace n ON n.oid=c.relnamespace
			WHERE n.nspname=current_schema() AND c.relkind='r' AND c.relname<>'job' ORDER BY 1`)
	).rows;
	const tables: Record<string, unknown> = {};
	for (const { name } of names)
		tables[name] = (
			await admin.execute<{ rows: string[] }>(
				sql`SELECT coalesce(array_agg(x::text ORDER BY x::text),'{}') AS rows FROM ${sql.identifier(name)} x`,
			)
		).rows[0]!.rows;
	return { tables, objects: [...live.keys()], calls: [...provider.calls] };
}
const witnessOf = async (subject: string) =>
	(await admin.select().from(t.lifecycle_witness).where(eq(t.lifecycle_witness.opaque_subject_id, subject)))[0]!;
const jobOf = async (subject: string) => {
	const [job] = (
		await admin.execute<{ state: string; error_code: string | null }>(
			sql`SELECT state, error_code FROM job WHERE kind='lifecycle_purge' AND tenant_id=${subject}::uuid`,
		)
	).rows;
	return [job!.state, job!.error_code];
};
const fileOf = async (id: string) => (await admin.select().from(t.file_object).where(eq(t.file_object.id, id)))[0]!;

const account = async (who: Actor) => {
	const [row] = await admin.select().from(t.account).where(eq(t.account.id, who.id));
	const subject = { kind: "account" as const, id: accountId.parse(who.id) };
	const requested = ok(
		await gatedTransaction(db, (tx) =>
			api.requestAccountDeletion(
				tx,
				{ session: who.session, selected: subject },
				command({ confirmed: true }, row!.revision),
			),
		),
	);
	return { subject, requestId: requested.requestId, revision: requested.revision };
};
const workspace = async (plant: Workspace & { kind: "plant" }, owner: Actor) => {
	const [row] = await admin.select().from(t.plant).where(eq(t.plant.id, plant.id));
	const subject = { kind: "plant" as const, id: tenantId.parse(plant.id) };
	const requested = ok(
		await gatedTransaction(db, (tx) =>
			api.requestWorkspaceDeletion(
				tx,
				{ session: owner.session, selected: subject },
				command({ plant, confirmed: true }, row!.revision),
			),
		),
	);
	return { subject, requestId: requested.requestId, revision: requested.revision };
};
const note = async (who: Actor, description: string) =>
	ok(
		await feedbackWriter.submit(
			db,
			await actorOf(who),
			{ requestKey: randomUUID(), category: "bug", description, page: "Documents", address: "/documents" },
			{ appVersion: null },
		),
	);
async function ordinaryAccess(who: Actor) {
	const fresh = randomUUID();
	const [login] = (
		await admin.execute<{ email: string; passwords: number }>(sql`SELECT email,
			(SELECT count(*)::int FROM auth_account WHERE user_id=${who.user}::uuid) AS passwords
			FROM auth_user WHERE id=${who.user}::uuid`)
	).rows;
	await admin.execute(sql`INSERT INTO auth_session(id,user_id,token,expires_at)
		VALUES(${fresh}::uuid,${who.user}::uuid,${fresh},clock_timestamp()+interval '1 day')`);
	const viewers = [await readViewer(db, who.session), await readViewer(db, fresh as never)];
	await admin.execute(sql`DELETE FROM auth_session WHERE id=${fresh}::uuid`);
	const actor = await RequestActor.resolve(db, who.session);
	return {
		normal: viewers.some((viewer) => viewer !== null) || actor instanceof RequestActor,
		email: login?.email ?? null,
		passwords: login?.passwords ?? 0,
	};
}
const cancel = (who: Actor, request: Awaited<ReturnType<typeof account>>) =>
	openedDeletion(
		gatedTransaction(admin, (tx) =>
			issueRestrictedDeletionSession(tx, request, async () => ({ accountId: who.id, provenAt: new Date() })),
		),
		request,
	).then((proof) =>
		gatedTransaction(db, (tx) =>
			api.cancelAccountDeletion(tx, proof, command({ subject: request.subject, requestId: request.requestId })),
		),
	);

type File = Awaited<ReturnType<typeof readyFile>>;
let p: Workspace & { kind: "plant" }, q: Workspace & { kind: "plant" };
let a: Actor, b: Actor, pOwner: Actor, qOwner: Actor, foreign: Actor;
let r: Awaited<ReturnType<typeof account>>, s: Awaited<ReturnType<typeof workspace>>;
let privateBytes: File, plantFile: File, qFile: File, bFile: File;
let personId: string, documentId: string;

before(async () => {
	mock.timers.enable({ apis: ["Date"], now: REQUESTED.getTime() });
	await at(REQUESTED);
	p = await seed.plant({ name: "Harvest Point" });
	q = await seed.plant({ name: "Grace Hill", timezone: "America/New_York" });
	a = await seed.actor(p, "admin", { email: "alex@example.test" });
	b = await seed.actor(null, "owner");
	pOwner = await seed.actor(p, "owner");
	qOwner = await seed.actor(q, "owner");
	foreign = await seed.actor(q, "member");
	await note(a, PRIVATE);
	await note(b, "B's own note");
	privateBytes = await readyFile(admin, live, a.id, Buffer.from("A's private bytes"), "avatar");
	await admin.update(t.account).set({ avatar_object_id: privateBytes.id }).where(eq(t.account.id, a.id));
	bFile = await readyFile(admin, live, b.id, Buffer.from("B's bytes"), "avatar");
	plantFile = await readyFile(admin, live, p.id, Buffer.from("P's bytes"));
	qFile = await readyFile(admin, live, q.id, Buffer.from("Q's bytes"));
	documentId = randomUUID();
	await admin.execute(
		sql`INSERT INTO document(id,tenant_id,kind,title) VALUES(${documentId},${a.id}::uuid,'native',${PRIVATE})`,
	);
	ok(
		await withPeopleWrite(db, await actorOf(a), (tx, ctx) =>
			peopleWriter.createPerson(tx, ctx, { requestKey: randomUUID(), input: { displayName: "Ben Cole" } }),
		),
	);
	const [made] = (
		await admin.execute<{ id: string }>(
			sql`SELECT id FROM person WHERE tenant_id=${p.id}::uuid AND display_name='Ben Cole'`,
		)
	).rows;
	personId = made!.id;

	const qRequest = await workspace(q, qOwner);
	const proof = await openedDeletion(
		gatedTransaction(admin, (tx) =>
			issueRestrictedDeletionSession(tx, qRequest, async () => ({ accountId: qOwner.id, provenAt: REQUESTED })),
		),
		qRequest,
	);
	ok(
		await gatedTransaction(db, (tx) =>
			api.cancelWorkspaceDeletion(
				tx,
				proof,
				command({ subject: qRequest.subject, requestId: qRequest.requestId }, qRequest.revision),
			),
		),
	);
	for (const who of [qOwner, foreign])
		await admin.execute(sql`INSERT INTO auth_session(id,user_id,token,expires_at)
			VALUES(${who.session}::uuid,${who.user}::uuid,${randomUUID()},'2027-01-01T00:00:00Z') ON CONFLICT DO NOTHING`);
	r = await account(a);
	await at(new Date(REQUESTED.getTime() + SECOND));
	s = await workspace(p, pOwner);
	await at(NOW);
	await admin.execute(sql`UPDATE auth_session SET expires_at='2027-01-01T00:00:00Z'`);
});
after(async () => {
	mock.timers.reset();
	await database.close();
});

const kept = async () => {
	const [history] = (
		await admin.execute<{ people: number; audits: number; named: number }>(sql`SELECT
			(SELECT count(*)::int FROM person WHERE id=${personId}::uuid AND plant_id=${p.id}::uuid) AS people,
			(SELECT count(*)::int FROM audit_event WHERE subject_id=${personId}::uuid AND actor_token IS NOT NULL) AS audits,
			(SELECT count(*)::int FROM audit_event WHERE actor_id=${a.id}::uuid) AS named`)
	).rows;
	return history;
};
const privateRows = async () =>
	(
		await admin.execute<{ notes: number; documents: number }>(sql`SELECT
			(SELECT count(*)::int FROM feedback WHERE description=${PRIVATE}) AS notes,
			(SELECT count(*)::int FROM document WHERE tenant_id=${a.id}::uuid) AS documents`)
	).rows[0];

test("AC:EVRY-INTERNAL-PURGEELIGIBLESUBJECT only the deletion due at its exact deadline purges, in chunks that survive a timeout and an interruption", async (step) => {
	const attempt = async () => {
		const w = await witnessOf(a.id);
		const file = await fileOf(privateBytes.id);
		const access = await ordinaryAccess(a);
		const rows = await privateRows();
		return {
			status: w.state,
			livePurgedAt: w.live_purged_at,
			normal_access: access.normal,
			completed_chunks: rows!.notes + rows!.documents === 0 ? [1] : [],
			object_cleanup:
				file.state === "purged" ? "confirmed" : file.purge_requested_at === null ? "not_attempted" : "unknown",
			plant_history_retained: (await kept())!.people === 1 && (await kept())!.audits > 0,
		};
	};

	await step.test("one millisecond before the deadline the worker touches nothing", async () => {
		await later(-1);
		const before = await state();
		assert.equal(await work(), 0);
		const after = await state();
		assert.deepEqual(after, before);
		assert.equal((await witnessOf(a.id)).state, "pending_deletion");
		await at(NOW);
	});

	await step.test(
		"at the deadline the rows go, the provider times out, and the account stays purging and hidden",
		async () => {
			assert.deepEqual(await privateRows(), { notes: 1, documents: 1 });
			assert.ok((await kept())!.named > 0);
			provider.down = true;
			assert.equal(await work(), 0);
			const outcome = {
				status: "purging",
				livePurgedAt: null,
				normal_access: false,
				completed_chunks: [1],
				object_cleanup: "unknown",
				plant_history_retained: true,
			};
			assert.deepEqual(await attempt(), outcome);
			assert.deepEqual(await jobOf(a.id), ["retry_wait", "removal_unconfirmed"]);
			assert.deepEqual(provider.calls, [privateBytes.key]);
			assert.ok(live.has(privateBytes.key));
			const file = await fileOf(privateBytes.id);
			assert.deepEqual([file.state, file.purged_at], ["cleanup", null]);
			assert.equal((await kept())!.named, 0, "the church keeps the history without the account's name on it");
			assert.equal((await ordinaryAccess(a)).email, `removed-${a.id}@removed.invalid`);

			const before = await state();
			assert.equal(await work(), 0);
			assert.deepEqual(await state(), before, "a second run before its retry time changes nothing");
			assert.deepEqual(await attempt(), outcome);
		},
	);

	await step.test(
		"a request one second from its deadline, a cancelled one and an unrelated account are untouched",
		async () => {
			const pending = await witnessOf(p.id);
			assert.deepEqual([pending.state, pending.cancel_until?.getTime()], ["pending_deletion", NOW.getTime() + SECOND]);
			assert.deepEqual(await jobOf(p.id), ["ready", null]);
			assert.equal((await witnessOf(q.id)).state, "cancelled");
			assert.deepEqual(await jobOf(q.id), ["superseded", "not_current"]);
			assert.equal(await readViewer(db, b.session).then((viewer) => viewer?.accountId), b.id);
			for (const file of [plantFile, qFile, bFile]) {
				assert.equal((await fileOf(file.id)).state, "ready");
				assert.ok(live.has(file.key));
			}
			const [notes] = (
				await admin.execute<{ n: number }>(
					sql`SELECT count(*)::int AS n FROM feedback WHERE description='B''s own note'`,
				)
			).rows;
			assert.equal(notes!.n, 1);
			const refused = await cancel(a, r);
			assert.ok(refused.status === "refused" && refused.error.code === "deadline_passed", JSON.stringify(refused));
		},
	);

	await step.test(
		"foreign-context-refused: another church's member cannot purge, sees nothing and changes nothing",
		async () => {
			assert.equal((await readViewer(db, foreign.session))?.accountId, foreign.id);
			const before = await state();
			const held = await jobOf(a.id);
			let ran = 0;
			const route = cronRoute("cron-secret", async () => {
				ran++;
				await work();
				return Response.json({ status: "ok" });
			});
			const claim = { subject: r.subject, requestId: r.requestId, revision: r.revision };
			for (let repeat = 0; repeat < 2; repeat++) {
				for (const [name, value] of [
					["cookie", `better-auth.session_token=${foreign.session}`],
					["authorization", `Bearer ${foreign.session}`],
					["authorization", "Bearer cron-secrex"],
				] as const) {
					const response = await route(
						new Request(`https://app.example.test/api/cron/jobs?subject=${a.id}`, { headers: { [name]: value } }),
					);
					assert.equal(response.status, 401);
					assert.deepEqual(await response.json(), { status: "unauthorized" });
				}
				for (const subject of [r.subject, { kind: "account" as const, id: accountId.parse(randomUUID()) }])
					await assert.rejects(
						createLifecycleCleanup(cleanup, {
							authorize: async () => false,
							removeOwnedResources: async () => assert.fail("no owned resource is touched"),
						})({ ...claim, subject }),
						{ code: "unavailable" },
					);
				for (const statement of [
					sql`SELECT settings_purge_content(${(await witnessOf(a.id)).id}::uuid,${r.requestId}::uuid,1)`,
					sql`SELECT settings_purge_subject(${(await witnessOf(a.id)).id}::uuid,${r.requestId}::uuid,1)`,
				])
					await assert.rejects(
						db.execute(statement),
						(error: { cause?: { code?: string } }) => error.cause?.code === "42501",
					);
				await assert.rejects(cancel(foreign, r));
				const own = await gatedTransaction(db, (tx) =>
					api.requestAccountDeletion(
						tx,
						{ session: foreign.session, selected: r.subject },
						command({ confirmed: true }, "1"),
					),
				);
				assert.equal(own.status, "refused");
				assert.equal(JSON.stringify(own).includes(PRIVATE), false);
				assert.equal(JSON.stringify(own).includes(r.requestId), false);
			}
			assert.equal(ran, 0);
			assert.deepEqual(await state(), before);
			assert.deepEqual(await jobOf(a.id), held);
		},
	);

	await step.test(
		"required-boundary-failure: a cleanup store that cannot be reached writes nothing and keeps the finished chunk",
		async () => {
			const before = await state();
			const offline = createDatabase({ connectionString: "postgres://nobody@127.0.0.1:9/none", max: 1 });
			step.after(() => closeDatabase(offline));
			await later(10 * MINUTE);
			assert.equal(await runDuePurges(db, offline, storage, 10), 0);
			assert.deepEqual(await jobOf(a.id), ["retry_wait", "purge_unavailable"]);
			const failed = await state();
			assert.deepEqual(failed, before, "no domain row, stored file or provider call changed");
			assert.equal(await runDuePurges(db, offline, storage, 10), 0);
			assert.deepEqual(await state(), before);
			assert.deepEqual(await privateRows(), { notes: 0, documents: 0 });
			assert.equal((await witnessOf(a.id)).state, "purging");
		},
	);

	await admin.execute(
		sql`UPDATE job SET eligible_at='2027-01-01T00:00:00Z' WHERE kind='lifecycle_purge' AND tenant_id=${p.id}::uuid`,
	);
	await step.test(
		"a worker that dies holding the claim is replaced, and the resumed purge completes once",
		async () => {
			provider.down = false;
			await later(40 * MINUTE);
			const [lost] = await claimDue(db, ["lifecycle_purge"]);
			assert.equal(lost?.tenant_id, a.id);
			const resumedAt = new Date(NOW.getTime() + 2 * 60 * MINUTE);
			assert.equal(await work(), 0, "the held claim is not taken");
			assert.equal((await ordinaryAccess(a)).normal, false);
			await at(resumedAt);
			assert.equal(await work(), 0, "the lost claim is recovered first");
			assert.deepEqual(await jobOf(a.id), ["retry_wait", "lease_expired"]);
			const completedAt = new Date(resumedAt.getTime() + 10 * MINUTE);
			await at(completedAt);
			assert.equal(await work(), 1);
			assert.deepEqual(await attempt(), {
				status: "purged",
				livePurgedAt: completedAt,
				normal_access: false,
				completed_chunks: [1],
				object_cleanup: "confirmed",
				plant_history_retained: true,
			});
			const purged = await witnessOf(a.id);
			assert.equal(purged.copy_expires_at!.getTime(), completedAt.getTime() + 7 * DAY);
			assert.equal(live.has(privateBytes.key), false);
			assert.deepEqual(await jobOf(a.id), ["succeeded", null]);

			const done = await state();
			await at(new Date(completedAt.getTime() + DAY));
			assert.equal(await work(), 0);
			const again = await createLifecycleCleanup(cleanup, {
				authorize: async () => true,
				removeOwnedResources: async () => assert.fail("nothing is left to remove"),
			})({ subject: r.subject, requestId: r.requestId, revision: r.revision });
			assert.equal(again.status, "purged");
			assert.deepEqual(await state(), done, "a repeat never moves the purge time or the copy expiry");
			assert.equal((await witnessOf(p.id)).request_id, s.requestId);
			assert.equal((await witnessOf(p.id)).state, "pending_deletion");
		},
	);
});
