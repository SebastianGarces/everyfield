// WP-037, T-205: the text templates. Each is one everyfield.doc/1 file that the library preview, "Save for your church"
// and a Church Document all render. No database. Exports of a Church Document go through doc-render.ts;
// doc-render.test.mts and church.test.mts cover them.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import test, { describe } from "node:test";
import type { BlockNode, SlotNode } from "../../../packages/contracts/src/documents/format/index.ts";
import { forkTemplate } from "../../../packages/contracts/src/documents/format/index.ts";
import { ContrastLog } from "../../../packages/domain/src/documents/contrast.ts";
import { library } from "../../../packages/domain/src/documents/catalog.ts";
import { NEUTRAL_EXPORT_THEME } from "../../../packages/domain/src/documents/church-theme.ts";
import { DOC_TEMPLATES, docTemplateById } from "../../../packages/domain/src/documents/doc-templates.ts";
import { renderDocFile } from "../../../packages/domain/src/documents/doc-render.ts";
import { fieldValues, printedDoc } from "../../../packages/domain/src/documents/doc-values.ts";
import { docElement } from "../../../packages/domain/src/documents/layouts/doc.tsx";
import { libraryDoc, renderPreview } from "../../../packages/domain/src/documents/library-render.ts";
import { resolveMerge } from "../../../packages/domain/src/documents/merge.ts";
import { renderContext, renderPdfElement } from "../../../packages/domain/src/documents/render.ts";
import { TEXT_TEMPLATE_IDS } from "../../../packages/domain/src/documents/templates/church.ts";
import { NEUTRAL_THEME } from "../../../packages/domain/src/documents/theme.ts";
import { DOCTRINAL } from "./fixtures/doctrinal.mts";
import { docxParts, pdfPages, wordText } from "./fixtures/readers.mts";
import { lowContrastKit, sampleKit } from "./fixtures/sample-kit.ts";

const CHURCH = "Harborlight Church";
const PASTOR = "Pastor Daniel Reyes";
const catalogJson = JSON.parse(
	readFileSync(new URL("../../../docs/catalog/document-templates.json", import.meta.url), "utf8"),
);

const EDITABLE = ["member-expectations", "launch-team-commitment", "follow-up-letter", "bylaws", "prayer-letter"];
const file = (id: string) => docTemplateById(id)!;
/** Every slot node in a body, at any depth. */
const slotsOf = (nodes: readonly BlockNode[] | undefined): SlotNode[] =>
	(nodes ?? []).flatMap((node): SlotNode[] =>
		node.type === "slot"
			? [node]
			: node.type === "box"
				? slotsOf(node.content)
				: node.type === "columns"
					? node.content.flatMap((column) => slotsOf(column.content))
					: [],
	);

describe("AC:DOC-022 Church Document templates", () => {
	test("AC:DOC-022 five text templates, each a template file with a class and the church and pastor fields", () => {
		assert.deepEqual(TEXT_TEMPLATE_IDS, EDITABLE);
		const classOf = Object.fromEntries(
			catalogJson.templates.map((t: { id: string; class: string }) => [t.id, t.class]),
		);
		for (const id of EDITABLE) {
			const template = file(id);
			assert.equal(template.class, classOf[id], id);
			assert.equal(template.version, 1);
			assert.ok((template.body.content ?? []).length > 0);
			assert.deepEqual(
				template.fields.filter((f) => f.source === "church.name" || f.source === "church.pastor").map((f) => f.key),
				["church_name", "pastor_name"],
				id,
			);
		}
		assert.equal(file("bylaws").class, "formal/legal");
		assert.equal(file("prayer-letter").class, "outward-facing");
	});

	test("AC:DOC-022 every template file is a catalog template of the same class", () => {
		const classOf = new Map(
			(catalogJson.templates as { id: string; class: string }[]).map((t) => [t.id, t.class] as const),
		);
		for (const template of DOC_TEMPLATES) assert.equal(classOf.get(template.id), template.class, template.id);
	});

	test("AC:DOC-002 a merge value with no source is a marked blank, never invented", async () => {
		const doc = await libraryDoc(file("bylaws"), { church_name: "Harvest Point" }, NEUTRAL_THEME, null);
		const values = fieldValues(doc);
		assert.equal(values.church_name, "Harvest Point");
		assert.equal(values.pastor_name, "[pastor name]");
		// A merge value that holds a token prints as written: the fallback fills once, from the other fields' sources.
		const tokened = await libraryDoc(file("bylaws"), { church_name: "{pastor_name}" }, NEUTRAL_THEME, null);
		assert.equal(fieldValues(tokened).church_name, "{pastor_name}");
		assert.equal(fieldValues(tokened).church_legal_name, "{pastor_name}");
	});

	test("AC:DOC-019 AC:DOC-021 every printed string says church plant, never a bare plant, and spells Everyfield", async () => {
		for (const id of ["bylaws", "prayer-letter"]) {
			const doc = await forkTemplate(docTemplateById(id)!, { data: { church_name: CHURCH, pastor_name: PASTOR } });
			const created = new Date("2026-10-30T16:00:00Z");
			const pdf = (await pdfPages(await renderDocFile(doc, "pdf", NEUTRAL_EXPORT_THEME, created))).join(" ");
			const word = docxParts(await renderDocFile(doc, "docx", NEUTRAL_EXPORT_THEME, created));
			const docx = wordText(word["word/document.xml"]!);
			// The file without its format tag, which names the format (everyfield.doc/1), not the product.
			const raw = JSON.stringify({ ...file(id), format: null });
			for (const text of [pdf, docx, raw]) {
				const bare = text.replace(/church\s+plant/gi, "").match(/.{0,30}\bplant.{0,30}/i);
				assert.equal(bare, null, `${id}: bare plant: ${bare?.[0]}`);
				assert.equal(/every ?field/i.test(text.replace(/Everyfield/g, "")), false);
			}
		}
	});

	test("AC:DOC-020 Everyfield ships no doctrinal text in any text template", () => {
		for (const id of EDITABLE) {
			for (const slot of slotsOf(file(id).body.content))
				assert.deepEqual(slot.content ?? [], [], `${id}/${slot.attrs?.key} starts empty`);
			const text = JSON.stringify(file(id));
			assert.equal(DOCTRINAL.test(text), false, `${id} states a doctrine: ${DOCTRINAL.exec(text)?.[0]}`);
		}
		assert.deepEqual(
			slotsOf(file("bylaws").body.content).map((slot) => slot.attrs),
			[{ label: "Statement of faith", key: "statement-of-faith" }],
		);
	});
});

describe("AC:DOC-016 body model", () => {
	test("AC:DOC-016 the body never holds the legal notice or the letterhead", () => {
		// The class prints the legal notice and the kit the letterhead, outside the editable body.
		for (const id of EDITABLE) {
			const text = JSON.stringify(file(id).body);
			assert.equal(text.includes("not legal advice"), false, id);
			assert.equal(/EIN \d/i.test(text), false, id);
		}
	});
});

describe("AC:DOC-011 text-document layout and fixed previews", () => {
	test("AC:DOC-011 AC:DOC-017 both themes keep the approved text-document look with legible type", async () => {
		for (const id of EDITABLE)
			for (const theme of [sampleKit("#1F4E6B"), lowContrastKit(), NEUTRAL_THEME]) {
				const doc = printedDoc(await libraryDoc(file(id), { church_name: CHURCH, pastor_name: PASTOR }, theme, null));
				const ctx = renderContext(CHURCH, fieldValues(doc), theme, doc.class);
				await renderPdfElement(docElement(ctx, doc));
				assert.ok(ctx.log.rows.length > 0, id);
				for (const row of ctx.log.rows)
					assert.ok(row.ratio >= row.min, `${id} ${row.use} ${row.ratio.toFixed(2)} < ${row.min}`);
			}
		assert.ok(new ContrastLog().rows.length === 0);
	});

	test("AC:DOC-011 every library preview keeps its pinned bytes", async () => {
		// SHA-256 of each preview at RENDER_PROFILE.layout 4 (the hash-all fixture, all values filled). A change of bytes
		// regenerates these from fixtures/hash-all.mts and bumps RENDER_PROFILE.layout.
		const pinned: Record<string, string> = {
			"commitment-card": "1b41c76862d62fcb959ff1c723dd90f5458de198ca003b07e35c868d341b456e",
			"response-card": "886b00c9c4f76b3c5c248fdf1123a7a36b46c091e543b1cfda0a1724db53361e",
			"guest-sign-in-sheet": "cc51c11c7426ff45aec2553cb9739707ffbe42e2c0604395cf0966d1e58feb46",
			"vision-meeting-agenda": "6e02c8306f25274eb12d53517fb421cee2adc1c9dc7cab2f64d9aadae069e35d",
			"member-expectations": "5214099a73b7ca4a28c1dad04462957b04128d62299d6bc2b888564aec871ec4",
			"launch-team-commitment": "63d8318d0f1681d3365824f2da93248f6c296ce068b6dc0a30c065c2ec81ff2e",
			"follow-up-letter": "b2af923fae493e371b0ec9dc79e470021e1088d3fcf059a74574f411b4bcb10d",
			"board-meeting-agenda": "d052c93f9127e1027c74aec9fb0a1809bf88d4145d0a7df1b49896f6edaa7648",
			"first-year-budget": "c948ac590a75abe546383e68846b7e4f12b26ad1d64d0e66c7651dde40105c80",
			"budget-worksheet": "357615ae52c07533192975325d8bc8eab096b69d04da00bb876ba5a7b900216b",
			"launch-sunday-checklists": "4fd61da39007805617236b09bfc88424cd1446724d0c29cd590c7bba6397682f",
			bylaws: "ed209c8f7b53f4aad6f6ec11337a9d7934b795dee70eebdeea922337273b47bc",
			"prayer-letter": "e802e0cdddc730488ae5eedf537325f214b4d051033b8ff740d21e12dc150558",
		};
		const loaded = await library();
		for (const [id, hash] of Object.entries(pinned)) {
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
});
