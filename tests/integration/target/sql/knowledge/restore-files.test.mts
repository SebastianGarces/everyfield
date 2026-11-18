import "../../../platform/setup.mts";
import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { sql } from "../../../../../packages/db/src/query.ts";
import { readCurrentManifest, restoreWithCurrentManifest } from "../../../../../ops/maintenance/restore.mts";
import { testDatabase } from "../../../../support/test-database.mts";
import { seeds } from "../../../../support/fixture.mts";
import {
	closedTo,
	dropTarget,
	freezeClock,
	objectStore,
	operator,
	readyFile,
	schemaExists,
	snapshot,
	type Store,
} from "./support.mts";

const COHERENT = new Date("2026-10-13T15:00:00.000Z");
const INCIDENT = new Date("2026-10-13T16:00:00.000Z");
const V2 = "a".repeat(64);

const database = await testDatabase({ prefix: "wp092fil", clock: COHERENT });
const { admin, schema } = database;
const seed = seeds(admin);
const live: Store = new Map();
const targets: string[] = [];
let plant, file;

before(async () => {
	await freezeClock(admin, schema, COHERENT);
	plant = await seed.plant({ name: "Harvest Point" });
	file = await readyFile(admin, live, plant.id, Buffer.from("%PDF-1.7 launch plan D"));
	const b = await seed.actor(plant, "member");
	const requestId = randomUUID();
	await admin.execute(sql`INSERT INTO lifecycle_witness (kind, opaque_subject_id, account_id, request_id, requester_id,
		requester_opaque_id, request_revision, state, requested_at, cancel_until, witness_checkpoint, cleanup_state)
		VALUES ('account', ${b.id}::uuid, ${b.id}::uuid, ${requestId}::uuid, ${b.id}::uuid, ${b.id}::uuid, 1,
		'pending_deletion', clock_timestamp(), clock_timestamp() + interval '720 hours', 1, 'not_started')`);
});
after(async () => {
	for (const name of targets) await dropTarget(admin, name);
	await database.close();
});

async function rehearse(copy, times: Date[] = [INCIDENT], incidentAt?: Date) {
	const target = `${schema}_r${targets.length}`;
	targets.push(target);
	const store: Store = new Map();
	const clock = [...times];
	const result = await restoreWithCurrentManifest(
		{
			admin,
			source: schema,
			targetSchema: target,
			objects: objectStore(store),
			clock: () => (clock.length > 1 ? clock.shift()! : clock[0]!),
		},
		{ capability: operator, target: "isolated", snapshot: copy, current: () => readCurrentManifest(admin), incidentAt },
	);
	return { result, store, target };
}

test("AC:REC59-003 restored bytes of an older file version fail the restore closed, naming only the file", async () => {
	const v1 = Buffer.from("%PDF-1.7 handbook D-v1");
	const v2 = randomUUID(),
		key = `private/${plant.id}/${randomUUID()}`;
	await admin.execute(sql`INSERT INTO file_object (id, tenant_id, purpose, opaque_key, media_type, max_bytes, byte_count,
		sha256, state, upload_key, claim_generation)
		VALUES (${v2}::uuid, ${plant.id}::uuid, 'generated', ${key}, 'application/pdf', 8388608, ${v1.length}, ${V2},
		'ready', ${"upload-" + v2}, 0)`);
	live.set(key, v1);
	const copy = await snapshot(admin, live, { createdAt: COHERENT });
	assert.equal(copy.manifest.objects.find((o) => o.id === v2).sha256, V2);
	try {
		const { result, store, target } = await rehearse(copy);
		assert.deepEqual(
			{ restore_success: result.restore_success, service_opened: result.service_opened },
			{ restore_success: false, service_opened: false },
		);
		assert.equal(result.refusal, "file_mismatch");
		assert.equal(result.file, v2);
		assert.doesNotMatch(JSON.stringify(result), /PDF|handbook/);
		assert.equal(await schemaExists(admin, target), false);
		assert.equal(store.size, 0);
	} finally {
		await admin.execute(sql`UPDATE file_object SET state='cleanup' WHERE id=${v2}::uuid`);
		await admin.execute(sql`UPDATE file_object SET state='purged', purged_at=clock_timestamp() WHERE id=${v2}::uuid`);
		live.delete(key);
	}
});

test("AC:OPS54-002 a restored database without the bytes of one ready file keeps the customer-data gate blocked", async () => {
	const copy = await snapshot(admin, live, { createdAt: COHERENT });
	(copy.objects as Map<string, Uint8Array>).delete(file.id);
	const { result, store, target } = await rehearse(copy);
	assert.deepEqual(
		{ customer_data_gate: result.customer_data_gate, restore_success: result.restore_success },
		{ customer_data_gate: "blocked", restore_success: false },
	);
	assert.equal(result.refusal, "file_missing");
	assert.equal(result.file, file.id);
	assert.equal(result.service_opened, false);
	assert.equal(await schemaExists(admin, target), false);
	assert.equal(store.size, 0);
});

test("AC:REC59-004 a timed drill measures the recovery point and time against the internal targets", async (step) => {
	const copy = await snapshot(admin, live, { createdAt: COHERENT });

	await step.test("restored by 20:00: one hour lost, four hours to recover, targets met, no customer SLA", async () => {
		const start = new Date("2026-10-13T16:30:00.000Z"),
			done = new Date("2026-10-13T20:00:00.000Z");
		const { result, store, target } = await rehearse(copy, [start, done], INCIDENT);
		assert.equal(result.restore_success, true, JSON.stringify(result));
		assert.deepEqual(
			{
				observed_loss_hours: result.observed_loss_hours,
				observed_restore_hours: result.observed_restore_hours,
				internal_target_met: result.internal_target_met,
				customer_SLA: result.customer_SLA,
			},
			{ observed_loss_hours: 1, observed_restore_hours: 4, internal_target_met: true, customer_SLA: null },
		);
		assert.deepEqual(store.get(file.key), live.get(file.key));
		assert.equal(result.service_opened, false);
		assert.equal(result.customer_data_gate, "blocked");
		assert.equal(await closedTo(database.connect("runtime", { schema: target, max: 1 }), target), true);
	});

	await step.test("restored by 21:00: five hours misses the four-hour target", async () => {
		const start = new Date("2026-10-13T16:30:00.000Z"),
			done = new Date("2026-10-13T21:00:00.000Z");
		const { result } = await rehearse(copy, [start, done], INCIDENT);
		assert.equal(result.restore_success, true);
		assert.equal(result.observed_restore_hours, 5);
		assert.equal(result.internal_target_met, false);
		assert.equal(result.customer_SLA, null);
	});
});
