// WP-036 criteria 2, 5 and 6: the built-in template files and the one generic Forme renderer for everyfield.doc/1.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import test from "node:test";
import { PDFDocument, PDFName } from "../../../packages/domain/node_modules/pdf-lib/cjs/index.js";
import {
	docDocument,
	forkTemplate,
	type DocDocument,
	type DocTemplate,
} from "../../../packages/contracts/src/documents/format/index.ts";
import { DOC_TEMPLATES, docTemplateById, loadTemplate } from "../../../packages/domain/src/documents/doc-templates.ts";
import { renderDocPdf } from "../../../packages/domain/src/documents/doc-render.ts";
import { SLOT_BLANK_NOTE } from "../../../packages/domain/src/documents/templates/church.ts";
import { pdfPages } from "./fixtures/readers.mts";

const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const folder = new URL("../../../packages/domain/src/documents/templates/", import.meta.url);
const DATA = {
	church_name: "Harbor City Church",
	church_legal_name: "Harbor City Church, Inc.",
	church_tagline: "A new church plant. You are welcome here.",
	contact_line: "harborcity.church  ·  (555) 010-0199",
};
const fork = async (id: string) => forkTemplate(docTemplateById(id)!, { data: DATA });
const count = (text: string, part: string) => text.split(part).length - 1;
const range = (n: number) => Array.from({ length: n }, (_, i) => i + 1);

test("WP-036 the four template files load through the contract parser and a file that does not validate fails", () => {
	const files = readdirSync(folder)
		.filter((name) => name.endsWith(".json"))
		.sort();
	assert.deepEqual(files, [
		"budget-worksheet.json",
		"commitment-card.json",
		"conflict-of-interest-policy.json",
		"guest-sign-in-sheet.json",
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

test("WP-036 the conflict-of-interest policy prints its text, numbered headings, footer and adoption fields", async () => {
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

test("WP-036 the card sheet prints four cards on one Letter page with suffixed field names and cut marks", async () => {
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
	const doc = await PDFDocument.load(pdf.bytes);
	const size = doc.getPage(0).getSize();
	assert.deepEqual([size.width, size.height], [612, 792]);
	// The cards sit in four 306 x 396 pt quarters: each card title is in its own quarter.
	const words = pdf.text[0]!.filter((line) => line === "My commitment");
	assert.equal(words.length, 4);
	const again = await renderDocPdf(await fork("commitment-card"));
	assert.equal(sha(again.bytes), sha(pdf.bytes));
});

test("WP-036 the guest sign-in sheet prints 18 write-in rows and the budget prints its ledger with input boxes", async () => {
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

test("WP-036 typed values print computed formula, subtotal and total cells", async () => {
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

test("WP-036 every node, mark and page setup part of the design node table prints", async () => {
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
});

test("WP-036 a header or footer can print on the first page only or on the later pages only", async () => {
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

test("WP-036 criterion 6: a wiped fork of the policy still validates and prints the legal notice", async () => {
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
