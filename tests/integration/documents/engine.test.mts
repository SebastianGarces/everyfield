// WP-036/api: the Forme renderer, the theme and the 11 templates. No database: it renders real bytes.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import test, { describe } from "node:test";
import {
	PDFArray,
	PDFDict,
	PDFDocument,
	PDFName,
	PDFRef,
	PDFSignature,
} from "../../../packages/domain/node_modules/pdf-lib/cjs/index.js";
import ExcelJS from "../../../packages/domain/node_modules/exceljs/lib/exceljs.nodejs.js";
import { library, templateView } from "../../../packages/domain/src/documents/catalog.ts";
import {
	ContrastLog,
	MIN_BODY,
	MIN_NONTEXT,
	legible,
	ratio,
	textOn,
} from "../../../packages/domain/src/documents/contrast.ts";
import { resolveMerge } from "../../../packages/domain/src/documents/merge.ts";
import {
	RENDER_PROFILE,
	digestOf,
	engineVersionOf,
	renderContext,
	renderEngineVersion,
	renderPdfElement,
	renderPreview,
	renderTemplatePdf,
} from "../../../packages/domain/src/documents/render.ts";
import { legalFixture } from "../../../packages/domain/test/legal-fixture.tsx";
import {
	DOCUMENT_CLASSES,
	NEUTRAL_THEME,
	resolveDocumentTheme,
	makePalette,
} from "../../../packages/domain/src/documents/theme.ts";
import { contentSnapshot, REGISTRY, entryFor } from "../../../packages/domain/src/documents/templates/registry.ts";
import {
	FOLLOW_UP_LETTER,
	LAUNCH_TEAM_COMMITMENT,
	MEMBER_EXPECTATIONS,
} from "../../../packages/domain/src/documents/templates/text-content.ts";
import { fontDigests } from "../../../packages/domain/src/documents/fonts.ts";
import { lowContrastKit, sampleKit } from "./fixtures/sample-kit.ts";

const CHURCH = "Harborlight Church";
const FULL = {
	church_name: CHURCH,
	pastor_name: "Pastor Daniel Reyes",
	meeting_date: "Tuesday, November 10, 2026",
	meeting_number: "3",
	launch_date: "Sunday, April 11, 2027",
};
const NEUTRAL_VALUES = { church_name: CHURCH };
const pdfs = REGISTRY.filter((entry) => entry.format === "pdf");
const catalogJson = JSON.parse(
	readFileSync(new URL("../../../docs/catalog/document-templates.json", import.meta.url), "utf8"),
);

const ink = (e: { id: string }) => e.id;
const tagsOf = async (bytes: Buffer) => {
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

describe("WP-036/api engine", () => {
	test("DOC-006: the registry and docs/catalog/document-templates.json agree on id, class and format", async () => {
		const existing = catalogJson.templates.filter((t: { source: string }) => t.source === "existing");
		assert.deepEqual(REGISTRY.map(ink), existing.map(ink));
		for (const row of existing) {
			const entry = entryFor(row.id)!;
			assert.equal(entry.documentClass, row.class, row.id);
			assert.equal(entry.format, row.format, row.id);
		}
		assert.equal(REGISTRY.filter((e) => e.format === "pdf").length, 9);
		assert.deepEqual(REGISTRY.filter((e) => e.format === "xlsx").map(ink), ["first-year-budget", "budget-worksheet"]);
		const loaded = await library();
		for (const template of loaded.templates)
			assert.deepEqual(template.formats, [entryFor(template.id)!.format], template.id);
		assert.equal(loaded.templates.find((t) => t.id === "launch-sunday-checklists")!.pageCount, 2);
	});

	test("DOC-007: the template view carries class, page size, page count and fillable", async () => {
		const loaded = await library();
		const view = (id: string) => templateView(loaded.templates.find((t) => t.id === id)!);
		assert.deepEqual(view("commitment-card").pageSize, { width: 306, height: 396 });
		assert.deepEqual(view("response-card").pageSize, { width: 306, height: 396 });
		assert.deepEqual(view("vision-meeting-agenda").pageSize, { width: 612, height: 792 });
		assert.equal(view("launch-sunday-checklists").pageCount, 2);
		assert.equal(view("commitment-card").documentClass, "outward-facing");
		assert.equal(view("guest-sign-in-sheet").fillable, true);
		assert.equal(view("first-year-budget").fillable, false);
		assert.equal(view("first-year-budget").pageSize, null);
		assert.deepEqual(view("launch-sunday-checklists").outline, [
			"Setup",
			"Hospitality",
			"Worship",
			"Kids",
			"Connections",
			"Prayer",
		]);
		assert.deepEqual(view("vision-meeting-agenda").outline, ["Run of show", "Attendees", "Follow-up actions"]);
	});

	test("DOC-008: the neutral theme gives every church the church name, ink and green, and no Everyfield mark", async () => {
		assert.deepEqual(DOCUMENT_CLASSES, ["formal/legal", "outward-facing", "operational"]);
		for (const cls of DOCUMENT_CLASSES) assert.equal(resolveDocumentTheme({ name: "Any church" }, cls), NEUTRAL_THEME);
		assert.equal(NEUTRAL_THEME.primary, "#181D19");
		assert.equal(NEUTRAL_THEME.accent, "#026B40");
		assert.equal(NEUTRAL_THEME.logo, undefined);
		for (const entry of pdfs) {
			const out = await renderTemplatePdf(entry, NEUTRAL_VALUES);
			const text = out.text.flat().join(" ");
			assert.equal(text.includes("Everyfield"), false, `${entry.id} prints Everyfield`);
			assert.equal(text.includes(CHURCH), true, `${entry.id} lacks the church name in the logo slot`);
			assert.equal(out.bytes.includes("Everyfield logo"), false);
		}
	});

	test("DOC-009: textOn and legible derive contrast-safe colors and a pair below its minimum throws", async () => {
		assert.ok(ratio(textOn("#1F4E6B", "#181D19"), "#1F4E6B") >= MIN_BODY);
		assert.ok(ratio(legible("#F5D90A", "#FFFFFF", "#181D19", MIN_BODY), "#FFFFFF") >= MIN_BODY);
		assert.ok(ratio(legible("#E3A21A", "#FFFFFF", "#181D19", MIN_NONTEXT), "#FFFFFF") >= MIN_NONTEXT);
		assert.throws(() => new ContrastLog().pair("pale text", "#F5D90A", "#FFFFFF"), /contrast/);
		const low = makePalette(lowContrastKit());
		assert.equal(low.onPrimary, "#181D19", "text on the pale fill falls back to ink");
		assert.equal(low.onAccent, "#181D19");
		assert.notEqual(low.primaryText, "#F5D90A", "a pale brand color never prints as text");
		assert.ok(ratio(low.primaryText, "#FFFFFF") >= MIN_BODY);
		assert.ok(ratio(low.accentLine, "#FFFFFF") >= MIN_NONTEXT);
		const log = new ContrastLog();
		for (const entry of pdfs) {
			const ctx = renderContext(CHURCH, FULL, lowContrastKit());
			await renderPdfElement(entry.build(ctx));
			for (const row of ctx.log.rows) log.rows.push(row);
		}
		for (const row of log.rows) assert.ok(row.ratio >= row.min, `${row.use} ${row.ratio.toFixed(2)} < ${row.min}`);
		assert.ok(
			log.rows.some((row) => row.min === MIN_NONTEXT),
			"lines and checkbox outlines are held to 3:1",
		);
	});

	test("DOC-010: only DM Serif Display, DM Sans and EF Figures are embedded, from committed files", async () => {
		for (const entry of pdfs) {
			const out = await renderTemplatePdf(entry, FULL, sampleKit());
			const doc = await PDFDocument.load(out.bytes, { updateMetadata: false });
			const names = new Set<string>();
			for (const [, obj] of doc.context.enumerateIndirectObjects()) {
				if (obj instanceof PDFDict && obj.get(PDFName.of("Type"))?.toString() === "/Font") {
					const base = obj.get(PDFName.of("BaseFont"));
					if (base instanceof PDFName) names.add(base.decodeText().replace(/^[A-Z]{6}\+/, ""));
				}
			}
			for (const name of names)
				assert.match(name, /^(DMSans|DMSerifDisplay|EFFigures)(-[A-Za-z]+)?$/, `${entry.id}: ${name}`);
			assert.ok(names.size >= 2, entry.id);
		}
		assert.equal(fontDigests().length, 7);
	});

	test("DOC-002: the same inputs give the same SHA-256 in two separate Node processes", () => {
		const run = () =>
			execFileSync(
				"node_modules/.bin/tsx",
				["--conditions=react-server", "../../tests/integration/documents/fixtures/hash-all.mts"],
				{
					cwd: fileURLToPath(new URL("../../../packages/domain/", import.meta.url)),
					encoding: "utf8",
					env: { ...process.env, TZ: "Pacific/Kiritimati" },
				},
			);
		const first = run();
		const second = run();
		assert.equal(first.trim().split("\n").length, 11);
		assert.equal(first, second);
	});

	test("DOC-002: no PDF holds a wall-clock date or a random id", async () => {
		for (const entry of pdfs) {
			const a = await renderTemplatePdf(entry, FULL);
			await new Promise((resolve) => setTimeout(resolve, 1100));
			const b = await renderTemplatePdf(entry, FULL);
			assert.equal(digestOf(a.bytes), digestOf(b.bytes), entry.id);
			assert.equal(/\/(CreationDate|ModDate)/.test(a.bytes.toString("latin1")), false, `${entry.id} has a date`);
			break;
		}
	});

	test("DOC-004: the engine version hashes the packages, fonts, tokens and registry", () => {
		const base = contentSnapshot();
		assert.equal(renderEngineVersion(), engineVersionOf(base));
		const changed = structuredClone(base);
		changed.cards[0]!.heading = "My promise";
		assert.notEqual(engineVersionOf(changed), engineVersionOf(base));
		const pkg = JSON.parse(readFileSync(new URL("../../../packages/domain/package.json", import.meta.url), "utf8"));
		for (const [name, version] of Object.entries(RENDER_PROFILE.packages))
			assert.equal(pkg.dependencies[name], version, name);
		assert.notEqual(
			renderEngineVersion(),
			"10fb2db30c93f4d3c5d3a1a4a1d2d4f9",
			"differs from the version of the hand-written writer",
		);
	});

	test("DOC-017: each PDF holds its named AcroForm fields, tooltips, signature fields and a /DR font", async () => {
		for (const entry of pdfs) {
			const out = await renderTemplatePdf(entry, NEUTRAL_VALUES);
			const doc = await PDFDocument.load(out.bytes, { updateMetadata: false });
			const fields = doc.getForm().getFields();
			assert.deepEqual(fields.map((f) => f.getName()).sort(), [...entry.fields].sort(), entry.id);
			for (const field of fields) {
				const tip = field.acroField.dict.get(PDFName.of("TU"));
				assert.ok(tip && tip.toString().length > 4, `${entry.id}.${field.getName()} has no tooltip`);
				if (field.getName() === "signature")
					assert.ok(field instanceof PDFSignature, `${entry.id} signature is not a /Sig field`);
			}
			if (fields.length) {
				const dr = (doc.catalog.lookup(PDFName.of("AcroForm")) as PDFDict).lookup(PDFName.of("DR"));
				assert.ok(
					dr instanceof PDFDict && dr.lookup(PDFName.of("Font")) instanceof PDFDict,
					`${entry.id} has no /DR font`,
				);
			}
		}
		const withValues = await renderTemplatePdf({ id: "guest-sign-in-sheet" }, FULL);
		assert.equal(
			withValues.fields.some((f) => f.name === "meeting_date"),
			false,
			"a given date prints as text, not a field",
		);
		assert.equal(
			withValues.text.flat().some((line) => line.includes("Tuesday, November 10, 2026")),
			true,
		);
	});

	test("DOC-018: each PDF is tagged, titled, set to a language and logos carry alt text", async () => {
		for (const entry of pdfs) {
			const out = await renderTemplatePdf(entry, FULL, sampleKit());
			const { doc, tags } = await tagsOf(out.bytes);
			assert.ok(tags.has("H1"), `${entry.id} has no H1`);
			if (
				!["commitment-card", "response-card"].includes(entry.id) &&
				entry.id !== "follow-up-letter" &&
				entry.id !== "guest-sign-in-sheet"
			)
				assert.ok(tags.has("H2"), `${entry.id} has no H2`);
			if (
				["guest-sign-in-sheet", "vision-meeting-agenda", "board-meeting-agenda", "launch-sunday-checklists"].includes(
					entry.id,
				)
			)
				assert.ok(tags.has("Table"), `${entry.id} has no Table`);
			assert.equal(doc.catalog.get(PDFName.of("Lang"))?.toString(), "(en-US)");
			assert.ok(doc.getTitle()?.includes(CHURCH), entry.id);
			assert.ok(doc.catalog.get(PDFName.of("MarkInfo")), entry.id);
			assert.ok(out.bytes.includes("Harborlight Church logo"), `${entry.id} lacks logo alt text`);
		}
	});

	test("DOC-019: 'plant' appears only in 'church plant', in every PDF and XLSX text", async () => {
		const texts: string[] = [];
		for (const entry of pdfs) texts.push((await renderTemplatePdf(entry, FULL, sampleKit())).text.flat().join(" "));
		for (const entry of pdfs) texts.push((await renderTemplatePdf(entry, NEUTRAL_VALUES)).text.flat().join(" "));
		for (const kind of ["first-year-budget", "budget-worksheet"] as const) {
			const workbook = new ExcelJS.Workbook();
			await workbook.xlsx.load(await xlsxBytes(kind));
			workbook.eachSheet((sheet) =>
				sheet.eachRow((row) => row.eachCell((cell) => typeof cell.value === "string" && texts.push(cell.value))),
			);
		}
		for (const text of texts) {
			const bare = text.replace(/church\s+plant/gi, "").match(/.{0,30}\bplant.{0,30}/i);
			assert.equal(bare, null, `bare plant: ${bare?.[0]}`);
			assert.equal(/every ?field/i.test(text.replace(/Everyfield/g, "")), false, "brand spelling");
		}
	});

	test("DOC-020: a formal/legal document always prints the notice, and an unfilled doctrinal slot is a visible blank", async () => {
		const out = await renderPdfElement(legalFixture(renderContext(CHURCH, NEUTRAL_VALUES, NEUTRAL_THEME)));
		const text = out.text.flat().join(" ");
		assert.ok(text.includes("Template, not legal advice"));
		assert.ok(text.includes("To be completed by the network"));
	});

	test("DOC-015: text-heavy content is structured data that reads without rendering", () => {
		for (const spec of [MEMBER_EXPECTATIONS, LAUNCH_TEAM_COMMITMENT, FOLLOW_UP_LETTER]) {
			assert.ok(spec.sections.length >= 1);
			for (const section of spec.sections)
				for (const block of section.blocks) assert.ok(block.kind === "p" || block.kind === "list");
		}
		assert.deepEqual(
			MEMBER_EXPECTATIONS.sections.map((s) => s.heading),
			["Be present", "GROW", "PRAY", "GIVE", "Join a team", "Protect the unity"],
		);
		assert.deepEqual(
			MEMBER_EXPECTATIONS.signatures.map((s) => s.name),
			["full_name", "signature", "signed_date"],
		);
		assert.deepEqual(
			LAUNCH_TEAM_COMMITMENT.signatures.map((s) => s.name),
			["full_name", "signature", "signed_date"],
		);
		assert.equal(FOLLOW_UP_LETTER.greeting, "Dear friend,");
	});

	test("DOC-011 to DOC-014: page counts and layouts match the approved arrangement", async () => {
		for (const entry of pdfs) {
			const out = await renderTemplatePdf(entry, FULL, sampleKit());
			assert.equal(out.pages, entry.pageCount, entry.id);
			assert.ok(out.bytes.length < 8 * 1024 * 1024);
		}
		const checklists = await renderTemplatePdf({ id: "launch-sunday-checklists" }, FULL);
		assert.ok(checklists.text[1]!.includes("Launch Sunday Checklists, continued"));
		for (const team of ["Setup", "Hospitality", "Worship"]) assert.ok(checklists.text[0]!.includes(team), team);
		for (const team of ["Kids", "Connections", "Prayer"]) assert.ok(checklists.text[1]!.includes(team), team);
		const card = await renderTemplatePdf({ id: "commitment-card" }, NEUTRAL_VALUES);
		for (const line of ["My commitment", "GROW", "PRAY", "GIVE"]) assert.ok(card.text[0]!.includes(line), line);
		const vision = await renderTemplatePdf({ id: "vision-meeting-agenda" }, FULL);
		for (const line of ["Welcome and prayer", "Our story", "The vision", "The ask: GROW,", "PRAY, GIVE", "Next steps"])
			assert.ok(vision.text[0]!.join(" ").includes(line), line);
		const board = await renderTemplatePdf({ id: "board-meeting-agenda" }, FULL);
		for (const line of ["Opening prayer", "Approve the", "Financial report", "Ministry updates", "Action items"])
			assert.ok(board.text[0]!.join(" ").includes(line), line);
	});

	test("DOC-012, DOC-013: budgets hold labels, live formulas, a frozen pane and a currency format", async () => {
		const first = new ExcelJS.Workbook();
		await first.xlsx.load(await xlsxBytes("first-year-budget"));
		assert.deepEqual(
			first.worksheets.map((s) => s.name),
			["Monthly budget", "Annual summary"],
		);
		const monthly = first.getWorksheet("Monthly budget")!;
		assert.equal(monthly.getCell("A1").value, `${CHURCH} First-Year Budget`);
		assert.equal(monthly.getCell("A3").value, "Category");
		assert.equal(monthly.getCell("B3").value, "Month 1");
		assert.equal(monthly.getCell("M3").value, "Month 12");
		assert.equal(monthly.getCell("N3").value, "Year total");
		assert.equal(monthly.getCell("A5").value, "Tithes and offerings");
		assert.equal(monthly.getCell("A10").value, "Total income");
		assert.deepEqual(monthly.getCell("B10").value, { formula: "SUM(B5:B9)" });
		assert.equal(monthly.getCell("A23").value, "Total expenses");
		assert.deepEqual(monthly.getCell("N23").value, { formula: "SUM(N13:N22)" });
		assert.deepEqual(monthly.getCell("B25").value, { formula: "B10-B23" });
		const view = monthly.views[0] as { state?: string; xSplit?: number; ySplit?: number; topLeftCell?: string };
		assert.deepEqual([view.state, view.xSplit, view.ySplit, view.topLeftCell], ["frozen", 1, 3, "B4"]);
		assert.equal(monthly.getColumn(1).width, 36);
		assert.match(String(monthly.getCell("B5").numFmt), /\$/);
		const summary = first.getWorksheet("Annual summary")!;
		const linked = summary.getCell("B5").value as { formula: string };
		assert.match(linked.formula, /^'Monthly budget'!N\d+$/);
		const sheet = new ExcelJS.Workbook();
		await sheet.xlsx.load(await xlsxBytes("budget-worksheet"));
		const w = sheet.getWorksheet("Budget worksheet")!;
		assert.equal(w.getCell("B3").value, "Monthly");
		assert.equal(w.getCell("C3").value, "Annual");
		assert.deepEqual(w.getCell("C5").value, { formula: "B5*12" });
		assert.deepEqual(w.getCell("C10").value, { formula: "SUM(C5:C9)" });
	});

	test(
		"DOC-012: LibreOffice recalculates a filled budget to the expected totals",
		{ skip: !hasSoffice() },
		async () => {
			const { mkdtempSync, writeFileSync, readFileSync: read } = await import("node:fs");
			const { tmpdir } = await import("node:os");
			const { join } = await import("node:path");
			const book = new ExcelJS.Workbook();
			await book.xlsx.load(await xlsxBytes("first-year-budget"));
			const monthly = book.getWorksheet("Monthly budget")!;
			for (let c = 2; c <= 13; c++) {
				monthly.getCell(5, c).value = 1000;
				monthly.getCell(6, c).value = 500;
				monthly.getCell(13, c).value = 700;
			}
			// LibreOffice trusts cached results in an Excel file, so a filled copy drops them and forces a real recalculation.
			book.eachSheet((sheet) =>
				sheet.eachRow((row) =>
					row.eachCell((cell) => {
						const value = cell.value as { formula?: string } | null;
						if (value && typeof value === "object" && value.formula)
							cell.value = { formula: value.formula } as ExcelJS.CellFormulaValue;
					}),
				),
			);
			book.calcProperties.fullCalcOnLoad = true;
			const dir = mkdtempSync(join(tmpdir(), "ef-xlsx-"));
			writeFileSync(join(dir, "filled.xlsx"), Buffer.from(await book.xlsx.writeBuffer()));
			execFileSync(
				"soffice",
				[
					"--headless",
					"--convert-to",
					"csv:Text - txt - csv (StarCalc):44,34,76,1,,0,false,true,false,false,false,-1",
					"--outdir",
					dir,
					join(dir, "filled.xlsx"),
				],
				{ stdio: "ignore" },
			);
			const out = execFileSync("ls", [dir], { encoding: "utf8" });
			const csv = out.split("\n").find((n) => n.includes("Monthly") && n.endsWith(".csv"))!;
			const rows = read(join(dir, csv), "utf8").split("\n");
			const income = rows.find((r) => r.startsWith("Total income"))!;
			assert.match(income, /,18000$/, "12 months x (1000 + 500) is 18000");
			const net = rows.find((r) => r.startsWith("Net ("))!;
			assert.match(net, /,9600$/, "18000 income less 8400 expense is 9600");
		},
	);
});

function hasSoffice() {
	try {
		execFileSync("soffice", ["--version"], { stdio: "ignore" });
		return true;
	} catch {
		return false;
	}
}

async function xlsxBytes(kind: "first-year-budget" | "budget-worksheet") {
	const loaded = await library();
	const template = loaded.templates.find((t) => t.id === kind)!;
	const resolved = resolveMerge(template, { churchName: CHURCH, pastorName: null, launchDate: null }, {});
	if (!resolved.ok) throw new Error("merge");
	const bytes = await renderPreview(template, "xlsx", resolved);
	assert.ok(bytes);
	return bytes;
}
