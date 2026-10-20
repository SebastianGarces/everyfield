import { sql as querySql } from "../../../packages/db/node_modules/drizzle-orm/index.js";
import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { transaction } from "../../../apps/web/src/server/platform/database.ts";
import {
	enqueueJob,
	claimDue,
	finishClaim,
	recoverLease,
	checkpoint,
	extendLease,
} from "../../../apps/web/src/server/jobs/queue.ts";
import { db, runtime, tenant, setup, teardown, subject, due } from "./support.mts";
before(setup);
after(teardown);
const create = async (maxAttempts = 4, kind = "document_render") => {
	const id = await subject();
	return transaction(runtime, (tx) =>
		enqueueJob(tx, {
			tenant,
			subject: id,
			kind,
			key: id,
			revision: "1",
			eligibleAt: "2026-01-01T00:00:00Z",
			maxAttempts,
		}),
	);
};
test("AC:CASE-NTF-002 INV-jobs: concurrent claims fence late completions and retain retry budget", async () => {
	const id = await create();
	const groups = await Promise.all([claimDue(runtime, ["document_render"]), claimDue(runtime, ["document_render"])]);
	assert.deepEqual(groups.map((g) => g.length).sort(), [0, 1]);
	const claim = groups.flat()[0];
	assert.equal(claim.id, id);
	assert.equal(claim.claim_generation, "1");
	assert.equal(await extendLease(runtime, claim, 30), true);
	await db.execute(
		querySql`UPDATE job SET lease_until=clock_timestamp()-interval '1 second' WHERE id=${querySql.param(id)}`,
	);
	assert.equal(await recoverLease(runtime), 1);
	assert.equal(await transaction(runtime, (tx) => finishClaim(tx, claim, { state: "succeeded" })), false);
	await due();
	const [newClaim] = await claimDue(runtime, ["document_render"]);
	assert.equal(newClaim.claim_generation, "3");
	assert.equal(newClaim.attempt_count, 2);
	for (const stale of [
		claim,
		{ ...newClaim, claim_generation: claim.claim_generation },
		{ ...newClaim, lease_owner: claim.lease_owner },
	]) {
		assert.equal(await transaction(runtime, (tx) => finishClaim(tx, stale, { state: "succeeded" })), false);
		assert.equal(await transaction(runtime, (tx) => checkpoint(tx, stale, "stale-output")), false);
		assert.equal(await extendLease(runtime, stale, 30), false);
	}
	assert.equal(await transaction(runtime, (tx) => finishClaim(tx, newClaim, { state: "succeeded" })), true);
	assert.equal(
		(await db.execute(querySql`SELECT state FROM job WHERE id=${querySql.param(id)}`)).rows[0].state,
		"succeeded",
	);
});
test("INV-jobs: default, assessment and explicit leases meet the execution limits", async () => {
	async function bracket(operation, seconds) {
		const before = (await db.execute(querySql`SELECT clock_timestamp()::text AS at`)).rows[0].at;
		const claim = await operation();
		const result =
			await db.execute(querySql`SELECT lease_until BETWEEN ${querySql.param(before)}::timestamptz+make_interval(secs=>${querySql.param(seconds)})
      AND clock_timestamp()+make_interval(secs=>${querySql.param(seconds)}) AS correct FROM job WHERE id=${querySql.param(claim.id)}`);
		assert.equal(result.rows[0].correct, true);
		return claim;
	}
	for (const [kind, seconds, expected] of [
		["document_render", undefined, 300],
		["assessment", undefined, 120],
		["document_render", 1, 1],
		["document_render", 120, 120],
		["document_render", 300, 300],
		["assessment", 300, 120],
	]) {
		await create(4, kind);
		const claim = await bracket(async () => {
			const [c] = await claimDue(runtime, [kind], 1, seconds);
			return c;
		}, expected);
		if (seconds !== 1)
			for (const extension of [300, 1])
				await bracket(
					async () => {
						assert.equal(await extendLease(runtime, claim, extension), true);
						return claim;
					},
					kind === "assessment" ? 120 : extension,
				);
		for (const invalid of [0, 301, 1.5]) {
			await assert.rejects(claimDue(runtime, [kind], 1, invalid));
			await assert.rejects(extendLease(runtime, claim, invalid));
		}
		await db.execute(
			querySql`UPDATE job SET state='cancelled',lease_owner=NULL,lease_until=NULL WHERE id=${querySql.param(claim.id)}`,
		);
	}
});
test("INV-jobs: safe checkpoints resume, external effects reconcile, exhausted jobs stop", async () => {
	for (const external of [false, true]) {
		const id = await create(1);
		const [claim] = await claimDue(runtime, ["document_render"]);
		if (external) assert.equal(await transaction(runtime, (tx) => checkpoint(tx, claim, "external")), true);
		await db.execute(
			querySql`UPDATE job SET lease_until=clock_timestamp()-interval '1 second' WHERE id=${querySql.param(id)}`,
		);
		assert.equal(await recoverLease(runtime), 1);
		assert.equal(
			(await db.execute(querySql`SELECT state FROM job WHERE id=${querySql.param(id)}`)).rows[0].state,
			external ? "reconcile" : "failed",
		);
		assert.equal(await transaction(runtime, (tx) => finishClaim(tx, claim, { state: "succeeded" })), false);
	}
	const id = await create();
	const [claim] = await claimDue(runtime, ["document_render"]);
	assert.equal(
		await transaction(runtime, (tx) =>
			finishClaim(tx, claim, { state: "retry_wait", code: "busy", retryAfterSeconds: 900 }),
		),
		true,
	);
	const wait = await db.execute(
		querySql`SELECT round(extract(epoch FROM next_attempt_at-clock_timestamp()))::int seconds FROM job WHERE id=${querySql.param(id)}`,
	);
	assert.ok(wait.rows[0].seconds >= 899 && wait.rows[0].seconds <= 900);
	assert.deepEqual(await claimDue(runtime, ["document_render"]), []);
});
test("INV-jobs: intent and producer fact roll back together, replay retains original job identity", async () => {
	const record = await subject();
	const input = {
		tenant,
		subject: record,
		kind: "document_render",
		key: record,
		revision: "1",
		eligibleAt: "2026-01-01T00:00:00Z",
	};
	await assert.rejects(
		transaction(runtime, async (tx) => {
			await tx.execute(querySql`UPDATE document SET title='changed' WHERE id=${querySql.param(record)}`);
			await enqueueJob(tx, input);
			throw Error("required_receipt_failed");
		}),
		/required_receipt_failed/,
	);
	assert.equal(
		(await db.execute(querySql`SELECT title FROM document WHERE id=${querySql.param(record)}`)).rows[0].title,
		"Synthetic",
	);
	assert.equal(
		(await db.execute(querySql`SELECT count(*)::int n FROM job WHERE subject_record_id=${querySql.param(record)}`))
			.rows[0].n,
		0,
	);
	const id = await transaction(runtime, (tx) => enqueueJob(tx, input));
	assert.equal(await transaction(runtime, (tx) => enqueueJob(tx, input)), id);
});

test("INV-scan: committed pages retain the owed tail beyond both page and retry limits", async () => {
	const { scanPage } = await import("../../../apps/web/src/server/jobs/queue.ts");
	const id = await transaction(runtime, (tx) =>
		enqueueJob(tx, {
			tenant,
			subject: null,
			kind: "notification",
			key: "sweep",
			revision: null,
			eligibleAt: "2026-01-01T00:00:00Z",
			maxAttempts: 1,
		}),
	);
	const ids = [];
	for (let i = 0; i < 5; i++) ids.push(await subject());
	ids.sort();
	let observed = 0;
	const config = {
		size: 2,
		load: async (tx, after, size) => {
			const r = await tx.execute(
				querySql`SELECT id FROM document WHERE tenant_id=${querySql.param(tenant)} AND id=ANY(${querySql.param(ids)}::uuid[]) AND (${querySql.param(after)}::uuid IS NULL OR id>${querySql.param(after)}::uuid) ORDER BY id LIMIT ${querySql.param(size)}`,
			);
			return r.rows.map((r) => r.id);
		},
		process: async (tx, ids) => {
			await tx.execute(querySql`UPDATE document SET title='processed' WHERE id=ANY(${querySql.param(ids)}::uuid[])`);
		},
	};
	for (let i = 0; i < 4; i++) {
		const [claim] = await claimDue(runtime, ["notification"]);
		assert.equal(claim.id, id);
		assert.equal(await transaction(runtime, (tx) => scanPage(tx, claim, config)), true);
		observed++;
	}
	assert.equal(observed, 4);
	assert.equal(
		(
			await db.execute(
				querySql`SELECT count(*)::int n FROM document WHERE id=ANY(${querySql.param(ids)}::uuid[]) AND title='processed'`,
			)
		).rows[0].n,
		5,
	);
	assert.equal(
		(await db.execute(querySql`SELECT state FROM job WHERE id=${querySql.param(id)}`)).rows[0].state,
		"succeeded",
	);
});
