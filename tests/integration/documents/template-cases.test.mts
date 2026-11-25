import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test, { after, describe } from "node:test";
import { sql, type SQL } from "../../../packages/db/src/query.ts";
import { PDFDocument } from "../../../packages/domain/node_modules/pdf-lib/cjs/index.js";
import { RequestActor } from "../../../packages/domain/src/access/session.ts";
import { documentsReader, documentsWriter } from "../../../packages/domain/src/documents/index.ts";
import { fixture, ok, refused } from "../../support/fixture.mts";
import { recorded, touched, untouched } from "../../support/recorded.mts";
import { docxParts, pdfPages, wordText } from "./fixtures/readers.mts";
import { MemoryClient } from "./storage.mts";
import { present } from "./support.mts";

type Format = "pdf" | "docx" | "xlsx";
type Case = {
	id: string;
	given: {
		template: { id: string; formats: Format[]; catalog_sha256: string; document_class?: string };
		document: { use_church_branding: boolean };
	};
	action: {
		operation: string;
		arguments: {
			template: string;
			format: Format;
			merge_fields: Record<string, string>;
			request_key: string;
		};
	};
	expected: { result: Record<string, unknown> };
	subcases?: Case[];
	name?: string;
};

const read = (path: string) => readFileSync(new URL(`../../../${path}`, import.meta.url));
const cases: Case[] = JSON.parse(read("docs/acceptance/knowledge.json").toString("utf8")).cases;
const caseOf = (id: string) =>
	present(
		cases.find((c) => c.id === id),
		id,
	);
type FrozenTemplate = {
	id: string;
	name: string;
	description: string;
	category: string;
	phase?: number;
	relatedWikiSlug?: string;
	mergeFields: { key: string; label: string; required: boolean; autoFill?: string }[];
};
const { DOCUMENT_TEMPLATES }: { DOCUMENT_TEMPLATES: FrozenTemplate[] } = await import(
	new URL("../../../docs/reference/document-templates.ts", import.meta.url).href
);
const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

const database = await fixture({
	prefix: "templatecases",
	plant: { name: "Registered Plant Name" },
});
after(() => database.close());
const { admin } = database;
const db = database.pools.runtime;
const client = new MemoryClient();
const storage = { bucket: "synthetic-only", client };
const account = database.actors.admin.id;
const actor = await RequestActor.resolve(db, database.actors.admin.session);
assert.ok(actor instanceof RequestActor);
const authority = actor;

const one = async <T extends Record<string, unknown>>(query: SQL) => {
	const { rows } = await admin.execute<T>(query);
	assert.equal(rows.length, 1);
	return present(rows[0]);
};
const savedBytes = async (generated: { id: string; digest: string; byteCount: number }) => {
	const file = await one<{ opaque_key: string; sha256: string; state: string; purpose: string }>(
		sql`SELECT f.opaque_key,f.sha256,f.state,f.purpose FROM generated_document g JOIN file_object f ON f.id=g.object_id WHERE g.id=${generated.id}`,
	);
	const bytes = present(client.objects.get(file.opaque_key), "the saved bytes");
	assert.deepEqual(
		[file.state, file.purpose, file.sha256, generated.digest, generated.byteCount],
		["ready", "generated", sha(bytes), sha(bytes), bytes.length],
	);
	return bytes;
};
const effects = async <T,>(body: () => Promise<T>, tables: string[], audits: string[]) => {
	const run = await recorded(admin, () => touched(admin, body));
	assert.deepEqual(run.added, { audits, jobs: [], notices: 0, mail: 0 });
	assert.deepEqual(run.value.tables, tables);
	return run.value.value;
};
const SAVES = ["audit_event", "file_object", "generated_document", "record"];

const printed = (...lines: string[]) => lines.join(" ");
const COMMITMENT = printed(
	"Harvest Point A new church plant. You are welcome here. My commitment CORE GROUP",
	"Through Launch Sunday, I will:",
	"GROW Join a weekly group and keep learning with the church plant family.",
	"PRAY Pray each week for our neighbors and for Launch Sunday.",
	"GIVE Give my time, my gifts and my money toward the launch.",
	"NAME EMAIL OR PHONE SIGNATURE DATE",
	"Please hand this card back to the person who gave it to you.",
);
const range = (n: number) => Array.from({ length: n }, (_, i) => i + 1);
const AGENDA_FIELDS = [
	...range(6).flatMap((n) => [`time_${n}`, `segment_${n}`, `lead_${n}`, `notes_${n}`]),
	...range(8).flatMap((n) => [`attendee_${n}_name`, `attendee_${n}_role`, `present_${n}`]),
	...range(4).flatMap((n) => [`action_${n}`, `owner_${n}`, `due_${n}`, `done_${n}`]),
];
const AGENDA_BODY = printed(
	"1 Run of show TIME SEGMENT LEAD NOTES",
	"2 Attendees Tick when present NAME ROLE HERE NAME ROLE HERE",
	"3 Follow-up actions ACTION OWNER DUE DONE",
);
const TEAM = "TEAM LEAD DONE TASK OWNER TIME";
const CHECKLIST_TEAMS = ["setup", "hospitality", "worship", "kids", "connections", "prayer"];

const PRINTED: Record<string, { pages: string[]; size: [number, number]; fields: string[]; unplaced?: string[] }> = {
	"CASE-DOC-004": {
		pages: [printed(COMMITMENT, COMMITMENT, COMMITMENT, COMMITMENT)],
		size: [612, 792],
		fields: range(4).flatMap((card) =>
			["row_1_done", "row_2_done", "row_3_done", "full_name", "contact", "signature", "signed_date"].map(
				(name) => `${name}_t${card}`,
			),
		),
		unplaced: ["pastor_name"],
	},
	"CASE-DOC-005": {
		pages: [
			printed(
				"Harvest Point A new church plant. You are welcome here. Stay in touch VISION MEETING",
				"Thank you for coming. Check each way you would like to be involved:",
				"Send me news about the church plant. Invite me to a weekly group.",
				"I would like to serve on a launch team. Add me to the prayer list. NAME EMAIL PHONE",
			),
		],
		size: [306, 396],
		fields: ["involve_updates", "involve_group", "involve_serve", "involve_pray", "full_name", "email", "phone"],
	},
	"CASE-DOC-006": {
		pages: [
			printed(
				"Harvest Point VISION MEETING Guest Sign-in Sheet",
				"Welcome to Harvest Point. Please sign in so we can thank you and stay in touch.",
				"MEETING DATE MEETING NUMBER # NAME EMAIL PHONE WHO INVITED YOU?",
				"1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18",
				"Harvest Point | Guest sign-in sheet Page 1 of 1",
			),
		],
		size: [612, 792],
		fields: [
			"meeting_date",
			"meeting_number",
			...range(18).flatMap((n) => [`row_${n}_name`, `row_${n}_email`, `row_${n}_phone`, `row_${n}_invited_by`]),
		],
		unplaced: ["meeting_date", "meeting_number"],
	},
	"CASE-DOC-007": {
		pages: [
			printed(
				"Harvest Point CORE GROUP · VISION MEETING Vision Meeting Agenda",
				"Share the vision for Harvest Point, a new church plant, and invite each guest to GROW, PRAY and GIVE.",
				"DATE 2026-10-20 TIME PLACE FACILITATOR Alex Rivera",
				AGENDA_BODY,
				"Harvest Point | Vision meeting agenda Page 1 of 1",
			),
		],
		size: [612, 792],
		fields: ["meeting_time", "meeting_place", ...AGENDA_FIELDS],
	},
	"CASE-DOC-011": {
		pages: [
			printed(
				"Harvest Point BOARD AND ELDERS Board and Elder Meeting Agenda",
				"Pray, decide and assign action items for Harvest Point.",
				"DATE 2026-10-20 TIME PLACE FACILITATOR",
				AGENDA_BODY,
				"Harvest Point | Board and elder meeting agenda Page 1 of 1",
			),
		],
		size: [612, 792],
		fields: ["meeting_time", "meeting_place", "facilitator", ...AGENDA_FIELDS],
	},
	"CASE-DOC-014": {
		pages: [
			printed(
				"Harvest Point TEAM CHECKLISTS Launch Sunday Checklists Launch Sunday · 2026-10-25",
				"Check each task when it is done. Each owner confirms by the time written beside it, so the whole church plant team is ready together.",
				`1 Setup ${TEAM} Unlock doors and turn on the lights Set out the chairs in rows`,
				"Hang the welcome banner at the street entrance Test the projector, screen and slides Walk the room with the launch-day map",
				`2 Hospitality ${TEAM} Brew coffee and set out tea and water Place directional signs outside`,
				"Prepare name tags and a guest welcome table Brief greeters: smile, say a name, walk guests to a seat Check restrooms and refill supplies",
				`3 Worship ${TEAM} Load the stage and run the sound check Tune instruments and check monitors`,
				"Confirm the song order and lyric slides Rehearse the opening song and transitions Pray with the team before doors open",
				"Harvest Point | Launch Sunday checklists | 2026-10-25 Page 1 of 2",
			),
			printed(
				"Launch Sunday Checklists, continued HARVEST POINT",
				`4 Kids ${TEAM} Set up the safe check-in desk and name labels Stock each room with the lesson and craft supplies`,
				"Hand out volunteer badges and room assignments Review the allergy and pickup procedure Open rooms and greet the first families",
				`5 Connections ${TEAM} Set up the connect table with a card and pen for each guest Post the QR code for the next-steps form`,
				"Print the handout: groups, serving and giving Assign a host to each first-time guest Collect the cards and enter them by noon",
				`6 Prayer ${TEAM} Open the prayer room and set out prayer cards Walk and pray over the room, row by row`,
				"Brief the prayer team on how to listen and pray with guests Stand ready at the front during the final song Log answered prayers for the church plant newsletter",
				"Harvest Point | Launch Sunday checklists | 2026-10-25 Page 2 of 2",
			),
		],
		size: [612, 792],
		fields: CHECKLIST_TEAMS.flatMap((team) => [
			`${team}_lead`,
			...range(5).flatMap((n) => [`${team}_${n}_done`, `${team}_${n}_owner`, `${team}_${n}_time`]),
		]),
	},
};

function frozenTemplate(id: string) {
	const c = caseOf(id);
	const { template } = c.given;
	assert.equal(sha(read("docs/reference/document-templates.ts")), template.catalog_sha256);
	assert.equal(c.expected.result.template_catalog_sha256, template.catalog_sha256);
	return present(DOCUMENT_TEMPLATES.find((frozen) => frozen.id === template.id));
}

async function generated(id: string, unplaced: string[] = []) {
	const c = caseOf(id);
	const { template, format, merge_fields, request_key } = c.action.arguments;
	const frozen = frozenTemplate(id);
	const view = ok(await documentsReader["templates.get"](db, authority, { templateId: template }));
	assert.deepEqual(
		[view.name, view.description, view.category, view.phase, view.wikiSlug, view.formats],
		[
			frozen.name,
			frozen.description,
			frozen.category,
			frozen.phase ?? null,
			frozen.relatedWikiSlug ?? null,
			c.given.template.formats,
		],
	);
	assert.deepEqual(
		view.mergeFields,
		frozen.mergeFields
			.filter((field) => !unplaced.includes(field.key))
			.map(({ key, label, required, autoFill }) => ({
				key,
				label,
				required,
				autoFill: autoFill ?? null,
			})),
	);
	const overrides = Object.fromEntries(Object.entries(merge_fields).filter(([key]) => !unplaced.includes(key)));
	const input = { templateId: template, format, overrides };
	const request = { ...input, requestKey: request_key };
	for (const other of (["pdf", "docx", "xlsx"] as const).filter((f) => !c.given.template.formats.includes(f)))
		refused(
			await untouched(admin, () => documentsWriter.generate(db, authority, { ...request, format: other }, storage)),
			"invalid_input",
		);
	const preview = ok(await untouched(admin, () => documentsReader.preview(db, authority, input)));
	const made = ok(
		await effects(() => documentsWriter.generate(db, authority, request, storage), SAVES, [
			"documents.generated",
			"files.finalized",
		]),
	);
	assert.deepEqual(
		[made.templateId, made.format, made.plantId, made.savedTemplateName, made.creatorAccountId],
		[c.expected.result.template, c.expected.result.format, database.tenant.id, frozen.name, account],
	);
	const row = await one<{ inputs: unknown }>(sql`SELECT inputs FROM generated_document WHERE id=${made.id}`);
	assert.deepEqual(
		row.inputs,
		Object.entries(overrides).map(([key, value]) => ({ key, value, source: "override" })),
	);
	const bytes = await savedBytes(made);
	assert.deepEqual(bytes, Buffer.from(present(preview.artifact), "base64"));
	const again = await untouched(admin, () => documentsWriter.generate(db, authority, request, storage));
	assert.deepEqual(ok(again), made);
	return { bytes, result: c.expected.result };
}

describe("named PDF templates", { concurrency: 1 }, () => {
	for (const [id, approved] of Object.entries(PRINTED))
		test(`AC:${id} the saved PDF opens with the approved text, footer and write-in fields, equals its preview and adds nothing else`, async () => {
			const { bytes, result } = await generated(id, approved.unplaced);
			assert.equal(bytes.subarray(0, 5).toString("latin1"), "%PDF-");
			assert.deepEqual(
				(await pdfPages(bytes)).map((page) => page.trim()),
				approved.pages,
			);
			const pdf = await PDFDocument.load(bytes, { updateMetadata: false });
			assert.equal(pdf.getTitle()?.includes(String(result.church_name)), true);
			for (const page of pdf.getPages()) assert.deepEqual([page.getWidth(), page.getHeight()], approved.size);
			assert.deepEqual(
				pdf
					.getForm()
					.getFields()
					.map((field) => field.getName())
					.sort(),
				[...approved.fields].sort(),
			);
			const text = approved.pages.join(" ");
			assert.ok(text.includes(String(result.church_name)));
			if (result.paper === "letter") assert.deepEqual(approved.size, [612, 792]);
			if (id === "CASE-DOC-004") {
				const cards = text.split(`Through ${result.through}, I will:`).length - 1;
				assert.equal(1 / cards, result.page_fraction);
				for (const term of result.commitment_terms as string[]) assert.equal(text.split(` ${term} `).length - 1, 4);
			}
		});
});

const CATEGORIES = {
	income: [
		"Tithes and offerings",
		"Sending church support",
		"Network or denominational support",
		"Grants",
		"Other income",
	],
	expenses: [
		"Pastor and staff pay",
		"Payroll taxes and benefits",
		"Rent or facility",
		"Utilities and internet",
		"Insurance",
		"Worship and sound",
		"Kids ministry",
		"Outreach and marketing",
		"Office and supplies",
		"Giving to the network and missions",
	],
};
type CellValue = string | number | null | { formula: string };
type Sheet = {
	name: string;
	getCell(address: string): { value: CellValue };
	eachRow(visit: (row: { eachCell(visit: (cell: { address: string; value: CellValue }) => void): void }) => void): void;
};
type Workbook = {
	worksheets: Sheet[];
	xlsx: { load(bytes: Uint8Array): Promise<unknown> };
	getWorksheet(name: string): Sheet | undefined;
};
const ExcelJS: { Workbook: new () => Workbook } = createRequire(import.meta.url)(
	"../../../packages/domain/node_modules/exceljs/lib/exceljs.nodejs.js",
);
const opened = async (bytes: Uint8Array) => {
	const book = new ExcelJS.Workbook();
	await book.xlsx.load(bytes);
	return book;
};
const grid = (sheet: Sheet) => {
	const cells: Record<string, string | number> = {};
	sheet.eachRow((row) =>
		row.eachCell(({ address, value }) => {
			if (value !== null) cells[address] = typeof value === "object" ? `=${value.formula}` : value;
		}),
	);
	return cells;
};
const COLUMNS = "ABCDEFGHIJKLMN";
const labels = (first: number, names: string[]) => Object.fromEntries(names.map((name, i) => [`A${first + i}`, name]));
const perRow = (first: number, last: number, column: string, formula: (row: number) => string) =>
	Object.fromEntries(range(last - first + 1).map((n) => [`${column}${first + n - 1}`, formula(first + n - 1)]));
const perColumn = (row: number, columns: string, formula: (column: string) => string) =>
	Object.fromEntries([...columns].map((column) => [`${column}${row}`, formula(column)]));

function calculated(book: Workbook, sheet: string, ref: string): number {
	const { value } = present(book.getWorksheet(sheet)).getCell(ref);
	if (value === null) return 0;
	if (typeof value === "number") return value;
	assert.ok(typeof value === "object", `${ref} holds text`);
	const formula = value.formula.replace(/^\((.*)\)$/, "$1");
	const linked = /^'([^']+)'!([A-Z]\d+)$/.exec(formula);
	if (linked) return calculated(book, present(linked[1]), present(linked[2]));
	const sum = /^SUM\(([A-Z])(\d+):([A-Z])(\d+)\)$/.exec(formula);
	if (sum) {
		const [, left = "", top, right = "", bottom] = sum;
		let total = 0;
		for (const column of COLUMNS.slice(COLUMNS.indexOf(left), COLUMNS.indexOf(right) + 1))
			for (let row = Number(top); row <= Number(bottom); row++) total += calculated(book, sheet, `${column}${row}`);
		return total;
	}
	const [, a, operator, b] = present(/^([A-Z]\d+)([-*/])(\w+)$/.exec(formula), formula);
	const left = calculated(book, sheet, present(a));
	const right = /^\d+$/.test(present(b)) ? Number(b) : calculated(book, sheet, present(b));
	return operator === "-" ? left - right : operator === "*" ? left * right : left / right;
}
const recalculates = (bytes: Uint8Array) =>
	assert.match(present(docxParts(bytes)["xl/workbook.xml"]), /<calcPr [^>]*fullCalcOnLoad="1"/);

describe("named XLSX templates", { concurrency: 1 }, () => {
	test("AC:CASE-DOC-012 the saved first-year budget opens with twelve months, the approved categories and live formulas that recalculate, equals its preview and adds nothing else", async () => {
		const { bytes, result } = await generated("CASE-DOC-012");
		const book = await opened(bytes);
		assert.deepEqual(
			book.worksheets.map((sheet) => sheet.name),
			["Monthly budget", "Annual summary"],
		);
		const shared = {
			...labels(4, ["Income", ...CATEGORIES.income, "Total income"]),
			...labels(12, ["Expenses", ...CATEGORIES.expenses, "Total expenses"]),
			A25: "Net (income minus expenses)",
		};
		const amounts = COLUMNS.slice(1);
		assert.deepEqual(grid(present(book.worksheets[0])), {
			A1: `${result.church_name} First-Year Budget`,
			A2: "Enter each amount in a boxed cell. The totals add up on their own.",
			A3: "Category",
			...perColumn(3, amounts, (c) => (c === "N" ? "Year total" : `Month ${amounts.indexOf(c) + 1}`)),
			...shared,
			...perRow(5, 9, "N", (r) => `=SUM(B${r}:M${r})`),
			...perColumn(10, amounts, (c) => `=SUM(${c}5:${c}9)`),
			...perRow(13, 22, "N", (r) => `=SUM(B${r}:M${r})`),
			...perColumn(23, amounts, (c) => `=SUM(${c}13:${c}22)`),
			...perColumn(25, amounts, (c) => `=${c}10-${c}23`),
		});
		const linked = [...range(6).map((n) => n + 4), ...range(11).map((n) => n + 12), 25];
		assert.deepEqual(grid(present(book.worksheets[1])), {
			A1: `${result.church_name} Annual Summary`,
			A2: "This sheet reads the Monthly budget sheet. Type amounts there, not here.",
			A3: "Category",
			B3: "Year total",
			C3: "Monthly average",
			...shared,
			...Object.fromEntries(
				linked.flatMap((r) => [
					[`B${r}`, `='Monthly budget'!N${r}`],
					[`C${r}`, `=B${r}/12`],
				]),
			),
		});
		recalculates(bytes);
		const monthly = present(book.getWorksheet("Monthly budget"));
		for (const column of amounts.slice(0, 12)) {
			monthly.getCell(`${column}5`).value = 1000;
			monthly.getCell(`${column}6`).value = 500;
			monthly.getCell(`${column}13`).value = 700;
		}
		const totals = () => [
			...["B10", "N10", "N23", "N25"].map((ref) => calculated(book, "Monthly budget", ref)),
			...["B10", "B25", "C25"].map((ref) => calculated(book, "Annual summary", ref)),
		];
		assert.deepEqual(totals(), [1500, 18000, 8400, 9600, 18000, 9600, 800]);
		monthly.getCell("B5").value = 2200;
		assert.deepEqual(totals(), [2700, 19200, 8400, 10800, 19200, 10800, 900]);
	});

	test("AC:CASE-DOC-013 the saved budget worksheet opens with monthly and annual columns and live formulas that recalculate, equals its preview and adds nothing else", async () => {
		const { bytes, result } = await generated("CASE-DOC-013");
		const book = await opened(bytes);
		assert.deepEqual(
			book.worksheets.map((sheet) => sheet.name),
			["Budget worksheet"],
		);
		const sheet = present(book.worksheets[0]);
		assert.deepEqual(grid(sheet), {
			A1: `${result.church_name} Budget Worksheet`,
			A2: "Enter each amount in a boxed cell. The totals add up on their own.",
			A3: "Category",
			B3: "Monthly",
			C3: "Annual",
			...labels(4, ["Income", ...CATEGORIES.income, "Total income"]),
			...labels(11, ["Expenses", ...CATEGORIES.expenses, "Total expenses", "Net (income minus expenses)"]),
			...perRow(5, 9, "C", (r) => `=(B${r}*12)`),
			...perColumn(10, "BC", (c) => `=SUM(${c}5:${c}9)`),
			...perRow(12, 21, "C", (r) => `=(B${r}*12)`),
			...perColumn(22, "BC", (c) => `=SUM(${c}12:${c}21)`),
			...perColumn(23, "BC", (c) => `=${c}10-${c}22`),
		});
		recalculates(bytes);
		sheet.getCell("B5").value = 4000;
		sheet.getCell("B8").value = 1000;
		sheet.getCell("B14").value = 1500;
		const totals = () => ["C5", "B10", "C10", "C22", "B23", "C23"].map((ref) => calculated(book, sheet.name, ref));
		assert.deepEqual(totals(), [48000, 5000, 60000, 18000, 3500, 42000]);
		sheet.getCell("B14").value = 2000;
		assert.deepEqual(totals(), [48000, 5000, 60000, 24000, 3000, 36000]);
	});
});

type Piece = string | { pdf: string; word: string };
const label = (text: string): Piece => ({ pdf: text.toUpperCase(), word: text });
const marked = (mark: string, text: string): Piece => ({ pdf: `${mark} ${text}`, word: text });
const SIGN = [label("Name"), label("Signature"), label("Date")];
const PROSE: Record<string, { title: string; footer: string; body: Piece[] }> = {
	"CASE-DOC-008": {
		title: "Expectations of a Core Group Member",
		footer: "Harvest Point | Expectations of a Core Group Member Page 1 of 1",
		body: [
			"Harvest Point",
			label("Core group"),
			"Expectations of a Core Group Member",
			"Thank you for joining the core group of Harvest Point. A new church plant grows from a small team that shows up. This page says what we ask of you, and what you can expect from us.",
			"1 Be present The core group meets each week. Your presence tells the others that this church plant is worth building.",
			marked("•", "Come to the weekly core group meeting."),
			marked("•", "Arrive on time and stay to the end."),
			marked("•", "Tell your group leader before you miss a meeting."),
			"2 GROW We grow together. Join a weekly group, read what we read and ask your questions in the open.",
			"3 PRAY Pray each week for the neighbors we hope to reach, for the leaders and for Launch Sunday. Pray with the group when we gather.",
			"4 GIVE Give your time, your gifts and your money toward the launch. Give as you are able. No one is pressed or compared.",
			"5 Join a team Serve on one launch team before Launch Sunday. Pick the team that fits how God made you. Your group leader will help you choose.",
			"6 Protect the unity Speak well of the church plant and of its people. Take a concern to the leaders first, and do it in person.",
			"By signing, I say that I have read these expectations and that I will do my best to keep them.",
			...SIGN,
		],
	},
	"CASE-DOC-009": {
		title: "Launch Team Commitment",
		footer: "Harvest Point | Launch Team Commitment Page 1 of 1",
		body: [
			"Harvest Point",
			label("Launch team"),
			"Launch Team Commitment",
			"The launch team carries Harvest Point from the first gathering to Launch Sunday and beyond. This letter names what each member commits to. Read it, pray over it and sign it when you are ready.",
			"1 My role I will serve on one launch team through Launch Sunday and for at least the first three months after it. I will keep the team lead informed of my plans and my limits.",
			"2 My time",
			marked("•", "I will come to the launch team meetings."),
			marked("•", "I will come to the training for my team."),
			marked("•", "I will arrive early on Launch Sunday and stay to help close."),
			"3 My prayer I will pray each week for the church plant, its leaders, the team and the people we hope to welcome.",
			"4 My giving I will give regularly and with joy toward the work of this church plant, as God leads me.",
			"5 My conduct I will treat every guest and every teammate with respect. I will follow the safety rules for children and the guidance of the team lead. I will speak well of the church plant and of its leaders.",
			"I make this commitment freely. I understand that I may talk with the pastor at any time if my situation changes.",
			...SIGN,
		],
	},
	"CASE-DOC-010": {
		title: "Vision Meeting Follow-up Letter",
		footer: "Harvest Point | Thank You for Coming Page 1 of 1",
		body: [
			"Harvest Point",
			label("Letter"),
			"Thank You for Coming",
			label("Date"),
			"Dear friend,",
			"Thank you for coming to our vision meeting. It meant a great deal to us that you gave an evening to hear about Harvest Point, a new church plant.",
			"We shared why we believe this church is needed, who we hope to reach and what a Sunday could look like. We would love to hear what you thought. Your questions and your ideas help us build something that serves our neighbors well.",
			"Here are three ways to take the next step:",
			marked("1.", "Come to the next vision meeting and bring a friend."),
			marked("2.", "Join a weekly group and meet the core group."),
			marked("3.", "Tell us how you would like to help. Reply to this letter or speak with one of us in person."),
			"There is no pressure and no obligation. We simply want you to know that you are welcome, and that we are praying for you.",
			"With gratitude, Alex Rivera Harvest Point",
		],
	},
};
const textOf = (pieces: Piece[], format: "pdf" | "word") =>
	pieces.map((piece) => (typeof piece === "string" ? piece : piece[format])).join(" ");

describe("named editable templates", { concurrency: 1 }, () => {
	for (const [id, approved] of Object.entries(PROSE))
		test(`AC:${id} a Church Document keeps the approved template as revision 1, and its PDF and Word files open with that revision's content`, async (t) => {
			const c = caseOf(id);
			const { template, merge_fields, request_key } = c.action.arguments;
			const { result } = c.expected;
			const frozen = frozenTemplate(id);
			assert.equal(frozen.name, approved.title);
			const request = { templateId: template, mergeFields: merge_fields, requestKey: request_key };
			const objects = client.objects.size;
			const create = () => documentsWriter.createFromTemplate(db, authority, request);
			const doc = ok(
				await effects(
					create,
					["audit_event", "document", "document_revision", "record"],
					["documents.created_from_template"],
				),
			);
			assert.equal(client.objects.size - objects, result.files_created);
			assert.deepEqual(
				[doc.templateId, doc.tenantId, doc.revision, doc.title, doc.documentClass, doc.formats],
				[
					result.template,
					database.tenant.id,
					String(result.revision),
					frozen.name,
					c.given.template.document_class,
					c.given.template.formats,
				],
			);
			const file = JSON.parse(read(`packages/domain/src/documents/templates/${template}.json`).toString("utf8"));
			const row = await one<{ body: string; version_number: number; tenant_id: string }>(
				sql`SELECT body,version_number::int AS version_number,tenant_id FROM document_revision WHERE document_id=${doc.id}`,
			);
			assert.deepEqual([row.version_number, row.tenant_id], [1, database.tenant.id]);
			const revision = JSON.parse(row.body);
			assert.deepEqual([revision.body, revision.page, revision.fields], [file.body, file.page, file.fields]);
			assert.deepEqual(revision.data, {
				...merge_fields,
				church_legal_name: result.church_name,
			});
			assert.deepEqual(ok(await untouched(admin, create)), doc);

			for (const sub of present(c.subcases))
				await t.test(`${id} ${sub.name}`, async () => {
					const { format, request_key: requestKey } = sub.action.arguments;
					assert.equal(doc.useChurchBranding, sub.given.document.use_church_branding);
					const stored = client.objects.size;
					const input = { documentId: doc.id, revision: 1, format, requestKey };
					const exported = ok(
						await effects(() => documentsWriter.exportNative(db, authority, input, storage), SAVES, [
							"documents.exported",
							"files.finalized",
						]),
					);
					assert.equal(client.objects.size - stored, sub.expected.result.generated_document_saved);
					assert.deepEqual(
						[exported.format, exported.templateId, exported.source],
						[sub.expected.result.format, template, { documentId: doc.id, revisionId: doc.revisionId, revision: 1 }],
					);
					const bytes = await savedBytes(exported);
					if (format === "pdf") {
						assert.deepEqual(
							(await pdfPages(bytes)).map((page) => page.trim()),
							[`${textOf(approved.body, "pdf")} ${approved.footer}`],
						);
						const [page] = (await PDFDocument.load(bytes, { updateMetadata: false })).getPages();
						assert.deepEqual([page?.getWidth(), page?.getHeight()], [612, 792]);
					} else {
						const parts = docxParts(bytes);
						assert.match(present(parts["[Content_Types].xml"]), /wordprocessingml\.document\.main\+xml/);
						assert.equal(wordText(present(parts["word/document.xml"])), textOf(approved.body, "word"));
						assert.equal(wordText(present(parts["word/footer1.xml"])), approved.footer);
					}
					assert.ok(textOf(approved.body, "word").includes(String(sub.expected.result.church_name)));
				});
			const saved = await one<{ n: number }>(
				sql`SELECT count(*)::int AS n FROM generated_document WHERE source_revision_id=${doc.revisionId}`,
			);
			assert.equal(saved.n, 2);
		});
});

test("a merge value that the card or the sign-in sheet has no place to print is refused and saves nothing", async () => {
	for (const [id, path] of [
		["CASE-DOC-004", "overrides.pastor_name"],
		["CASE-DOC-006", "overrides.meeting_date"],
	] as const) {
		const { template, format, merge_fields } = caseOf(id).action.arguments;
		const error = refused(
			await untouched(admin, () =>
				documentsWriter.generate(
					db,
					authority,
					{ templateId: template, format, overrides: merge_fields, requestKey: `${id}-unplaced` },
					storage,
				),
			),
			"invalid_input",
		);
		assert.deepEqual(error.details.issues, [{ path, problem: "Unknown merge field." }]);
	}
});
