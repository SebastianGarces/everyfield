import "../../../platform/setup.mts";
import test, { after, before, mock } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { eq, sql } from "../../../../../packages/db/src/query.ts";
import * as t from "../../../../../packages/db/src/schema/tables.ts";
import { createLifecycleCleanup, deletionOperations } from "../../../../../packages/domain/src/settings/index.ts";
import { issueRestrictedDeletionSession } from "../../../../../packages/domain/src/settings/deletion.ts";
import { RequestActor, readViewer } from "../../../../../packages/domain/src/access/session.ts";
import { feedbackWriter } from "../../../../../packages/domain/src/feedback/index.ts";
import { queueJobs } from "../../../../../apps/web/src/server/jobs/queue.ts";
import { validateCandidate } from "../../../../../ops/maintenance/recovery.mts";
import { readCurrentManifest, restoreWithCurrentManifest } from "../../../../../ops/maintenance/restore.mts";
import { testDatabase } from "../../../../support/test-database.mts";
import { ok, seeds } from "../../../../support/fixture.mts";
import {
	dropTarget,
	freezeClock,
	objectStore,
	operator,
	readyFile,
	schemaExists,
	snapshot,
	closedTo,
	type Store,
} from "./support.mts";
import { gatedTransaction } from "../../../../../packages/domain/src/operations/writes.ts";

const REQUESTED = new Date("2026-10-13T16:00:00.000Z");
const SNAPSHOT_AT = new Date("2026-11-19T16:00:00.000Z");
const FIRST_PURGE = new Date("2026-11-20T15:00:00.000Z");
const PURGED = new Date("2026-11-20T16:00:00.000Z");
const RESTORE_EARLY = new Date("2026-11-21T16:00:00.000Z");
const RECOPY_AT = new Date("2026-11-26T16:00:00.000Z");
const RESTORE_AT = new Date("2026-11-27T16:00:00.000Z");

const database = await testDatabase({
	prefix: "wp092rst",
	roles: { runtime: ["runtime"], cleanup: ["cleanup"] },
	clock: REQUESTED,
});
const { admin, schema } = database;
const { runtime: db, cleanup } = database.pools;
const seed = seeds(admin);
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
const command = (input, expectedRevision = "1") => ({ input, expectedRevision, requestKey: randomUUID() });
const PRIVATE = "A's private note about the launch budget";
const live: Store = new Map();
const targets: string[] = [];

let a, subject, requestId, avatar, cancelUntil, image;
async function at(when: Date) {
	await freezeClock(admin, schema, when);
	mock.timers.setTime(when.getTime());
}

before(async () => {
	mock.timers.enable({ apis: ["Date"], now: REQUESTED.getTime() });
	await at(REQUESTED);
	const plant = await seed.plant({ name: "Harvest Point" });
	a = await seed.actor(plant, "admin", { email: "alex@example.test" });
	subject = { kind: "account" as const, id: a.id };
	const actor = await RequestActor.resolve(db, a.session);
	assert.ok(actor instanceof RequestActor);
	ok(
		await feedbackWriter.submit(
			db,
			actor,
			{ requestKey: randomUUID(), category: "bug", description: PRIVATE, page: "Documents", address: "/documents" },
			{ appVersion: null },
		),
	);
	avatar = await readyFile(admin, live, a.id, Buffer.from("A's avatar bytes"), "avatar");
	await admin.update(t.account).set({ avatar_object_id: avatar.id }).where(eq(t.account.id, a.id));

	const [account] = await admin.select().from(t.account).where(eq(t.account.id, a.id));
	const requested = ok(
		await gatedTransaction(db, (tx) =>
			api.requestAccountDeletion(
				tx,
				{ session: a.session, selected: subject },
				command({ confirmed: true }, account.revision),
			),
		),
	);
	requestId = requested.requestId;
	cancelUntil = requested.cancelUntil;

	await at(SNAPSHOT_AT);
	image = await snapshot(admin, live, { createdAt: SNAPSHOT_AT });

	let attempts = 0;
	const purge = createLifecycleCleanup(cleanup, {
		authorize: async () => true,
		async removeOwnedResources(input) {
			if (++attempts === 1) return false;
			live.delete(avatar.key);
			for (const state of ["cleanup", "purged"])
				await admin.execute(sql`UPDATE file_object SET state=${state},
					purged_at=CASE WHEN ${state}='purged' THEN clock_timestamp() END WHERE tenant_id=${input.subject.id}::uuid`);
			return true;
		},
	});
	const input = { subject, requestId, revision: requested.revision };
	await at(FIRST_PURGE);
	assert.equal((await purge(input)).status, "purging");
	await at(PURGED);
	assert.equal((await purge(input)).status, "purged");
});
after(async () => {
	mock.timers.reset();
	for (const name of targets) await dropTarget(admin, name);
	await database.close();
});

async function rehearse(when: Date, copy) {
	await at(when);
	const target = `${schema}_r${targets.length}`;
	targets.push(target);
	const store: Store = new Map();
	const result = await restoreWithCurrentManifest(
		{ admin, source: schema, targetSchema: target, objects: objectStore(store), clock: () => when },
		{ capability: operator, target: "isolated", snapshot: copy, current: () => readCurrentManifest(admin) },
	);
	return { result, store, target };
}

async function privateVisible(target: string, store: Store) {
	if (!(await schemaExists(admin, target))) return store.size > 0;
	const at = (table: string) => sql.raw(`${target}.${table}`);
	const [row] = (
		await admin.execute<{ bodies: number; email: string | null }>(
			sql`SELECT (SELECT count(*)::int FROM ${at("feedback")} WHERE description=${PRIVATE}) AS bodies,
				(SELECT u.email FROM ${at("account")} c JOIN ${at("auth_user")} u ON u.id=c.auth_user_id WHERE c.id=${a.id}::uuid) AS email`,
		)
	).rows;
	return row!.bodies > 0 || row!.email === a.email || store.has(avatar.key);
}

async function cancelThrough(target: string) {
	const pool = database.connect("admin", { schema: target, max: 1 });
	const proof = await gatedTransaction(pool, (tx) =>
		issueRestrictedDeletionSession(tx, { subject, requestId }, async () => ({ accountId: a.id, provenAt: new Date() })),
	);
	return gatedTransaction(pool, (tx) => api.cancelAccountDeletion(tx, proof, command({ subject, requestId })));
}

const witnessIn = async (target: string) =>
	(
		await admin.execute<{ state: string; copy_expires_at: Date }>(
			sql`SELECT state, copy_expires_at FROM ${sql.raw(`${target}.lifecycle_witness`)} WHERE opaque_subject_id=${a.id}::uuid`,
		)
	).rows[0];

test("AC:ORG55-008 a restore from before the purge keeps A hidden, with the copy expiry of the current witness", async (step) => {
	await step.test(
		"the request sets the cancel deadline; the live purge after one retry sets the copy expiry",
		async () => {
			assert.equal(cancelUntil, "2026-11-12T16:00:00.000Z");
			const [w] = await admin.select().from(t.lifecycle_witness).where(eq(t.lifecycle_witness.opaque_subject_id, a.id));
			assert.equal(w.state, "purged");
			assert.equal(w.live_purged_at.toISOString(), PURGED.toISOString());
			assert.equal(w.copy_expires_at.toISOString(), "2026-11-27T16:00:00.000Z");
		},
	);

	await step.test(
		"before the copy expires: the restored image shows A purged, not pending, and the target is closed",
		async () => {
			const { result, store, target } = await rehearse(RESTORE_EARLY, image);
			assert.equal(result.restore_success, true, JSON.stringify(result));
			assert.equal(result.service_opened, false);
			assert.equal(result.customer_data_gate, "blocked");
			assert.equal(await privateVisible(target, store), false);
			const w = await witnessIn(target);
			assert.equal(w.state, "purged");
			assert.equal(new Date(w.copy_expires_at).toISOString(), "2026-11-27T16:00:00.000Z");
			const runtime = database.connect("runtime", { schema: target, max: 1 });
			await assert.rejects(readViewer(runtime, a.session));
			assert.equal(await closedTo(runtime, target), true);
		},
	);

	await step.test("on 2026-11-27T16:00:00Z the pre-purge snapshot has expired: nothing restores", async () => {
		const { result, store, target } = await rehearse(RESTORE_AT, image);
		const A = result.subjects.find((s) => s.id === a.id)!;
		const outcome = {
			cancel_until: A.cancel_until,
			copy_expiry: A.copy_expiry,
			restored_private_visible: await privateVisible(target, store),
		};
		assert.deepEqual(outcome, {
			cancel_until: "2026-11-12T16:00:00Z",
			copy_expiry: "2026-11-27T16:00:00Z",
			restored_private_visible: false,
		});
		assert.equal(result.refusal, "copy_expired_or_invalid");
		assert.equal(result.service_opened, false);
		assert.equal(await schemaExists(admin, target), false);
	});
});

test("AC:DEL58-008 a recopy after the purge never resets the copy expiry, and the restored subject stays hidden", async (step) => {
	const recopy = {
		...image,
		manifest: { ...image.manifest, createdAt: RECOPY_AT.toISOString(), expiresAt: "2026-12-03T16:00:00.000Z" },
	};
	const reset = {
		...recopy,
		manifest: { ...recopy.manifest, subjects: [{ id: a.id, expiresAt: "2026-12-03T16:00:00.000Z" }] },
	};

	await step.test("the recopy's later expiry is refused through the original-expiry map", async () => {
		await at(RECOPY_AT);
		const original = new Map([[a.id, "2026-11-27T16:00:00.000Z"]]);
		assert.throws(() => validateCandidate(reset.manifest, RECOPY_AT, original), /subject_expired_or_reset/);
		assert.equal(validateCandidate(reset.manifest, RECOPY_AT).effectiveExpiresAt, "2026-12-03T16:00:00.000Z");
		const refused = await rehearse(RESTORE_AT, reset);
		assert.equal(refused.result.refusal, "subject_expired_or_reset");
		assert.equal(await schemaExists(admin, refused.target), false);
	});

	await step.test("on 2026-11-27T16:00:00Z the restored recopy hides A and refuses its cancel", async () => {
		const { result, store, target } = await rehearse(RESTORE_AT, recopy);
		assert.equal(result.restore_success, true, JSON.stringify(result));
		const w = await witnessIn(target);
		let cancel;
		const outcome = {
			copy_expiry: result.subjects.find((s) => s.id === a.id)!.copy_expiry,
			restored_visible: await privateVisible(target, store),
			cancel_allowed: (cancel = await cancelThrough(target)).status === "ok",
		};
		assert.deepEqual(outcome, { copy_expiry: "2026-11-27T16:00:00Z", restored_visible: false, cancel_allowed: false });
		assert.equal(cancel.error.code, "deadline_passed");
		assert.equal(w.state, "purged");
		assert.equal(new Date(w.copy_expires_at).toISOString(), "2026-11-27T16:00:00.000Z");
		assert.equal(result.service_opened, false);
	});
});
