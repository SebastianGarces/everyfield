import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { copyStatus, expireCopies, readCopies, runBackup } from "../../../ops/maintenance/backup.mts";
import { KEEP_MS } from "../../../ops/maintenance/capture.mts";
import { openEncryptedCopy } from "../../../ops/maintenance/copy.mts";
import { fakeBucket } from "../../support/fake-bucket.mts";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const NOW = new Date("2026-11-24T08:30:00.000Z");
const dir = mkdtempSync(join(tmpdir(), "backup-bucket-"));
const keyFile = join(dir, "backup.key");
writeFileSync(keyFile, randomBytes(32), { mode: 0o600 });
after(() => rmSync(dir, { recursive: true, force: true }));
const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const CHURCH = "Harvest Point private prayer list";

let fake: Awaited<ReturnType<typeof fakeBucket>>;
async function open(step: { after(run: () => Promise<void>): void }) {
	const opened = await fakeBucket();
	fake = opened;
	step.after(() => opened.close());
}

function snapshot(createdAt: Date, subjects: { id: string; expiresAt: string }[] = []) {
	const image = Buffer.from(JSON.stringify({ version: 1, tables: { person: [{ name: CHURCH }] } }));
	const file = Buffer.from(`%PDF-1.7 ${CHURCH}`);
	const id = randomUUID();
	return {
		image,
		objects: new Map([[id, file]]),
		manifest: {
			version: 1,
			source: "a".repeat(40),
			schema: "b".repeat(64),
			createdAt: createdAt.toISOString(),
			expiresAt: new Date(createdAt.getTime() + KEEP_MS).toISOString(),
			database: { id: randomUUID(), sha256: sha256(image), bytes: image.length, version: "lsn:0/1" },
			objects: [{ id, sha256: sha256(file), bytes: file.length, version: "1" }],
			keyVersion: randomUUID(),
			witnessCheckpoint: "0",
			subjects,
		},
	};
}
async function backup(at: Date, subjects: { id: string; expiresAt: string }[] = []) {
	fake.settings.now = at;
	const taken = snapshot(at, subjects);
	const result = await runBackup({ bucket: fake.bucket, keyFile, capture: async () => taken, clock: () => at });
	return { taken, result };
}
async function complete(at: Date, subjects: { id: string; expiresAt: string }[] = []) {
	const { taken, result } = await backup(at, subjects);
	if (!result.copy_complete) assert.fail(result.refusal);
	return { taken, location: result.location };
}

test("INV-backup: a copy counts as complete only after its uploaded bytes are read back, opened and hashed", async (step) => {
	await open(step);
	await step.test("a whole upload is complete, opens to the same bytes and stores no known plaintext", async () => {
		const { taken, location } = await complete(NOW);
		assert.deepEqual(
			(await readCopies(fake.bucket, NOW)).map(({ location: at, state, expires_at }) => ({ at, state, expires_at })),
			[{ at: location, state: "complete", expires_at: "2026-12-01T06:30:00.000Z" }],
		);
		const opened = await openEncryptedCopy(fake.bucket, location, keyFile);
		assert.deepEqual(opened.image, taken.image);
		for (const [key, { bytes }] of fake.objects) assert.equal(bytes.indexOf(Buffer.from("Harvest Point")), -1, key);
	});

	const broken: [string, (key: string, bytes: Buffer) => Buffer | "refuse"][] = [
		["an upload refused at the database", (key, bytes) => (key.endsWith("/database") ? "refuse" : bytes)],
		["an upload refused at a file", (key, bytes) => (key.includes("/objects/") ? "refuse" : bytes)],
		["an upload refused at the key", (key, bytes) => (key.endsWith("/key") ? "refuse" : bytes)],
		["an upload refused at the manifest", (key, bytes) => (key.endsWith("/manifest.json") ? "refuse" : bytes)],
		["a cut database", (key, bytes) => (key.endsWith("/database") ? bytes.subarray(0, -1) : bytes)],
		[
			"a changed file byte",
			(key, bytes) => {
				if (key.includes("/objects/")) bytes[bytes.length - 1]! ^= 1;
				return bytes;
			},
		],
		[
			"a changed manifest",
			(key, bytes) =>
				key.endsWith("/manifest.json") ? Buffer.from(bytes.toString().replace('"lsn:0/1"', '"lsn:0/2"')) : bytes,
		],
		["a marker that never lands", (key, bytes) => (key.endsWith("/verified.json") ? "refuse" : bytes)],
	];
	for (const [name, put] of broken)
		await step.test(`${name} is never complete`, async () => {
			fake.objects.clear();
			fake.settings.put = put;
			const { result } = await backup(NOW);
			assert.equal(result.copy_complete, false);
			const copies = await readCopies(fake.bucket, NOW);
			assert.equal(
				copies.some((c) => c.state === "complete"),
				false,
			);
			assert.equal((await copyStatus(fake.bucket, NOW)).daily_fallback_eligible, false);
		});

	await step.test("a complete copy that loses an object later stops being complete", async () => {
		fake.objects.clear();
		fake.settings.put = (_key, bytes) => bytes;
		const { location } = await complete(NOW);
		for (const key of [...fake.objects.keys()]) if (key.startsWith(`${location}/objects/`)) fake.objects.delete(key);
		assert.deepEqual(
			(await readCopies(fake.bucket, NOW)).map((c) => c.state),
			["incomplete"],
		);
	});
});

test("INV-backup: expiry deletes every copy at or past its effective expiry, and nothing else", async (step) => {
	await open(step);
	const atExpiry = await complete(new Date(NOW.getTime() - KEEP_MS));
	const pastExpiry = await complete(new Date(NOW.getTime() - 9 * DAY));
	const beforeExpiry = await complete(new Date(NOW.getTime() - KEEP_MS + 1000));
	const subjectExpiry = await complete(new Date(NOW.getTime() - 2 * DAY), [
		{ id: randomUUID(), expiresAt: NOW.toISOString() },
	]);
	const fresh = await complete(NOW);
	fake.settings.put = (key, bytes) => (key.endsWith("/manifest.json") ? "refuse" : bytes);
	await backup(new Date(NOW.getTime() - 6 * HOUR));
	await backup(new Date(NOW.getTime() - 5 * HOUR));

	const result = await expireCopies(fake.bucket, NOW);
	assert.equal(result.expiry_proven, true);
	const gone = [atExpiry, pastExpiry, subjectExpiry].map((c) => c.location);
	const kept = [beforeExpiry, fresh].map((c) => c.location);
	assert.equal(result.deleted.length, 4);
	for (const location of gone) assert.ok(result.deleted.includes(location));
	for (const location of kept) assert.ok(result.kept.includes(location));
	const left = new Set(
		[...fake.objects.keys()].filter((k) => k.startsWith("copy/")).map((k) => k.split("/").slice(0, 3).join("/")),
	);
	assert.equal(left.size, 3);
	assert.ok(kept.every((location) => left.has(location)));
});

test("INV-backup: a purged church's copies end within seven days of the purge, with time left for a late hourly run", async (step) => {
	await open(step);
	const purgedAt = new Date(NOW.getTime() - 7 * DAY);
	await complete(new Date(purgedAt.getTime() - 1));
	const lastRunBeforeDeadline = new Date(purgedAt.getTime() + 7 * DAY - HOUR);
	assert.equal((await expireCopies(fake.bucket, lastRunBeforeDeadline)).deleted.length, 1);
	assert.equal(
		[...fake.objects.keys()].some((k) => k.startsWith("copy/")),
		false,
	);
});

test("INV-backup: provider settings that keep deleted copies make the expiry check fail", async (step) => {
	await open(step);
	await complete(new Date(NOW.getTime() - 8 * DAY));
	fake.settings.softDelete = true;
	const result = await expireCopies(fake.bucket, NOW);
	assert.equal(result.expiry_proven, false);
	assert.ok(result.failing.includes("soft_delete_on"));
	assert.ok(result.failing.some((f) => f.startsWith("deleted_copy_recoverable:copy/")));
	fake.settings.softDelete = false;
	for (const setting of ["versioning", "snapshots"] as const) {
		fake.settings[setting] = true;
		assert.deepEqual((await expireCopies(fake.bucket, NOW)).failing, [`${setting}_on`]);
		fake.settings[setting] = false;
	}
	assert.deepEqual((await expireCopies(fake.bucket, NOW)).failing, []);
});

test("INV-backup: status shows each day and never offers a missing, stale or failed day as the 24-hour fallback", async (step) => {
	await open(step);
	await step.test("an empty bucket fails", async () => {
		const status = await copyStatus(fake.bucket, NOW);
		assert.equal(status.daily_fallback_eligible, false);
		assert.ok(status.failing.includes("no_complete_copy"));
		assert.equal(
			status.days.every((d) => d.state === "missed"),
			true,
		);
	});

	await step.test("a fresh copy shows its date, age, size and expiry", async () => {
		await complete(NOW);
		const at = new Date(NOW.getTime() + 23 * HOUR);
		const status = await copyStatus(fake.bucket, at);
		const [copy] = status.copies;
		assert.deepEqual(
			[copy!.date, copy!.age_hours, copy!.expires_at, copy!.state],
			["2026-11-24", 23, "2026-12-01T06:30:00.000Z", "complete"],
		);
		assert.ok(copy!.bytes > 0);
		assert.equal(status.daily_fallback_eligible, true);
		assert.deepEqual(status.days, [
			{ date: "2026-11-24", state: "complete" },
			{ date: "2026-11-25", state: "due" },
		]);
		assert.deepEqual(status.failing, ["app_key_restriction_open"]);
		assert.equal((await copyStatus(fake.bucket, at, "closed")).failing.length, 0);
	});

	await step.test(
		"a copy older than 24 hours is no fallback, and past 26 hours it is stale and the day missed",
		async () => {
			const late = await copyStatus(fake.bucket, new Date(NOW.getTime() + 24 * HOUR + 60_000), "closed");
			assert.equal(late.daily_fallback_eligible, false);
			const missed = await copyStatus(fake.bucket, new Date(NOW.getTime() + 27 * HOUR), "closed");
			assert.deepEqual(missed.failing, ["newest_copy_stale", "missed_day:2026-11-25"]);
			assert.equal(missed.daily_fallback_eligible, false);
		},
	);

	await step.test("a failed upload is a failed day, never a fallback", async () => {
		fake.settings.put = (key, bytes) => (key.endsWith("/verified.json") ? "refuse" : bytes);
		const nextRun = new Date(NOW.getTime() + DAY);
		await backup(nextRun);
		const status = await copyStatus(fake.bucket, new Date(nextRun.getTime() + HOUR), "closed");
		assert.deepEqual(status.days.at(-1), { date: "2026-11-25", state: "failed" });
		assert.ok(status.failing.includes("failed_day:2026-11-25"));
		assert.equal(status.daily_fallback_eligible, false);
	});
});

test("INV-backup: the bucket store writes only copy keys in its own bucket and never overwrites one", async (step) => {
	await open(step);
	for (const key of ["private/plant/file", "copy/../x", "copy/2026-11-24/x/key"])
		await assert.rejects(fake.bucket.put(key, Buffer.from("x")), { message: "copy_key_invalid" });
	const key = `copy/2026-11-24/${randomUUID()}/key`;
	await fake.bucket.put(key, Buffer.from("one"));
	await assert.rejects(fake.bucket.put(key, Buffer.from("two")), { name: "PreconditionFailed" });
	assert.equal(fake.objects.get(key)!.bytes.toString(), "one");
});
