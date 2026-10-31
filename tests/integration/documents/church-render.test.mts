// WP-037: the Church Document templates, the PDF and Word renderers and the body model. No database: real bytes.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import test, { describe } from "node:test";
import {
	PDFArray,
	PDFDict,
	PDFDocument,
	PDFName,
	PDFRef,
} from "../../../packages/domain/node_modules/pdf-lib/cjs/index.js";
import {
	BODY_BLOCKS_MAX,
	churchBody,
	slotIdsOf,
	type ChurchBlock,
} from "../../../packages/contracts/src/documents/body.ts";
import { ContrastLog } from "../../../packages/domain/src/documents/contrast.ts";
import { renderChurchDocx, renderChurchPdf } from "../../../packages/domain/src/documents/church-render.ts";
import { NEUTRAL_EXPORT_THEME, type ExportTheme } from "../../../packages/domain/src/documents/church-theme.ts";
import { library } from "../../../packages/domain/src/documents/catalog.ts";
import { resolveMerge } from "../../../packages/domain/src/documents/merge.ts";
import {
	renderContext,
	renderPdfElement,
	renderPreview,
	renderTemplatePdf,
} from "../../../packages/domain/src/documents/render.ts";
import { churchDocument } from "../../../packages/domain/src/documents/layouts/church-doc.tsx";
import {
	CHURCH_TEMPLATES,
	NOT_EDITABLE,
	PENDING_EDITABLE,
	SLOT_BLANK_NOTE,
	churchTemplate,
	resolveBody,
	resolveTokens,
} from "../../../packages/domain/src/documents/templates/church.ts";
import { entryFor } from "../../../packages/domain/src/documents/templates/registry.ts";
import { readImport } from "../../../packages/domain/src/documents/unpack.ts";
import { docxParts, hasSoffice, pdfPages, sofficeToPdf, wordText } from "./fixtures/readers.mts";
import { lowContrastKit, sampleKit } from "./fixtures/sample-kit.ts";

const CHURCH = "Harborlight Church";
const PASTOR = "Pastor Daniel Reyes";
const SAVED = new Date("2026-10-30T16:00:00Z");
const catalogJson = JSON.parse(
	readFileSync(new URL("../../../docs/catalog/document-templates.json", import.meta.url), "utf8"),
);

const brandTheme = (primary = "#1F4E6B"): ExportTheme => ({
	kind: "church",
	primary: primary.toUpperCase(),
	fonts: { heading: "DM Serif Display", body: "DM Sans" },
	render: sampleKit(primary),
});
const bodyOf = (id: string, pastor: string | null = PASTOR) =>
	resolveBody(churchTemplate(id)!.body, { church_name: CHURCH, pastor_name: pastor });
const input = (id: string, theme: ExportTheme = NEUTRAL_EXPORT_THEME, body?: ChurchBlock[]) => ({
	template: churchTemplate(id)!,
	body: body ?? bodyOf(id),
	church: CHURCH,
	pastorName: PASTOR,
	theme,
	savedAt: SAVED,
});
const tagsOf = async (bytes: Uint8Array) => {
	const doc = await PDFDocument.load(bytes, { updateMetadata: false });
	const tags = new Set<string>();
	const walk = (node: unknown) => {
		const o = node instanceof PDFRef ? doc.context.lookup(node) : node;
		if (o instanceof PDFDict) {
			const s = o.get(PDFName.of("S"));
			if (s instanceof PDFName) tags.add(s.decodeText());
			const k = o.get(PDFName.of("K"));
			if (k) walk(k);
		} else if (o instanceof PDFArray) for (const x of o.asArray()) walk(x);
	};
	walk(doc.catalog.lookup(PDFName.of("StructTreeRoot")));
	return { doc, tags };
};
const EDITABLE = ["member-expectations", "launch-team-commitment", "follow-up-letter", "bylaws", "prayer-letter"];

describe("WP-037 Church Document templates", () => {
	test("DOC-022: five authored templates, each with a frame, a class and merge fields", () => {
		assert.deepEqual(
			CHURCH_TEMPLATES.map((t) => t.id),
			EDITABLE,
		);
		const classOf = Object.fromEntries(
			catalogJson.templates.map((t: { id: string; class: string }) => [t.id, t.class]),
		);
		for (const template of CHURCH_TEMPLATES) {
			assert.equal(template.documentClass, classOf[template.id], template.id);
			assert.equal(template.version, 1);
			assert.ok(template.body.length > 0);
		}
		assert.equal(churchTemplate("bylaws")!.documentClass, "formal/legal");
		assert.equal(churchTemplate("bylaws")!.frame.kind, "adopt");
		assert.equal(churchTemplate("prayer-letter")!.documentClass, "outward-facing");
		assert.equal(churchTemplate("prayer-letter")!.style, "letter");
	});

	test("DOC-022: the editable, pending and not-editable id lists equal docs/catalog/document-templates.json", () => {
		const rows = catalogJson.templates as { id: string; editable: boolean }[];
		const editable = rows.filter((t) => t.editable).map((t) => t.id);
		assert.deepEqual([...editable].sort(), [...EDITABLE, ...PENDING_EDITABLE].sort());
		assert.deepEqual(
			[...NOT_EDITABLE].sort(),
			rows
				.filter((t) => !t.editable)
				.map((t) => t.id)
				.sort(),
		);
	});

	test("DOC-002: a merge value with no source is a marked blank, never invented", () => {
		assert.equal(
			resolveTokens("Hello {pastor_name} of {church_name}", { church_name: "Harvest Point", pastor_name: null }),
			"Hello [pastor name] of Harvest Point",
		);
		// One pass: a merge value that holds a token does not resolve again, and an unknown token stays as written.
		assert.equal(
			resolveTokens("{church_name} {other}", { church_name: "{pastor_name}", pastor_name: "X" }),
			"{pastor_name} {other}",
		);
		for (const block of bodyOf("bylaws", null)) assert.equal(JSON.stringify(block).includes("{church_name}"), false);
	});

	test("DOC-019: every printed string says church plant, never a bare plant, and spells Everyfield", async () => {
		for (const id of ["bylaws", "prayer-letter"]) {
			const pdf = (await renderChurchPdf(input(id))).text.flat().join(" ");
			const docx = wordText(docxParts(renderChurchDocx(input(id)))["word/document.xml"]!);
			const raw = JSON.stringify(churchTemplate(id));
			for (const text of [pdf, docx, raw]) {
				const bare = text.replace(/church\s+plant/gi, "").match(/.{0,30}\bplant.{0,30}/i);
				assert.equal(bare, null, `${id}: bare plant: ${bare?.[0]}`);
				assert.equal(/every ?field/i.test(text.replace(/Everyfield/g, "")), false);
			}
		}
	});

	test("DOC-020: Everyfield ships no doctrinal text in any authored template", () => {
		const doctrinal =
			/\b(trinity|trinitarian|inerran|infallib|virgin birth|resurrection|atonement|justification|predestin|baptis|eucharist|communion|salvation|saved by|original sin|second coming|deity of|divinity)/i;
		for (const template of CHURCH_TEMPLATES) {
			const slots = template.body.filter((b) => b.kind === "slot");
			assert.deepEqual(
				slots.map((b) => b.slotId),
				template.slots.map((s) => s.id),
				`${template.id}: the body holds one node for each slot`,
			);
			for (const slot of slots) assert.equal(slot.text, "", `${template.id}/${slot.slotId} starts empty`);
			const text = JSON.stringify(template);
			assert.equal(doctrinal.test(text), false, `${template.id} states a doctrine: ${doctrinal.exec(text)?.[0]}`);
		}
		assert.deepEqual(churchTemplate("bylaws")!.slots, [{ id: "statement-of-faith", label: "Statement of faith" }]);
	});
});

describe("WP-037 body model", () => {
	test("DOC-002: the block kinds are the Wiki safe-editor kinds plus the slot node", () => {
		const body: ChurchBlock[] = [
			{ kind: "heading", text: "H" },
			{ kind: "subheading", text: "S" },
			{ kind: "paragraph", text: "P" },
			{ kind: "quote", text: "Q" },
			{ kind: "bulleted_list", items: ["a"] },
			{ kind: "numbered_list", items: ["b"] },
			{ kind: "slot", slotId: "statement-of-faith", text: "" },
		];
		assert.deepEqual(churchBody.parse(body), body);
		assert.deepEqual(slotIdsOf(body), ["statement-of-faith"]);
		for (const bad of [
			[{ kind: "notice", text: "Template, not legal advice" }],
			[{ kind: "signature", text: "x" }],
			[{ kind: "paragraph", text: "x", extra: 1 }],
			[{ kind: "paragraph", text: "bad\0char" }],
			[{ kind: "paragraph", text: "lone \uD800 surrogate" }],
			[{ kind: "slot", slotId: "Bad Id", text: "" }],
			[
				{ kind: "slot", slotId: "a", text: "" },
				{ kind: "slot", slotId: "a", text: "" },
			],
		])
			assert.equal(churchBody.safeParse(bad).success, false, JSON.stringify(bad));
	});

	test("DOC-002: 1,000 blocks pass and 1,001 are refused; a list item counts as a block", () => {
		const paragraph = (n: number): ChurchBlock => ({ kind: "paragraph", text: `Paragraph ${n}` });
		assert.equal(churchBody.safeParse(Array.from({ length: BODY_BLOCKS_MAX }, (_, i) => paragraph(i))).success, true);
		assert.equal(
			churchBody.safeParse(Array.from({ length: BODY_BLOCKS_MAX + 1 }, (_, i) => paragraph(i))).success,
			false,
		);
		const list: ChurchBlock = { kind: "bulleted_list", items: Array.from({ length: 200 }, (_, i) => `Item ${i}`) };
		assert.equal(churchBody.safeParse([list, list, list, list, list]).success, true, "1,000 items");
		assert.equal(churchBody.safeParse([list, list, list, list, list, paragraph(1)]).success, false, "1,001 items");
		const big: ChurchBlock = { kind: "paragraph", text: "x".repeat(20_000) };
		assert.equal(churchBody.safeParse(Array.from({ length: 101 }, () => big)).success, false, "over the size limit");
	});

	test("DOC-016: the body never holds the legal notice, the letterhead or the signature block", () => {
		for (const template of CHURCH_TEMPLATES) {
			const text = JSON.stringify(template.body);
			assert.equal(text.includes("not legal advice"), false, template.id);
			assert.equal(/signature|EIN \d/i.test(text), false, template.id);
		}
	});
});

describe("WP-037 PDF export", () => {
	test("DOC-023: the PDF is tagged for PDF/UA, titled, in English and every field has a tooltip", async () => {
		for (const id of EDITABLE) {
			const out = await renderChurchPdf(input(id, brandTheme()));
			const { doc, tags } = await tagsOf(out.bytes);
			for (const tag of ["H1", "P", "Figure"]) assert.ok(tags.has(tag), `${id} has no ${tag}`);
			if (id !== "follow-up-letter" && id !== "prayer-letter") assert.ok(tags.has("H2"), `${id} has no H2`);
			assert.equal(doc.catalog.get(PDFName.of("Lang"))?.toString(), "(en-US)");
			assert.ok(doc.getTitle()?.includes(CHURCH), id);
			assert.ok(doc.catalog.get(PDFName.of("MarkInfo")), id);
			assert.ok(Buffer.from(out.bytes).includes("pdfuaid:part"), `${id} lacks the PDF/UA identifier`);
			for (const field of doc.getForm().getFields())
				assert.ok(field.acroField.dict.get(PDFName.of("TU")), `${id}.${field.getName()} has no tooltip`);
		}
		const bylaws = await tagsOf((await renderChurchPdf(input("bylaws"))).bytes);
		assert.ok(bylaws.tags.has("Table"), "the adoption block is a table");
		const names = bylaws.doc
			.getForm()
			.getFields()
			.map((f) => f.getName());
		assert.deepEqual(
			names.filter((n) => n.endsWith("_signature")),
			["adopt_1_signature", "adopt_2_signature", "adopt_3_signature"],
		);
	});

	test("DOC-011: the template preview and the export of revision 1 show the same page text and outline", async () => {
		const loaded = await library();
		for (const id of ["member-expectations", "launch-team-commitment", "follow-up-letter"]) {
			for (const [theme, render] of [
				[NEUTRAL_EXPORT_THEME, undefined],
				[brandTheme(), sampleKit()],
			] as const) {
				const template = loaded.templates.find((t) => t.id === id)!;
				const resolved = resolveMerge(template, { churchName: CHURCH, pastorName: PASTOR, launchDate: null }, {});
				assert.ok(resolved.ok);
				const preview = await renderTemplatePdf(template, { church_name: CHURCH, pastor_name: PASTOR }, render);
				const exported = await renderChurchPdf(input(id, theme));
				assert.deepEqual(exported.text, preview.text, `${id} page text`);
				assert.equal(exported.pages, preview.pages);
				assert.deepEqual(
					exported.fields.map((f) => f.name),
					preview.fields.map((f) => f.name),
				);
				assert.equal(
					createHash("sha256").update(exported.bytes).digest("hex"),
					createHash("sha256").update(preview.bytes).digest("hex"),
					`${id}: one render path gives one set of bytes`,
				);
				const outline = churchTemplate(id)!.body.flatMap((b) => (b.kind === "heading" ? [b.text] : []));
				assert.deepEqual(
					entryFor(id)!.outline,
					churchTemplate(id)!.style === "letter" ? [churchTemplate(id)!.title] : outline,
				);
				for (const heading of outline) assert.ok(exported.text.flat().join(" ").includes(heading), heading);
			}
		}
	});

	test("DOC-011: both themes keep the approved text-document look with legible type", async () => {
		const kits = [brandTheme(), { ...brandTheme("#F5D90A"), render: lowContrastKit() }, NEUTRAL_EXPORT_THEME];
		for (const id of EDITABLE)
			for (const theme of kits) {
				const ctx = renderContext(
					CHURCH,
					{ church_name: CHURCH, pastor_name: PASTOR },
					theme.render,
					churchTemplate(id)!.documentClass,
				);
				await renderPdfElement(churchDocument(ctx, churchTemplate(id)!, bodyOf(id)));
				for (const row of ctx.log.rows)
					assert.ok(row.ratio >= row.min, `${id} ${row.use} ${row.ratio.toFixed(2)} < ${row.min}`);
			}
		assert.ok(new ContrastLog().rows.length === 0);
	});

	test("DOC-011: fixed-layout and budget previews keep main's bytes", async () => {
		// SHA-256 of each preview on main before WP-037 (the hash-all fixture, all values filled).
		const main: Record<string, string> = {
			"commitment-card": "7cb2e5a410ae6a8eb999ec97fcb38a8f4ecca62b7425afd55646f5a789eb31e8",
			"response-card": "886b00c9c4f76b3c5c248fdf1123a7a36b46c091e543b1cfda0a1724db53361e",
			"guest-sign-in-sheet": "4e05727fb075b1520d4c7730f5cae05bcce83d62e0f4e4ef709617332b735d3f",
			"vision-meeting-agenda": "3982b52ff36a1576b1ce1a61d5ce9ef921c10d25935606ac0328730ac1eb48d4",
			"board-meeting-agenda": "5cf26818136c15356e496cf7e5d0b13e4633dc75dd8f162b8df740d4090f2f1e",
			"first-year-budget": "c948ac590a75abe546383e68846b7e4f12b26ad1d64d0e66c7651dde40105c80",
			"budget-worksheet": "71bf4e094e4b1a1dadb568c56f556d28a3c44bd01735c216aaa1a2348d2d465d",
			"launch-sunday-checklists": "1104b12797154d8b6554c346c9e66ea92661051f2388177777330e6bc0ab3166",
		};
		const loaded = await library();
		for (const [id, hash] of Object.entries(main)) {
			const template = loaded.templates.find((t) => t.id === id)!;
			const resolved = resolveMerge(
				template,
				{ churchName: "Harborlight Church", pastorName: "Pastor Daniel Reyes", launchDate: "Sunday, April 11, 2027" },
				{},
			);
			assert.ok(resolved.ok);
			const bytes = await renderPreview(template, template.formats[0]!, resolved);
			assert.equal(createHash("sha256").update(bytes!).digest("hex"), hash, id);
		}
	});

	test("DOC-002: the same revision and theme give the same PDF and the same Word bytes", async () => {
		for (const id of ["bylaws", "prayer-letter"]) {
			const a = await renderChurchPdf(input(id, brandTheme()));
			const b = await renderChurchPdf(input(id, brandTheme()));
			assert.deepEqual(a.bytes, b.bytes);
			assert.deepEqual(renderChurchDocx(input(id, brandTheme())), renderChurchDocx(input(id, brandTheme())));
		}
		const one = await renderChurchPdf(input("bylaws", brandTheme("#1F4E6B")));
		const two = await renderChurchPdf(input("bylaws", brandTheme("#8B1E3F")));
		assert.notDeepEqual(one.bytes, two.bytes);
	});
});

describe("WP-037 legal notice and doctrinal slot", () => {
	const emptied = (id: string) => churchTemplate(id)!.body.filter((b) => b.kind === "slot") as ChurchBlock[];

	test("CASE-DOC-019-EDIT: a formal/legal body with all its text deleted still prints the notice in both files", async () => {
		const empty = input("bylaws", brandTheme(), emptied("bylaws"));
		const pdf = await renderChurchPdf(empty);
		assert.ok((await pdfPages(pdf.bytes)).join(" ").includes("Template, not legal advice"));
		const parts = docxParts(renderChurchDocx(empty));
		assert.ok(wordText(parts["word/footer1.xml"]!).includes("Template, not legal advice"), "in the footer");
		assert.equal(wordText(parts["word/document.xml"]!).includes("not legal advice"), false, "outside the body");
	});

	test("CASE-DOC-019-EDIT: an outward-facing or operational export holds no notice", async () => {
		for (const id of ["prayer-letter", "follow-up-letter", "member-expectations", "launch-team-commitment"]) {
			assert.equal(
				(await pdfPages((await renderChurchPdf(input(id))).bytes)).join(" ").includes("legal advice"),
				false,
				id,
			);
			const parts = docxParts(renderChurchDocx(input(id)));
			for (const part of Object.values(parts)) assert.equal(part.includes("legal advice"), false, id);
		}
	});

	test("CASE-DOC-020-EDIT: an unfilled statement-of-faith slot is a visible, marked blank with no default text", async () => {
		const pdf = (await pdfPages((await renderChurchPdf(input("bylaws", brandTheme()))).bytes)).join(" ");
		const docx = wordText(docxParts(renderChurchDocx(input("bylaws", brandTheme())))["word/document.xml"]!);
		for (const text of [pdf, docx]) {
			assert.ok(/statement of faith/i.test(text));
			assert.ok(text.includes(SLOT_BLANK_NOTE.slice(0, 30)), "the marked blank");
		}
		// Nothing but the label and the note sits in the slot: the next text is the next article.
		const afterNote = docx.slice(docx.indexOf(SLOT_BLANK_NOTE) + SLOT_BLANK_NOTE.length).trimStart();
		assert.ok(afterNote.startsWith("03 Members") || afterNote.startsWith("Members"), afterNote.slice(0, 40));
	});

	test("CASE-DOC-020-EDIT: a filled slot prints the church's own words in both files", async () => {
		const body = bodyOf("bylaws").map((b) =>
			b.kind === "slot" ? { ...b, text: "We hold these words as our own." } : b,
		);
		const pdf = (await pdfPages((await renderChurchPdf(input("bylaws", NEUTRAL_EXPORT_THEME, body))).bytes)).join(" ");
		const docx = wordText(
			docxParts(renderChurchDocx(input("bylaws", NEUTRAL_EXPORT_THEME, body)))["word/document.xml"]!,
		);
		for (const text of [pdf, docx]) {
			assert.ok(text.includes("We hold these words as our own."));
			assert.equal(text.includes(SLOT_BLANK_NOTE.slice(0, 30)), false);
		}
	});
});

describe("WP-037 Word export", () => {
	test("DOC-023: the Word file is valid, uses heading styles, list numbering and tables, and keeps the theme", async () => {
		const theme = brandTheme("#1F4E79");
		// A PNG logo with alt text, as a stored brand asset is.
		const png = Buffer.from(
			"iVBORw0KGgoAAAANSUhEUgAAAAQAAAACCAYAAACZgbYnAAAAEklEQVR4nGP8z8Dwn4EIwDiqEAB6bQQDbRS/ZwAAAABJRU5ErkJggg==",
			"base64",
		);
		const withLogo: ExportTheme = {
			...theme,
			render: {
				...theme.render,
				logo: { bytes: png, mediaType: "image/png", alt: "Harborlight Church logo", aspect: 2 },
			},
		};
		for (const id of EDITABLE) {
			const bytes = renderChurchDocx(input(id, withLogo));
			const parts = docxParts(bytes);
			const document = parts["word/document.xml"]!;
			assert.ok(parts["[Content_Types].xml"]!.includes("wordprocessingml.document.main+xml"));
			assert.match(document, /<w:pStyle w:val="Title"\/>/);
			if (id !== "follow-up-letter" && id !== "prayer-letter")
				assert.match(document, /<w:pStyle w:val="Heading1"\/>/, id);
			assert.ok(document.includes("<w:tbl>"), `${id} has a table`);
			assert.match(parts["word/styles.xml"]!, /w:styleId="Heading1"/);
			assert.match(parts["word/numbering.xml"]!, /w:numFmt w:val="bullet"/);
			assert.ok(parts["word/styles.xml"]!.includes('w:val="1F4E79"'), `${id}: theme color`);
			assert.ok(
				parts["word/styles.xml"]!.includes("DM Serif Display") && parts["word/styles.xml"]!.includes("DM Sans"),
			);
			assert.match(parts["word/header1.xml"]!, /descr="Harborlight Church logo"/, `${id}: logo alt text`);
			assert.ok(parts["word/media/logo.png"], `${id}: the logo is in the file`);
			assert.match(parts["word/footer1.xml"]!, /PAGE/);
		}
		const bylaws = docxParts(renderChurchDocx(input("bylaws", withLogo)));
		assert.ok((bylaws["word/document.xml"]!.match(/<w:tbl>/g) ?? []).length >= 2, "slot and adoption table");
		assert.ok(bylaws["word/document.xml"]!.includes("Adoption signatures"));
		assert.match(
			bylaws["word/document.xml"]!,
			/<w:numPr><w:ilvl w:val="0"\/><w:numId w:val="2"\/>/,
			"numbered headings",
		);
		assert.match(bylaws["word/document.xml"]!, /<w:numId w:val="10"\/>/, "a numbered list restarts at one");
		const letterhead = docxParts(renderChurchDocx(input("bylaws", brandTheme())));
		assert.ok(wordText(letterhead["word/footer1.xml"]!).includes("Harborlight Community Church, Inc."));
		assert.ok(wordText(letterhead["word/footer1.xml"]!).includes("EIN 84-1234567"));
	});

	test("DOC-023: a reader that is not the writer opens the Word file", async () => {
		const bytes = renderChurchDocx(input("bylaws", brandTheme()));
		// The importer of DOC-016 reads Word with its own ZIP and XML code.
		const text = readImport(bytes, "docx");
		for (const phrase of ["Bylaws", "Name and purpose", "Harborlight Church", "Board member"])
			assert.ok(text.includes(phrase), phrase);
		if (hasSoffice()) {
			const pdf = (await pdfPages(sofficeToPdf(bytes))).join(" ");
			for (const phrase of ["Name and purpose", "Statement of faith", "Template, not legal advice"])
				assert.ok(pdf.includes(phrase), phrase);
		}
		const outPy = execFileSync(
			"python3",
			[
				"-I",
				"-c",
				"import sys,zipfile,io;z=zipfile.ZipFile(io.BytesIO(sys.stdin.buffer.read()));print(z.namelist()[0])",
			],
			{ input: bytes },
		);
		assert.equal(outPy.toString().trim(), "[Content_Types].xml");
	});
});
