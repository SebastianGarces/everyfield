// WP-037: the authored Church Document templates, their text-document layout and the body they start with. No database.
// Exports of a Church Document go through doc-render.ts; doc-render.test.mts and church.test.mts cover them.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import test, { describe } from "node:test";
import { forkTemplate } from "../../../packages/contracts/src/documents/format/index.ts";
import { ContrastLog } from "../../../packages/domain/src/documents/contrast.ts";
import { library } from "../../../packages/domain/src/documents/catalog.ts";
import { NEUTRAL_EXPORT_THEME } from "../../../packages/domain/src/documents/church-theme.ts";
import { DOC_TEMPLATES, docTemplateById } from "../../../packages/domain/src/documents/doc-templates.ts";
import { renderDocFile } from "../../../packages/domain/src/documents/doc-render.ts";
import { resolveMerge } from "../../../packages/domain/src/documents/merge.ts";
import { renderContext, renderPdfElement, renderPreview } from "../../../packages/domain/src/documents/render.ts";
import { churchDocument } from "../../../packages/domain/src/documents/layouts/church-doc.tsx";
import {
	CHURCH_TEMPLATES,
	churchTemplate,
	resolveBody,
	resolveTokens,
} from "../../../packages/domain/src/documents/templates/church.ts";
import { DOCTRINAL } from "./fixtures/doctrinal.mts";
import { docxParts, pdfPages, wordText } from "./fixtures/readers.mts";
import { lowContrastKit, sampleKit } from "./fixtures/sample-kit.ts";

const CHURCH = "Harborlight Church";
const PASTOR = "Pastor Daniel Reyes";
const catalogJson = JSON.parse(
	readFileSync(new URL("../../../docs/catalog/document-templates.json", import.meta.url), "utf8"),
);

const bodyOf = (id: string, pastor: string | null = PASTOR) =>
	resolveBody(churchTemplate(id)!.body, { church_name: CHURCH, pastor_name: pastor });
const kit = (primary = "#1F4E6B") => ({ render: sampleKit(primary) });
const EDITABLE = ["member-expectations", "launch-team-commitment", "follow-up-letter", "bylaws", "prayer-letter"];

describe("AC:DOC-022 Church Document templates", () => {
	test("AC:DOC-022 five authored templates, each with a frame, a class and merge fields", () => {
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

	test("AC:DOC-022 every template file is a catalog template of the same class", () => {
		const classOf = new Map(
			(catalogJson.templates as { id: string; class: string }[]).map((t) => [t.id, t.class] as const),
		);
		for (const template of DOC_TEMPLATES) assert.equal(classOf.get(template.id), template.class, template.id);
	});

	test("AC:DOC-002 a merge value with no source is a marked blank, never invented", () => {
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

	test("AC:DOC-019 AC:DOC-021 every printed string says church plant, never a bare plant, and spells Everyfield", async () => {
		for (const id of ["bylaws", "prayer-letter"]) {
			const doc = await forkTemplate(docTemplateById(id)!, { data: { church_name: CHURCH, pastor_name: PASTOR } });
			const created = new Date("2026-10-30T16:00:00Z");
			const pdf = (await pdfPages(await renderDocFile(doc, "pdf", NEUTRAL_EXPORT_THEME, created))).join(" ");
			const word = docxParts(await renderDocFile(doc, "docx", NEUTRAL_EXPORT_THEME, created));
			const docx = wordText(word["word/document.xml"]!);
			const raw = JSON.stringify(churchTemplate(id));
			for (const text of [pdf, docx, raw]) {
				const bare = text.replace(/church\s+plant/gi, "").match(/.{0,30}\bplant.{0,30}/i);
				assert.equal(bare, null, `${id}: bare plant: ${bare?.[0]}`);
				assert.equal(/every ?field/i.test(text.replace(/Everyfield/g, "")), false);
			}
		}
	});

	test("AC:DOC-020 Everyfield ships no doctrinal text in any authored template", () => {
		for (const template of CHURCH_TEMPLATES) {
			const slots = template.body.filter((b) => b.kind === "slot");
			assert.deepEqual(
				slots.map((b) => b.slotId),
				template.slots.map((s) => s.id),
				`${template.id}: the body holds one node for each slot`,
			);
			for (const slot of slots) assert.equal(slot.text, "", `${template.id}/${slot.slotId} starts empty`);
			const text = JSON.stringify(template);
			assert.equal(DOCTRINAL.test(text), false, `${template.id} states a doctrine: ${DOCTRINAL.exec(text)?.[0]}`);
		}
		assert.deepEqual(churchTemplate("bylaws")!.slots, [{ id: "statement-of-faith", label: "Statement of faith" }]);
	});
});

describe("AC:DOC-016 body model", () => {
	test("AC:DOC-016 the body never holds the legal notice, the letterhead or the signature block", () => {
		for (const template of CHURCH_TEMPLATES) {
			const text = JSON.stringify(template.body);
			assert.equal(text.includes("not legal advice"), false, template.id);
			assert.equal(/signature|EIN \d/i.test(text), false, template.id);
		}
	});
});

describe("AC:DOC-011 text-document layout and fixed previews", () => {
	test("AC:DOC-011 AC:DOC-017 both themes keep the approved text-document look with legible type", async () => {
		const kits = [kit(), { render: lowContrastKit() }, NEUTRAL_EXPORT_THEME];
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

	test("AC:DOC-011 fixed-layout and budget previews keep main's bytes", async () => {
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
});
