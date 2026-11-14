// WP-036 criteria 2, 5 and 6: the built-in template files and the one generic Forme renderer for everyfield.doc/1.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import test from "node:test";
import {
	decodePDFRawStream,
	PDFArray,
	PDFDocument,
	PDFName,
	PDFRawStream,
} from "../../../packages/domain/node_modules/pdf-lib/cjs/index.js";
import {
	docDocument,
	forkTemplate,
	type BlockNode,
	type DocDocument,
	type DocTemplate,
} from "../../../packages/contracts/src/documents/format/index.ts";
import {
	DOC_TEMPLATES,
	docTemplateById,
	loadTemplate,
	sheetOf,
} from "../../../packages/domain/src/documents/doc-templates.ts";
import { renderDocFile, renderDocPdf } from "../../../packages/domain/src/documents/doc-render.ts";
import { library, templateView } from "../../../packages/domain/src/documents/catalog.ts";
import { SLOT_BLANK_NOTE, fieldValues, frozenData } from "../../../packages/domain/src/documents/doc-values.ts";
import { libraryDoc, renderPreview, renderTemplatePdf } from "../../../packages/domain/src/documents/library-render.ts";
import { resolveMerge } from "../../../packages/domain/src/documents/merge.ts";
import { fillStatementSlots } from "../../../packages/domain/src/documents/network-statement.ts";
import { NEUTRAL_THEME } from "../../../packages/domain/src/documents/theme.ts";
import { buildLedgerWorkbook } from "../../../packages/domain/src/documents/xlsx.ts";
import { docxParts, pdfPages, wordText } from "./fixtures/readers.mts";

const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const folder = new URL("../../../packages/domain/src/documents/templates/", import.meta.url);
const DATA = {
	church_name: "Harbor City Church",
	church_legal_name: "Harbor City Church, Inc.",
	church_tagline: "A new church plant. You are welcome here.",
	contact_line: "harborcity.church  ·  (555) 010-0199",
};
const fork = async (id: string) => forkTemplate(docTemplateById(id)!, { data: DATA });
const THEME = {
	render: NEUTRAL_THEME,
	fonts: { heading: "DM Serif Display", body: "DM Sans" },
	kind: "everyfield-neutral" as const,
	primary: null,
};
const SAVED = new Date("2026-11-01T12:00:00Z");
const count = (text: string, part: string) => text.split(part).length - 1;
const range = (n: number) => Array.from({ length: n }, (_, i) => i + 1);

test("AC:CASE-DOC-022 the eleven template files load through the contract parser and a file that does not validate fails", () => {
	const files = readdirSync(folder)
		.filter((name) => name.endsWith(".json"))
		.sort();
	assert.deepEqual(files, [
		"budget-worksheet.json",
		"bylaws.json",
		"child-protection-policy.json",
		"commitment-card.json",
		"conflict-of-interest-policy.json",
		"financial-controls-policy.json",
		"follow-up-letter.json",
		"guest-sign-in-sheet.json",
		"launch-team-commitment.json",
		"member-expectations.json",
		"prayer-letter.json",
	]);
	assert.deepEqual(
		DOC_TEMPLATES.map((t) => t.id),
		files.map((name) => name.replace(/\.json$/, "")),
	);
	for (const name of files) {
		const raw = JSON.parse(readFileSync(new URL(name, folder), "utf8"));
		const id = name.replace(/\.json$/, "");
		assert.deepEqual(loadTemplate(id, raw), raw);
	}
	const broken = JSON.parse(readFileSync(new URL("guest-sign-in-sheet.json", folder), "utf8"));
	broken.body.content.at(-1).content = [{ type: "row", content: [{ type: "cell" }] }];
	assert.throws(
		() => loadTemplate("guest-sign-in-sheet", broken),
		/templates\/guest-sign-in-sheet\.json does not validate:\n.*the row has 1 cell but the table has 5 columns/,
	);
	assert.throws(
		() => loadTemplate("guest-sign-in-sheet", { ...broken, kind: "document", origin: null }),
		/does not validate/,
	);
	const renamed = JSON.parse(readFileSync(new URL("budget-worksheet.json", folder), "utf8"));
	assert.throws(() => loadTemplate("first-year-budget", renamed), /holds the template "budget-worksheet"/);
});

test("AC:CASE-DOC-023 the conflict-of-interest policy prints its text, numbered headings, footer and adoption fields", async () => {
	const pdf = await renderDocPdf(await fork("conflict-of-interest-policy"));
	assert.equal(pdf.pages, 2);
	const pages = await pdfPages(pdf.bytes);
	assert.match(
		pages[0]!,
		/^Harbor City Church BOARD POLICY Conflict of Interest Policy This policy says how the board of Harbor City Church, a church plant/,
	);
	assert.match(pages[0]!, /01 Purpose .* 02 Who this policy covers/);
	assert.match(pages[1]!, /09 If a member breaks this policy/);
	assert.match(pages[1]!, /BOARD MEMBER ROLE SIGNATURE DATE/);
	for (const [i, page] of pages.entries()) {
		assert.ok(page.includes("Harbor City Church, Inc. | Conflict of Interest Policy"), `page ${i + 1} footer`);
		assert.ok(page.includes(`Page ${i + 1} of 2`), `page ${i + 1} number`);
		assert.equal(count(page, "Template, not legal advice"), 1, `page ${i + 1} notice`);
	}
	assert.deepEqual(
		pdf.fields.map((f) => f.name),
		range(3).flatMap((n) => [`row_${n}_member`, `row_${n}_role`, `row_${n}_signature`, `row_${n}_date`]),
	);
	assert.deepEqual(
		pdf.fields.filter((f) => f.type === "Sig").map((f) => f.name),
		["row_1_signature", "row_2_signature", "row_3_signature"],
	);
	const again = await renderDocPdf(await fork("conflict-of-interest-policy"));
	assert.equal(sha(again.bytes), sha(pdf.bytes), "a second render gives the same bytes");
});

// T-325: the Child Protection and Financial Controls policies are formal/legal templates like the conflict-of-interest
// policy. Each forks with the church's details filled in and renders to PDF and Word, with the notice on every page.
for (const [id, title, firstHeading, lastHeading] of [
	["child-protection-policy", "Child Protection Policy", "01 Purpose", "09 Records"],
	["financial-controls-policy", "Financial Controls Policy", "01 Purpose", "09 Yearly review"],
] as const)
	test(`the ${title.toLowerCase()} renders to PDF and Word with the church filled in and the notice on every page`, async () => {
		const template = docTemplateById(id)!;
		assert.equal(template.class, "formal/legal");
		assert.deepEqual(template.exports, ["pdf", "docx"]);
		const doc = await fork(id);
		const pdf = await renderDocPdf(doc);
		const pages = await pdfPages(pdf.bytes);
		assert.match(pages[0]!, new RegExp(`${title} This policy says how Harbor City Church, a church plant`));
		const text = pages.join("\n");
		assert.ok(text.includes(firstHeading) && text.includes(lastHeading), "numbered headings");
		assert.ok(!text.includes("{church_name}"), "every church name is filled in");
		for (const [i, page] of pages.entries()) {
			assert.ok(page.includes(`| ${title}`), `page ${i + 1} footer`);
			assert.equal(count(page, "Template, not legal advice"), 1, `page ${i + 1} notice`);
		}
		const word = await renderDocFile(doc, "docx", THEME, SAVED);
		const words = Object.values(docxParts(word)).map(wordText).join(" ");
		assert.ok(words.includes("Harbor City Church, a church plant"), "the Word file holds the filled-in text");
		assert.ok(words.includes("Template, not legal advice"), "the Word file holds the notice");
	});

// T-205: the eight library templates with a template file. The library renders each from that file alone.
const TWINNED = [
	"commitment-card",
	"guest-sign-in-sheet",
	"member-expectations",
	"launch-team-commitment",
	"follow-up-letter",
	"bylaws",
	"prayer-letter",
	"budget-worksheet",
];
const STATEMENT = "We believe what our sending network wrote.\n\nA second paragraph.";
const resolvedFor = async (id: string, pastor: string | null) => {
	const template = (await library()).templates.find((t) => t.id === id)!;
	const resolved = resolveMerge(
		template,
		{ churchName: "Harbor City Church", pastorName: pastor, launchDate: null },
		{},
	);
	assert.ok(resolved.ok);
	return { template, resolved };
};

test("the library preview of each twinned template is the everyfield.doc/1 render of its file", async () => {
	for (const id of TWINNED) {
		const { template, resolved } = await resolvedFor(id, "Pastor Ada");
		const format = template.formats[0]!;
		assert.deepEqual(template.formats, [docTemplateById(id)!.exports[0]], id);
		const preview = await renderPreview(template, format, resolved, NEUTRAL_THEME, undefined, STATEMENT);
		const doc = await libraryDoc(
			docTemplateById(id)!,
			{ church_name: "Harbor City Church", pastor_name: "Pastor Ada" },
			NEUTRAL_THEME,
			STATEMENT,
		);
		const own =
			format === "pdf"
				? (await renderDocPdf(doc)).bytes
				: Buffer.from(buildLedgerWorkbook(doc, fieldValues(doc), NEUTRAL_THEME));
		assert.equal(sha(preview!), sha(own), id);
		// The merge values fill the file's own fields; the brand fields fall back as the file says.
		assert.equal(fieldValues(doc).church_name, "Harbor City Church", id);
		if (doc.fields.some((f) => f.key === "pastor_name")) assert.equal(fieldValues(doc).pastor_name, "Pastor Ada", id);
		if (doc.fields.some((f) => f.key === "church_legal_name"))
			assert.equal(fieldValues(doc).church_legal_name, "Harbor City Church", id);
	}
	const bylaws = await renderTemplatePdf(
		{ id: "bylaws" },
		{ church_name: "Harbor City Church" },
		NEUTRAL_THEME,
		undefined,
		STATEMENT,
	);
	const text = (await pdfPages(bylaws.bytes)).join(" ");
	assert.ok(text.includes("We believe what our sending network wrote."), "the network statement fills the slot");
	assert.equal(text.includes(SLOT_BLANK_NOTE), false);
});

/** The text of each heading in a body, merge fields left out. */
const headingTexts = (nodes: readonly BlockNode[] | undefined): string[] =>
	(nodes ?? []).flatMap((node): string[] => {
		if (node.type === "heading") {
			const text = (node.content ?? [])
				.map((n) => (n.type === "text" ? n.text : ""))
				.join("")
				.trim();
			return text ? [text] : [];
		}
		if (node.type === "columns") return node.content.flatMap((column) => headingTexts(column.content));
		if (node.type === "box") return headingTexts(node.content);
		return [];
	});

test("the library facts of each twinned template are read from its file", async () => {
	const { templates } = await library();
	for (const id of TWINNED) {
		const file = docTemplateById(id)!;
		const template = templates.find((t) => t.id === id)!;
		const view = templateView(template);
		const pdf = file.exports[0] === "pdf" ? await renderDocPdf(file) : null;
		assert.equal(view.documentClass, file.class, id);
		assert.deepEqual(
			view.pageSize,
			pdf ? { width: sheetOf(file.page).width, height: sheetOf(file.page).height } : null,
			id,
		);
		assert.equal(view.pageCount, pdf ? pdf.pages : 1, id);
		assert.deepEqual(view.outline, headingTexts(file.body.content), id);
		assert.equal(view.fillable, (pdf?.fields.length ?? 0) > 0, id);
		assert.deepEqual(
			template.facts.fields,
			(pdf?.fields ?? []).map((f) => f.name),
			id,
		);
		if (id === "bylaws" || id === "prayer-letter") {
			assert.equal(view.name, file.title, id);
			assert.equal(view.description, file.description, id);
			assert.equal(view.category, "administrative", id);
			assert.deepEqual(
				view.mergeFields.map((f) => [f.key, f.required, f.autoFill]),
				// Bylaws never print the pastor's name, so they offer no input for it.
				id === "bylaws"
					? [["church_name", true, "church_name"]]
					: [
							["church_name", true, "church_name"],
							["pastor_name", false, "pastor_name"],
						],
				id,
			);
		}
	}
});

test("every merge field the library offers for a twinned template prints its value", async () => {
	// A template file prints only the merge values it declares, so the library offers no input that a render drops.
	const { templates } = await library();
	for (const id of TWINNED.filter((id) => docTemplateById(id)!.exports[0] === "pdf")) {
		const view = templateView(templates.find((t) => t.id === id)!);
		const values = Object.fromEntries(view.mergeFields.map((f) => [f.key, `Marker ${f.key.replace(/_/g, " ")}`]));
		const text = (await renderTemplatePdf({ id }, values)).text.flat().join("\n");
		for (const [key, value] of Object.entries(values)) assert.ok(text.includes(value), `${id} drops ${key}`);
	}
	const keys = (id: string) => templateView(templates.find((t) => t.id === id)!).mergeFields.map((f) => f.key);
	// Main offered these, and the template files print none of them.
	assert.deepEqual(keys("commitment-card"), ["church_name"]);
	assert.deepEqual(keys("guest-sign-in-sheet"), ["church_name"]);
	assert.deepEqual(keys("member-expectations"), ["church_name"]);
	assert.deepEqual(keys("follow-up-letter"), ["church_name", "pastor_name"]);
});

test("AC:CASE-DOC-022 an unedited Church Document prints the same pages as its template's library preview", async () => {
	// One renderer: "Save for your church" and "Create Church Document" both render the template file. The document is
	// made as documents.createFromTemplate makes it: the church's values frozen, the network's statement in its slot.
	for (const id of TWINNED.filter((id) => docTemplateById(id)!.exports[0] === "pdf"))
		for (const pastor of ["Pastor Ada", null]) {
			const values: Record<string, string> = {
				church_name: "Harbor City Church",
				...(pastor ? { pastor_name: pastor } : {}),
			};
			const preview = await renderTemplatePdf({ id }, values, NEUTRAL_THEME, undefined, STATEMENT);
			const template = docTemplateById(id)!;
			const { data } = frozenData(template.fields, {
				churchName: "Harbor City Church",
				pastorName: pastor,
				tagline: null,
				legalName: null,
				contactLine: null,
				meetingDate: null,
			});
			const created = fillStatementSlots(await forkTemplate(template, { id: "doc-church-1", data }), STATEMENT);
			const doc = await renderDocPdf(created);
			assert.equal(doc.pages, preview.pages, id);
			assert.deepEqual(doc.text, preview.text, id);
			assert.deepEqual(doc.fields, preview.fields, id);
			assert.ok(doc.text.flat().join(" ").includes("Harbor City Church"), id);
		}
});

test("AC:CASE-DOC-004 the card sheet prints four cards on one Letter page with suffixed field names and cut marks", async () => {
	const pdf = await renderDocPdf(await fork("commitment-card"));
	assert.equal(pdf.pages, 1);
	const [page] = await pdfPages(pdf.bytes);
	for (const words of [
		"My commitment",
		"CORE GROUP",
		"GROW",
		"PRAY",
		"GIVE",
		"harborcity.church",
		"A new church plant.",
	])
		assert.equal(count(page!, words), 4, words);
	const perCard = ["row_1_done", "row_2_done", "row_3_done", "full_name", "contact", "signature", "signed_date"];
	assert.deepEqual(
		pdf.fields.map((f) => f.name),
		range(4).flatMap((t) => perCard.map((field) => `${field}_t${t}`)),
	);
	// documents/doc-10: each card's signature is a /Sig field, and a suffixed field has its unsuffixed tooltip.
	const typed = new Map(pdf.fields.map((f) => [f.name, f]));
	assert.deepEqual(
		pdf.fields.filter((f) => f.type === "Sig").map((f) => `${f.name}:${f.type}`),
		range(4).map((t) => `signature_t${t}:Sig`),
	);
	assert.equal(typed.get("signature_t1")!.tooltip, "Signature: sign here");
	assert.equal(typed.get("full_name_t2")!.tooltip, "Full name");
	assert.equal(typed.get("row_1_done_t3")!.tooltip, "Row 1: done");
	const doc = await PDFDocument.load(pdf.bytes);
	const size = doc.getPage(0).getSize();
	assert.deepEqual([size.width, size.height], [612, 792]);
	// The cards sit in four 306 x 396 pt quarters: each card title is in its own quarter.
	const words = pdf.text[0]!.filter((line) => line === "My commitment");
	assert.equal(words.length, 4);
	const again = await renderDocPdf(await fork("commitment-card"));
	assert.equal(sha(again.bytes), sha(pdf.bytes));
});

type Rect = { x0: number; y0: number; x1: number; y1: number };

/** The drawing operator lines of a PDF's first page. */
async function pageOps(bytes: Uint8Array) {
	const doc = await PDFDocument.load(bytes);
	const contents = doc.getPage(0).node.Contents()!;
	const streams = contents instanceof PDFArray ? contents.asArray().map((s) => doc.context.lookup(s)) : [contents];
	const ops = streams
		.map((s) => Buffer.from(decodePDFRawStream(s as PDFRawStream).decode()).toString("latin1"))
		.join("\n")
		.split("\n");
	return { doc, ops };
}

/**
 * Every rectangle a PDF page strokes, with the line width it is stroked at and the clip it is drawn under. Reads the
 * page's own drawing operators, so it sees the drawn border rather than the form widget over it. The page draws its
 * boxes as `x y w h re` then `S` (stroke) or `B` (fill and stroke), clips as `x y w h re W n`, and nests with `q`/`Q`.
 */
async function strokedRects(bytes: Uint8Array) {
	const { doc, ops } = await pageOps(bytes);
	type State = { clip: Rect; width: number };
	const page = doc.getPage(0).getSize();
	let state: State = { clip: { x0: 0, y0: 0, x1: page.width, y1: page.height }, width: 1 };
	const stack: State[] = [];
	// A bare `re` line whose paint operator comes on the next line, as the checkboxes draw.
	let pending: Rect | null = null;
	const out: (Rect & { width: number; clip: Rect })[] = [];
	const stroke = (rect: Rect) => out.push({ ...rect, width: state.width, clip: state.clip });
	for (const line of ops) {
		const tokens = line.trim().split(/\s+/);
		const op = tokens.at(-1);
		if (tokens[4] === "re") {
			const [x, y, w, h] = tokens.slice(0, 4).map(Number) as [number, number, number, number];
			const rect = { x0: Math.min(x, x + w), y0: Math.min(y, y + h), x1: Math.max(x, x + w), y1: Math.max(y, y + h) };
			pending = null;
			if (tokens[5] === "W") {
				const c = state.clip;
				state.clip = {
					x0: Math.max(c.x0, rect.x0),
					y0: Math.max(c.y0, rect.y0),
					x1: Math.min(c.x1, rect.x1),
					y1: Math.min(c.y1, rect.y1),
				};
			} else if (op === "S" || op === "B") stroke(rect);
			else if (op === "re") pending = rect;
			continue;
		}
		if (pending && tokens.length === 1 && (op === "S" || op === "B")) stroke(pending);
		pending = null;
		if (op === "q") stack.push({ ...state });
		else if (op === "Q") state = stack.pop()!;
		else if (op === "w" && tokens.length === 2) state.width = Number(tokens[0]);
	}
	return out;
}

test("AC:CASE-DOC-004 every box on the 4-per-sheet card sheet draws its whole border inside its own card", async () => {
	const pdf = await renderDocPdf(await fork("commitment-card"));
	const boxes = await strokedRects(pdf.bytes);
	const cards = [
		{ x0: 0, y0: 396, x1: 306, y1: 792 },
		{ x0: 306, y0: 396, x1: 612, y1: 792 },
		{ x0: 0, y0: 0, x1: 306, y1: 396 },
		{ x0: 306, y0: 0, x1: 612, y1: 396 },
	];
	const at = (n: number) => n.toFixed(2);
	const clipped: string[] = [];
	for (const [i, card] of cards.entries()) {
		const inCard = boxes.filter((b) => b.x0 >= card.x0 && b.x1 <= card.x1 && b.y0 >= card.y0 && b.y1 <= card.y1);
		// Name, Email or phone, Signature and Date, plus the three checkboxes (each drawn as an outer and inner square).
		const fields = inCard.filter((b) => b.y1 - b.y0 >= 17 && b.x1 - b.x0 >= 90);
		assert.equal(fields.length, 4, `card ${i + 1} draws its four field boxes`);
		// A row of boxes shares one height: Date is as tall as Signature beside it, Name as Email or phone.
		assert.ok(
			fields.some((b) => b.x1 - b.x0 === 90 && Math.round(b.y1 - b.y0) === 24),
			`card ${i + 1} draws its Date box at the Signature box's height`,
		);
		assert.deepEqual(
			[...new Set(fields.map((b) => Math.round(b.y1 - b.y0)))].sort(),
			[17, 24],
			`card ${i + 1}: each row of boxes has one height`,
		);
		assert.equal(inCard.length, 10, `card ${i + 1} draws 4 field boxes and 3 double-square checkboxes`);
		for (const b of inCard) {
			const half = b.width / 2;
			const box = `card ${i + 1} box x ${at(b.x0)} to ${at(b.x1)}, y ${at(b.y0)} (${b.width} pt border)`;
			assert.ok(b.clip.x0 >= card.x0 && b.clip.x1 <= card.x1, `${box} is clipped to its card`);
			if (b.x1 + half > b.clip.x1) clipped.push(`${box}: right border cut at ${at(b.clip.x1)}`);
			if (b.x0 - half < b.clip.x0) clipped.push(`${box}: left border cut at ${at(b.clip.x0)}`);
			if (b.y1 + half > b.clip.y1 || b.y0 - half < b.clip.y0) clipped.push(`${box}: top or bottom border cut`);
		}
	}
	assert.deepEqual(clipped, [], "no border is cut by its card's clip");
});

test("AC:CASE-DOC-004 each checkbox on the card sits level with its GROW, PRAY or GIVE tile, in the middle of a two-line row", async () => {
	const pdf = await renderDocPdf(await fork("commitment-card"));
	const rects = (await pageOps(pdf.bytes)).ops
		.map((line) => line.trim().split(/\s+/))
		.filter((t) => t[4] === "re")
		.map((t) => t.slice(0, 4).map(Number) as [number, number, number, number]);
	const middle = ([, y, , h]: [number, number, number, number]) => +(y + h / 2).toFixed(1);
	// The top-left card (y above 396): its three tag tiles (42 x 14) and the outer squares of its checkboxes (12 x 12).
	const top = (r: [number, number, number, number]) => r[0] < 306 && r[1] > 396;
	const tiles = rects.filter((r) => top(r) && r[2] === 42 && Math.abs(r[3]) === 14).map(middle);
	const boxes = rects.filter((r) => top(r) && r[2] === 12 && Math.abs(r[3]) === 12).map(middle);
	assert.equal(tiles.length, 3, "three tag tiles");
	assert.equal(boxes.length, 3, "three checkboxes");
	assert.deepEqual(
		boxes.map((y, i) => Math.abs(y - tiles[i]!) <= 0.5),
		[true, true, true],
		`checkbox middles ${boxes} match tile middles ${tiles}`,
	);
});

test("AC:CASE-DOC-004 each card closes with the return line, under the contact line when there is one and with no gap when there is none", async () => {
	// Maya, Nov 12 (T-205): the card names no title. With no planter-name field, the line is the hand-back form.
	const RETURN = "Please hand this card back to the person who gave it to you.";
	const [withContact] = await pdfPages((await renderDocPdf(await fork("commitment-card"))).bytes);
	assert.equal(count(withContact!, RETURN), 4, "one return line on each of the four cards");
	assert.equal(
		count(withContact!, `${DATA.contact_line.replace(/\s+/g, " ")} ${RETURN}`),
		4,
		"the return line follows the contact line",
	);
	assert.ok(!/pastor/i.test(withContact!), "no hard-coded title");

	// No contact line: the footer drops the empty line, so the card draws as if its footer had no contact line at all.
	const blank = { ...DATA, contact_line: "" };
	const card = docTemplateById("commitment-card")!;
	const bare = await renderDocPdf(await forkTemplate(card, { data: blank }));
	const [text] = await pdfPages(bare.bytes);
	assert.equal(count(text!, RETURN), 4);
	const without = structuredClone(card);
	without.page.footer!.content = without.page.footer!.content.filter(
		(n) => !(n.type === "paragraph" && n.content?.some((i) => i.type === "field")),
	);
	assert.equal(without.page.footer!.content.length, 2, "the rule and the return line");
	const reference = await renderDocPdf(await forkTemplate(without, { data: blank }));
	assert.deepEqual((await pageOps(bare.bytes)).ops, (await pageOps(reference.bytes)).ops);
});

test("AC:CASE-DOC-006 AC:CASE-DOC-013 the guest sign-in sheet prints 18 write-in rows and the budget prints its ledger with input boxes", async () => {
	const sign = await renderDocPdf(await fork("guest-sign-in-sheet"));
	assert.equal(sign.pages, 1);
	const [signText] = await pdfPages(sign.bytes);
	assert.match(signText!, /Guest Sign-in Sheet Welcome to Harbor City Church\. Please sign in/);
	assert.match(signText!, /# NAME EMAIL PHONE WHO INVITED YOU\?/);
	assert.ok(signText!.includes("Harbor City Church, Inc. | Guest sign-in sheet"));
	assert.ok(!signText!.includes("Template, not legal advice"), "an operational document has no legal notice");
	assert.deepEqual(
		sign.fields.map((f) => f.name),
		[
			"meeting_date",
			"meeting_number",
			...range(18).flatMap((n) => [`row_${n}_name`, `row_${n}_email`, `row_${n}_phone`, `row_${n}_invited_by`]),
		],
	);

	const budget = await renderDocPdf(await fork("budget-worksheet"));
	assert.equal(budget.pages, 1);
	const [budgetText] = await pdfPages(budget.bytes);
	assert.match(budgetText!, /Harbor City Church Budget Worksheet/);
	assert.match(budgetText!, /Income Tithes and offerings .* Total income Expenses Pastor and staff pay/);
	assert.match(budgetText!, /Net \(income minus expenses\)/);
	assert.doesNotMatch(budgetText!, /\$0/, "a blank worksheet prints no computed zeros");
	assert.deepEqual(
		budget.fields.map((f) => f.name),
		range(15).map((n) => `row_${n}_monthly`),
	);
});

test("AC:CASE-DOC-013 typed values print computed formula, subtotal and total cells", async () => {
	const doc = await fork("budget-worksheet");
	const table = doc.body.content!.find((b) => b.type === "table")!;
	assert.equal(table.type, "table");
	if (table.type !== "table") return;
	const set = (label: string, value: number) => {
		const row = table.content!.find(
			(r) =>
				r.content[0]!.content?.[0]?.type === "text" && (r.content[0]!.content[0] as { text: string }).text === label,
		)!;
		row.content[1] = { type: "cell", attrs: { value } };
	};
	set("Tithes and offerings", 4000);
	set("Grants", 1000);
	set("Rent or facility", 1500);
	assert.equal(docDocument.safeParse(doc).success, true);
	const [text] = await pdfPages((await renderDocPdf(doc)).bytes);
	assert.match(text!, /Tithes and offerings \$4,000 \$48,000/);
	assert.match(text!, /Total income \$5,000 \$60,000/);
	assert.match(text!, /Total expenses \$1,500 \$18,000/);
	assert.match(text!, /Net \(income minus expenses\) \$3,500 \$42,000/);
});

/** One document that holds every node and mark of the design.md node table, and every page setup part. */
function everyNode(): DocDocument {
	const t = (text: string, marks?: DocDocument["body"]["content"] extends unknown ? any[] : never) =>
		marks ? { type: "text" as const, text, marks } : { type: "text" as const, text };
	const p = (style: string, ...content: any[]) => ({ type: "paragraph", attrs: { style }, content });
	const doc: any = {
		format: "everyfield.doc/1",
		kind: "document",
		id: "every-node",
		version: 1,
		title: "Every node",
		class: "outward-facing",
		exports: ["pdf", "docx", "xlsx"],
		origin: null,
		fields: [
			{ key: "church_name", label: "Church name", type: "text", source: "church.name", required: true },
			{ key: "pastor_name", label: "Pastor name", type: "text", source: "church.pastor" },
		],
		data: { church_name: "Harbor City Church", pastor_name: "Dana Brooks" },
		page: {
			size: "a4",
			orientation: "landscape",
			margin: { top: 36, right: 48, bottom: 48, left: 48 },
			tile: null,
			header: { pages: "all", content: [p("small", t("Running header"))] },
			footer: { pages: "all", content: [p("small", t("Footer "), { type: "pageNumber", attrs: { format: "page" } })] },
		},
		body: {
			type: "doc",
			content: [
				{ type: "image", attrs: { source: "logo", width: 150, height: 34 } },
				{
					type: "heading",
					attrs: { level: 1 },
					content: [t("Title of "), { type: "field", attrs: { key: "church_name" } }],
				},
				p("kicker", t("Kicker words")),
				p("lead", t("A lead paragraph.")),
				p(
					"body",
					t("Bold", [{ type: "bold" }]),
					t(" and "),
					t("italic", [{ type: "italic" }]),
					t(" and "),
					t("underline", [{ type: "underline" }]),
					t(" and "),
					t("a link", [{ type: "link", attrs: { href: "https://everyfield.app" } }]),
					{ type: "hardBreak" },
					t("after a break."),
				),
				p("small", t("A small paragraph signed by "), { type: "field", attrs: { key: "pastor_name" } }),
				{ type: "heading", attrs: { level: 2, numbered: true }, content: [t("First numbered")] },
				{ type: "heading", attrs: { level: 3, numbered: true }, content: [t("Numbered sub")] },
				{ type: "heading", attrs: { level: 2 }, content: [t("Plain heading")] },
				{ type: "bulletList", content: [{ type: "listItem", content: [p("body", t("Bullet one"))] }] },
				{
					type: "orderedList",
					content: [
						{ type: "listItem", content: [p("body", t("Step one"))] },
						{ type: "listItem", content: [p("body", t("Step two"))] },
					],
				},
				{ type: "quote", content: [p("body", t("A quoted line."))] },
				{ type: "divider", attrs: { weight: "hairline", color: "border" } },
				{ type: "divider", attrs: { weight: "bar", color: "accent" } },
				{ type: "spacer", attrs: { size: 24 } },
				{
					type: "columns",
					attrs: { gap: 12, valign: "top" },
					content: [
						{
							type: "column",
							attrs: { width: 2 },
							content: [{ type: "writeIn", attrs: { label: "Full name", key: "full_name", kind: "text", width: 0 } }],
						},
						{
							type: "column",
							attrs: { width: 1 },
							content: [
								{ type: "writeIn", attrs: { label: "Signed", key: "member_signature", kind: "signature", width: 0 } },
							],
						},
						{
							type: "column",
							attrs: { width: 1 },
							content: [{ type: "writeIn", attrs: { label: "Date", key: "signed_on", kind: "date", width: 0 } }],
						},
					],
				},
				{
					type: "box",
					attrs: { fill: "primary", border: "none", padding: 12 },
					content: [p("body", t("GROW", [{ type: "tag" }]), t(" Words on the primary fill."))],
				},
				{ type: "pageBreak" },
				{ type: "slot", attrs: { label: "Statement of faith" }, content: [] },
				{ type: "slot", attrs: { label: "Mission" }, content: [p("body", t("Our own mission words."))] },
				{
					type: "table",
					attrs: {
						style: "ledger",
						zebra: true,
						headerFill: "accent",
						sheet: "Plan",
						columns: [
							{ id: "n", label: "#", type: "index", width: 30 },
							{ id: "item", label: "Item", type: "text", width: 0 },
							{ id: "done", label: "Done", type: "check", width: 40 },
							{ id: "qty", label: "Qty", type: "number", width: 60 },
							{ id: "cost", label: "Cost", type: "money", width: 80 },
							{ id: "total", label: "Line total", type: "formula", formula: "qty * cost", format: "money", width: 90 },
						],
					},
					content: [
						{
							type: "row",
							attrs: { role: "group", sign: "add" },
							content: [
								{ type: "cell" },
								{ type: "cell", content: [t("Supplies")] },
								{ type: "cell" },
								{ type: "cell" },
								{ type: "cell" },
								{ type: "cell" },
							],
						},
						{
							type: "row",
							content: [
								{ type: "cell" },
								{ type: "cell", content: [t("Chairs")] },
								{ type: "cell" },
								{ type: "cell", attrs: { value: 3 } },
								{ type: "cell", attrs: { value: 400 } },
								{ type: "cell" },
							],
						},
						{
							type: "row",
							content: [
								{ type: "cell" },
								{ type: "cell", content: [t("Lights")] },
								{ type: "cell" },
								{ type: "cell", attrs: { value: 2 } },
								{ type: "cell", attrs: { value: 250.5 } },
								{ type: "cell" },
							],
						},
						{
							type: "row",
							attrs: { role: "subtotal" },
							content: [
								{ type: "cell" },
								{ type: "cell", content: [t("Supplies total")] },
								{ type: "cell" },
								{ type: "cell" },
								{ type: "cell" },
								{ type: "cell" },
							],
						},
						{
							type: "row",
							attrs: { role: "total" },
							content: [
								{ type: "cell" },
								{ type: "cell", content: [t("Grand total")] },
								{ type: "cell" },
								{ type: "cell" },
								{ type: "cell" },
								{ type: "cell" },
							],
						},
					],
				},
			],
		},
	};
	return docDocument.parse(doc);
}

test("AC:CASE-DOC-023 every node, mark and page setup part of the design node table prints", async () => {
	const doc = everyNode();
	const pdf = await renderDocPdf(doc);
	const pages = await pdfPages(pdf.bytes);
	// A4 landscape is short: the kept-together box moves to page 2, and the page break starts page 3.
	assert.equal(pdf.pages, 3, JSON.stringify(pages));
	assert.ok(pages[1]!.includes("Words on the primary fill.") && !pages[1]!.includes("STATEMENT OF FAITH"));
	assert.ok(pages[2]!.startsWith("Running header STATEMENT OF FAITH"), "the page break starts a new page");
	const all = pages.join(" ");
	for (const words of [
		"Title of Harbor City Church",
		"KICKER WORDS",
		"A lead paragraph.",
		"Bold and italic and underline and a link",
		"after a break.",
		"A small paragraph signed by Dana Brooks",
		"01 First numbered",
		"1.1 Numbered sub",
		"Plain heading",
		"Bullet one",
		"1. Step one 2. Step two",
		"A quoted line.",
		"FULL NAME",
		"GROW",
		"Words on the primary fill.",
		"STATEMENT OF FAITH",
		SLOT_BLANK_NOTE,
		"MISSION Our own mission words.",
		"Supplies 1 Chairs 3 $400 $1,200 2 Lights 2 $250.50 $501",
		"Supplies total 5 $650.50 $1,701",
		"Grand total 5 $650.50 $1,701",
	])
		assert.ok(all.includes(words), `prints "${words}"`);
	for (const [i, page] of pages.entries()) {
		assert.ok(page.startsWith("Running header"), `page ${i + 1} header`);
		assert.ok(page.includes(`Footer Page ${i + 1}`), `page ${i + 1} footer and page number`);
	}
	assert.deepEqual(
		pdf.fields.map((f) => `${f.name}:${f.type}`),
		["full_name:Tx", "member_signature:Sig", "signed_on:Tx", "row_1_done:Btn", "row_2_done:Btn"],
	);
	const loaded = await PDFDocument.load(pdf.bytes);
	const size = loaded.getPage(0).getSize();
	assert.deepEqual([Math.round(size.width), Math.round(size.height)], [842, 595], "A4 landscape");
	const raw = Buffer.from(pdf.bytes).toString("latin1");
	assert.match(raw, /\/URI \(https:\/\/everyfield\.app\)/, "the link is an annotation");
	const fonts = new Set<string>();
	for (const [, obj] of loaded.context.enumerateIndirectObjects()) {
		const base = (obj as { get?: (n: PDFName) => unknown }).get?.(PDFName.of("BaseFont"));
		if (base instanceof PDFName) fonts.add(base.decodeText().replace(/^[A-Z]{6}\+/, ""));
	}
	assert.ok(
		[...fonts].some((f) => /Italic/.test(f)),
		`the italic mark uses an italic face: ${[...fonts]}`,
	);

	// The Word file follows the same page setup and prints the text inside columns, the box, the header and the footer.
	const word = docxParts(await renderDocFile(doc, "docx", THEME, SAVED));
	const body = word["word/document.xml"]!;
	assert.match(
		body,
		/<w:pgSz w:w="16840" w:h="11900" w:orient="landscape"\/>/,
		"A4 landscape, 842 by 595 points in twips",
	);
	for (const words of ["FULL NAME", "Words on the primary fill.", "Title of Harbor City Church", "Chairs", "Lights"])
		assert.ok(wordText(body).toUpperCase().includes(words.toUpperCase()), `Word prints "${words}"`);
	const header = Object.keys(word).filter((k) => /^word\/header\d+\.xml$/.test(k));
	assert.deepEqual(
		header.map((k) => wordText(word[k]!)),
		["Running header"],
	);
	assert.match(word["word/footer1.xml"]!, /w:instr=" PAGE "/, "the footer's page number is a PAGE field");
	assert.match(wordText(word["word/footer1.xml"]!), /^Footer /);
	const legal = structuredClone(doc);
	legal.page.size = "legal";
	const legalWord = docxParts(await renderDocFile(docDocument.parse(legal), "docx", THEME, SAVED));
	assert.match(
		legalWord["word/document.xml"]!,
		/<w:pgSz w:w="20160" w:h="12240" w:orient="landscape"\/>/,
		"Legal landscape is 14 by 8.5 inches",
	);
});

test("AC:CASE-DOC-023 a header or footer can print on the first page only or on the later pages only", async () => {
	const doc = await fork("conflict-of-interest-policy");
	doc.page.header = {
		pages: "rest",
		content: [{ type: "paragraph", content: [{ type: "text", text: "Policy, continued" }] }],
	};
	doc.page.footer = {
		pages: "first",
		content: [{ type: "paragraph", content: [{ type: "text", text: "First page only" }] }],
	};
	const pdf = await renderDocPdf(docDocument.parse(doc));
	const pages = await pdfPages(pdf.bytes);
	assert.ok(pages.length >= 2);
	assert.ok(pages[0]!.includes("First page only") && !pages[0]!.includes("Policy, continued"));
	for (const page of pages.slice(1))
		assert.ok(page.startsWith("Policy, continued") && !page.includes("First page only"));
	for (const page of pages) assert.ok(page.includes("Template, not legal advice"));
});

test("AC:CASE-DOC-019-EDIT a wiped fork of the policy still validates and prints the legal notice", async () => {
	const template: DocTemplate = docTemplateById("conflict-of-interest-policy")!;
	const doc = await forkTemplate(template, { data: DATA });
	doc.body = { type: "doc", content: [] };
	doc.page.header = { pages: "all", content: [] };
	doc.page.footer = { pages: "all", content: [] };
	assert.deepEqual(docDocument.parse(doc), doc);
	const pdf = await renderDocPdf(doc);
	assert.equal(pdf.pages, 1);
	const [page] = await pdfPages(pdf.bytes);
	assert.equal(page, "Template, not legal advice");
	assert.ok(pdf.text[0]!.includes("Template, not legal advice"));
	// The notice comes from the class, not from content: an operational fork wiped the same way prints nothing.
	const plain = await renderDocPdf({ ...doc, class: "operational" });
	assert.deepEqual(await pdfPages(plain.bytes), [""]);
});

test("AC:CASE-DOC-022 New from template freezes each field from its source, else its fallback, and says which", async () => {
	const { frozenData, fieldValues } = await import("../../../packages/domain/src/documents/doc-values.ts");
	const card = docTemplateById("commitment-card")!;
	const policy = docTemplateById("conflict-of-interest-policy")!;
	const sources = {
		churchName: "Harbor City Church",
		pastorName: null,
		tagline: null,
		legalName: null,
		contactLine: null,
		meetingDate: null,
	};
	assert.deepEqual(frozenData(policy.fields, sources), {
		data: { church_name: "Harbor City Church", church_legal_name: "Harbor City Church" },
		from: { church_name: "church.name", church_legal_name: "fallback" },
	});
	const frozen = frozenData(card.fields, { ...sources, tagline: "Come as you are." });
	assert.deepEqual(frozen, {
		data: { church_name: "Harbor City Church", church_tagline: "Come as you are.", contact_line: "" },
		from: { church_name: "church.name", church_tagline: "brand.tagline", contact_line: "fallback" },
	});
	// An empty frozen value prints nothing; a template prints its samples.
	const doc = await forkTemplate(card, { data: frozen.data });
	assert.equal(fieldValues(doc).contact_line, "");
	assert.equal(fieldValues(card).contact_line, "harborcity.church  ·  (555) 010-0199");
});
