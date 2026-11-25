import "../../platform/setup.mts";
import assert from "node:assert/strict";
import { createSecretKey, randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after, before, mock } from "node:test";
import { nativeFromText } from "../../../../packages/contracts/src/documents/native.ts";
import { sql, type SQL } from "../../../../packages/db/src/query.ts";
import { S3Client } from "../../../../packages/db/src/schema/storage.ts";
import { RequestActor } from "../../../../packages/domain/src/access/session.ts";
import {
	communicationWriter,
	type DeliveryTransport,
	runDueScheduled,
	withCommunicationWrite,
} from "../../../../packages/domain/src/communication/index.ts";
import { documentsWriter } from "../../../../packages/domain/src/documents/index.ts";
import { createPrivateCare } from "../../../../packages/domain/src/intelligence/index.ts";
import { runDuePurges } from "../../../../packages/domain/src/jobs/lifecycle-purge.ts";
import {
	claimUnknownMail,
	createMailService,
	MAIL_PASSES,
	runDueMail,
} from "../../../../packages/domain/src/jobs/mail.ts";
import { claimDue, queueJobs } from "../../../../packages/domain/src/jobs/queue.ts";
import { gatedTransaction } from "../../../../packages/domain/src/operations/writes.ts";
import { deletionOperations, type DeletionSubject } from "../../../../packages/domain/src/settings/index.ts";
import { copyStatus, expireCopies, runBackup } from "../../../../ops/maintenance/backup.mts";
import { BackupBucket, privateEnv } from "../../../../ops/maintenance/bucket.mts";
import { captureSnapshot } from "../../../../ops/maintenance/capture.mts";
import { createEncryptedCopy, openEncryptedCopy } from "../../../../ops/maintenance/copy.mts";
import { openDrillTarget } from "../../../../ops/maintenance/drill.mts";
import { probeAppKeys, probeBackupBucket } from "../../../../ops/maintenance/probe.mts";
import { readiness } from "../../../../ops/maintenance/readiness.mts";
import {
	readCurrentManifest,
	restoreWithCurrentManifest,
	type Snapshot,
} from "../../../../ops/maintenance/restore.mts";
import { backupConfig, runBackupCli } from "../../../support/backup-cli.mts";
import { fakeBucket } from "../../../support/fake-bucket.mts";
import { ok, seeds, type Actor, type Workspace } from "../../../support/fixture.mts";
import { testDatabase } from "../../../support/test-database.mts";
import { MAILING } from "../../communication/church-address.mts";
import {
	closedTo,
	dropTarget,
	freezeClock,
	objectStore,
	readyFile,
	schemaExists,
	snapshot,
	type Store,
} from "../sql/knowledge/support.mts";

type Case = {
	id: string;
	given: Record<string, Record<string, unknown>>;
	clock: { now: string };
	action: { arguments: Record<string, unknown> };
	expected: { state: Record<string, unknown>; result: Record<string, unknown> };
};
const { cases } = JSON.parse(
	readFileSync(new URL("../../../../docs/acceptance/recovery.json", import.meta.url), "utf8"),
) as { cases: Case[] };
const caseOf = (id: string) => cases.find((c) => c.id === id) ?? assert.fail(`no case ${id}`);
const str = (value: unknown) => (typeof value === "string" ? value : assert.fail(JSON.stringify(value)));
const strings = (value: unknown) => (Array.isArray(value) ? value.map(str) : assert.fail(JSON.stringify(value)));
const DAY = 86_400_000;
const plus = (at: string | Date, ms: number) => new Date(new Date(at).getTime() + ms);
function capabilityOf(c: Case, operation?: string) {
	const { authority, verified, operation_ids, environment } = c.given["caller-capability"] ?? assert.fail(c.id);
	return { authority, verified, operation_ids: operation ? [operation] : operation_ids, environment };
}
const RESTORE = "maintenance.restoreWithCurrentManifest";

const START = new Date("2026-09-13T16:00:00.000Z");
const database = await testDatabase({
	prefix: "recoverycases",
	roles: { runtime: ["runtime"], cleanup: ["cleanup"] },
	max: 6,
	clock: START,
});
const { admin, schema } = database;
const { runtime: db, cleanup } = database.pools;
const seed = seeds(admin);
const live: Store = new Map();
const targets: string[] = [];
const dir = mkdtempSync(join(tmpdir(), "recovery-cases-"));
async function at(when: string | Date) {
	const instant = new Date(when);
	await freezeClock(admin, schema, instant);
	mock.timers.setTime(instant.getTime());
}
before(() => mock.timers.enable({ apis: ["Date"], now: START.getTime() }));
after(async () => {
	mock.timers.reset();
	for (const name of targets) await dropTarget(admin, name);
	rmSync(dir, { recursive: true, force: true });
	await database.close();
});
const rows = async (query: SQL) => (await admin.execute(query)).rows;
const one = async (query: SQL) => (await rows(query))[0] ?? assert.fail("the query returned no row");
const actorOf = async (who: Actor, pool = db) => {
	const found = await RequestActor.resolve(pool, who.session);
	assert.ok(found instanceof RequestActor);
	return found;
};

async function restored(
	capability: unknown,
	copy: Snapshot,
	when: string | Date,
	current: () => Promise<unknown> = () => readCurrentManifest(admin),
) {
	const target = `${schema.slice(0, 50)}_t${targets.length}`;
	targets.push(target);
	const store: Store = new Map();
	const result = await restoreWithCurrentManifest(
		{ admin, source: schema, targetSchema: target, objects: objectStore(store), clock: () => new Date(when) },
		{ capability, target: "isolated", snapshot: copy, current },
	);
	const closed = !(await schemaExists(admin, target)) || (await closedTo(db, target));
	return { target, store, result, closed };
}
const opening = {
	authority: "authorized_restricted_recovery_operator",
	verified: true,
	operation_ids: ["maintenance.openDrillTarget"],
	environment: "isolated-drill",
} as const;
async function opened(target: string) {
	const answer = await openDrillTarget(
		{
			admin,
			connection: new URL("postgres://ci@127.0.0.1:5432/everyfield_ci"),
			neon: () => ({ endpoints: [], branches: [] }),
		},
		{ capability: opening, target },
	);
	assert.equal(answer.opened, true, JSON.stringify(answer));
	return database.connect("runtime", { schema: target, max: 2 });
}

const credential = (endpoint: string) => (name: string) => {
	const path = join(dir, `${randomUUID()}-${name}.env`);
	writeFileSync(path, `AWS_ACCESS_KEY_ID=${name}\nAWS_SECRET_ACCESS_KEY=s\nAWS_ENDPOINT_URL_S3=${endpoint}\n`, {
		mode: 0o600,
	});
	return path;
};
async function separateBucket(t: { after(run: () => Promise<void>): void }, when: string | Date) {
	const fake = await fakeBucket();
	t.after(() => fake.close());
	fake.settings.now = new Date(when);
	return fake;
}
type Fake = Awaited<ReturnType<typeof fakeBucket>>;
const key = createSecretKey(randomBytes(32));
async function daily(fake: Fake, copy: Snapshot, when: string | Date) {
	fake.settings.now = new Date(when);
	return runBackup({ bucket: fake.bucket, key, capture: async () => copy, clock: () => new Date(when) });
}
const storedBytes = (fake: Fake) => [...fake.objects].map(([at, o]) => [at, o.bytes.toString("hex")]);

test("AC:BKT60-001 the app, build and preview keys reach nothing in the backup bucket and the restricted key lists, reads and writes it", async (t) => {
	const c = caseOf("BKT60-001");
	const names = strings(c.action.arguments.credentials);
	assert.deepEqual(names, ["app", "build", "preview", "restricted-backup"]);
	await at(c.clock.now);
	const fake = await separateBucket(t, c.clock.now);
	const restricted = names[3];
	const admits = (accessKey: string | undefined) => accessKey === restricted;
	const copy = await snapshot(admin, live, { createdAt: new Date(c.clock.now) });
	const taken = await daily(fake, copy, c.clock.now);
	assert.ok(taken.copy_complete);
	fake.settings.admits = admits;
	const file = credential(fake.endpoint);
	const paths = Object.fromEntries(names.map((name) => [name, file(name)]));
	const path = (name: string) => paths[name] ?? assert.fail(name);

	const before = storedBytes(fake);
	const read = [];
	for (const name of names) {
		const probe = await probeBackupBucket(await privateEnv(path(name)));
		const answer = name === restricted ? "allowed" : "refused";
		assert.deepEqual(probe, { list: answer, read: answer, write: answer, delete: answer }, name);
		read.push(probe.read === "allowed");
	}
	assert.deepEqual(read, c.expected.result.can_read);
	assert.deepEqual(storedBytes(fake), before, "the probes leave the copies as they were");

	const manifest = `${taken.location}/manifest.json`;
	for (const name of names.slice(0, 3)) {
		const bucket = await BackupBucket.open(path(name));
		for (const attempt of [
			() => bucket.list(),
			() => bucket.get(manifest),
			() => bucket.put(`copy/2026-10-13/${randomUUID()}/key`, Buffer.from("x")),
			() => bucket.delete(manifest),
			() => openEncryptedCopy(bucket, taken.location, key),
			() => copyStatus(bucket, new Date(c.clock.now)),
		])
			await assert.rejects(attempt(), name);
	}
	assert.deepEqual(storedBytes(fake), before);
	const bucket = await BackupBucket.open(path(str(restricted)));
	assert.ok((await bucket.list()).some((o) => o.key === manifest));
	const reopened = await openEncryptedCopy(bucket, taken.location, key);
	assert.deepEqual(reopened.image, copy.image);
	assert.equal((await copyStatus(bucket, new Date(c.clock.now))).newest_complete_age_hours, 0);

	const given = [`production=${path("app")}`, `development=${path("build")}`, `preview=${path("preview")}`];
	assert.equal((await probeAppKeys(given)).restricted, true);
	const config = backupConfig(join(dir, "probe"), {
		context: "restricted-backup",
		operations: ["bucket-probe"],
		url: new URL("postgres://ci@127.0.0.1:5432/everyfield_ci"),
		files: { endpoint: fake.endpoint, bucket: "everyfield" },
		backups: fake.endpoint,
	});
	const flags = given.flatMap((keys) => ["--keys", keys]);
	const command = ["bucket-probe", "--config", config];
	const closed = await runBackupCli([...command, ...flags]);
	assert.equal(closed.code, 0, closed.stdout + closed.stderr);
	assert.equal((await runBackupCli(command)).code, 0, "the backup key is refused on the app's own buckets");
	for (const leaked of names.slice(0, 3)) {
		fake.settings.admits = (accessKey) => admits(accessKey) || accessKey === leaked;
		const open = await runBackupCli([...command, ...flags]);
		assert.equal(open.code, 2, leaked);
		assert.equal(JSON.parse(open.stdout).restricted, false, leaked);
	}
});

test("AC:REC59-001 a one-day database history and any set of snapshots leave the release gate blocked, and no snapshot is kept past its expiry, not even the latest", async (t) => {
	const c = caseOf("REC59-001");
	const { PITR_days, required_days, snapshots } = c.given.execution ?? assert.fail("no facts");
	const { result } = c.expected;
	const now = new Date(c.clock.now);
	const [old, latest] = strings(snapshots).map((day) => new Date(`${day}T15:00:00.000Z`));
	assert.ok(old && latest);
	const fake = await separateBucket(t, old);
	for (const when of [old, latest]) {
		await at(when);
		assert.ok((await daily(fake, await snapshot(admin, live, { createdAt: when }), when)).copy_complete);
	}
	await at(now);
	const before = await copyStatus(fake.bucket, now, "closed");
	assert.deepEqual(
		before.copies.map((copy) => copy.state),
		["expired", "complete"],
	);
	assert.ok(before.failing.some((f) => f.startsWith("expired_copy_remains")));

	const history = (days: unknown) => ({ PITR_days: days, required_days, snapshots });
	const complete = {
		cost_approval: {
			approved: true,
			approved_at: c.clock.now,
			monthly_usd: { low: 5, expected: 10, high: 20 },
		},
		host_schedule: { host: "host-1", schedule: "daily", verified_at: c.clock.now },
		key_exclusion: { denied: { app: true, build: true, preview: true }, verified_at: c.clock.now },
		coherent_restore: { live_recovery_proven: true, verified_at: c.clock.now },
	};
	const { coherent_restore: _, ...unproven } = complete;
	for (const [evidence, missing] of [
		[history(PITR_days), ["cost_approval", "host_schedule", "key_exclusion", "coherent_restore"]],
		[{ ...unproven, coherent_restore: { ...history(PITR_days), verified_at: c.clock.now } }, ["coherent_restore"]],
		[{ ...unproven, coherent_restore: { ...history(required_days), verified_at: c.clock.now } }, ["coherent_restore"]],
		[{ ...complete, ...history(PITR_days) }, []],
	] as const) {
		const report = readiness({ capability: capabilityOf(c), evidence, now, copies: before });
		assert.ok(report.refusal === null);
		assert.equal(report.customer_data_gate, result.release_gate);
		assert.equal(report.live_evidence_verified, false);
		assert.deepEqual(report.missing, missing);
	}
	const { account, session, context } = c.given["caller-capability"]?.subject_actor as Record<string, unknown>;
	assert.deepEqual(readiness({ capability: { account, session, context, role: "Admin" }, evidence: complete, now }), {
		refusal: "operator_unavailable",
	});

	const expired = await expireCopies(fake.bucket, now);
	assert.deepEqual(expired.deleted, [before.copies[0]?.location]);
	assert.deepEqual(expired.kept, [before.copies[1]?.location]);
	assert.equal(expired.expiry_proven, true);
	const manual = await createEncryptedCopy(
		{ store: fake.bucket, clock: () => plus(latest, 5 * DAY) },
		{
			capability: {
				authority: "authorized_restricted_backup_operator",
				verified: true,
				operation_ids: ["maintenance.createEncryptedCopy"],
				environment: "isolated-test",
			},
			key,
			source: { copy: str(before.copies[1]?.location) },
		},
	);
	assert.ok(manual.copy_encrypted);
	assert.equal(
		Date.parse(manual.effective_expires_at),
		plus(latest, 7 * DAY).getTime(),
		"a manual copy starts no new week",
	);
	const end = plus(latest, 7 * DAY);
	assert.equal((await expireCopies(fake.bucket, plus(end, -1))).deleted.length, 0);
	const last = await expireCopies(fake.bucket, end);
	assert.equal(last.deleted.length, 2);
	assert.equal(last.kept.length > 0, result.indefinitely_preserved_latest);
	assert.equal(
		(await fake.bucket.list()).some((o) => o.key.startsWith("copy/")),
		result.indefinitely_preserved_latest,
	);
	const after = readiness({
		capability: capabilityOf(c),
		evidence: complete,
		now: end,
		copies: await copyStatus(fake.bucket, end),
	});
	assert.ok(after.refusal === null);
	assert.deepEqual([after.customer_data_gate, after.daily_fallback_eligible], [result.release_gate, false]);
});

test("AC:REC59-002 a deleted object comes back for seven days only; a soft-deleted bucket is no separate backup and stays unproven until it is permanently cleaned", async (t) => {
	const c = caseOf("REC59-002");
	const { result } = c.expected;
	const object = c.given["D-v1"] ?? assert.fail("no object");
	const [deletedAt, recoverUntil] = [str(object.deleted_at), str(object.recover_until)];
	await at(deletedAt);
	const plant = await seed.plant({ name: "Harvest Point" });
	const D = await readyFile(admin, live, plant.id, Buffer.from(str(object.body)));
	const copy = await snapshot(admin, live, { createdAt: new Date(deletedAt) });
	const capability = capabilityOf(c);

	for (const when of [c.clock.now, plus(recoverUntil, -1)]) {
		const { result: back, store, closed } = await restored(capability, copy, when);
		assert.equal(back.restore_success, true, JSON.stringify(back));
		assert.equal(Buffer.from(store.get(D.key) ?? []).toString(), result.object_text);
		assert.deepEqual([back.service_opened, closed], [false, true]);
		assert.equal(back.guaranteed_disaster_RTO, null);
	}
	const gone = await restored(capability, copy, recoverUntil);
	assert.deepEqual([gone.result.refusal, gone.store.size], ["copy_expired_or_invalid", 0]);
	const accepted = [];
	for (const days of [6, 7, 8, 30]) {
		const longer = { ...copy, manifest: { ...copy.manifest, expiresAt: plus(deletedAt, days * DAY).toISOString() } };
		if ((await restored(capability, longer, c.clock.now)).result.restore_success) accepted.push(days);
	}
	assert.equal(Math.max(...accepted), result.native_recovery_days);
	const ordinary = { account: "A", session: "session-A", role: "Admin" };
	assert.equal((await restored(ordinary, copy, c.clock.now)).result.refusal, "operator_unavailable");

	const fake = await separateBucket(t, deletedAt);
	assert.ok((await daily(fake, copy, deletedAt)).copy_complete);
	fake.settings.softDelete = true;
	const [held] = (await copyStatus(fake.bucket, new Date(c.clock.now))).copies;
	for (const { key: at } of await fake.bucket.list()) if (at.startsWith("copy/")) await fake.bucket.delete(at);
	const status = await copyStatus(fake.bucket, new Date(c.clock.now));
	assert.ok((await fake.bucket.remains()).some((r) => r.deleted && r.key.startsWith(held?.location ?? "none")));
	assert.equal(
		status.daily_fallback_eligible || status.newest_complete_age_hours !== null,
		result.separate_control_backup,
	);
	assert.ok(status.failing.includes("no_complete_copy"));
	const report = readiness({
		capability: {
			authority: "explicit_scoped_operator",
			verified: true,
			operation_ids: ["ops.readiness"],
			environment: "isolated-test",
		},
		evidence: {},
		now: new Date(c.clock.now),
		copies: status,
	});
	assert.ok(report.refusal === null);
	assert.deepEqual(
		[report.daily_fallback_eligible, report.customer_data_gate],
		[result.separate_control_backup, "blocked"],
	);

	const swept = await expireCopies(fake.bucket, new Date(recoverUntil));
	assert.equal(swept.remains.length === 0, result.physical_cleanup_synchronous, "deleting does not erase");
	assert.equal(!swept.expiry_proven, result.soft_deleted_bucket_requires_permanent_cleanup);
	assert.ok(swept.failing.includes("soft_delete_on"));
	assert.ok(swept.failing.some((f) => f.startsWith("deleted_copy_recoverable:")));
	fake.settings.softDelete = false;
	const cleaned = await expireCopies(fake.bucket, new Date(recoverUntil));
	assert.deepEqual([cleaned.remains, cleaned.expiry_proven], [[], true]);
	for (const setting of ["versioning", "snapshots"] as const) {
		fake.settings[setting] = true;
		const kept = await expireCopies(fake.bucket, new Date(recoverUntil));
		assert.deepEqual([kept.expiry_proven, kept.failing], [false, [`${setting}_on`]]);
		fake.settings[setting] = false;
	}
});

test("AC:RECOVERY-COPY-001 a daily candidate without one replaced object is never promoted or opened, the ordinary app reaches no backup, and a restore proves no RPO or RTO", async (t) => {
	const c = caseOf("RECOVERY-COPY-001");
	const { result } = c.expected;
	const now = new Date(c.clock.now);
	const yesterday = plus(now, -23 * 3_600_000);
	await at(yesterday);
	const plant = await seed.plant({ name: "Harvest Point" });
	const A = await seed.actor(plant, "admin");
	const D1 = await readyFile(admin, live, plant.id, Buffer.from("document D1"));
	const first = await snapshot(admin, live, { createdAt: yesterday });
	const fake = await separateBucket(t, yesterday);
	const taken = await daily(fake, first, yesterday);
	assert.ok(taken.copy_complete);

	await at(now);
	const D2 = await readyFile(admin, live, plant.id, Buffer.from("document D2"));
	const candidate = await snapshot(admin, live, { createdAt: now });
	const without: Snapshot = { ...candidate, objects: new Map([...candidate.objects].filter(([id]) => id !== D2.id)) };
	assert.equal(candidate.objects.size - without.objects.size, 1);
	assert.equal(c.given["case-input"]?.missing_object, "D2");
	const good = () => storedBytes(fake).filter(([at]) => at?.startsWith(taken.location));
	const before = good();
	const complete = async () =>
		(await copyStatus(fake.bucket, now)).copies
			.filter((copy) => copy.state === "complete")
			.map((copy) => copy.location);
	assert.deepEqual(await complete(), [taken.location]);
	assert.deepEqual(await daily(fake, without, now), { copy_complete: false, refusal: "file_missing" });
	const files = new Map(live);
	files.delete(D2.key);
	await assert.rejects(
		captureSnapshot({
			db: admin,
			schema,
			files: {
				read: async (at) => (files.has(at) ? { bytes: files.get(at) ?? Buffer.alloc(0), version: "1" } : null),
				keys: async () => [...files.keys()],
			},
			sourceCommit: "a".repeat(40),
		}),
		{ message: "file_missing" },
	);
	fake.settings.put = (at, bytes) => (at.endsWith(`objects/${D2.id}`) ? Buffer.from("another object") : bytes);
	const damaged = await daily(fake, candidate, now);
	assert.equal(damaged.copy_complete, result.candidate_promoted);
	assert.deepEqual(await complete(), [taken.location]);
	const tampered = (await copyStatus(fake.bucket, now)).copies.find((copy) => copy.location !== taken.location);
	assert.equal(tampered?.state, "incomplete");
	await assert.rejects(openEncryptedCopy(fake.bucket, str(tampered?.location), key), { message: "copy_unreadable" });
	assert.deepEqual(good(), before, "the last complete copy is untouched");

	const capability = capabilityOf(c);
	const refusedRestore = await restored(capability, without, now);
	assert.deepEqual(
		[refusedRestore.result.restore_success, refusedRestore.result.refusal, refusedRestore.result.file],
		[result.candidate_promoted, "file_missing", D2.id],
	);
	assert.equal(refusedRestore.store.size, 0);
	assert.equal(await schemaExists(admin, refusedRestore.target), false);

	const back = await restored(capability, await openEncryptedCopy(fake.bucket, taken.location, key), now);
	assert.equal(back.result.restore_success, true, JSON.stringify(back.result));
	assert.equal(Buffer.from(back.store.get(D1.key) ?? []).toString(), "document D1");
	assert.equal(back.result.service_opened || !back.closed, result.normal_access);
	assert.equal(refusedRestore.result.service_opened || !refusedRestore.closed, result.normal_access);
	const inTarget = database.connect("runtime", { schema: back.target, max: 1 });
	await assert.rejects(RequestActor.resolve(inTarget, A.session));
	assert.equal((await restored({ account: A.id, role: "Admin" }, first, now)).result.refusal, "operator_unavailable");

	assert.deepEqual(
		[back.result.guaranteed_disaster_RTO, back.result.customer_SLA, back.result.internal_target_met],
		[null, null, false],
	);
	assert.equal(back.result.observed_loss_hours !== null, result.RPO_claim_proven);
	assert.equal(back.result.observed_restore_hours !== null, result.RTO_claim_proven);
	const report = readiness({
		capability: {
			authority: "explicit_scoped_operator",
			verified: true,
			operation_ids: ["ops.readiness"],
			environment: "isolated-test",
		},
		evidence: { coherent_restore: { ...back.result, verified_at: c.clock.now } },
		now,
		copies: await copyStatus(fake.bucket, now),
	});
	assert.ok(report.refusal === null);
	assert.equal(report.live_evidence_verified || !report.missing.includes("coherent_restore"), result.RPO_claim_proven);
	assert.deepEqual([report.daily_fallback_eligible, report.customer_data_gate], [true, "blocked"]);

	fake.settings.admits = (accessKey) => accessKey === "restricted";
	const file = credential(fake.endpoint);
	const ordinary = await probeBackupBucket(await privateEnv(file("app")));
	assert.equal(Object.values(ordinary).includes("allowed"), result.ordinary_app_backup_access);
	assert.equal((await probeBackupBucket(await privateEnv(file("restricted")))).read, "allowed");
	const app = await BackupBucket.open(file("app"));
	await assert.rejects(openEncryptedCopy(app, taken.location, key));
	fake.settings.admits = () => true;
	await assert.rejects(openEncryptedCopy(app, taken.location, createSecretKey(randomBytes(32))), {
		message: "copy_unreadable",
	});
});

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
		assert.equal(command.constructor.name, "DeleteObjectCommand");
		if (provider.down) throw Error("provider_timeout");
		live.delete(str(command.input.Key));
		return {};
	}
}
const storage = { bucket: "synthetic-only", client: new Bucket() };
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
const keys = {
	encryptionKey: Buffer.alloc(32, 7),
	addressKey: Buffer.alloc(32, 9),
	from: "news@example.test",
	origin: "https://app.example.test",
};
const holding = {
	paused: false,
	send: async () => ({ outcome: "unknown" }),
	cancel: async (ids: string[]) => ids.map(() => ({ outcome: "done" })),
	reschedule: async () => {},
} as unknown as DeliveryTransport;

async function schedule(author: RequestActor, plant: Workspace, name: string, sendAt: string) {
	const personId = randomUUID();
	await admin.execute(sql`INSERT INTO person(id,tenant_id,plant_id,display_name,email,source,stage,adult_classification,
		commitment_state,pipeline_position,state,created_at)
		VALUES(${personId},${plant.id},${plant.id},${name},${`${name}@example.test`},'other','prospect','unknown','unknown',0,
		'live',clock_timestamp())`);
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
	const { communicationId } = saved;
	const accepted = ok(
		await withCommunicationWrite(db, author, (tx, ctx) =>
			communicationWriter.scheduleReviewed(tx, ctx, {
				requestKey: randomUUID(),
				expectedRevision: saved.revision,
				input: { communicationId, scheduledAt: sendAt },
			}),
		),
	);
	const revision = async () =>
		str((await one(sql`SELECT revision::text AS revision FROM communication WHERE id=${communicationId}`)).revision);
	ok(
		await communicationWriter.handOffScheduled(
			db,
			author,
			{ requestKey: randomUUID(), expectedRevision: accepted.revision, input: { communicationId } },
			holding,
			keys,
		),
	);
	return { communicationId, revision };
}

test("AC:RECOVERY-DELETE-001 an old backup restores under the newer witness: the deleted login's private text and the cancelled message stay gone, shared facts stay, and a failed or restored purge is never complete or open", async () => {
	const c = caseOf("RECOVERY-DELETE-001");
	const { result } = c.expected;
	const note = str(c.given["private-A"]?.note);
	await at(START);
	const P = await seed.plant({ name: "Harvest Point", ...MAILING });
	const R = await seed.plant({ name: "Removed church" });
	const A = await seed.actor(P, "admin");
	const owner = await seed.actor(P, "owner");
	const ownerR = await seed.actor(R, "owner");
	await admin.execute(sql`UPDATE account SET personal_timezone='America/Chicago' WHERE id IN (${A.id},${owner.id})`);
	const author = await actorOf(A);
	const care = createPrivateCare();
	const week = ok(await care.readCurrent(db, author, {}));
	ok(
		await care.save(db, author, {
			requestKey: randomUUID(),
			expectedRevision: week.revision,
			input: { answers: { spiritual: "strained", family: "steady", financial: "steady", pace: "steady" }, note },
		}),
	);
	const document = async (by: RequestActor, title: string) =>
		ok(await documentsWriter.saveNative(db, by, { title, body: nativeFromText(title), expectedRevision: "0" })).id;
	const shared = await document(author, "Launch plan");
	const removed = await document(await actorOf(ownerR), "Removed church plan");
	const avatar = await readyFile(admin, live, A.id, Buffer.from("A's photo"), "avatar");
	await admin.execute(sql`UPDATE account SET avatar_object_id=${avatar.id} WHERE id=${A.id}`);

	const ask = async (who: Actor, subject: DeletionSubject) => {
		const { revision } = await one(
			subject.kind === "account"
				? sql`SELECT revision::text AS revision FROM account WHERE id=${subject.id}`
				: sql`SELECT revision::text AS revision FROM plant WHERE id=${subject.id}`,
		);
		const context = { session: who.session, selected: subject };
		const raw = (input: object) => ({ input, expectedRevision: revision, requestKey: randomUUID() });
		return ok(
			await gatedTransaction(db, (tx) =>
				subject.kind === "account"
					? deletions.requestAccountDeletion(tx, context, raw({ confirmed: true }))
					: deletions.requestWorkspaceDeletion(tx, context, raw({ plant: subject, confirmed: true })),
			),
		);
	};
	const asked = await ask(A, { kind: "account", id: A.id } as DeletionSubject);
	assert.equal(Date.parse(asked.cancelUntil), Date.parse(c.clock.now));
	await ask(ownerR, { kind: "plant", id: R.id } as DeletionSubject);

	const backupAt = plus(c.clock.now, -DAY);
	await at(backupAt);
	const session = randomUUID();
	await admin.execute(sql`INSERT INTO auth_session(id,user_id,token,expires_at)
		VALUES(${session},${owner.user},${randomUUID()},'2027-01-01T00:00:00Z')`);
	const sender = await actorOf({ ...owner, session: session as Actor["session"] });
	const due = plus(c.clock.now, 30 * 60_000).toISOString();
	const cancelled = await schedule(sender, P, "cancelled", due);
	const standing = await schedule(sender, P, "standing", due);
	const copy = await snapshot(admin, live, { createdAt: backupAt });
	assert.ok(copy.image.includes(note));
	assert.ok(copy.objects.has(avatar.id));
	await at(plus(backupAt, 3_600_000));
	ok(
		await communicationWriter.cancelScheduledReviewed(
			db,
			sender,
			{
				requestKey: randomUUID(),
				expectedRevision: await cancelled.revision(),
				input: { communicationId: cancelled.communicationId },
			},
			holding,
		),
	);
	const mailOf = (id: string, where = schema) =>
		one(sql`SELECT state FROM ${sql.raw(`${where}.mail`)} WHERE logical_key LIKE ${`communication/${id}/%`}`);
	assert.equal((await mailOf(cancelled.communicationId)).state, c.given["case-input"]?.scheduled_message);

	const witnessOf = (id: string, where = schema) =>
		one(
			sql`SELECT state,live_purged_at,copy_expires_at FROM ${sql.raw(`${where}.lifecycle_witness`)} WHERE opaque_subject_id=${id}`,
		);
	const expectGone = async (target: string, state: string) => {
		const at = (table: string) => sql.raw(`${target}.${table}`);
		const tables = await rows(sql`SELECT c.relname AS name FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
			WHERE n.nspname=${target} AND c.relkind='r'`);
		let held = 0;
		for (const { name } of tables)
			held += Number(
				(await one(sql`SELECT count(*)::int AS n FROM ${at(str(name))} x WHERE x::text LIKE ${`%${note}%`}`)).n,
			);
		const facts = await one(sql`SELECT
			(SELECT count(*)::int FROM ${at("private_week")} WHERE author_id=${A.id}) AS weeks,
			(SELECT count(*)::int FROM ${at("private_week")} WHERE plant_id=${P.id}) AS transferred,
			(SELECT count(*)::int FROM ${at("document")} WHERE id=${shared} AND tenant_id=${P.id}) AS shared,
			(SELECT count(*)::int FROM ${at("person")} WHERE plant_id=${P.id}) AS people,
			(SELECT count(*)::int FROM ${at("document")} WHERE id=${removed}) AS removed,
			(SELECT count(*)::int FROM ${at("auth_session")} WHERE user_id=${A.user}) AS sessions,
			(SELECT count(*)::int FROM ${at("auth_user")} WHERE email=${A.email}) AS logins`);
		assert.equal(held + Number(facts.weeks) + Number(facts.transferred) > 0, result.private_body_restored);
		assert.equal(facts.shared === 1 && facts.people === 2, result.shared_fact_survives);
		assert.deepEqual([facts.removed, facts.sessions, facts.logins], [0, 0, 0]);
		const witness = await witnessOf(A.id, target);
		assert.equal(witness.state, state);
		return witness;
	};

	await at(c.clock.now);
	provider.down = true;
	assert.equal(await runDuePurges(db, cleanup, storage, 10), 1, "only the church without files completes");
	const failed = await witnessOf(A.id);
	assert.equal(failed.state === "purged" || failed.live_purged_at !== null, result.failed_purge_reports_complete);
	assert.equal(failed.state, "purging");
	const job = await one(sql`SELECT state FROM job WHERE kind='lifecycle_purge' AND tenant_id=${A.id}`);
	assert.equal(job.state, "retry_wait");
	const capability = capabilityOf(c, RESTORE);
	assert.equal((await restored(capabilityOf(c), copy, c.clock.now)).result.refusal, "operator_unavailable");
	const halfway = await restored({ ...capability, authority: opening.authority }, copy, c.clock.now);
	assert.equal(halfway.result.restore_success, true, JSON.stringify(halfway.result));
	const unfinished = await expectGone(halfway.target, "purging");
	assert.equal(unfinished.live_purged_at !== null, result.failed_purge_reports_complete);
	assert.equal(halfway.store.has(avatar.key), false);

	provider.down = false;
	const purgedAt = plus(c.clock.now, 5 * 60_000);
	await at(purgedAt);
	assert.equal(await runDuePurges(db, cleanup, storage, 10), 1);
	const current = await witnessOf(A.id);
	assert.equal(current.state, c.given["case-input"]?.current_witness);
	assert.equal(new Date(String(current.copy_expires_at)).getTime(), plus(purgedAt, 7 * DAY).getTime());

	const later = plus(c.clock.now, 3_600_000);
	await at(later);
	const operator = { ...capability, authority: opening.authority };
	const back = await restored(operator, copy, later);
	assert.equal(back.result.restore_success, true, JSON.stringify(back.result));
	assert.equal(back.result.service_opened || !back.closed, result.normal_access);
	assert.equal(back.store.has(avatar.key), false);
	const witness = await expectGone(back.target, "purged");
	assert.deepEqual(
		[witness.live_purged_at, witness.copy_expires_at].map(String),
		[current.live_purged_at, current.copy_expires_at].map(String),
	);
	assert.equal((await mailOf(cancelled.communicationId, back.target)).state, "cancelled");

	const runtime = await opened(back.target);
	for (const who of [A, ownerR])
		assert.equal((await RequestActor.resolve(runtime, who.session)) instanceof RequestActor, result.normal_access);
	const sent: string[] = [];
	const delivery: DeliveryTransport = {
		paused: false,
		async send(batch) {
			sent.push(...batch.messages.map((m) => m.to));
			return { outcome: "ids", ids: batch.messages.map(() => "prov-" + randomUUID()) };
		},
		cancel: async (ids) => ids.map(() => ({ outcome: "unknown" })),
		reschedule: async () => assert.fail("nothing is rescheduled"),
	};
	for (let pass = 0; pass < 2; pass++) await runDueScheduled(runtime, delivery, keys, 50, Number.MAX_SAFE_INTEGER);
	assert.equal(sent.includes("cancelled@example.test"), result.scheduled_message_replayed);
	assert.deepEqual(sent, ["standing@example.test"], "the message nobody cancelled still goes once");
	assert.equal((await mailOf(standing.communicationId, back.target)).state, "accepted");

	const tooLate = await restored(operator, copy, plus(backupAt, 7 * DAY));
	assert.deepEqual([tooLate.result.refusal, tooLate.closed], ["copy_expired_or_invalid", true]);
	const recopied = {
		...copy,
		manifest: {
			...copy.manifest,
			subjects: [{ id: A.id, expiresAt: plus(purgedAt, 7 * DAY + 1).toISOString() }],
		},
	};
	assert.equal((await restored(operator, recopied, later)).result.refusal, "subject_expired_or_reset");
});

test("AC:OUTBOX-RESTORE-001 a restored unknown email keeps its original provider key and stays unknown: without provider evidence nothing is sent", async () => {
	const c = caseOf("OUTBOX-RESTORE-001");
	const { state, result } = c.expected;
	const { first_dispatched_at, provider_key } = c.given.mail ?? assert.fail("no mail");
	await at(str(first_dispatched_at));
	const plant = await seed.plant({ name: "Harvest Point" });
	const person = await seed.actor(plant, "owner");
	const calls = { send: [] as string[], lookup: [] as string[] };
	const service = (pool: typeof db) =>
		createMailService({
			db: pool,
			...keys,
			authorize: async (_tx, mails) => new Set(mails.map((m) => m.id)),
			transport: {
				send: async (_payload, requestKey) => {
					calls.send.push(requestKey);
					return { kind: "unknown" };
				},
				lookup: async (id) => {
					calls.lookup.push(id);
					return { kind: "unknown" };
				},
			},
		});
	const mail = service(db);
	const logicalKey = `onboarding/${randomUUID()}`;
	const intent = {
		owner: { kind: "plant" as const, id: plant.id },
		purpose: "relationship_receipt" as const,
		logicalKey,
		recipient: person.id,
		address: person.email,
		content: { subject: "Welcome", text: "Welcome" },
		operation: null,
		notice: null,
		eligibleAt: new Date(str(first_dispatched_at)).toISOString(),
	};
	const enqueue = (pool: typeof db, by: typeof mail) => gatedTransaction(pool, (tx) => by.enqueue(tx, intent));
	const id = await enqueue(db, mail);
	await admin.execute(sql`UPDATE mail_request SET provider_key=${str(provider_key)}
		WHERE id=(SELECT request_id FROM mail_request_member WHERE mail_id=${id})`);
	const [claim] = await claimDue(db, ["mail"]);
	assert.ok(claim);
	assert.equal(claim.subject_record_id, id);
	assert.deepEqual(await mail.dispatch(claim), { kind: "unknown" });
	assert.deepEqual(calls.send, [provider_key]);
	calls.send.length = 0;

	const read = async (where = schema) => {
		const table = (name: string) => sql.raw(`${where}.${name}`);
		return one(sql`SELECT j.state AS job_state,m.state AS mail_state,r.provider_key,r.first_dispatched_at,
				m.provider_message_id,m.logical_key FROM ${table("mail")} m JOIN ${table("job")} j ON j.id=m.job_id
			JOIN ${table("mail_request_member")} mm ON mm.mail_id=m.id JOIN ${table("mail_request")} r ON r.id=mm.request_id
			WHERE m.id=${id}`);
	};
	const unknown = await read();
	assert.equal(new Date(String(unknown.first_dispatched_at)).getTime(), Date.parse(str(first_dispatched_at)));
	await at("2026-10-17T12:00:00Z");
	const copy = await snapshot(admin, live, { createdAt: new Date("2026-10-17T12:00:00Z") });

	await at(c.clock.now);
	const counts = () =>
		one(sql`SELECT (SELECT count(*)::int FROM mail) AS mail,(SELECT count(*)::int FROM mail_attempt) AS attempts,
			(SELECT count(*)::int FROM notice) AS notices,(SELECT count(*)::int FROM audit_event) AS audits`);
	const before = await counts();
	const quiet = async (pool: typeof db, by: typeof mail) => {
		const outcome = await by.reconcileUnknownOutcome(id);
		assert.equal(outcome.kind, result.outcome);
		for (const prefixes of Object.values(MAIL_PASSES)) {
			assert.deepEqual(await claimUnknownMail(pool, prefixes), []);
			await runDueMail(pool, by, prefixes, 50, Number.MAX_SAFE_INTEGER);
		}
		assert.equal(await enqueue(pool, by), id, "the same occurrence is the same email");
		assert.equal(calls.send.length, result.external_sends);
	};
	await quiet(db, mail);
	const { job_state, mail_state, provider_key: kept } = await read();
	assert.deepEqual({ job_state, mail_state, provider_key: kept }, state);
	assert.deepEqual(await read(), unknown);
	assert.deepEqual(await counts(), before);
	assert.deepEqual(calls.lookup, [], "with no provider id there is nothing to ask about");
	await assert.rejects(mail.recordProviderReceipt(id, "prov-guess"), /recovery_unavailable/);

	const restore = {
		authority: opening.authority,
		verified: true,
		operation_ids: [RESTORE],
		environment: "isolated-test",
	};
	const back = await restored(restore, copy, c.clock.now);
	assert.equal(back.result.restore_success, true, JSON.stringify(back.result));
	const runtime = await opened(back.target);
	await quiet(runtime, service(runtime));
	const there = await read(back.target);
	assert.deepEqual([there.mail_state, there.provider_key, there.logical_key], ["unknown", provider_key, logicalKey]);
	assert.equal(there.job_state, "cancelled", "a restored copy closes the job of mail already handed off");

	await admin.execute(sql`UPDATE mail SET provider_message_id='prov-original' WHERE id=${id}`);
	await quiet(db, mail);
	assert.deepEqual(calls.lookup, ["prov-original"], "only the original receipt is looked up");
	const still = await read();
	assert.deepEqual(
		{ job_state: still.job_state, mail_state: still.mail_state, provider_key: still.provider_key },
		state,
	);
});
