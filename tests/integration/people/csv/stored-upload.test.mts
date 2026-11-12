import { testDatabase } from "../../../support/test-database.mts";
import { sql } from "../../../../packages/db/node_modules/drizzle-orm/index.js";
import { S3Client } from "../../../../packages/db/node_modules/@aws-sdk/client-s3/dist-cjs/index.js";
import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import { RequestActor } from "../../../../packages/domain/src/access/session.ts";
import { runDueObjectCleanup } from "../../../../apps/web/src/server/jobs/object-cleanup.ts";
import { runDueImports } from "../../../../apps/web/src/server/people/run-imports.ts";
import { scheduledJobs } from "../../../../apps/web/src/server/jobs/scheduled.ts";
import {
	executeStoredImport,
	peopleCsv as csv,
	previewStoredImport,
	retryStoredImport,
	signPeopleImport,
} from "../../../../packages/domain/src/people/index.ts";

// T-191: the People CSV import over the shared private-file flow (REQ-PPL-018 with REQ-PPL-014's upload). The browser
// puts the file once into the private bucket with a signed PUT; the preview and the import each read the stored object
// on the server. These tests drive the public operations as the web routes call them, against a synthetic bucket.

const database = await testDatabase({ prefix: "t191" });
const { admin, schema } = database;
const db = database.pools.runtime;

const plant = randomUUID(),
	otherPlant = randomUUID();
// 0: Owner, 1: Member, 2: Owner of another church.
const actors = Array.from({ length: 3 }, () => ({ id: randomUUID(), user: randomUUID(), session: randomUUID() }));
const plantOf = (who) => (who === 2 ? otherPlant : plant);
const LIMIT = 10 * 1024 * 1024;
const ok = (result) => {
	assert.equal(result.status, "ok", JSON.stringify(result).slice(0, 500));
	return result.value;
};
const refused = (result, code = "unavailable") => {
	assert.equal(result.status, "refused", JSON.stringify(result).slice(0, 500));
	assert.equal(result.error.code, code);
	return result.error;
};
const rows = async (query) => (await admin.execute(query)).rows;
const count = async (table) => (await rows(sql.raw(`SELECT count(*)::int n FROM ${schema}.${table}`)))[0].n;
const authority = (who = 0) => db.transaction((t) => RequestActor.resolve(t, actors[who].session));
const header = "first_name,last_name,email,phone,street,city,state,postal_code,country,source,source_details,notes\r\n";
const fileOf = (tag, n) =>
	header +
	Array.from(
		{ length: n },
		(_, i) => `${tag}${i + 1},Stored,${tag.toLowerCase()}${i + 1}@example.test,,,,,,,,,\r\n`,
	).join("");
const bytes = (text) => new TextEncoder().encode(text);

/**
 * A private bucket: what a browser PUT with a signed URL leaves there, the server's reads of it, and the objects the
 * shared cleanup deletes. `length` stands for the stored length when it differs from the bytes that arrive.
 */
function privateStorage() {
	const uploads = new Map();
	const reads = { count: 0, bodies: 0 };
	const deleted = [];
	const signer = new S3Client({
		region: "auto",
		endpoint: "https://storage.example.test",
		credentials: { accessKeyId: "synthetic", secretAccessKey: "synthetic" },
	});
	signer.send = async (command) => {
		const i = command.input;
		switch (command.constructor.name) {
			case "GetBucketAclCommand":
				return { Grants: [{ Grantee: { ID: "private-owner" }, Permission: "FULL_CONTROL" }] };
			case "GetObjectCommand": {
				reads.count++;
				const found = uploads.get(i.Key);
				if (!found) throw Object.assign(Error("NoSuchKey"), { name: "NoSuchKey" });
				return {
					ContentLength: found.length ?? found.bytes.length,
					ContentType: found.type,
					Body: {
						transformToByteArray: async () => {
							reads.bodies++;
							return found.bytes;
						},
					},
				};
			}
			case "DeleteObjectCommand":
				deleted.push(i.Key);
				uploads.delete(i.Key);
				return {};
			default:
				throw Error("unexpected provider operation");
		}
	};
	return { bucket: "synthetic-only", client: signer, uploads, reads, deleted };
}
const storage = privateStorage();
const keyOf = (uploadId, church = plant) => `private/${church}/${uploadId}`;

/** The browser's way in: sign for the file's length, then PUT it, which leaves the bytes under the signed key. */
async function upload(text, who = 0) {
	const file = bytes(text);
	const signed = ok(await signPeopleImport(db, storage, await authority(who), { byteLength: file.length }));
	storage.uploads.set(keyOf(signed.uploadId, plantOf(who)), { bytes: file, type: signed.headers["content-type"] });
	return signed.uploadId;
}
const preview = async (uploadId, who = 0) => previewStoredImport(db, storage, await authority(who), { uploadId });
const choose = (p) => p.rows.filter((r) => r.status === "valid").map((r) => ({ row: r.row, choice: r.suggested }));
const submit = async (uploadId, p, requestKey = randomUUID(), choices = choose(p)) =>
	executeStoredImport(db, storage, await authority(), {
		requestKey,
		uploadId,
		fileDigest: p.fileDigest,
		reviewDigest: p.reviewDigest,
		choices,
	});
const receiptOf = (requestKey) =>
	db.transaction(async (t) =>
		csv.getImportReceipt(t, { session: actors[0].session, selected: { kind: "plant", id: plant } }, { requestKey }),
	);

before(async () => {
	for (const a of actors) {
		await admin.execute(
			sql`INSERT INTO auth_user(id,email,email_verified,name) VALUES(${sql.param(a.user)},${sql.param(a.id + "@example.test")},true,'Synthetic')`,
		);
		await admin.execute(
			sql`INSERT INTO account(id,auth_user_id,registration_state,registration_kind) VALUES(${sql.param(a.id)},${sql.param(a.user)},'active','planter')`,
		);
		await admin.execute(
			sql`INSERT INTO auth_session(id,user_id,token,expires_at) VALUES(${sql.param(a.session)},${sql.param(a.user)},${sql.param(randomUUID())},clock_timestamp()+interval '1 day')`,
		);
	}
	for (const church of [plant, otherPlant])
		await admin.execute(
			sql`INSERT INTO plant(id,name,timezone,warning_days,alert_days,digest_weekday,digest_hour,phase,material_revision) VALUES(${sql.param(church)},'Synthetic','America/Chicago',7,14,1,8,1,1)`,
		);
	for (const [i, role] of [
		[0, "owner"],
		[1, "member"],
		[2, "owner"],
	])
		await admin.execute(
			sql`INSERT INTO seat(account_id,plant_id,role,accepted_at) VALUES(${sql.param(actors[i].id)},${sql.param(plantOf(i))},${sql.param(role)},clock_timestamp()-interval '1 minute')`,
		);
});
after(async () => {
	await database.close();
});

test("AC:TARGET-PPL-018 the Owner signs one upload, and the preview and the import read the stored object, never the browser's rows", async () => {
	const text = fileOf("Ana", 3);
	const file = bytes(text);
	const signed = ok(await signPeopleImport(db, storage, await authority(), { byteLength: file.length }));
	// A five-minute write-once PUT for this church's key, the exact type and length.
	const url = new URL(signed.url);
	assert.ok(url.pathname.endsWith(`/${keyOf(signed.uploadId)}`), url.pathname);
	assert.deepEqual(signed.headers, {
		"content-type": "text/csv",
		"if-none-match": "*",
		"cache-control": "private, no-store",
	});
	assert.match(url.searchParams.get("X-Amz-SignedHeaders"), /content-length/);
	// The staged file is pending, never ready, and the shared cleanup is queued for when it expires.
	assert.deepEqual(
		await rows(sql`SELECT f.state,f.purpose,f.max_bytes::int AS max_bytes,f.byte_count,
 j.kind,j.eligible_at=f.expires_at AS at_expiry,f.expires_at>clock_timestamp()+interval '55 minutes' AS lasts_an_hour
 FROM file_object f JOIN job j ON j.subject_record_id=f.id WHERE f.id=${sql.param(signed.uploadId)}`),
		[
			{
				state: "pending",
				purpose: "native_import",
				max_bytes: file.length,
				byte_count: null,
				kind: "object_cleanup",
				at_expiry: true,
				lasts_an_hour: true,
			},
		],
	);
	storage.uploads.set(keyOf(signed.uploadId), { bytes: file, type: "text/csv" });

	const p = ok(await preview(signed.uploadId));
	assert.deepEqual(
		p.rows.map((r) => [r.row, r.status, r.values.displayName]),
		[
			[1, "valid", "Ana1 Stored"],
			[2, "valid", "Ana2 Stored"],
			[3, "valid", "Ana3 Stored"],
		],
	);
	assert.deepEqual(p.counts, { rows: 3, valid: 3, invalid: 0, existingDuplicates: 0, withinFileDuplicates: 0 });
	// The import request names the upload and the review; it holds no file and no rows.
	const requestKey = randomUUID();
	const queued = ok(await submit(signed.uploadId, p, requestKey));
	assert.equal(queued.status, "in_progress");
	await runDueImports(db, 10);
	const done = ok(await receiptOf(requestKey));
	assert.equal(done.status, "complete");
	assert.deepEqual(done.counts, { created: 3, skipped: 0, failed: 0, remaining: 0 });
	assert.deepEqual(
		(
			await rows(
				sql`SELECT display_name FROM person WHERE id=ANY(${sql.param(done.rows.map((r) => r.personId))}::uuid[]) ORDER BY created_at`,
			)
		).map((r) => r.display_name),
		["Ana1 Stored", "Ana2 Stored", "Ana3 Stored"],
	);

	// Only an Owner or Admin signs, previews or imports; nothing is written for a Member.
	const files = await count("file_object");
	refused(await signPeopleImport(db, storage, await authority(1), { byteLength: 10 }));
	assert.equal(await count("file_object"), files);
	const reads = storage.reads.count;
	refused(await preview(signed.uploadId, 1));
	refused(
		await executeStoredImport(db, storage, await authority(1), {
			requestKey: randomUUID(),
			uploadId: signed.uploadId,
			fileDigest: p.fileDigest,
			reviewDigest: p.reviewDigest,
			choices: choose(p),
		}),
	);
	assert.equal(storage.reads.count, reads, "a Member's request never reads the bucket");
});

test("AC:TARGET-PPL-018 a file over 10 MiB is refused before upload, and a stored object over the limit is refused unread", async () => {
	const files = await count("file_object");
	refused(await signPeopleImport(db, storage, await authority(), { byteLength: LIMIT + 1 }), "file_too_large");
	refused(await signPeopleImport(db, storage, await authority(), { byteLength: 0 }), "invalid_input");
	assert.equal(await count("file_object"), files, "a refused sign stages nothing");

	// A browser that skips the check and stores more than the limit under a signed key: the server refuses the object
	// without reading its body, at preview and at import, and nobody is created.
	const uploadId = await upload(fileOf("Big", 2));
	const p = ok(await preview(uploadId));
	storage.uploads.get(keyOf(uploadId)).length = LIMIT + 1;
	const people = await count("person"),
		bodies = storage.reads.bodies;
	refused(await preview(uploadId), "file_too_large");
	refused(await submit(uploadId, p), "file_too_large");
	assert.equal(storage.reads.bodies, bodies);
	assert.equal(await count("person"), people);
	// The limit itself is a full file: exactly 10 MiB of valid CSV previews.
	const exact = header + "Max,Size,max@example.test,,,,,,,,,";
	const full = await upload(exact + "x".repeat(LIMIT - bytes(exact).length - 2) + "\r\n");
	assert.equal(storage.uploads.get(keyOf(full)).bytes.length, LIMIT);
	assert.equal(ok(await preview(full)).counts.valid, 0, "a 10 MiB note is too long, but the file is read");
});

test("AC:TARGET-PPL-018 BUG-PR198 the import saves exactly the previewed object: swapped, missing or incomplete is file_changed with nobody created", async () => {
	const uploadId = await upload(fileOf("Swap", 2));
	const p = ok(await preview(uploadId));
	const people = await count("person"),
		imports = await count("person_import");
	// Someone replaces the stored object after the preview.
	storage.uploads.set(keyOf(uploadId), { bytes: bytes(fileOf("Other", 2)), type: "text/csv" });
	refused(await submit(uploadId, p), "file_changed");
	// The object is gone, or arrives shorter than stored.
	const original = bytes(fileOf("Swap", 2));
	storage.uploads.delete(keyOf(uploadId));
	refused(await submit(uploadId, p), "file_changed");
	storage.uploads.set(keyOf(uploadId), { bytes: original.slice(0, -5), type: "text/csv", length: original.length });
	refused(await submit(uploadId, p), "file_changed");
	refused(await preview(uploadId), "file_changed");
	// An upload id with nothing stored under it.
	refused(await submit(randomUUID(), p), "file_changed");
	assert.equal(await count("person"), people);
	assert.equal(await count("person_import"), imports);
	// The same bytes again import as previewed.
	storage.uploads.set(keyOf(uploadId), { bytes: original, type: "text/csv" });
	assert.equal(ok(await submit(uploadId, p)).status, "in_progress");
	await runDueImports(db, 10);
	assert.equal(await count("person"), people + 2);
});

// T-194 (people/peo-48, D-801 to D-803): a failed or partial import keeps its uploaded file for 7 days after it last
// stopped with rows left, then the scheduled run deletes it. "Try N rows again" uses the kept copy; after the deletion,
// the same file uploaded again finishes the remaining rows. Row 2 of each file fails in the database on the first run.
const failRow = async (on) =>
	admin.execute(
		sql.raw(
			on
				? `CREATE FUNCTION ${schema}.fail_row() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF NEW.email LIKE '%2@example.test' THEN RAISE EXCEPTION 'synthetic row failure'; END IF; RETURN NEW; END $$;
 CREATE TRIGGER fail_row BEFORE INSERT ON ${schema}.person FOR EACH ROW EXECUTE FUNCTION ${schema}.fail_row();`
				: `DROP TRIGGER fail_row ON ${schema}.person; DROP FUNCTION ${schema}.fail_row()`,
		),
	);
/** A 3-row import whose row 2 failed: its file, upload, review, key and receipt. */
async function partialImport(tag) {
	const text = fileOf(tag, 3);
	const uploadId = await upload(text);
	const p = ok(await preview(uploadId));
	const requestKey = randomUUID();
	await failRow(true);
	try {
		ok(await submit(uploadId, p, requestKey));
		await runDueImports(db, 10);
	} finally {
		await failRow(false);
	}
	const receipt = ok(await receiptOf(requestKey));
	assert.equal(receipt.status, "partial");
	assert.deepEqual(receipt.remaining, [2]);
	assert.equal(receipt.fileKept, true);
	return { text, uploadId, p, requestKey, receipt };
}
const kept = async (importId) =>
	(await rows(sql`SELECT upload IS NOT NULL AS kept FROM person_import WHERE id=${sql.param(importId)}`))[0].kept;
/** The import's job last stopped this long ago. */
const stoppedAgo = (importId, interval) =>
	admin.execute(sql`UPDATE job SET finished_at=clock_timestamp()-${interval}::interval
 WHERE id=(SELECT job_id FROM person_import WHERE id=${sql.param(importId)})`);
const cron = "synthetic-cron-secret";
const tick = scheduledJobs({
	secret: cron,
	db,
	storage: null,
	cleanup: null,
	reminders: null,
	digests: null,
	mail: null,
});
/** One scheduled run, as the platform's cron sends it: the number of kept files it deleted. */
async function scheduledRun() {
	const response = await tick(
		new Request("http://localhost/api/cron/jobs", { headers: { authorization: `Bearer ${cron}` } }),
	);
	const body = await response.json();
	assert.equal(body.steps["people-import-files"].status, "ok", JSON.stringify(body));
	return body.steps["people-import-files"].count;
}
/** The file's copy is deleted: 7 days pass and the scheduled run comes. */
async function expireCopy(importId) {
	await stoppedAgo(importId, "7 days");
	await scheduledRun();
	assert.equal(await kept(importId), false);
}
/** The staged upload's hour is over: the shared cleanup queued at its expiry removes the object and its row. */
async function expireStaged(uploadId) {
	await admin.execute(sql`UPDATE job SET eligible_at=clock_timestamp()-interval '1 second'
 WHERE kind='object_cleanup' AND subject_record_id=${sql.param(uploadId)}`);
	await runDueObjectCleanup(db, storage, 100);
	assert.equal(storage.uploads.has(keyOf(uploadId)), false);
}
/** Every row the import created maps to exactly one stored Person: the rows, in order. */
async function oncePerRow(importId) {
	const found = await rows(sql`SELECT (e.metadata->'import'->>'row')::int AS row, count(*)::int AS events,
 count(DISTINCT e.subject_id)::int AS people, (SELECT count(*)::int FROM person p WHERE p.id=ANY(array_agg(e.subject_id))) AS stored
 FROM audit_event e WHERE e.command_id=${sql.param(importId)} AND e.action='people.created' GROUP BY 1 ORDER BY 1`);
	for (const r of found) assert.deepEqual([r.events, r.people, r.stored], [1, 1, 1], `row ${r.row}`);
	return found.map((r) => r.row);
}
const retry = async (requestKey, uploadId, who = 0) =>
	retryStoredImport(db, storage, await authority(who), uploadId ? { requestKey, uploadId } : { requestKey });
const jobOf = async (importId) =>
	(
		await rows(sql`SELECT j.state,j.revision::int AS revision,pi.actor_id FROM job j JOIN person_import pi ON pi.job_id=j.id
 WHERE pi.id=${sql.param(importId)}`)
	)[0];

test("AC:TARGET-PPL-018 T-194 a partial import keeps its file for 7 days from its last stop, then the scheduled run deletes it and the receipt stays", async () => {
	const { requestKey, receipt } = await partialImport("Keep");
	assert.equal(await kept(receipt.importId), true);
	// 6 days 23 hours after it stopped, the copy is still kept.
	await stoppedAgo(receipt.importId, "6 days 23 hours");
	await scheduledRun();
	assert.equal(await kept(receipt.importId), true);
	assert.deepEqual(ok(await receiptOf(requestKey)), receipt);
	// At 7 days the scheduled run deletes it. Which rows were created, skipped or failed, and why, is unchanged.
	await stoppedAgo(receipt.importId, "7 days");
	assert.ok((await scheduledRun()) >= 1);
	assert.equal(await kept(receipt.importId), false);
	assert.deepEqual(ok(await receiptOf(requestKey)), { ...receipt, fileKept: false });

	// A complete import keeps no copy as soon as it finishes.
	const uploadId = await upload(fileOf("Whole", 2));
	const p = ok(await preview(uploadId));
	const wholeKey = randomUUID();
	ok(await submit(uploadId, p, wholeKey));
	await runDueImports(db, 10);
	const done = ok(await receiptOf(wholeKey));
	assert.equal(done.status, "complete");
	assert.equal(done.fileKept, false);
	assert.equal(await kept(done.importId), false);
});

test("AC:TARGET-PPL-018 T-194 within 7 days Try N rows again writes only the remaining rows from the kept copy, after the staged upload expired", async () => {
	const { uploadId, p, requestKey, receipt } = await partialImport("Again");
	const people = await count("person");
	// The 1-hour staged upload is gone; the kept copy is all the server has.
	await expireStaged(uploadId);
	refused(await submit(uploadId, p, requestKey), "file_changed");

	// A Member, and another church's Owner naming this import, are refused; nothing is queued.
	const before = await jobOf(receipt.importId);
	refused(await retry(requestKey, undefined, 1));
	refused(await retry(requestKey, undefined, 2));
	assert.deepEqual(await jobOf(receipt.importId), before);

	const again = ok(await retry(requestKey));
	assert.equal(again.importId, receipt.importId);
	assert.equal(again.status, "in_progress");
	await runDueImports(db, 10);
	const done = ok(await receiptOf(requestKey));
	assert.equal(done.status, "complete");
	assert.equal(done.fileKept, false, "a complete import keeps no copy");
	assert.equal(await count("person"), people + 1);
	assert.deepEqual(await oncePerRow(receipt.importId), [1, 2, 3]);
	assert.deepEqual(
		done.rows.filter((r) => r.row !== 2),
		receipt.rows.filter((r) => r.row !== 2),
	);
	// Pressing it again after the import completed answers the receipt and creates nobody.
	assert.deepEqual(ok(await retry(requestKey)), done);
	await runDueImports(db, 10);
	assert.equal(await count("person"), people + 1);
	assert.deepEqual(await oncePerRow(receipt.importId), [1, 2, 3]);
});

test("AC:TARGET-PPL-018 T-194 after the copy is deleted, only the same file uploaded again resumes the import, and nobody is created twice", async () => {
	const { text, requestKey, receipt } = await partialImport("Later");
	await expireCopy(receipt.importId);
	const people = await count("person");
	// The button has no copy to use now.
	refused(await retry(requestKey), "import_file_expired");

	// A different file is refused, and nothing is written: no person, no kept file, no queued job.
	const before = await jobOf(receipt.importId);
	for (const other of [fileOf("Other", 3), text.replace("Later3", "Later3x")])
		refused(await retry(requestKey, await upload(other)), "import_file_mismatch");
	assert.equal(await count("person"), people);
	assert.equal(await kept(receipt.importId), false);
	assert.deepEqual(await jobOf(receipt.importId), before);
	assert.deepEqual(ok(await receiptOf(requestKey)), { ...receipt, fileKept: false });

	// The same bytes from a Member, or from another church's Owner in their own church, are refused.
	refused(await retry(requestKey, await upload(text), 1));
	refused(await retry(requestKey, await upload(text, 2), 2));
	assert.equal(await count("person"), people);
	assert.deepEqual(await jobOf(receipt.importId), before);

	// The same file again resumes the same import: only row 2 is written.
	const again = ok(await retry(requestKey, await upload(text)));
	assert.equal(again.importId, receipt.importId);
	assert.equal(again.status, "in_progress");
	await runDueImports(db, 10);
	const done = ok(await receiptOf(requestKey));
	assert.equal(done.status, "complete");
	assert.deepEqual(done.counts, { created: 3, skipped: 0, failed: 0, remaining: 0 });
	assert.equal(await count("person"), people + 1);
	assert.deepEqual(await oncePerRow(receipt.importId), [1, 2, 3]);
	// The same file once more after it completed creates nobody.
	assert.deepEqual(ok(await retry(requestKey, await upload(text))), done);
	await runDueImports(db, 10);
	assert.equal(await count("person"), people + 1);
});

test("AC:TARGET-PPL-018 a failed or abandoned upload leaves no ready file: the shared cleanup removes the staged object and its row", async () => {
	// Signed but never uploaded, and uploaded but never imported.
	const never = ok(await signPeopleImport(db, storage, await authority(), { byteLength: 100 })).uploadId;
	const abandoned = await upload(fileOf("Gone", 1));
	ok(await preview(abandoned));
	const staged = [never, abandoned];
	assert.deepEqual(await rows(sql`SELECT DISTINCT state FROM file_object WHERE id=ANY(${sql.param(staged)}::uuid[])`), [
		{ state: "pending" },
	]);
	assert.equal(await count("file_object WHERE purpose='native_import' AND state='ready'"), 0);
	// Their hour passes: the cleanup queued at expiry comes due.
	await admin.execute(sql`UPDATE job SET eligible_at=clock_timestamp()-interval '1 second'
 WHERE kind='object_cleanup' AND subject_record_id=ANY(${sql.param(staged)}::uuid[])`);
	await runDueObjectCleanup(db, storage, 100);
	assert.deepEqual(await rows(sql`SELECT DISTINCT state FROM file_object WHERE id=ANY(${sql.param(staged)}::uuid[])`), [
		{ state: "purged" },
	]);
	assert.ok(storage.deleted.includes(keyOf(abandoned)));
	assert.equal(storage.uploads.has(keyOf(abandoned)), false);
	refused(await preview(abandoned), "file_changed");
});
