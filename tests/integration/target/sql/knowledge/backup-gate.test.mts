import "../../../platform/setup.mts";
import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { copyStatus, runBackup } from "../../../../../ops/maintenance/backup.mts";
import { openEncryptedCopy } from "../../../../../ops/maintenance/copy.mts";
import { readiness } from "../../../../../ops/maintenance/readiness.mts";
import { readCurrentManifest, restoreWithCurrentManifest } from "../../../../../ops/maintenance/restore.mts";
import { fakeBucket } from "../../../../support/fake-bucket.mts";
import { testDatabase } from "../../../../support/test-database.mts";
import { type Actor, seeds, type Workspace } from "../../../../support/fixture.mts";
import { dropTarget, freezeClock, objectStore, operator, readyFile, snapshot, type Store } from "./support.mts";

const SNAPSHOT_AT = new Date("2026-10-12T17:00:00.000Z");
const RESTORE_AT = new Date("2026-10-13T16:00:00.000Z");
const scoped = {
	authority: "explicit_scoped_operator",
	verified: true,
	operation_ids: ["ops.readiness"],
	environment: "isolated-test",
} as const;

const database = await testDatabase({ prefix: "wp095gate", clock: SNAPSHOT_AT });
const { admin, schema } = database;
const seed = seeds(admin);
const live: Store = new Map();
const targets: string[] = [];
let plant: Workspace, a: Actor, dir: string, keyFile: string, file: Awaited<ReturnType<typeof readyFile>>;
let journal: unknown, copy: Awaited<ReturnType<typeof snapshot>>;

before(async () => {
	await freezeClock(admin, schema, SNAPSHOT_AT);
	plant = await seed.plant({ name: "Harvest Point" });
	a = await seed.actor(plant, "admin");
	file = await readyFile(admin, live, plant.id, Buffer.from("%PDF-1.7 launch plan D"));
	dir = await mkdtemp(join(tmpdir(), "wp095-gate-"));
	keyFile = join(dir, "backup.key");
	await writeFile(keyFile, randomBytes(32), { mode: 0o600 });
	copy = await snapshot(admin, live, { createdAt: SNAPSHOT_AT });
	journal = await readCurrentManifest(admin);
});
after(async () => {
	for (const name of targets) await dropTarget(admin, name);
	await rm(dir, { recursive: true, force: true });
	await database.close();
});

async function bucketCopy(step: { after(run: () => Promise<void>): void }) {
	const fake = await fakeBucket();
	step.after(() => fake.close());
	fake.settings.now = SNAPSHOT_AT;
	const taken = await runBackup({
		bucket: fake.bucket,
		keyFile,
		capture: async () => copy,
		clock: () => SNAPSHOT_AT,
	});
	if (!taken.copy_complete) assert.fail(taken.refusal);
	return { fake, location: taken.location };
}

async function restoreFrom(opened: Parameters<typeof restoreWithCurrentManifest>[1]["snapshot"], at: Date) {
	const target = `${schema}_r${targets.length}`;
	targets.push(target);
	const store: Store = new Map();
	const result = await restoreWithCurrentManifest(
		{ admin, source: schema, targetSchema: target, objects: objectStore(store), clock: () => at },
		{ capability: operator, target: "isolated", snapshot: opened, current: async () => journal },
	);
	return { result, store };
}

test("AC:BKT60-003 with the provider and the primary lost, a surviving daily copy 23 hours old is the fallback, with no disaster RTO", async (step) => {
	const { fake, location } = await bucketCopy(step);

	await step.test("the surviving copy restores the rows and bytes from the separately kept journal", async () => {
		const { result, store } = await restoreFrom(await openEncryptedCopy(fake.bucket, location, keyFile), RESTORE_AT);
		assert.equal(result.restore_success, true, JSON.stringify(result));
		assert.deepEqual(
			{
				copy_age_hours: result.copy_age_hours,
				daily_fallback_eligible: result.daily_fallback_eligible,
				guaranteed_disaster_RTO: result.guaranteed_disaster_RTO,
			},
			{ copy_age_hours: 23, daily_fallback_eligible: true, guaranteed_disaster_RTO: null },
		);
		assert.deepEqual(Buffer.from(store.get(file.key)!), live.get(file.key));
	});

	await step.test("the same copy past 24 hours restores but is no daily fallback", async () => {
		const late = new Date(SNAPSHOT_AT.getTime() + 24 * 3_600_000 + 1);
		const { result } = await restoreFrom(await openEncryptedCopy(fake.bucket, location, keyFile), late);
		assert.equal(result.restore_success, true, JSON.stringify(result));
		assert.equal(result.daily_fallback_eligible, false);
		assert.equal(result.guaranteed_disaster_RTO, null);
	});

	await step.test("an outage that loses the copy as well leaves no fallback and restores nothing", async () => {
		fake.objects.clear();
		await assert.rejects(openEncryptedCopy(fake.bucket, location, keyFile), { message: "copy_unreadable" });
		const status = await copyStatus(fake.bucket, RESTORE_AT);
		assert.equal(status.daily_fallback_eligible, false);
		assert.ok(status.failing.includes("no_complete_copy"));
	});
});

test("AC:REC59-005 a fresh copy in the separate bucket is fallback evidence while the customer-data gate stays blocked and no second provider gates it", async (step) => {
	const none = await fakeBucket();
	step.after(() => none.close());
	const absent = readiness({
		capability: scoped,
		evidence: {},
		now: RESTORE_AT,
		copies: await copyStatus(none.bucket, RESTORE_AT),
	});
	assert.equal(absent.refusal === null && absent.daily_fallback_eligible, false);

	const { fake } = await bucketCopy(step);
	const copies = await copyStatus(fake.bucket, RESTORE_AT);
	assert.equal(copies.newest_complete_age_hours, 23);
	const report = readiness({ capability: scoped, evidence: {}, now: RESTORE_AT, copies });
	if (report.refusal !== null) return assert.fail(report.refusal);
	assert.deepEqual(
		{
			customer_data_gate: report.customer_data_gate,
			daily_fallback_eligible: report.daily_fallback_eligible,
			second_provider_gate: report.second_provider_gate,
		},
		{ customer_data_gate: "blocked", daily_fallback_eligible: true, second_provider_gate: false },
	);
	assert.deepEqual(report.missing, ["cost_approval", "host_schedule", "key_exclusion", "coherent_restore"]);
	assert.deepEqual(readiness({ capability: { account: a.id, role: "Admin" }, evidence: {}, now: RESTORE_AT, copies }), {
		refusal: "operator_unavailable",
	});
});
