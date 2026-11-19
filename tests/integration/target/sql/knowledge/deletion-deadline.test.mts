import "../../../platform/setup.mts";
import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { eq, sql } from "../../../../../packages/db/src/query.ts";
import * as t from "../../../../../packages/db/src/schema/tables.ts";
import { deletionOperations } from "../../../../../packages/domain/src/settings/index.ts";
import { issueRestrictedDeletionSession } from "../../../../../packages/domain/src/settings/deletion.ts";
import { readViewer } from "../../../../../packages/domain/src/access/session.ts";
import { queueJobs } from "../../../../../apps/web/src/server/jobs/queue.ts";
import { testDatabase } from "../../../../support/test-database.mts";
import { ok, refusedWith, seeds } from "../../../../support/fixture.mts";
import { freezeClock } from "./support.mts";

const REQUESTED = new Date("2026-10-13T16:00:00.000Z");
const DEADLINE = new Date("2026-11-12T16:00:00.000Z");
const BEFORE = new Date("2026-11-12T15:59:59.999Z");

const database = await testDatabase({ prefix: "wp092del", clock: new Date("2026-11-12T15:00:00.000Z") });
const { admin, schema } = database;
const db = database.pools.runtime;
const seed = seeds(admin);
const denied = refusedWith({ details: {} });
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

let plant;
before(async () => {
	plant = await seed.plant({ name: "Harvest Point" });
});
after(() => database.close());

async function pendingDeletion() {
	const a = await seed.actor(plant, "admin");
	const requestId = randomUUID();
	const [w] = await admin
		.insert(t.lifecycle_witness)
		.values({
			kind: "account",
			opaque_subject_id: a.id,
			account_id: a.id,
			request_id: requestId,
			requester_id: a.id,
			requester_opaque_id: a.id,
			request_revision: "1",
			state: "pending_deletion",
			requested_at: REQUESTED,
			cancel_until: DEADLINE,
			witness_checkpoint: "1",
			cleanup_state: "not_started",
		})
		.returning();
	await admin.execute(sql`SELECT settings_suspend_subject(${w.id}::uuid,${requestId}::uuid)`);
	return { a, subject: { kind: "account" as const, id: a.id }, requestId, witness: w.id };
}

const restricted = (a, subject, requestId, at: Date) =>
	admin.transaction((tx) =>
		issueRestrictedDeletionSession(tx, { subject, requestId }, async () => ({ accountId: a.id, provenAt: at })),
	);

async function ordinary(a) {
	const sessions = await admin
		.select({ id: t.auth_session.id })
		.from(t.auth_session)
		.where(eq(t.auth_session.user_id, a.user));
	const viewers = await Promise.all([a.session, ...sessions.map((s) => s.id)].map((id) => readViewer(db, id)));
	return viewers.some((v) => v !== null);
}

const witnessOf = async (id: string) =>
	(await admin.select().from(t.lifecycle_witness).where(eq(t.lifecycle_witness.id, id)))[0];

test("AC:DEL58-003 the restricted session cancels only the current request, and only before its deadline", async (step) => {
	await step.test(
		"before the deadline: cancel allowed, with no ordinary data before it; a stale proof cannot cancel the newer request",
		async () => {
			await freezeClock(admin, schema, BEFORE);
			const { a, subject, requestId, witness } = await pendingDeletion();
			const proof = await restricted(a, subject, requestId, BEFORE);
			const status = ok(await db.transaction((tx) => api.getAccountDeletionStatus(tx, proof, { subject, requestId })));
			assert.deepEqual(status, {
				status: "pending_deletion",
				subject,
				requestId,
				revision: "1",
				requestedAt: REQUESTED.toISOString(),
				cancelUntil: DEADLINE.toISOString(),
			});
			const ordinaryDataBeforeCancel = await ordinary(a);
			assert.equal(ordinaryDataBeforeCancel, false);

			const cancelled = ok(
				await db.transaction((tx) => api.cancelAccountDeletion(tx, proof, command({ subject, requestId }))),
			);
			const cancelAllowed = cancelled.status === "cancelled";
			assert.equal(cancelAllowed, true);
			assert.equal(cancelled.cancelledAt, BEFORE.toISOString());
			assert.equal((await witnessOf(witness)).state, "cancelled");

			const session = randomUUID();
			await admin.insert(t.auth_session).values({
				id: session,
				user_id: a.user,
				token: randomBytes(32).toString("hex"),
				expires_at: new Date(BEFORE.getTime() + 86_400_000),
			});
			const [account] = await admin.select().from(t.account).where(eq(t.account.id, a.id));
			const newer = ok(
				await db.transaction((tx) =>
					api.requestAccountDeletion(
						tx,
						{ session, selected: subject },
						command({ confirmed: true }, account.revision),
					),
				),
			);
			assert.equal(newer.status, "pending_deletion");
			assert.equal(newer.revision, "2");
			assert.notEqual(newer.requestId, requestId);
			const stale = [
				await db.transaction((tx) => api.cancelAccountDeletion(tx, proof, command({ subject, requestId }))),
				await db.transaction((tx) =>
					api.cancelAccountDeletion(tx, proof, command({ subject, requestId: newer.requestId }, "2")),
				),
			];
			for (const r of stale) denied(r, "proof_invalid");
			const oldRequestCancelAllowed = stale.some((r) => r.status === "ok");
			assert.equal(oldRequestCancelAllowed, false);
			const current = await witnessOf(witness);
			assert.equal(current.state, "pending_deletion");
			assert.equal(current.request_id, newer.requestId);
		},
	);

	await step.test(
		"at-deadline: cancel refused although the purge has not run, and ordinary data stays denied",
		async () => {
			await freezeClock(admin, schema, DEADLINE);
			const { a, subject, requestId, witness } = await pendingDeletion();
			const proof = await restricted(a, subject, requestId, DEADLINE);
			const refused = await db.transaction((tx) =>
				api.cancelAccountDeletion(tx, proof, command({ subject, requestId })),
			);
			denied(refused, "deadline_passed");
			const cancelAllowed = refused.status === "ok";
			assert.equal(cancelAllowed, false);
			const w = await witnessOf(witness);
			assert.equal(w.state, "pending_deletion");
			assert.equal(w.live_purged_at, null);
			const ordinaryDataAllowed = await ordinary(a);
			assert.equal(ordinaryDataAllowed, false);
		},
	);
});
