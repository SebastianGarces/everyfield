// T-20 (WP-036 slice): conditional text, the `if` node. The format refuses each misplaced or ill-formed condition with
// its own message; the PDF and the Word file print a true condition's blocks in place and leave a false one out with
// no blank; the editor's "prints now" state matches the PDF; and the agenda overflow note builds from format nodes.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
	docDocument,
	forkTemplate,
	type BlockNode,
	type DocDocument,
	type FieldDecl,
	type IfNode,
} from "../../../packages/contracts/src/documents/format/index.ts";
import { renderDocFile } from "../../../packages/domain/src/documents/doc-render.ts";
import { DOC_TEMPLATES, docTemplateById } from "../../../packages/domain/src/documents/doc-templates.ts";
import { conditionHolds, printedDoc } from "../../../packages/domain/src/documents/doc-values.ts";
import { NEUTRAL_THEME } from "../../../packages/domain/src/documents/theme.ts";
import { conditionLabel } from "../../../apps/web/src/features/documents/church/editor/condition.ts";
import { docxParts, pdfPages, wordText } from "./fixtures/readers.mts";

const THEME = {
	render: NEUTRAL_THEME,
	fonts: { heading: "DM Serif Display", body: "DM Sans" },
	kind: "everyfield-neutral" as const,
	primary: null,
};
const SAVED = new Date("2026-11-01T12:00:00Z");
const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const pdf = (doc: DocDocument) => renderDocFile(doc, "pdf", THEME, SAVED);
const docx = (doc: DocDocument) => renderDocFile(doc, "docx", THEME, SAVED);
const pdfText = async (doc: DocDocument) => (await pdfPages(await pdf(doc))).join(" ");
const wordBody = async (doc: DocDocument) => docxParts(await docx(doc))["word/document.xml"]!;

const FIELDS: FieldDecl[] = [
	{ key: "church_name", label: "Church name", type: "text" },
	{ key: "pastor", label: "Pastor", type: "text" },
	{ key: "meeting_date", label: "Meeting date", type: "date" },
	{ key: "shown", label: "Attendees shown", type: "number" },
	{ key: "not_shown", label: "Attendees not shown", type: "number" },
	{ key: "attendees", label: "Attendees", type: "list" },
];
const text = (t: string): BlockNode => ({ type: "paragraph", content: [{ type: "text", text: t }] });
const cond = (attrs: IfNode["attrs"], content: BlockNode[] = [text("CONDITIONAL LINE")]): IfNode => ({
	type: "if",
	attrs,
	content,
});
function doc(content: BlockNode[], data: Record<string, unknown> = {}, extra: Partial<DocDocument> = {}): DocDocument {
	return {
		format: "everyfield.doc/1",
		kind: "document",
		id: "conditions",
		version: 1,
		title: "Conditions",
		class: "operational",
		exports: ["pdf", "docx"],
		origin: null,
		fields: FIELDS,
		data,
		page: { size: "letter", orientation: "portrait", margin: { top: 54, right: 54, bottom: 54, left: 54 } },
		body: { type: "doc", content },
		...extra,
	};
}
const issues = (value: unknown) => {
	const parsed = docDocument.safeParse(value);
	return parsed.success ? [] : parsed.error.issues.map((i) => i.message);
};

test("T-20 criterion 1: the format accepts a valid condition in the body, a column and a box", () => {
	const valid = doc([
		cond({ field: "pastor", test: "has-value" }),
		cond({ field: "not_shown", test: "more-than", value: 0 }),
		cond({ field: "attendees", test: "more-than", value: 3 }),
		cond({ field: "meeting_date", test: "is-empty" }, [text("a"), { type: "box", content: [text("b")] }]),
		{
			type: "columns",
			content: [{ type: "column", content: [cond({ field: "pastor", test: "is-empty" })] }, { type: "column" }],
		},
		{ type: "box", content: [cond({ field: "pastor", test: "has-value" })] },
	]);
	assert.deepEqual(issues(valid), []);
});

test("T-20 criterion 1: the format refuses each ill-formed or misplaced condition with its own message", () => {
	const valid = { field: "pastor", test: "has-value" } as const;
	const cases: [string, unknown, string][] = [
		[
			"an undeclared field",
			doc([cond({ field: "nobody", test: "has-value" })]),
			'body.content[0] (if): the condition reads the field "nobody", which is not declared in "fields"',
		],
		[
			"more-than on a text field",
			doc([cond({ field: "pastor", test: "more-than", value: 1 })]),
			'body.content[0] (if): a more-than condition compares a number or a list; "pastor" is a text field',
		],
		[
			"more-than on a date field",
			doc([cond({ field: "meeting_date", test: "more-than", value: 1 })]),
			'body.content[0] (if): a more-than condition compares a number or a list; "meeting_date" is a date field',
		],
		[
			"more-than with no value",
			doc([cond({ field: "shown", test: "more-than" })]),
			"body.content[0] (if): a more-than condition needs a value: a whole number from 0",
		],
		[
			"more-than with a negative value",
			doc([cond({ field: "shown", test: "more-than", value: -1 })]),
			"body.content[0] (if): the condition's value is -1; a more-than condition compares with a whole number from 0",
		],
		[
			"a value on another test",
			doc([cond({ field: "shown", test: "is-empty", value: 2 })]),
			'body.content[0] (if): only a more-than condition has a value; this condition tests "is-empty"',
		],
		["an empty condition", doc([cond(valid, [])]), "body.content[0] (if): conditional text holds at least one block"],
		[
			"a nested condition",
			doc([cond(valid, [cond(valid)])]),
			"body.content[0].content[0] (if): conditional text cannot hold another conditional text",
		],
		[
			"a nested condition in a box",
			doc([cond(valid, [{ type: "box", content: [cond(valid)] }])]),
			"body.content[0].content[0].content[0] (if): conditional text cannot hold another conditional text",
		],
		[
			"a budget table inside",
			doc([
				cond(valid, [
					{
						type: "table",
						attrs: { style: "ledger", columns: [{ id: "item", label: "Item", type: "text", width: 0 }] },
					},
				]),
			]),
			"body.content[0].content[0] (table): a budget table cannot sit inside conditional text; the Excel file prints no conditions",
		],
		[
			"a slot inside",
			doc([cond(valid, [{ type: "slot" }])]),
			"body.content[0].content[0] (slot): a section slot cannot sit inside conditional text",
		],
		[
			"in a quote",
			doc([{ type: "quote", content: [cond(valid) as never] }]),
			"body.content[0].content[0] (if): conditional text can sit only in the body, a column or a box, not in a quote",
		],
		[
			"in a list",
			doc([{ type: "bulletList", content: [{ type: "listItem", content: [cond(valid) as never] }] }]),
			"body.content[0].content[0].content[0] (if): conditional text can sit only in the body, a column or a box, not in a listItem",
		],
		[
			"in a slot",
			doc([{ type: "slot", content: [cond(valid) as never] }]),
			"body.content[0].content[0] (if): conditional text can sit only in the body, a column or a box, not in a slot",
		],
		[
			"in a table cell",
			doc([
				{
					type: "table",
					attrs: { columns: [{ id: "a", label: "A", type: "text", width: 0 }] },
					content: [{ type: "row", content: [{ type: "cell", content: [cond(valid) as never] }] }],
				},
			]),
			"(if): conditional text can sit only in the body, a column or a box, not in a cell",
		],
		[
			"in the header",
			doc(
				[],
				{},
				{
					page: {
						size: "letter",
						orientation: "portrait",
						margin: { top: 54, right: 54, bottom: 54, left: 54 },
						header: { pages: "all", content: [cond(valid)] },
					},
				},
			),
			"page.header.content[0] (if): conditional text cannot sit in the page header; it prints in the body only",
		],
		[
			"in the footer, in a column",
			doc(
				[],
				{},
				{
					page: {
						size: "letter",
						orientation: "portrait",
						margin: { top: 54, right: 54, bottom: 54, left: 54 },
						footer: {
							pages: "all",
							content: [{ type: "columns", content: [{ type: "column", content: [cond(valid)] }, { type: "column" }] }],
						},
					},
				},
			),
			"page.footer.content[0].content[0].content[0] (if): conditional text cannot sit in the page footer; it prints in the body only",
		],
		[
			"a page break inside, in a column",
			doc([
				{
					type: "columns",
					content: [{ type: "column", content: [cond(valid, [{ type: "pageBreak" }])] }, { type: "column" }],
				},
			]),
			"body.content[0].content[0].content[0].content[0] (pageBreak): a pageBreak node cannot sit inside this container",
		],
	];
	for (const [name, value, message] of cases) {
		const found = issues(value);
		assert.ok(
			found.some((m) => m.endsWith(message)),
			`${name}: expected "${message}", got ${JSON.stringify(found)}`,
		);
	}
});

test("T-20 criterion 1: a document with no condition keeps its stored form, and every template prints the same", async () => {
	for (const template of DOC_TEMPLATES) {
		const fork = await forkTemplate(template, { data: { church_name: "Harbor City Church" } });
		const before = structuredClone(fork);
		assert.equal(printedDoc(fork), fork, `${template.id}: no condition, the same object`);
		assert.deepEqual(fork, before, `${template.id}: nothing changed`);
	}
});

// Criterion 4: every case the editor labels, with the PDF of the same document.
const CASES: { name: string; condition: IfNode["attrs"]; data: Record<string, unknown>; prints: boolean }[] = [
	{
		name: "has-value, true",
		condition: { field: "pastor", test: "has-value" },
		data: { pastor: "Ana Ruiz" },
		prints: true,
	},
	{
		name: "has-value, false (no value: the bracketed label)",
		condition: { field: "pastor", test: "has-value" },
		data: {},
		prints: false,
	},
	{
		name: "has-value, false (a frozen empty value)",
		condition: { field: "pastor", test: "has-value" },
		data: { pastor: "" },
		prints: false,
	},
	{ name: "is-empty, true", condition: { field: "meeting_date", test: "is-empty" }, data: {}, prints: true },
	{
		name: "is-empty, false",
		condition: { field: "meeting_date", test: "is-empty" },
		data: { meeting_date: "Nov 9, 2026" },
		prints: false,
	},
	{
		name: "has-value on a list, true",
		condition: { field: "attendees", test: "has-value" },
		data: { attendees: [{ name: "A" }] },
		prints: true,
	},
	{
		name: "is-empty on a list, true",
		condition: { field: "attendees", test: "is-empty" },
		data: { attendees: [] },
		prints: true,
	},
	{
		name: "number above",
		condition: { field: "not_shown", test: "more-than", value: 5 },
		data: { not_shown: 6 },
		prints: true,
	},
	{
		name: "number at",
		condition: { field: "not_shown", test: "more-than", value: 5 },
		data: { not_shown: 5 },
		prints: false,
	},
	{
		name: "number below",
		condition: { field: "not_shown", test: "more-than", value: 5 },
		data: { not_shown: 4 },
		prints: false,
	},
	{
		name: "number with no value",
		condition: { field: "not_shown", test: "more-than", value: 0 },
		data: {},
		prints: false,
	},
	{
		name: "list above",
		condition: { field: "attendees", test: "more-than", value: 2 },
		data: { attendees: [{}, {}, {}] },
		prints: true,
	},
	{
		name: "list at",
		condition: { field: "attendees", test: "more-than", value: 2 },
		data: { attendees: [{}, {}] },
		prints: false,
	},
	{
		name: "list below",
		condition: { field: "attendees", test: "more-than", value: 2 },
		data: { attendees: [{}] },
		prints: false,
	},
];

test("T-20 criterion 4: the editor's prints-now state matches the PDF in every case", async () => {
	for (const c of CASES) {
		const d = doc([text("BEFORE"), cond(c.condition), text("AFTER")], c.data);
		assert.deepEqual(issues(d), [], c.name);
		assert.equal(conditionHolds(d, c.condition), c.prints, `${c.name}: the editor's state`);
		const printed = await pdfText(d);
		assert.equal(printed.includes("CONDITIONAL LINE"), c.prints, `${c.name}: the PDF agrees with the editor`);
		assert.match(printed, /BEFORE AFTER|BEFORE CONDITIONAL LINE AFTER/, c.name);
	}
	assert.equal(
		conditionLabel(FIELDS, { field: "not_shown", test: "more-than", value: 0 }),
		"Prints only when Attendees not shown is more than 0",
	);
	assert.equal(conditionLabel(FIELDS, { field: "pastor", test: "has-value" }), "Prints only when Pastor has a value");
	assert.equal(
		conditionLabel(FIELDS, { field: "meeting_date", test: "is-empty" }),
		"Prints only when Meeting date is empty",
	);
});

/** Enough text to fill most of a page, so a left-out block moves the page break. */
const filler = Array.from({ length: 24 }, (_, i) => text(`Filler line ${i + 1} of the document body.`));

test("T-20 criteria 6 and 7: a false condition prints exactly as the document without it, page breaks included", async () => {
	const tall = Array.from({ length: 8 }, (_, i) => text(`Conditional line ${i + 1}`));
	const rest = [{ type: "pageBreak" } as BlockNode, text("Last page")];
	const without = doc([...filler, text("Next block"), ...rest]);
	const falseIf = doc([...filler, cond({ field: "pastor", test: "has-value" }, tall), text("Next block"), ...rest]);
	assert.deepEqual(issues(falseIf), []);
	assert.equal(sha(await pdf(falseIf)), sha(await pdf(without)), "the PDF bytes equal the document without the block");
	assert.equal(
		sha(await docx(falseIf)),
		sha(await docx(without)),
		"the Word bytes equal the document without the block",
	);
	assert.equal((await pdfPages(await pdf(falseIf))).length, 2);

	// True: the blocks print in place, as if they sat in the body. The extra lines push the page break: one page more.
	const trueIf = doc([...filler, cond({ field: "pastor", test: "has-value" }, tall), text("Next block"), ...rest], {
		pastor: "Ana",
	});
	const inline = doc([...filler, ...tall, text("Next block"), ...rest], { pastor: "Ana" });
	assert.equal(sha(await pdf(trueIf)), sha(await pdf(inline)), "a true condition prints its blocks in place");
	assert.equal(sha(await docx(trueIf)), sha(await docx(inline)));
	assert.equal((await pdfPages(await pdf(trueIf))).length, 3, "the page count follows the printed blocks");

	// In a column and in a box too; and the Word file has no empty paragraph where the block was.
	// Both conditions are false: the pastor has a value.
	const nested = doc(
		[
			{
				type: "columns",
				content: [
					{ type: "column", content: [text("Left"), cond({ field: "pastor", test: "is-empty" })] },
					{ type: "column", content: [text("Right")] },
				],
			},
			{ type: "box", content: [text("Boxed"), cond({ field: "pastor", test: "is-empty" }, [text("Boxed note")])] },
		],
		{ pastor: "Ana" },
	);
	const plain = doc(
		[
			{
				type: "columns",
				content: [
					{ type: "column", content: [text("Left")] },
					{ type: "column", content: [text("Right")] },
				],
			},
			{ type: "box", content: [text("Boxed")] },
		],
		{ pastor: "Ana" },
	);
	assert.equal(sha(await pdf(nested)), sha(await pdf(plain)));
	const xml = await wordBody(nested);
	assert.equal(xml, await wordBody(plain));
	assert.ok(!wordText(xml).includes("Boxed note") && !wordText(xml).includes("CONDITIONAL LINE"));
});

test("T-20 criterion 6: tiled card sheets follow the same rule", async () => {
	const page = {
		size: "letter" as const,
		orientation: "portrait" as const,
		margin: { top: 18, right: 18, bottom: 18, left: 18 },
		tile: { across: 2, down: 2, padding: 12, cutMarks: true },
	};
	const withIf = doc([text("Card"), cond({ field: "pastor", test: "has-value" }, [text("Pastor line")])], {}, { page });
	const without = doc([text("Card")], {}, { page });
	assert.equal(sha(await pdf(withIf)), sha(await pdf(without)));
	const shown = doc(
		[text("Card"), cond({ field: "pastor", test: "has-value" }, [text("Pastor line")])],
		{ pastor: "Ana" },
		{ page },
	);
	const printed = (await pdfPages(await pdf(shown))).join(" ");
	assert.equal(printed.split("Pastor line").length - 1, 4, "each of the four cards prints the line");
});

// Criterion 8: the agenda's attendee overflow note, from format nodes only. The agenda template does not change.
const NOTE = "This list shows the first 150 people. 1 more are not shown.";
function agenda(people: number) {
	const cap = 150;
	const noteBlock: IfNode = {
		type: "if",
		attrs: { field: "not_shown", test: "more-than", value: 0 },
		content: [
			{
				type: "paragraph",
				attrs: { style: "small" },
				content: [
					{ type: "text", text: "This list shows the first " },
					{ type: "field", attrs: { key: "shown" } },
					{ type: "text", text: " people. " },
					{ type: "field", attrs: { key: "not_shown" } },
					{ type: "text", text: " more are not shown." },
				],
			},
		],
	};
	const body = (note: boolean): BlockNode[] => [
		{ type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "Attendees" }] },
		text("The people on the guest list."),
		...(note ? [noteBlock] : []),
		{ type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "Follow-up actions" }] },
	];
	const data = { shown: Math.min(people, cap), not_shown: Math.max(people - cap, 0) };
	return { withNote: doc(body(true), data), without: doc(body(false), data) };
}

test("T-20 criterion 8: the agenda overflow note prints with 151 people on a 150 cap, and not with 150", async () => {
	const over = agenda(151).withNote;
	assert.deepEqual(issues(over), []);
	assert.ok((await pdfText(over)).includes(NOTE), "the PDF prints the note");
	assert.ok(wordText(await wordBody(over)).includes(NOTE), "the Word file prints the note");

	const at = agenda(150);
	const printed = await pdfText(at.withNote);
	assert.ok(!printed.includes("This list shows"), "no note in the PDF");
	assert.equal(
		sha(await pdf(at.withNote)),
		sha(await pdf(at.without)),
		"no blank: the PDF equals the agenda with no note",
	);
	const xml = await wordBody(at.withNote);
	assert.ok(!wordText(xml).includes("This list shows"), "no note in the Word file");
	assert.equal(xml, await wordBody(at.without), "no empty paragraph left in the Word file");
	assert.ok(docTemplateById("guest-sign-in-sheet"), "the templates load as they were");
});
