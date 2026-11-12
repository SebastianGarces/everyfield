import { fixture, ok, refused, waitingOnLock } from "../../../support/fixture.mts";
import { sql } from "../../../../packages/db/node_modules/drizzle-orm/index.js";
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import { RequestActor } from "../../../../packages/domain/src/access/session.ts";
import { PeopleReadContext } from "../../../../packages/domain/src/people/core.ts";
import { claimDue, finishClaim } from "../../../../apps/web/src/server/jobs/queue.ts";
import { runDueImports } from "../../../../apps/web/src/server/people/run-imports.ts";
import {
	executeBulkImport,
	listDuplicatePairs,
	peopleCsv as csv,
	peopleMerge,
	runPeopleImport,
	peopleReader,
	peopleWriter as people,
	personFields as fields,
	withPeopleWrite,
} from "../../../../packages/domain/src/people/index.ts";

// The task reminder port of a stage change or retirement. These people hold no dated, assigned task, so a replan
// here would be a bug.
const noReminders = async () => {
	throw Error("unexpected task reminder replan");
};

// People CSV import and export through their public operations on a scratch schema.
const database = await fixture({ prefix: "wp013" });
const { admin, schema } = database;
const db = database.pools.runtime;

const plants = [database.tenant.id, (await database.plant()).id],
	actors = [
		database.actors.owner,
		database.actors.member,
		await database.actor({ kind: "plant", id: plants[1] }, "admin"),
	];
// 0: plant A owner, 1: plant A member, 2: plant B admin.
const ctx = (who = 0) => ({ session: actors[who].session, selected: { kind: "plant", id: plants[who === 2 ? 1 : 0] } });
const rows = async (query) => (await admin.execute(query)).rows;
const count = async (table) => (await rows(sql.raw(`SELECT count(*)::int n FROM ${table}`)))[0].n;
const bytes = (text) => new TextEncoder().encode(text);
const read = (who, body) => db.transaction((t) => body(t, ctx(who)));
const actor = async (who = 0) => db.transaction((t) => RequestActor.resolve(t, actors[who].session));
// A write as the web mount runs it: withPeopleWrite with the request's resolved actor (RT-3).
const write = async (who, body) => withPeopleWrite(db, await actor(who), body);
const preview = (text, who = 0) => read(who, (t, c) => csv.previewImport(t, c, { file: bytes(text) }));
const header = "first_name,last_name,email,phone,street,city,state,postal_code,country,source,source_details,notes\r\n";
const choose = (p, choice = (r) => r.suggested) =>
	p.rows.filter((r) => r.status === "valid").map((r) => ({ row: r.row, choice: choice(r) }));
const submit = async (text, p, choices, requestKey = randomUUID(), who = 0) =>
	executeBulkImport(db, await actor(who), {
		requestKey,
		file: bytes(text),
		fileDigest: p.fileDigest,
		reviewDigest: p.reviewDigest,
		choices,
	});
// The web mount's worker: claim each due import job through the queue and run it.
// The web mount's drain: recover expired leases, then claim and run each due import job.
const drain = () => runDueImports(db, 10);
const receiptOf = (requestKey, who = 0) => read(who, (t, c) => csv.getImportReceipt(t, c, { requestKey }));
/** Submit, let the job run, and read the receipt, as the screen does. */
const importFile = async (text, p, choices, requestKey = randomUUID(), who = 0) => {
	const submitted = await submit(text, p, choices, requestKey, who);
	if (submitted.status !== "ok") return submitted;
	await drain();
	return receiptOf(requestKey, who);
};
async function person(name, input = {}) {
	return ok(
		await write(0, (t, c) =>
			people.createPerson(t, c, { requestKey: randomUUID(), input: { displayName: name, ...input } }),
		),
	).person;
}

after(async () => {
	await database.close();
});

test("AC:TARGET-PPL-018 the server reads the file honestly, previews duplicates without writing and refuses capped or malformed files", async () => {
	const template = csv.generateCsvTemplate();
	assert.equal(template.text, header);

	// The literal case file: BOM, CRLF, a quoted multiline note, doubled quotes and formula-looking text.
	const file =
		"﻿" +
		header +
		'Mara,,mara@example.test,,,,,,,other,,"First line\r\nSecond line"\r\n' +
		'Noah,,noah@example.test,,,,,,,other,,"He said ""hello"""\r\n' +
		"Lia,,lia@example.test,,,,,,,other,,=1+1\r\n";
	const before = await Promise.all(["person", "audit_event", "job"].map(count));
	const p = ok(await preview(file));
	assert.deepEqual(await Promise.all(["person", "audit_event", "job"].map(count)), before, "a preview writes nothing");
	assert.deepEqual(
		p.rows.map((r) => [r.row, r.status, r.values.displayName, r.values.summaryNotes, r.suggested]),
		[
			[1, "valid", "Mara", "First line\r\nSecond line", "create"],
			[2, "valid", "Noah", 'He said "hello"', "create"],
			[3, "valid", "Lia", "=1+1", "create"],
		],
	);
	assert.deepEqual(p.columns, { used: [...header.trim().split(",")], ignored: [] });

	// Existing and within-file duplicates are shown; preview never touches the existing Person.
	const existing = await person("Mara Existing", { email: "Mara@Example.test" });
	const dup = ok(await preview("first_name,email\r\nMara,mara@example.test\r\nMara,mara@example.test\r\n"));
	assert.deepEqual(
		dup.rows.map((r) => [r.row, r.existingDuplicates, r.withinFileDuplicateOf, r.suggested]),
		[
			[1, [{ personId: existing.id, displayName: "Mara Existing" }], null, "skip"],
			[2, [{ personId: existing.id, displayName: "Mara Existing" }], 1, "skip"],
		],
	);
	assert.equal((await rows(sql`SELECT revision::int r FROM person WHERE id=${sql.param(existing.id)}`))[0].r, 1);

	// Row problems are named per row; an export's extra columns are ignored, never imported.
	const mixed = ok(
		await preview(
			"First_Name,last_name,email,status,tags\r\n,,a@example.test,leader,x\r\nAva,,bad-email,leader,x\r\nZed,,z@example.test\r\n",
		),
	);
	assert.deepEqual(mixed.columns, { used: ["first_name", "last_name", "email"], ignored: ["status", "tags"] });
	assert.deepEqual(
		mixed.rows.map((r) => [r.row, r.status, r.problems]),
		[
			[1, "invalid", [{ column: null, code: "name_required" }]],
			[2, "invalid", [{ column: "email", code: "invalid_email" }]],
			[3, "invalid", [{ column: null, code: "column_count" }]],
		],
	);

	assert.deepEqual(
		refused(await preview('first_name,notes\r\nMara,"unterminated\r\n'), "malformed_csv_quoting").details,
		{
			line: 2,
		},
	);
	refused(await preview('first_name\r\nMa"ra\r\n'), "malformed_csv_quoting");
	refused(
		await read(0, (t, c) => csv.previewImport(t, c, { file: new Uint8Array(10485761).fill(120) })),
		"file_too_large",
	);
	refused(await preview("first_name\r\n" + "Mara\r\n".repeat(10001)), "row_limit_exceeded");
	assert.equal(ok(await preview("first_name\r\n" + "Mara\r\n".repeat(10000))).rows.length, 10000);
	refused(await preview("email\r\nmara@example.test\r\n"), "csv_header_invalid");
	refused(
		await read(0, (t, c) => csv.previewImport(t, c, { file: new Uint8Array([0x66, 0xff, 0xfe]) })),
		"unsupported_file_content",
	);

	// INV-tenancy: only this church's Owner or Admin previews against its people.
	refused(await preview(file, 1));
	refused(
		await db.transaction((t) =>
			csv.previewImport(
				t,
				{ session: actors[0].session, selected: { kind: "plant", id: plants[1] } },
				{ file: bytes(file) },
			),
		),
	);
	assert.deepEqual(await Promise.all(["person", "audit_event", "job"].map(count)), [
		before[0] + 1,
		before[1] + 1,
		before[2],
	]);
});

test("AC:TARGET-PPL-018 INV-lost-reply a partial import names its failed rows, survives a lost reply and resumes without duplicates", async () => {
	// The literal case: Noah's row fails in the database before it commits; Mara and Lia are still saved.
	const file =
		"\ufeff" +
		header +
		'Mara,,mara.case@example.test,,,,,,,other,,"First line\r\nSecond line"\r\n' +
		'Noah,,noah@example.test,,,,,,,other,,"He said ""hello"""\r\n' +
		"Lia,,lia.case@example.test,,,,,,,website,,=1+1\r\n";
	const failNoah = async (on) =>
		admin.execute(
			sql.raw(
				on
					? `CREATE FUNCTION ${schema}.fail_noah() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF NEW.email='noah@example.test' THEN RAISE EXCEPTION 'synthetic row failure'; END IF; RETURN NEW; END $$;
 CREATE TRIGGER fail_noah BEFORE INSERT ON ${schema}.person FOR EACH ROW EXECUTE FUNCTION ${schema}.fail_noah();`
					: `DROP TRIGGER fail_noah ON ${schema}.person; DROP FUNCTION ${schema}.fail_noah()`,
			),
		);
	const p = ok(await preview(file));
	const choices = [1, 2, 3].map((row) => ({ row, choice: "create" })),
		requestKey = randomUUID();
	const peopleBefore = await count("person");
	const outcome = (receipt) =>
		receipt.rows.map((r) => (r.status === "failed" ? [r.row, r.status, r.reason] : [r.row, r.status]));
	await failNoah(true);
	let first;
	try {
		// The request saves the reviewed rows and returns at once; the job writes them.
		const queued = ok(await submit(file, p, choices, requestKey));
		assert.equal(queued.status, "in_progress");
		assert.deepEqual(queued.remaining, [1, 2, 3]);
		await drain();
		// The reply is lost: the receipt read afterwards still names the failed row and why.
		first = ok(await receiptOf(requestKey));
	} finally {
		await failNoah(false);
	}
	assert.deepEqual(outcome(first), [
		[1, "created"],
		[2, "failed", "row_write_failed"],
		[3, "created"],
	]);
	assert.equal(first.status, "partial");
	assert.deepEqual(first.remaining, [2]);
	assert.deepEqual(first.counts, { created: 2, skipped: 0, failed: 1, remaining: 1 });
	assert.equal(await count("person"), peopleBefore + 2);

	// A changed review under the same key is refused; the same request retries only the unfinished row.
	refused(
		await submit(file, p, [{ row: 1, choice: "skip" }, ...choices.slice(1)], requestKey),
		"review_digest_conflict",
	);
	const again = ok(await submit(file, p, choices, requestKey));
	assert.equal(again.status, "in_progress");
	assert.deepEqual(outcome(again), [
		[1, "created"],
		[2, "remaining"],
		[3, "created"],
	]);
	await drain();
	const retry = ok(await receiptOf(requestKey));
	assert.equal(retry.status, "complete");
	assert.deepEqual(retry.counts, { created: 3, skipped: 0, failed: 0, remaining: 0 });
	assert.equal(retry.importId, first.importId);
	assert.equal(retry.rows[0].personId, first.rows[0].personId);
	assert.equal(await count("person"), peopleBefore + 3);
	assert.deepEqual(ok(await submit(file, p, choices, requestKey)), retry);
	await drain();
	assert.equal(await count("person"), peopleBefore + 3);
	assert.equal(await count("job WHERE kind='people_import' AND state='ready'"), 0);
	// A finished import keeps no copy of the uploaded file.
	assert.deepEqual(await rows(sql`SELECT upload FROM person_import WHERE id=${sql.param(retry.importId)}`), [
		{ upload: null },
	]);

	// The people hold the file's exact text, as Persons created by hand would: prospect, unknown classification.
	const saved = await rows(
		sql`SELECT display_name,notes,source,stage,adult_classification,commitment_state FROM person WHERE id=ANY(${sql.param(retry.rows.map((r) => r.personId))}::uuid[]) ORDER BY created_at`,
	);
	const plain = { stage: "prospect", adult_classification: "unknown", commitment_state: "unknown" };
	assert.deepEqual(saved, [
		{ display_name: "Mara", notes: "First line\r\nSecond line", source: "other", ...plain },
		{ display_name: "Lia", notes: "=1+1", source: "website", ...plain },
		{ display_name: "Noah", notes: 'He said "hello"', source: "other", ...plain },
	]);
	// One people.created history entry per Person, tied to the import, with no contact values.
	assert.deepEqual(
		await rows(
			sql`SELECT after_value, metadata FROM audit_event WHERE command_id=${sql.param(retry.importId)} AND action='people.created' ORDER BY (metadata->'import'->>'row')::int`,
		),
		[1, 2, 3].map((row) => ({ after_value: { stage: "prospect" }, metadata: { import: { row } } })),
	);

	// A large import: one failing row among 1,201 fails alone, across 500-row batches.
	const filler = (i) => `Bulk${i},Import,bulk.import${i}@example.test,,,,,,,,,\r\n`;
	const large =
		header +
		Array.from({ length: 1201 }, (_, i) =>
			i === 599 ? "Noah,Again,noah@example.test,,,,,,,,,\r\n" : filler(i + 1),
		).join("");
	const lp = ok(await preview(large));
	await failNoah(true);
	let big;
	try {
		big = ok(
			await importFile(
				large,
				lp,
				choose(lp, () => "create"),
			),
		);
	} finally {
		await failNoah(false);
	}
	assert.deepEqual(big.remaining, [600]);
	assert.deepEqual(big.counts, { created: 1200, skipped: 0, failed: 1, remaining: 1 });
	// The import keeps why each row failed, as the database named it, without the row's values.
	assert.deepEqual(await rows(sql`SELECT failed FROM person_import WHERE id=${sql.param(big.importId)}`), [
		{ failed: [{ row: 600, reason: "row_write_failed", code: "P0001", constraint: null }] },
	]);

	// A failure that is not the row's own, such as a serialization failure, fails no row: the job tries again later.
	const transient = header + "Tara,,tara@example.test,,,,,,,,,\r\nUli,,uli@example.test,,,,,,,,,\r\n";
	const tp = ok(await preview(transient)),
		transientKey = randomUUID();
	ok(
		await submit(
			transient,
			tp,
			choose(tp, () => "create"),
			transientKey,
		),
	);
	await admin.execute(
		sql.raw(`CREATE FUNCTION ${schema}.busy_uli() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF NEW.email='uli@example.test' THEN RAISE EXCEPTION 'synthetic serialization failure' USING ERRCODE='40001'; END IF; RETURN NEW; END $$;
 CREATE TRIGGER busy_uli BEFORE INSERT ON ${schema}.person FOR EACH ROW EXECUTE FUNCTION ${schema}.busy_uli();`),
	);
	try {
		await drain();
	} finally {
		await admin.execute(sql.raw(`DROP TRIGGER busy_uli ON ${schema}.person; DROP FUNCTION ${schema}.busy_uli()`));
	}
	const waiting = ok(await receiptOf(transientKey));
	assert.equal(waiting.status, "in_progress");
	assert.deepEqual(outcome(waiting), [
		[1, "remaining"],
		[2, "remaining"],
	]);
	await admin.execute(
		sql`UPDATE job SET next_attempt_at=clock_timestamp() WHERE kind='people_import' AND state='retry_wait'`,
	);
	await drain();
	const resumed = ok(await receiptOf(transientKey));
	assert.equal(resumed.status, "complete");
	assert.deepEqual(resumed.counts, { created: 2, skipped: 0, failed: 0, remaining: 0 });
});

test("AC:TARGET-PPL-018 INV-jobs an import whose worker loses its lease resumes once and creates every row once", async () => {
	const file =
		"first_name,email\r\n" +
		Array.from({ length: 1001 }, (_, i) => `Lease${i + 1},lease${i + 1}@example.test\r\n`).join("");
	const p = ok(await preview(file));
	const requestKey = randomUUID(),
		peopleBefore = await count("person");
	ok(await submit(file, p, choose(p), requestKey));
	// The lease expires as the first 500 rows commit, as when a worker stalls past its lease.
	await admin.execute(
		sql.raw(`CREATE FUNCTION ${schema}.expire_lease() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF NEW.email='lease500@example.test' THEN UPDATE ${schema}.job SET lease_until=clock_timestamp()-interval '1 second'
 WHERE kind='people_import' AND state='claimed'; END IF; RETURN NEW; END $$;
 CREATE TRIGGER expire_lease AFTER INSERT ON ${schema}.person FOR EACH ROW EXECUTE FUNCTION ${schema}.expire_lease();`),
	);
	try {
		const [claim] = await claimDue(db, ["people_import"]);
		assert.equal(await runPeopleImport(db, claim), "lost");
		assert.equal(await db.transaction((tx) => finishClaim(tx, claim, { state: "failed" })), false);
	} finally {
		await admin.execute(
			sql.raw(`DROP TRIGGER expire_lease ON ${schema}.person; DROP FUNCTION ${schema}.expire_lease()`),
		);
	}
	assert.equal(await count("person"), peopleBefore + 500);
	assert.equal(ok(await receiptOf(requestKey)).status, "in_progress");
	// The drain returns the expired lease to the queue; the job waits for the queue's retry delay, then resumes.
	await drain();
	assert.equal(await count("person"), peopleBefore + 500);
	await admin.execute(
		sql`UPDATE job SET next_attempt_at=clock_timestamp() WHERE kind='people_import' AND state='retry_wait'`,
	);
	await drain();
	const done = ok(await receiptOf(requestKey));
	assert.equal(done.status, "complete");
	assert.deepEqual(done.counts, { created: 1001, skipped: 0, failed: 0, remaining: 0 });
	assert.equal(await count("person"), peopleBefore + 1001);
	// BUG-551 (people/peo-6): the directory lists an import in file order, by each Person's created_at. Within one run
	// that holds across batches of 500: the resumed run wrote rows 501 to 1000, then row 1001 in a batch of its own.
	const at = new Map(
		(
			await rows(
				sql`SELECT display_name, created_at FROM person WHERE id=ANY(${sql.param(done.rows.map((r) => (r.status === "created" ? r.personId : null)))}::uuid[])`,
			)
		).map((r) => [Number(String(r.display_name).slice("Lease".length)), new Date(r.created_at).getTime()]),
	);
	assert.equal(at.size, 1001);
	const outOfOrder = (first, last) =>
		Array.from({ length: last - first }, (_, i) => first + i + 1).filter((n) => !(at.get(n) > at.get(n - 1)));
	assert.deepEqual(outOfOrder(1, 500), [], "the first run's rows keep file order");
	assert.deepEqual(outOfOrder(501, 1001), [], "the resumed run's rows keep file order across its two batches");
});

test("AC:TARGET-PPL-018 INV-jobs an import on its last attempt that saved progress waits for its retry after a transient error, then finishes", async () => {
	const file =
		"first_name,email\r\n" +
		Array.from({ length: 501 }, (_, i) => {
			const name = i < 3 ? `Refused${i}` : i === 500 ? "Flaky" : `Budget${i}`;
			return `${name},budget${i}@example.test\r\n`;
		}).join("");
	const p = ok(await preview(file));
	const requestKey = randomUUID(),
		peopleBefore = await count("person");
	ok(await submit(file, p, choose(p), requestKey));
	// Three rows the database refuses (P0001) in the first batch, and one transient failure (40001) in the second.
	await admin.execute(
		sql.raw(`CREATE FUNCTION ${schema}.budget_faults() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF NEW.first_name LIKE 'Refused%' THEN RAISE EXCEPTION 'refused'; END IF;
 IF NEW.first_name='Flaky' THEN RAISE EXCEPTION 'busy' USING ERRCODE='40001'; END IF; RETURN NEW; END $$;
 CREATE TRIGGER budget_faults BEFORE INSERT ON ${schema}.person FOR EACH ROW EXECUTE FUNCTION ${schema}.budget_faults();`),
	);
	const job = async () =>
		(
			await rows(
				sql`SELECT state,attempt_count,error_code FROM job WHERE kind='people_import' ORDER BY eligible_at DESC LIMIT 1`,
			)
		)[0];
	try {
		// Three attempts are already spent: the run claims the last one.
		await admin.execute(sql`UPDATE job SET attempt_count=3 WHERE kind='people_import' AND state='ready'`);
		await drain();
		// The first batch saved its three failed rows, which starts a fresh budget, so the transient error waits.
		assert.deepEqual(await job(), { state: "retry_wait", attempt_count: 0, error_code: "import_interrupted" });
		assert.equal(await count("person"), peopleBefore + 497);
	} finally {
		await admin.execute(
			sql.raw(`DROP TRIGGER budget_faults ON ${schema}.person; DROP FUNCTION ${schema}.budget_faults()`),
		);
	}
	await admin.execute(
		sql`UPDATE job SET next_attempt_at=clock_timestamp() WHERE kind='people_import' AND state='retry_wait'`,
	);
	await drain();
	assert.equal((await job()).state, "succeeded");
	assert.deepEqual(ok(await receiptOf(requestKey)).counts, { created: 498, skipped: 0, failed: 3, remaining: 3 });
	assert.equal(await count("person"), peopleBefore + 498);
});
test("AC:TARGET-PPL-018 INV-tenancy BUG-198-unconfirmed an import saves exactly the reviewed rows and refuses a changed file, review or authority", async () => {
	const existing = await person("Rae Existing", { phone: "(555) 010-2030" });
	const file =
		"first_name,last_name,phone,email\r\nRae,Import,555-010-2030,\r\nSam,One,,sam@example.test\r\nSam,Two,,SAM@example.test\r\nUma,,,uma@example.test\r\n,,,bad\r\n";
	const p = ok(await preview(file));
	assert.deepEqual(
		p.rows.map((r) => [
			r.row,
			r.status,
			r.existingDuplicates?.map((d) => d.personId) ?? null,
			r.withinFileDuplicateOf ?? null,
		]),
		[
			[1, "valid", [existing.id], null],
			[2, "valid", [], null],
			[3, "valid", [], 2],
			[4, "valid", [], null],
			[5, "invalid", null, null],
		],
	);
	const choices = [
		{ row: 1, choice: "create_and_review" },
		{ row: 2, choice: "create" },
		{ row: 3, choice: "create_and_review" },
		{ row: 4, choice: "skip" },
	];
	const peopleBefore = await count("person");

	refused(await importFile(file + "Extra,,,\r\n", p, choices), "file_changed");
	refused(await importFile(file, p, choices.slice(1)), "invalid_input");
	refused(await importFile(file, p, choices, randomUUID(), 1));
	await person("Uma Existing", { email: "uma@example.test" });
	refused(await importFile(file, p, choices), "review_stale");
	assert.equal(await count("person"), peopleBefore + 1);

	const fresh = ok(await preview(file));
	assert.notEqual(fresh.reviewDigest, p.reviewDigest);
	const receipt = ok(await importFile(file, fresh, choices));
	const [rae, sam1, sam2] = receipt.rows;
	assert.deepEqual(
		receipt.rows.map((r) => [r.row, r.status, r.reason ?? null]),
		[
			[1, "created", null],
			[2, "created", null],
			[3, "created", null],
			[4, "skipped", null],
			[5, "failed", "invalid"],
		],
	);
	// A review pair names the existing Person, or the earlier row's new Person; nothing existing is overwritten.
	assert.equal(rae.reviewWith, existing.id);
	assert.equal(sam1.reviewWith, null);
	assert.equal(sam2.reviewWith, sam1.personId);
	assert.equal(await count("person"), peopleBefore + 4);
	assert.deepEqual(
		await rows(sql`SELECT display_name,revision::int r FROM person WHERE id=${sql.param(existing.id)}`),
		[{ display_name: "Rae Existing", r: 1 }],
	);
	assert.deepEqual(
		await rows(
			sql`SELECT metadata->'import' m FROM audit_event WHERE subject_id=${sql.param(sam2.personId)} AND action='people.created'`,
		),
		[{ m: { row: 3, reviewWith: sam1.personId } }],
	);
	// Another church's Admin cannot read the receipt.
	refused(await read(2, (t, c) => csv.getImportReceipt(t, c, { requestKey: randomUUID() })));

	// INV-revocation: the import holds the importer's seat like every other write. A seat that ends while the import
	// waits for it refuses the import, and nothing is queued.
	const late = "first_name\r\nLate\r\n",
		lp = ok(await preview(late)),
		lateKey = randomUUID();
	const jobsBefore = await count("job");
	let release, locked;
	const ready = new Promise((resolve) => (locked = resolve)),
		done = new Promise((resolve) => (release = resolve));
	const holder = admin.transaction(async (a) => {
		const r = await a.execute(
			sql`UPDATE seat SET ended_at=clock_timestamp() WHERE account_id=${sql.param(actors[0].id)} RETURNING pg_backend_pid() pid`,
		);
		locked(r.rows[0].pid);
		await done;
	});
	await ready;
	const pending = submit(
		late,
		lp,
		choose(lp, () => "create"),
		lateKey,
	);
	// Release the seat once the import waits on it.
	await waitingOnLock(db);
	release();
	await holder;
	try {
		refused(await pending);
		assert.equal(await count("job"), jobsBefore);
	} finally {
		await admin.execute(sql`UPDATE seat SET ended_at=NULL WHERE account_id=${sql.param(actors[0].id)}`);
	}
});

test("AC:TARGET-PPL-018 D-516 a repeat of a skipped row has nothing to review against: review later is refused, add new imports", async () => {
	const tag = randomUUID().slice(0, 8);
	const file = `first_name,last_name,email\r\nVi,One,vi-${tag}@example.test\r\nVi,Two,VI-${tag}@example.test\r\n`;
	const p = ok(await preview(file));
	assert.deepEqual(
		p.rows.map((r) => [r.row, r.existingDuplicates.length, r.withinFileDuplicateOf]),
		[
			[1, 0, null],
			[2, 0, 1],
		],
	);
	const peopleBefore = await count("person"),
		importsBefore = await count("person_import");
	// The review screen hides "Add, review later" here; the server still refuses it and writes nothing.
	refused(
		await importFile(file, p, [
			{ row: 1, choice: "skip" },
			{ row: 2, choice: "create_and_review" },
		]),
		"invalid_input",
	);
	assert.equal(await count("person"), peopleBefore);
	assert.equal(await count("person_import"), importsBefore);

	const receipt = ok(
		await importFile(file, p, [
			{ row: 1, choice: "skip" },
			{ row: 2, choice: "create" },
		]),
	);
	assert.deepEqual(
		receipt.rows.map((r) => [r.row, r.status, r.reviewWith ?? null]),
		[
			[1, "skipped", null],
			[2, "created", null],
		],
	);
	assert.deepEqual(receipt.counts, { created: 1, skipped: 1, failed: 0, remaining: 0 });
	assert.equal(await count("person"), peopleBefore + 1);
});

test("AC:TARGET-PPL-018 T-193 each review-later row is a pair to review until a merge or retirement, only in its own church", async () => {
	const tag = randomUUID().slice(0, 8);
	const pairs = async (who = 0) => ok(await read(who, (t, c) => listDuplicatePairs(t, c)));
	const pia = await person(`Pia ${tag}`, { email: `pia-${tag}@example.test` });
	const quin = await person(`Quin ${tag}`, { email: `quin-${tag}@example.test` });
	await person(`Ross ${tag}`, { email: `ross-${tag}@example.test` });
	await person(`Uma ${tag}`, { email: `uma-${tag}@example.test` });
	const quinOther = await person(`Quin Other ${tag}`);
	// Rows 1 and 2 match existing people, row 5 repeats row 4; Ross is added new and Uma skipped, so neither pairs.
	const file =
		`first_name,last_name,email\r\nPia,Imported,pia-${tag}@example.test\r\nQuin,Imported,quin-${tag}@example.test\r\n` +
		`Ross,Imported,ross-${tag}@example.test\r\nTess,One,tess-${tag}@example.test\r\nTess,Two,tess-${tag}@example.test\r\n` +
		`Uma,Imported,uma-${tag}@example.test\r\n`;
	const p = ok(await preview(file));
	const before = new Set((await pairs()).items.map((x) => x.person.id));
	const receipt = ok(
		await importFile(file, p, [
			{ row: 1, choice: "create_and_review" },
			{ row: 2, choice: "create_and_review" },
			{ row: 3, choice: "create" },
			{ row: 4, choice: "create" },
			{ row: 5, choice: "create_and_review" },
			{ row: 6, choice: "skip" },
		]),
	);
	const id = (row) => receipt.rows.find((r) => r.row === row).personId;
	const fresh = async (who = 0) => (await pairs(who)).items.filter((x) => !before.has(x.person.id));
	// The read uses the import's own audit rows: no backfill or migration step runs between the import and the list.
	assert.deepEqual(await fresh(), [
		{ person: { id: id(1), displayName: "Pia Imported" }, with: { id: pia.id, displayName: `Pia ${tag}` } },
		{ person: { id: id(2), displayName: "Quin Imported" }, with: { id: quin.id, displayName: `Quin ${tag}` } },
		{ person: { id: id(5), displayName: "Tess Two" }, with: { id: id(4), displayName: "Tess One" } },
	]);

	// INV-tenancy: another church's Admin sees none of them, and a Member of this church is refused.
	assert.deepEqual((await pairs(2)).items, []);
	refused(await read(1, (t, c) => listDuplicatePairs(t, c)));

	// A merge of the pair, or of either one into someone else, removes it; so does retiring either one.
	const merge = async (sourceId, survivorId) => {
		const r = ok(await read(0, (t, c) => peopleMerge.getMergeReview(t, c, { sourceId, survivorId })));
		ok(
			await write(0, (t, c) =>
				peopleMerge.mergePeople(t, c, {
					requestKey: randomUUID(),
					input: { sourceId, survivorId, reviewDigest: r.reviewDigest, fieldChoices: {} },
				}),
			),
		);
	};
	await merge(id(1), pia.id);
	await merge(quin.id, quinOther.id);
	assert.deepEqual(
		(await fresh()).map((x) => x.person.id),
		[id(5)],
	);
	const [{ revision }] = await rows(sql`SELECT revision::text FROM person WHERE id=${sql.param(id(4))}`);
	const { reviewRevision } = ok(await read(0, (t, c) => peopleReader.getStatusWarnings(t, c, { personId: id(4) })));
	ok(
		await write(0, (t, c) =>
			people.retirePerson(
				t,
				c,
				{
					requestKey: randomUUID(),
					expectedRevision: revision,
					input: { personId: id(4), reason: "Moved away", reviewRevision, handoffs: [] },
				},
				noReminders,
			),
		),
	);
	assert.deepEqual(await fresh(), []);
});

test("AC:TARGET-PPL-019 AC:PERSONREF-HOUSEHOLD-TAG-SKILL-NOTE-RETIRE INV-tenancy INV-filters the export matches the directory's filters as formula-safe CSV without private fields", async () => {
	const plant = (who) =>
		write(who, (t, c) => fields.createTag(t, c, { requestKey: randomUUID(), input: { name: "Choir" } }));
	const choir = ok(await plant(0)).tag;
	const north = ok(
		await write(0, (t, c) => fields.createTag(t, c, { requestKey: randomUUID(), input: { name: "Northside" } })),
	).tag;
	const tag = (p, t) =>
		write(0, (tx, c) => fields.assignTag(tx, c, { requestKey: randomUUID(), input: { personId: p.id, tagId: t.id } }));
	const alex = await person("Alex Rivera", {
		firstName: "Alex",
		lastName: "Rivera",
		email: "alex@example.test",
		phone: "+1 555 0100",
		source: "website",
		stage: "leader",
		summaryNotes: "=1+1",
	});
	const mara = await person("Mara Quote", {
		firstName: "Mara",
		lastName: 'O"Neil, Jr',
		summaryNotes: "Line one\nLine two",
		source: "event",
	});
	const gone = await person("Retired Person", { firstName: "Retired", lastName: "Person", stage: "leader" });
	ok(await tag(alex, choir));
	ok(await tag(alex, north));
	ok(await tag(mara, choir));
	const review = ok(
		await read(0, (t, c) => peopleReader.getStatusWarnings(t, c, { personId: gone.id })),
	).reviewRevision;
	ok(
		await write(0, (t, c) =>
			people.retirePerson(
				t,
				c,
				{
					requestKey: randomUUID(),
					expectedRevision: gone.revision,
					input: { personId: gone.id, reason: "Moved away", reviewRevision: review, handoffs: [] },
				},
				noReminders,
			),
		),
	);
	const exported = (filters, who = 0) => read(who, (t, c) => csv.exportPeople(t, c, filters));
	const parseCsv = (text) => {
		assert.ok(text.startsWith("﻿"));
		const lines = [];
		let field = "",
			line = [],
			quoted = false;
		for (let i = 1; i < text.length; i++) {
			const ch = text[i];
			if (quoted) {
				if (ch === '"' && text[i + 1] === '"') ((field += '"'), i++);
				else if (ch === '"') quoted = false;
				else field += ch;
			} else if (ch === '"') quoted = true;
			else if (ch === ",") (line.push(field), (field = ""));
			else if (ch === "\r" && text[i + 1] === "\n")
				(line.push(field), lines.push(line), (line = []), (field = ""), i++);
			else field += ch;
		}
		return lines;
	};
	const columns = [
		"first_name",
		"last_name",
		"email",
		"phone",
		"street",
		"city",
		"state",
		"postal_code",
		"country",
		"status",
		"source",
		"source_details",
		"notes",
		"tags",
		"created_at",
	];

	// Every directory filter, and all-selected-tags AND, gives the same people in the same order as the directory.
	const filterSets = [
		{},
		{ stages: ["leader"] },
		{ sources: ["event"] },
		{ tags: [choir.id] },
		{ tags: [choir.id, north.id] },
		{ search: "quote" },
		{ archived: "include" },
		{ archived: "only" },
		{ adultClassification: "unknown" },
		{ commitment: "unknown" },
		{ search: "nobody-matches" },
	];
	for (const filters of filterSets) {
		const file = ok(await exported(filters));
		const [head, ...body] = parseCsv(file.text);
		assert.deepEqual(head, columns);
		const directory = [];
		for (let page = 1; ; page++) {
			const result = ok(await read(0, (t, c) => peopleReader.listPeople(t, c, { ...filters, page, limit: 100 })));
			// The export names a person with no stored name part by the display name's first word and the rest.
			directory.push(
				...result.items.map((p) =>
					p.firstName === null && p.lastName === null
						? [p.displayName.trim().split(/\s+/)[0], p.displayName.trim().replace(/^\S+\s*/, "")]
						: [p.firstName ?? "", p.lastName ?? ""],
				),
			);
			if (!result.next) break;
		}
		assert.deepEqual(
			body.map((r) => [r[0], r[1]]),
			directory,
			JSON.stringify(filters),
		);
		assert.deepEqual(
			{ matched: file.receipt.matched, returned: file.receipt.returned, completeness: file.receipt.completeness },
			{ matched: body.length, returned: body.length, completeness: "complete" },
		);
	}
	const empty = ok(await exported({ search: "nobody-matches" }));
	assert.equal(empty.text, "﻿" + columns.join(",") + "\r\n");
	assert.equal(empty.receipt.returned, 0);
	assert.equal(empty.receipt.filters.search, "nobody-matches");

	// Exact cells: RFC 4180 quoting, formula neutralization, semicolon tags and the UTC creation instant.
	const [, ...all] = parseCsv(ok(await exported({ tags: [choir.id] })).text);
	const created = (p) => p.createdAt.replace(/(\.\d{3})?Z$/, (m, ms) => (ms ?? ".000") + "Z");
	assert.deepEqual(all, [
		[
			"Alex",
			"Rivera",
			"alex@example.test",
			"'+1 555 0100",
			"",
			"",
			"",
			"",
			"",
			"leader",
			"website",
			"",
			"'=1+1",
			"Choir;Northside",
			created(alex),
		],
		[
			"Mara",
			'O"Neil, Jr',
			"",
			"",
			"",
			"",
			"",
			"",
			"",
			"prospect",
			"event",
			"",
			"Line one\nLine two",
			"Choir",
			created(mara),
		],
	]);
	const raw = ok(await exported({ tags: [choir.id] })).text;
	assert.ok(raw.includes('"O""Neil, Jr"'));
	assert.ok(raw.includes('"Line one\nLine two"'));
	// A retired Person leaves the default export but stays in its history.
	assert.ok(!raw.includes("Retired"));
	assert.ok(ok(await exported({ archived: "only" })).text.includes("Retired,Person"));

	// More rows than a directory page come out in one file.
	const many =
		"first_name,email\r\n" + Array.from({ length: 150 }, (_, i) => `Many${i},many${i}@example.test\r\n`).join("");
	const p = ok(await preview(many));
	ok(await importFile(many, p, choose(p)));
	const big = ok(await exported({ search: "many" }));
	assert.equal(big.receipt.returned, 150);
	assert.equal(parseCsv(big.text).length, 151);

	// INV-tenancy: a Member exports what the directory shows them; another church's Admin and an organization context
	// get none of this church's people.
	assert.equal(ok(await exported({}, 1)).text, ok(await exported({})).text);
	const foreign = ok(await exported({}, 2));
	assert.equal(foreign.receipt.returned, 0);
	refused(
		await db.transaction((t) =>
			csv.exportPeople(t, { session: actors[0].session, selected: { kind: "plant", id: plants[1] } }, {}),
		),
	);
	refused(
		await db.transaction((t) =>
			csv.exportPeople(t, { session: actors[0].session, selected: { kind: "organization", id: randomUUID() } }, {}),
		),
	);
	// A seat that ends after the request resolved its actor exports nothing.
	const owner = await actor(0);
	await admin.execute(sql`UPDATE seat SET ended_at=clock_timestamp() WHERE account_id=${sql.param(actors[0].id)}`);
	try {
		refused(await db.transaction((t) => csv.exportPeople(t, new PeopleReadContext(owner), {})));
	} finally {
		await admin.execute(sql`UPDATE seat SET ended_at=NULL WHERE account_id=${sql.param(actors[0].id)}`);
	}
});

test("AC:TARGET-PPL-019 BUG-export-names the export derives first_name and last_name from the display name only when no name part is stored, and writes nothing", async () => {
	const maria = await person("Maria Santos");
	const mary = await person("Mary Ann  Smith");
	const grace = await person("Grace");
	const robert = await person("Bob Lee", { firstName: "Robert", lastName: "Lee" });
	const uma = await person("Umaya Patel", { firstName: "Umaya" });
	const formula = await person("=cmd Smith");
	const exported = ok(await read(0, (t, c) => csv.exportPeople(t, c, {}))).text;
	const lines = exported.split("\r\n");
	const cells = (prefix) => {
		const found = lines.filter((l) => l.startsWith(prefix));
		assert.equal(found.length, 1, prefix);
		return found[0].split(",").slice(0, 2);
	};
	const mariaLine = lines.find((l) => l.startsWith("Maria,Santos,"));
	assert.ok(mariaLine?.startsWith("Maria,Santos,,,"), mariaLine);
	assert.deepEqual(cells("Mary,"), ["Mary", "Ann  Smith"]);
	assert.deepEqual(cells("Grace,"), ["Grace", ""]);
	assert.deepEqual(cells("Robert,"), ["Robert", "Lee"]);
	assert.deepEqual(cells("Umaya,"), ["Umaya", ""]);
	assert.deepEqual(cells("'=cmd,"), ["'=cmd", "Smith"]);
	// Criterion 8: nothing is written back.
	const stored = await rows(
		sql`SELECT display_name,first_name,last_name FROM person WHERE id IN (${sql.join(
			[maria, mary, grace, formula].map((p) => sql`${p.id}::uuid`),
			sql`, `,
		)})`,
	);
	assert.equal(stored.length, 4);
	for (const r of stored) assert.deepEqual([r.first_name, r.last_name], [null, null], r.display_name);
	// Criterion 10: the exported file previews as the same display name.
	const header = lines[0];
	const p = ok(await preview(header + "\r\n" + mariaLine + "\r\n"));
	assert.equal(p.rows.length, 1);
	assert.equal(p.rows[0].status, "valid");
	assert.equal(JSON.stringify(p.rows[0]).includes("Maria Santos"), true);
	void robert;
	void uma;
});

test("INV-C32 a CSV read takes no session lock: a sign-out never waits for an open preview, receipt or export", async () => {
	const file = "first_name\r\nLockfree\r\n";
	const p = ok(await preview(file));
	const requestKey = randomUUID();
	ok(
		await importFile(
			file,
			p,
			choose(p, () => "create"),
			requestKey,
		),
	);
	const reads = {
		previewImport: (t, c) => csv.previewImport(t, c, { file: bytes(file) }),
		getImportReceipt: (t, c) => csv.getImportReceipt(t, c, { requestKey }),
		exportPeople: (t, c) => csv.exportPeople(t, c, {}),
	};
	const waited = [];
	for (const [name, run] of Object.entries(reads))
		await read(0, async (t, c) => {
			assert.equal((await run(t, c)).status, "ok", name);
			// The read's transaction is still open.
			try {
				await admin.transaction(async (a) => {
					await a.execute(sql`SET LOCAL lock_timeout='250ms'`);
					await a.execute(sql`UPDATE auth_session SET expires_at=expires_at WHERE id=${sql.param(actors[0].session)}`);
				});
			} catch {
				waited.push(name);
			}
		});
	assert.deepEqual(waited, []);
});
