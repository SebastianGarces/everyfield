import { createDatabase, closeDatabase } from "../../../../packages/db/src/client.ts";
import { sql } from "../../../../packages/db/node_modules/drizzle-orm/index.js";
import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID, randomBytes } from "node:crypto";

import { migrate } from "../../../../packages/db/src/schema/migrate.ts";
import { RequestActor } from "../../../../packages/domain/src/access/session.ts";
import { PeopleReadContext } from "../../../../packages/domain/src/people/core.ts";
import {
	executeBulkImport,
	peopleCsv as csv,
	peopleReader,
	peopleWriter as people,
	personFields as fields,
} from "../../../../packages/domain/src/people/index.ts";

// People CSV import and export through their public operations on a scratch schema.
const source = new URL(process.env.DATABASE_URL_UNPOOLED ?? process.env.DATABASE_URL ?? "about:blank");
const localCi =
	process.env.CI === "true" &&
	process.env.EARLY_ACCESS_TEST_DATABASE === "1" &&
	["localhost", "127.0.0.1"].includes(source.hostname) &&
	source.pathname === "/everyfield_ci";
if (
	(!localCi && source.hostname !== "ep-autumn-dew-b8ltidky.c-14.us-east-1.aws.neon.tech") ||
	process.env.NODE_ENV === "production"
)
	throw Error("Only approved shared development or disposable CI endpoint allowed");
if (!localCi) source.searchParams.set("sslmode", "verify-full");
const schema = "wp013_" + randomUUID().replaceAll("-", ""),
	role = "wp013_" + randomBytes(8).toString("hex");
const admin = createDatabase({
	connectionString: source.href,
	max: 4,
	options: `-c search_path=${schema},pg_catalog,pg_temp`,
});
let db;

const plants = [randomUUID(), randomUUID()],
	actors = Array.from({ length: 3 }, () => ({ id: randomUUID(), user: randomUUID(), session: randomUUID() }));
// 0: plant A owner, 1: plant A member, 2: plant B admin.
const ctx = (who = 0) => ({ session: actors[who].session, selected: { kind: "plant", id: plants[who === 2 ? 1 : 0] } });
const ok = (result) => {
	assert.equal(result.status, "ok", JSON.stringify(result));
	return result.value;
};
const refused = (result, code = "unavailable") => {
	assert.equal(result.status, "refused", JSON.stringify(result).slice(0, 500));
	assert.equal(result.error.code, code);
	return result.error;
};
const rows = async (query) => (await admin.execute(query)).rows;
const count = async (table) => (await rows(sql.raw(`SELECT count(*)::int n FROM ${table}`)))[0].n;
const bytes = (text) => new TextEncoder().encode(text);
const read = (who, body) => db.transaction((t) => body(t, ctx(who)));
const actor = async (who = 0) => db.transaction((t) => RequestActor.resolve(t, actors[who].session));
const preview = (text, who = 0) => read(who, (t, c) => csv.previewImport(t, c, { file: bytes(text) }));
const header = "first_name,last_name,email,phone,street,city,state,postal_code,country,source,source_details,notes\r\n";
const choose = (p, choice = (r) => r.suggested) =>
	p.rows.filter((r) => r.status === "valid").map((r) => ({ row: r.row, choice: choice(r) }));
const importFile = async (text, p, choices, requestKey = randomUUID(), who = 0) =>
	executeBulkImport(db, await actor(who), {
		requestKey,
		file: bytes(text),
		fileDigest: p.fileDigest,
		reviewDigest: p.reviewDigest,
		choices,
	});
async function person(name, input = {}) {
	return ok(
		await db.transaction((t) =>
			people.createPerson(t, ctx(), { requestKey: randomUUID(), input: { displayName: name, ...input } }),
		),
	).person;
}

before(async () => {
	await admin.execute(sql.raw(`CREATE SCHEMA ${schema}`));
	await migrate(admin, schema);
	const password = randomBytes(32).toString("hex");
	await admin.execute(
		sql.raw(`CREATE ROLE ${role} LOGIN INHERIT PASSWORD '${password}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS`),
	);
	await admin.execute(sql.raw(`GRANT everyfield_runtime TO ${role}`));
	const url = new URL(source);
	url.username = role;
	url.password = password;
	db = createDatabase({ connectionString: url.href, max: 4, options: `-c search_path=${schema},pg_catalog,pg_temp` });
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
	for (const id of plants)
		await admin.execute(
			sql`INSERT INTO plant(id,name,timezone,warning_days,alert_days,digest_weekday,digest_hour,phase,material_revision) VALUES(${sql.param(id)},'Synthetic','America/Chicago',7,14,1,8,1,1)`,
		);
	for (const [i, plant, roleName] of [
		[0, plants[0], "owner"],
		[1, plants[0], "member"],
		[2, plants[1], "admin"],
	])
		await admin.execute(
			sql`INSERT INTO seat(account_id,plant_id,role,accepted_at) VALUES(${sql.param(actors[i].id)},${sql.param(plant)},${sql.param(roleName)},clock_timestamp())`,
		);
});
after(async () => {
	if (db) await closeDatabase(db);
	try {
		await admin.execute(sql.raw(`DROP SCHEMA IF EXISTS ${schema} CASCADE`));
		await admin.execute(sql.raw(`DROP ROLE IF EXISTS ${role}`));
	} finally {
		await closeDatabase(admin);
	}
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

test("AC:TARGET-PPL-018 a partial import names its failed rows, survives a lost reply and resumes without duplicates", async () => {
	// Mara, Noah and Lia sit in the first, third and last batch. The third batch fails in the database.
	const filler = (from, to) =>
		Array.from(
			{ length: to - from + 1 },
			(_, i) => `Filler${from + i},Import,f${from + i}@example.test,,,,,,,,,\r\n`,
		).join("");
	const file =
		header +
		'Mara,,mara.import@example.test,,,,,,,other,,"First line\r\nSecond line"\r\n' +
		filler(2, 1000) +
		'Noah,,noah@example.test,,,,,,,other,,"He said ""hello"""\r\n' +
		filler(1002, 2000) +
		"Lia,,lia@example.test,,,,,,,website,,=1+1\r\n";
	const p = ok(await preview(file));
	assert.equal(p.counts.valid, 2001);
	const choices = choose(p),
		requestKey = randomUUID();
	const peopleBefore = await count("person");
	await admin.execute(
		sql.raw(`CREATE FUNCTION ${schema}.fail_noah() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF NEW.email='noah@example.test' THEN RAISE EXCEPTION 'synthetic row failure'; END IF; RETURN NEW; END $$;
 CREATE TRIGGER fail_noah BEFORE INSERT ON ${schema}.person FOR EACH ROW EXECUTE FUNCTION ${schema}.fail_noah();`),
	);
	const step = () => importFile(file, p, choices, requestKey);
	const steps = [];
	try {
		for (let i = 0; i < 3; i++) steps.push(ok(await step()));
	} finally {
		await admin.execute(sql.raw(`DROP TRIGGER fail_noah ON ${schema}.person; DROP FUNCTION ${schema}.fail_noah()`));
	}
	const byRow = (receipt) => new Map(receipt.rows.map((r) => [r.row, r]));
	const outcome = (receipt, row) => {
		const r = byRow(receipt).get(row);
		return r.status === "failed" ? [row, r.status, r.reason] : [row, r.status];
	};
	const range = (from, to) => Array.from({ length: to - from + 1 }, (_, i) => from + i);
	// Each request writes one batch; the third batch fails in the database and is named, row by row.
	assert.deepEqual(
		steps.map((s) => s.counts),
		[
			{ created: 500, skipped: 0, failed: 0, remaining: 1501 },
			{ created: 1000, skipped: 0, failed: 0, remaining: 1001 },
			{ created: 1000, skipped: 0, failed: 500, remaining: 1001 },
		],
	);
	const failedStep = steps[2];
	assert.equal(failedStep.status, "partial");
	assert.deepEqual(
		[1, 1000, 1001, 1500, 1501, 2001].map((row) => outcome(failedStep, row)),
		[
			[1, "created"],
			[1000, "created"],
			[1001, "failed", "row_write_failed"],
			[1500, "failed", "row_write_failed"],
			[1501, "remaining"],
			[2001, "remaining"],
		],
	);
	assert.deepEqual(failedStep.remaining, range(1001, 2001));
	assert.equal(await count("person"), peopleBefore + 1000);

	// The reply is lost: the receipt still names every saved row and everything that remains.
	const lost = ok(await read(0, (t, c) => csv.getImportReceipt(t, c, { requestKey })));
	assert.deepEqual(lost.remaining, failedStep.remaining);
	assert.deepEqual(
		[1, 1001, 2001].map((row) => outcome(lost, row)),
		[
			[1, "created"],
			[1001, "remaining"],
			[2001, "remaining"],
		],
	);
	assert.equal(byRow(lost).get(1).personId, byRow(failedStep).get(1).personId);

	// The same request resumes only unfinished rows; a changed review under the same key is refused.
	const changed = choices.map((c) => (c.row === 1 ? { row: 1, choice: "skip" } : c));
	refused(await importFile(file, p, changed, requestKey), "review_digest_conflict");
	let retry;
	for (let i = 0; i < 5 && (!retry || retry.remaining.length); i++) retry = ok(await step());
	assert.equal(retry.status, "complete");
	assert.deepEqual(retry.remaining, []);
	assert.deepEqual(retry.counts, { created: 2001, skipped: 0, failed: 0, remaining: 0 });
	assert.equal(retry.importId, failedStep.importId);
	assert.equal(byRow(retry).get(1).personId, byRow(failedStep).get(1).personId);
	assert.equal(await count("person"), peopleBefore + 2001);
	assert.deepEqual(ok(await step()), retry);
	assert.equal(await count("person"), peopleBefore + 2001);
	assert.deepEqual(ok(await read(0, (t, c) => csv.getImportReceipt(t, c, { requestKey }))), retry);

	// The people hold the file's exact text, as Persons created by hand would: prospect, unknown classification.
	const created = byRow(retry);
	const saved = await rows(
		sql`SELECT display_name,notes,source,stage,adult_classification,commitment_state FROM person WHERE id IN (${sql.param(created.get(1).personId)},${sql.param(created.get(1001).personId)},${sql.param(created.get(2001).personId)}) ORDER BY array_position(ARRAY['Mara','Noah','Lia'],display_name)`,
	);
	assert.deepEqual(saved, [
		{
			display_name: "Mara",
			notes: "First line\r\nSecond line",
			source: "other",
			stage: "prospect",
			adult_classification: "unknown",
			commitment_state: "unknown",
		},
		{
			display_name: "Noah",
			notes: 'He said "hello"',
			source: "other",
			stage: "prospect",
			adult_classification: "unknown",
			commitment_state: "unknown",
		},
		{
			display_name: "Lia",
			notes: "=1+1",
			source: "website",
			stage: "prospect",
			adult_classification: "unknown",
			commitment_state: "unknown",
		},
	]);
	// One people.created history entry per Person, tied to the import.
	const history = await rows(
		sql`SELECT count(*)::int n, count(DISTINCT subject_id)::int people FROM audit_event WHERE command_id=${sql.param(retry.importId)} AND action='people.created'`,
	);
	assert.deepEqual(history, [{ n: 2001, people: 2001 }]);
});

test("AC:TARGET-PPL-018 INV-tenancy an import saves exactly the reviewed rows and refuses a changed file, review or authority", async () => {
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
});

test("AC:TARGET-PPL-019 AC:PERSONREF-HOUSEHOLD-TAG-SKILL-NOTE-RETIRE INV-tenancy the export matches the directory's filters as formula-safe CSV without private fields", async () => {
	const plant = (who) =>
		read(who, (t, c) => fields.createTag(t, c, { requestKey: randomUUID(), input: { name: "Choir" } }));
	const choir = ok(await plant(0)).tag;
	const north = ok(
		await read(0, (t, c) => fields.createTag(t, c, { requestKey: randomUUID(), input: { name: "Northside" } })),
	).tag;
	const tag = (p, t) =>
		read(0, (tx, c) => fields.assignTag(tx, c, { requestKey: randomUUID(), input: { personId: p.id, tagId: t.id } }));
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
		await read(0, (t, c) =>
			people.retirePerson(t, c, {
				requestKey: randomUUID(),
				expectedRevision: gone.revision,
				input: { personId: gone.id, reason: "Moved away", reviewRevision: review, handoffs: [] },
			}),
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
			directory.push(...result.items.map((p) => [p.firstName ?? "", p.lastName ?? ""]));
			if (!result.next) break;
		}
		assert.deepEqual(
			body.map((r) => [r[0], r[1]]),
			directory,
			JSON.stringify(filters),
		);
		assert.equal(file.receipt.count, body.length);
	}
	const empty = ok(await exported({ search: "nobody-matches" }));
	assert.equal(empty.text, "﻿" + columns.join(",") + "\r\n");
	assert.equal(empty.receipt.count, 0);
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
		"first_name,email\r\n" + Array.from({ length: 150 }, (_, i) => `Bulk${i},bulk${i}@example.test\r\n`).join("");
	const p = ok(await preview(many));
	ok(await importFile(many, p, choose(p)));
	const big = ok(await exported({ search: "bulk" }));
	assert.equal(big.receipt.count, 150);
	assert.equal(parseCsv(big.text).length, 151);

	// INV-tenancy: a member, another church's Admin and an organization context get no export.
	refused(await exported({}, 1));
	const foreign = ok(await exported({}, 2));
	assert.equal(foreign.receipt.count, 0);
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
