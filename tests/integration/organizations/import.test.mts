import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { sql } from "../../../packages/db/node_modules/drizzle-orm/index.js";

import { fixture } from "../../support/fixture.mts";
import { RequestActor } from "../../../packages/domain/src/access/session.ts";
import {
	pipelineWriter,
	readPipelineBoard,
	readPipelinePersonRecord,
} from "../../../packages/domain/src/organizations/pipeline.ts";
import { pipelineImportWriter, previewPipelineImport } from "../../../packages/domain/src/organizations/import.ts";
import { readPipelineExport } from "../../../packages/domain/src/organizations/data.ts";
import { APPLICATIONS, csvOf } from "./import-files/data.mts";

// Importing pipeline people from a CSV or a form's Excel export (T-363) against a migrated database. Grace Austin,
// America/Chicago: Dana is the Owner, Luis an Admin, Ana and Ben Members with no duty. Casey Lee is already in the
// pipeline with casey@example.test. applications.xlsx is a Microsoft Forms export holding Jordan Reyes, Sam Ortiz and a
// second application from Casey; applications-v2.xlsx has the same titles in another order.

const database = await fixture({ prefix: "pipelineimport", max: 6 });
const { admin } = database;
const db = database.pools.runtime;
after(() => database.close());

type Actor = { id: string; session: string };
type Org = { kind: "organization"; id: string };
let grace: Org, hill: Org;
let dana: Actor, luis: Actor, ana: Actor, ben: Actor, hillOwner: Actor;
let luisSeat: string;
const casey = randomUUID();

const files = new URL("./import-files/", import.meta.url);
const file = (name: string) => new Uint8Array(readFileSync(new URL(name, files)));
const text = (value: string) => new TextEncoder().encode(value);
const authority = (a: Actor) => RequestActor.resolve(db, a.session as never);
const ok = <T,>(r: { status: string; value?: T; refusal?: unknown }): T => {
	assert.equal(r.status, "ok", JSON.stringify(r));
	return r.value as T;
};
const refusal = (r: { status: string; refusal?: unknown }) => {
	assert.equal(r.status, "refused", JSON.stringify(r));
	return r.refusal;
};
const named = (org: Org, role: "owner" | "admin" | "member", name: string) =>
	database.actor(org as never, role, { user: { name } });
const board = async (a: Actor) => ok(await readPipelineBoard(db, await authority(a), {}));
const stageId = async (label: string, a: Actor = dana) => (await board(a)).stages.find((s) => s.label === label)!.id;

type Preview = { fileDigest: string; reviewDigest: string; columns: { title: string; choice: string; locked: boolean }[] };
type Previewed = Preview & {
	rows: { row: number; status: string; name: string | null; problems: string[]; existing: { name: string }[]; sameAs: number[]; stageId: string | null }[];
};
const preview = async (a: Actor, fileName: string, bytes: Uint8Array, columns: string[] | null = null) =>
	previewPipelineImport(db, await authority(a), { fileName, file: bytes, columns });
const previewed = async (a: Actor, fileName: string, bytes: Uint8Array, columns: string[] | null = null) =>
	ok(await preview(a, fileName, bytes, columns)) as Previewed;
type Result = { added: { row: number; personId: string }[]; skipped: number[]; refused: { row: number; problems: string[] }[] };
const run = async (
	a: Actor,
	fileName: string,
	bytes: Uint8Array,
	p: Preview,
	extra: { stageId: string; responsibleSeatId?: string | null; duplicates?: { row: number; choice: string }[]; importId?: string },
) =>
	pipelineImportWriter.importPeople(db, await authority(a), {
		importId: extra.importId ?? randomUUID(),
		fileName,
		file: bytes,
		fileDigest: p.fileDigest,
		reviewDigest: p.reviewDigest,
		columns: p.columns.map((c) => c.choice),
		stageId: extra.stageId,
		responsibleSeatId: extra.responsibleSeatId ?? null,
		duplicates: extra.duplicates ?? [],
	});
const livePeople = async (org: Org) =>
	Number(
		(await admin.execute(sql`SELECT count(*) AS n FROM pipeline_person WHERE organization_id=${org.id}::uuid`)).rows[0]!.n,
	);
const notesOf = async (personId: string) =>
	(
		await admin.execute(
			sql`SELECT n.body,n.author_id FROM person_note n WHERE n.person_id=${personId}::uuid ORDER BY n.occurred_at,n.id`,
		)
	).rows as { body: string; author_id: string }[];
const choiceByTitle = (p: Preview) => Object.fromEntries(p.columns.map((c) => [c.title, c.choice]));

before(async () => {
	grace = (await database.organization("sending_church", { name: "Grace Austin", timezone: "America/Chicago" })) as never;
	hill = (await database.organization("sending_network", { name: "Hill Country Network" })) as never;
	dana = await named(grace, "owner", "Dana");
	luis = await named(grace, "admin", "Luis");
	ana = await named(grace, "member", "Ana");
	ben = await named(grace, "member", "Ben");
	hillOwner = await named(hill, "owner", "Hana");
	luisSeat = (
		await admin.execute(sql`SELECT id FROM seat WHERE account_id=${luis.id}::uuid AND organization_id=${grace.id}::uuid`)
	).rows[0]!.id as string;
	ok(
		await pipelineWriter.addPerson(db, await authority(dana), {
			personId: casey,
			displayName: "Casey Lee",
			email: "casey@example.test",
			responsibleSeatId: null,
			stageId: await stageId("Resident"),
		}),
	);
});

test("columns match fields by title; unmatched questions are kept as answers and a background check is skipped", async () => {
	const p = await previewed(dana, "applications.xlsx", file("applications.xlsx"));
	assert.deepEqual(
		p.columns.map((c) => [c.title, c.choice, c.locked]),
		[
			["ID", "answer", false],
			["Start time", "answer", false],
			["Completion time", "answer", false],
			// The form's own Email and Name columns lose to the better titled questions, which take the fields.
			["Email", "skip", false],
			["Name", "skip", false],
			["Full name", "name", false],
			["Email address", "email", false],
			["Phone number", "answer", false],
			["Describe your calling", "answer", false],
			["Spouse's name", "answer", false],
			["Have you completed a background check?", "skip", true],
		],
	);
	const keep = p.columns.map((c) => c.choice);
	keep[10] = "answer";
	assert.deepEqual(refusal(await preview(dana, "applications.xlsx", file("applications.xlsx"), keep)), {
		code: "invalid_input",
		field: "columns.10",
	});
	keep[10] = "email";
	keep[6] = "skip";
	assert.deepEqual(refusal(await preview(dana, "applications.xlsx", file("applications.xlsx"), keep)), {
		code: "invalid_input",
		field: "columns.10",
	});
	// An import that keeps it is refused too, and adds no one.
	const before = await livePeople(grace);
	const kept = { ...p, columns: p.columns.map((c, i) => ({ ...c, choice: i === 10 ? "answer" : c.choice })) };
	assert.deepEqual(
		refusal(await run(dana, "applications.xlsx", file("applications.xlsx"), kept, { stageId: await stageId("Potential leader") })),
		{ code: "invalid_input", field: "columns.10" },
	);
	assert.equal(await livePeople(grace), before);
	// A field takes one column.
	const twice = p.columns.map((c) => c.choice);
	twice[4] = "name";
	assert.deepEqual(refusal(await preview(dana, "applications.xlsx", file("applications.xlsx"), twice)), {
		code: "invalid_input",
		field: "columns.5",
	});
});

test("a bad file is refused with its reason and changes nothing", async () => {
	const before = await livePeople(grace);
	const big = new Uint8Array(5 * 1024 * 1024 + 1).fill(97);
	const rows = "Full name\r\n" + Array.from({ length: 2001 }, (_, i) => `Person ${i}\r\n`).join("");
	for (const [name, bytes, problem] of [
		["applications.pdf", file("applications.xlsx"), "file_type"],
		["empty.csv", new Uint8Array(), "file_empty"],
		["blank.csv", text(",,\r\nJordan,jordan@example.test,\r\n"), "no_header"],
		["titles.csv", text("Full name,Email address\r\n"), "no_rows"],
		["big.csv", big, "file_too_large"],
		["long.csv", text(rows), "row_limit"],
		["broken.xlsx", text("Full name\r\nJordan\r\n"), "file_unreadable"],
	] as const)
		assert.deepEqual(refusal(await preview(dana, name, bytes)), { code: "file_refused", problem }, name);
	assert.equal(await livePeople(grace), before);
});

test("rows are ready, invalid with a reason, or possible duplicates of the pipeline and of each other", async () => {
	const csv = text(
		"Full name,Email address\r\n,nobody@example.test\r\nRiley Park,not-an-email\r\nTaylor Kim,taylor@example.test\r\nTay Kim,TAYLOR@example.test\r\n",
	);
	const p = await previewed(dana, "rows.csv", csv);
	assert.deepEqual(
		p.rows.map((r) => [r.row, r.status, r.problems, r.sameAs]),
		[
			[1, "invalid", ["name_required"], []],
			[2, "invalid", ["invalid_email"], []],
			[3, "duplicate", [], [4]],
			[4, "duplicate", [], [3]],
		],
	);
	// Every possible duplicate is the person's to decide: an import without a choice for each one is refused.
	const stage = await stageId("Potential leader");
	assert.deepEqual(refusal(await run(dana, "rows.csv", csv, p, { stageId: stage, duplicates: [{ row: 3, choice: "add" }] })), {
		code: "invalid_input",
		field: "duplicates",
	});
	const xlsx = await previewed(dana, "applications.xlsx", file("applications.xlsx"));
	assert.deepEqual(
		xlsx.rows.map((r) => [r.name, r.status, r.existing.map((e) => e.name)]),
		[
			["Jordan Reyes", "ready", []],
			["Sam Ortiz", "ready", []],
			["Casey Lee", "duplicate", ["Casey Lee"]],
		],
	);
});

let jordan: string;
test("Dana imports applications.xlsx: Jordan and Sam join the chosen stage, Casey is skipped and unchanged", async () => {
	const caseyBefore = ok(await readPipelinePersonRecord(db, await authority(dana), { personId: casey }));
	const caseyNotes = await notesOf(casey);
	// Dana changes one column's choice before importing: the form's ID is not worth keeping.
	const first = await previewed(dana, "applications.xlsx", file("applications.xlsx"));
	const columns = first.columns.map((c) => (c.title === "ID" ? "skip" : c.choice));
	const p = await previewed(dana, "applications.xlsx", file("applications.xlsx"), columns);
	const stage = await stageId("Potential leader");
	const importId = randomUUID();
	const result = ok(
		await run(dana, "applications.xlsx", file("applications.xlsx"), p, {
			stageId: stage,
			responsibleSeatId: luisSeat,
			duplicates: [{ row: 3, choice: "skip" }],
			importId,
		}),
	) as Result;
	assert.deepEqual(
		{ added: result.added.map((a) => a.row), skipped: result.skipped, refused: result.refused },
		{ added: [1, 2], skipped: [3], refused: [] },
	);
	jordan = result.added[0]!.personId;

	const potential = (await board(dana)).stages.find((s) => s.id === stage)!;
	assert.deepEqual(
		potential.people.map((x) => [x.name, x.email, x.responsible?.name]),
		[
			["Jordan Reyes", "jordan@example.test", "Luis"],
			["Sam Ortiz", "sam@example.test", "Luis"],
		],
	);
	// Nothing about the existing Casey Lee changed.
	assert.deepEqual(ok(await readPipelinePersonRecord(db, await authority(dana), { personId: casey })), caseyBefore);
	assert.deepEqual(await notesOf(casey), caseyNotes);

	// Jordan's history says he was imported, by Dana, today; his kept answers are one note by Dana.
	const record = ok(await readPipelinePersonRecord(db, await authority(dana), { personId: jordan }));
	assert.deepEqual(
		record.history.map((h) => [h.kind, h.actor, h.on, "to" in h ? h.to : null]),
		[["imported", "Dana", record.asOf, "Potential leader"]],
	);
	const today = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" }).format(
		new Date(`${record.asOf}T00:00:00Z`),
	);
	assert.deepEqual(
		record.notes.map((n) => (n.state === "current" ? [n.author, n.body] : null)),
		[
			[
				"Dana",
				[
					`Answers from applications.xlsx, ${today}`,
					"Start time\n2026-10-03 14:02",
					"Completion time\n2026-10-03 14:22",
					"Phone number\n512-555-0101",
					"Describe your calling\nEast Austin, among young families.\nWe have prayed about it for two years, together.",
					"Spouse's name\nMaria Reyes",
				].join("\n\n"),
			],
		],
	);
	// Sam's empty answers are left out.
	const sam = result.added[1]!.personId;
	assert.doesNotMatch((await notesOf(sam))[0]!.body, /Spouse's name|Phone number/);

	// The note has the ordinary note audience: Luis (an Admin, and responsible) reads it; Ben and Ana see no record.
	const luisView = ok(await readPipelinePersonRecord(db, await authority(luis), { personId: jordan }));
	assert.equal(luisView.notes.length, 1);
	for (const who of [ben, ana])
		assert.deepEqual(refusal(await readPipelinePersonRecord(db, await authority(who), { personId: jordan })), {
			code: "unavailable",
		});
	// The pipeline export leaves the note out like any note.
	const exported = ok(await readPipelineExport(db, await authority(dana)));
	assert.match(exported.text, /Jordan Reyes/);
	assert.doesNotMatch(exported.text, /East Austin|Maria Reyes/);

	// The same reviewed import again (a double click or a retry) answers the same and adds no one.
	const count = await livePeople(grace);
	const again = ok(
		await run(dana, "applications.xlsx", file("applications.xlsx"), p, {
			stageId: stage,
			responsibleSeatId: luisSeat,
			duplicates: [{ row: 3, choice: "skip" }],
			importId,
		}),
	);
	assert.deepEqual(again, result);
	assert.equal(await livePeople(grace), count);
	assert.equal((await notesOf(jordan)).length, 1);
	// The same import id with other choices is refused.
	assert.deepEqual(
		refusal(
			await run(dana, "applications.xlsx", file("applications.xlsx"), p, {
				stageId: stage,
				duplicates: [{ row: 3, choice: "skip" }],
				importId,
			}),
		),
		{ code: "conflict" },
	);
});

test("the import refuses a file that differs from the reviewed one, and a review the pipeline outdated", async () => {
	const bytes = text("Full name,Email address\r\nMorgan Hale,morgan@example.test\r\n");
	const p = await previewed(dana, "one.csv", bytes);
	const stage = await stageId("Potential leader");
	const count = await livePeople(grace);
	const changed = text("Full name,Email address\r\nMorgan Hale,morgan@example.test\r\nEve Stone,eve@example.test\r\n");
	assert.deepEqual(refusal(await run(dana, "one.csv", changed, p, { stageId: stage })), { code: "file_changed" });
	// Someone adds Morgan by hand after the preview: the reviewed findings no longer hold.
	ok(
		await pipelineWriter.addPerson(db, await authority(luis), {
			personId: randomUUID(),
			displayName: "Morgan Hale",
			email: "morgan@example.test",
			responsibleSeatId: null,
			stageId: stage,
		}),
	);
	assert.deepEqual(refusal(await run(dana, "one.csv", bytes, p, { stageId: stage })), { code: "review_stale" });
	assert.equal(await livePeople(grace), count + 1);
});

test("an export with the same titles in another order lines up with Dana's choices; a new title gets the default", async () => {
	const v1 = await previewed(dana, "applications.xlsx", file("applications.xlsx"));
	const v2 = await previewed(dana, "applications-v2.xlsx", file("applications-v2.xlsx"));
	assert.notDeepEqual(
		v1.columns.map((c) => c.title),
		v2.columns.map((c) => c.title),
	);
	assert.deepEqual(choiceByTitle(v2), choiceByTitle(v1));
	assert.equal(choiceByTitle(v2).ID, "skip");
	const fresh = await previewed(dana, "v3.csv", text("Favorite verse,Full name,Email\r\nJohn 3:16,Ari Cole,ari@example.test\r\n"));
	assert.deepEqual(
		fresh.columns.map((c) => [c.title, c.choice]),
		[
			["Favorite verse", "answer"],
			["Full name", "name"],
			// Remembered from Dana's import: the form's own Email column was skipped.
			["Email", "skip"],
		],
	);
});

test("a Stage column places rows by label; an unknown label is a row error and an empty one takes the chosen stage", async () => {
	const bytes = text(
		"Full name,Email address,Stage\r\nAvery Moss,avery@example.test,apprentice\r\nBlake Wren,blake@example.test,Pastor\r\nCam Doyle,cam@example.test,\r\n",
	);
	const p = await previewed(dana, "stages.csv", bytes);
	const apprentice = await stageId("Apprentice"),
		resident = await stageId("Resident");
	assert.deepEqual(
		p.rows.map((r) => [r.name, r.status, r.problems, r.stageId]),
		[
			["Avery Moss", "ready", [], apprentice],
			["Blake Wren", "invalid", ["unknown_stage"], null],
			["Cam Doyle", "ready", [], null],
		],
	);
	const result = ok(await run(dana, "stages.csv", bytes, p, { stageId: resident })) as Result;
	assert.deepEqual(result.refused, [{ row: 2, problems: ["unknown_stage"] }]);
	const b = await board(dana);
	const where = (name: string) => b.stages.find((s) => s.people.some((x) => x.name === name))?.label;
	assert.deepEqual([where("Avery Moss"), where("Blake Wren"), where("Cam Doyle")], ["Apprentice", undefined, "Resident"]);
});

test("a value a spreadsheet would run as a formula is stored as text and neutralized in the export", async () => {
	const name = '=HYPERLINK("http://example.test","Click")';
	const bytes = text(`Full name,Email address\r\n"${name.replaceAll('"', '""')}",formula@example.test\r\n`);
	const p = await previewed(dana, "formula.csv", bytes);
	const result = ok(await run(dana, "formula.csv", bytes, p, { stageId: await stageId("Potential leader") })) as Result;
	const record = ok(await readPipelinePersonRecord(db, await authority(dana), { personId: result.added[0]!.personId }));
	assert.equal(record.name, name);
	const exported = ok(await readPipelineExport(db, await authority(dana))).text;
	assert.ok(exported.includes(`"'${name.replaceAll('"', '""')}"`), "the export starts the cell with an apostrophe");
});

test("Ben, Ana and another organization's Owner cannot preview or import Grace Austin's people", async () => {
	const bytes = file("applications.xlsx");
	const p = await previewed(dana, "applications.xlsx", bytes);
	const stage = await stageId("Potential leader");
	const count = await livePeople(grace);
	for (const who of [ben, ana]) {
		assert.deepEqual(refusal(await preview(who, "applications.xlsx", bytes)), { code: "unavailable" });
		assert.deepEqual(
			refusal(await run(who, "applications.xlsx", bytes, p, { stageId: stage, duplicates: [{ row: 3, choice: "add" }] })),
			{ code: "unavailable" },
		);
	}
	// Hill Country's Owner sees neither Grace's people as duplicates nor Grace's remembered choices.
	const theirs = await previewed(hillOwner, "applications.xlsx", bytes);
	assert.equal(choiceByTitle(theirs).ID, "answer");
	assert.deepEqual(
		theirs.rows.map((r) => [r.status, r.existing]),
		[
			["ready", []],
			["ready", []],
			["ready", []],
		],
	);
	// Naming Grace's stage from Hill Country adds no one to Grace.
	assert.deepEqual(
		refusal(await run(hillOwner, "applications.xlsx", bytes, theirs, { stageId: stage })),
		{ code: "invalid_input", field: "stageId" },
	);
	assert.equal(await livePeople(grace), count);
	assert.equal(await livePeople(hill), 0);
});

test("a UTF-8 CSV with a BOM, CRLF, quoted commas and multi-line answers imports like the Excel file", async () => {
	const csvOrg = (await database.organization("sending_church", { name: "CSV Church", timezone: "America/Chicago" })) as Org;
	const xlsxOrg = (await database.organization("sending_church", { name: "XLSX Church", timezone: "America/Chicago" })) as Org;
	const imported = async (org: Org, fileName: string, bytes: Uint8Array) => {
		const owner = await named(org, "owner", "Owner");
		const p = await previewed(owner, fileName, bytes);
		const stage = (await board(owner)).stages[0]!.id;
		const result = ok(await run(owner, fileName, bytes, p, { stageId: stage })) as Result;
		const people = [];
		for (const a of result.added) {
			const r = ok(await readPipelinePersonRecord(db, await authority(owner), { personId: a.personId }));
			// The note's first line names the file; everything after it is the answers.
			people.push([r.name, r.email, r.notes.map((n) => (n.state === "current" ? n.body.split("\n\n").slice(1) : null))]);
		}
		return { columns: p.columns, people };
	};
	const fromCsv = await imported(csvOrg, "applications.csv", file("applications.csv"));
	const fromXlsx = await imported(xlsxOrg, "applications.xlsx", file("applications.xlsx"));
	assert.deepEqual(fromCsv, fromXlsx);
	assert.equal(fromCsv.people.length, 3);
	assert.deepEqual(file("applications.csv"), text(csvOf(APPLICATIONS)));
	assert.ok(fromCsv.people.some((p) => JSON.stringify(p).includes("young families.\\nWe have prayed")));
});
