// WP-036 slice 3: what the PDF paints for one document (the palette and the brand-kit images), and the format's image
// node printing the kit's own assets: `logo` the full logo, `mark` the mark, `photo` the cover photo. No database.
import assert from "node:assert/strict";
import test from "node:test";
import sharp from "../../../packages/db/node_modules/sharp/dist/index.mjs";
import { PDFDocument, PDFName } from "../../../packages/domain/node_modules/pdf-lib/cjs/index.js";
import { docDocument, forkTemplate, type DocDocument } from "../../../packages/contracts/src/documents/format/index.ts";
import type { BrandKitData } from "../../../packages/contracts/src/branding/index.ts";
import {
	documentBrand,
	NEUTRAL_EXPORT_THEME,
	type ExportTheme,
} from "../../../packages/domain/src/documents/church-theme.ts";
import { renderDocFile, renderDocPdf } from "../../../packages/domain/src/documents/doc-render.ts";
import { docTemplateById } from "../../../packages/domain/src/documents/doc-templates.ts";
import { makePalette, tokenColor, type ThemeImage } from "../../../packages/domain/src/documents/theme.ts";
import { MIN_BODY, ratio, textOn } from "../../../packages/domain/src/documents/contrast.ts";
import { docxMedia } from "./fixtures/readers.mts";
import { createHash } from "node:crypto";

const kit = (patch: Partial<BrandKitData> = {}): BrandKitData =>
	({
		primaryColor: "#1F4E6B",
		accentColor: "#D4731A",
		headingFont: "dm-serif-display",
		bodyFont: "dm-sans",
		assets: {
			full_logo: { fileId: "11111111-1111-4111-8111-111111111111", alt: "Logo" },
			full_logo_dark: null,
			mark: null,
			mark_dark: null,
			cover_photo: { fileId: "22222222-2222-4222-8222-222222222222", alt: "Cover" },
			signature: null,
		},
		...patch,
	}) as unknown as BrandKitData;

test("AC:CASE-BRD-006 the brand of a document is the palette the PDF paints, and the kit's images it may show", () => {
	const themed = documentBrand(kit(), true);
	const palette = makePalette({ name: "church", primary: "#1F4E6B", accent: "#D4731A" });
	assert.equal(themed.palette.themed, true);
	for (const key of ["ink", "mutedText", "muted", "border", "primary", "accent", "accentLine", "primaryText"] as const)
		assert.equal(themed.palette[key], palette[key], key);
	assert.equal(themed.palette.on.primary, palette.onPrimary);
	assert.equal(themed.palette.on.accent, palette.onAccent);
	// Every token the format has maps to a swatch color the renderer's own table gives.
	for (const token of ["ink", "muted-text", "primary", "accent", "muted", "border"] as const)
		assert.equal(tokenColor(palette, token), themed.palette[token === "muted-text" ? "mutedText" : token]);
	assert.deepEqual(themed.assets, {
		logo: { fileId: "11111111-1111-4111-8111-111111111111", alt: "Logo" },
		mark: null,
		photo: { fileId: "22222222-2222-4222-8222-222222222222", alt: "Cover" },
	});
	// With church branding off, or with no kit or no primary color, the neutral theme paints and no church image shows.
	const neutral = makePalette(NEUTRAL_EXPORT_THEME.render);
	for (const brand of [
		documentBrand(kit(), false),
		documentBrand(null, true),
		documentBrand(kit({ primaryColor: null }), true),
	]) {
		assert.equal(brand.palette.themed, false);
		assert.equal(brand.palette.primary, neutral.primary);
		assert.equal(brand.palette.accent, neutral.accent);
		assert.deepEqual(brand.assets, { logo: null, mark: null, photo: null });
	}
});

const png = async (width: number, height: number, color: string): Promise<ThemeImage> => ({
	bytes: new Uint8Array(
		await sharp({ create: { width, height, channels: 3, background: color } })
			.png()
			.toBuffer(),
	),
	mediaType: "image/png",
	alt: `${width} by ${height}`,
	aspect: width / height,
});

test("AC:CASE-BRD-006 an image node prints the full logo, the mark or the cover photo, in the PDF and the Word file", async () => {
	const logo = await png(600, 200, "#1F4E6B");
	const mark = await png(360, 360, "#D4731A");
	const photo = await png(900, 600, "#4D5361");
	const theme: ExportTheme = {
		...NEUTRAL_EXPORT_THEME,
		kind: "church",
		primary: "#1F4E6B",
		render: {
			...NEUTRAL_EXPORT_THEME.render,
			name: "church",
			primary: "#1F4E6B",
			accent: "#D4731A",
			images: { logo, mark, photo },
		},
	};
	const base = await forkTemplate(docTemplateById("conflict-of-interest-policy")!, {
		data: { church_name: "Harbor City Church", church_legal_name: "Harbor City Church, Inc." },
	});
	const doc = {
		...base,
		body: {
			type: "doc",
			content: (["logo", "mark", "photo"] as const).map((source) => ({
				type: "image",
				attrs: { source, width: 120, height: source === "photo" ? 80 : 40 },
			})),
		},
	} as unknown as DocDocument;
	assert.ok(docDocument.safeParse(doc).success, "the document parses");
	const pdf = await PDFDocument.load((await renderDocPdf(doc, theme.render)).bytes);
	const sizes: number[][] = [];
	for (const [, object] of pdf.context.enumerateIndirectObjects()) {
		const dict = (object as { dict?: { get(name: unknown): unknown } }).dict;
		if (dict?.get(PDFName.of("Subtype"))?.toString() === "/Image")
			sizes.push([Number(dict.get(PDFName.of("Width"))), Number(dict.get(PDFName.of("Height")))]);
	}
	for (const [source, image, size] of [
		["logo", logo, [600, 200]],
		["mark", mark, [360, 360]],
		["photo", photo, [900, 600]],
	] as const)
		assert.ok(
			sizes.some(([w, h]) => w === size[0] && h === size[1]),
			`the PDF holds the ${source}: ${JSON.stringify(sizes)} (${image.alt})`,
		);
	const media = Object.values(docxMedia(await renderDocFile(doc, "docx", theme, new Date(0))));
	for (const image of [logo, mark, photo])
		assert.ok(
			media.includes(createHash("sha256").update(image.bytes).digest("hex")),
			`the Word file holds ${image.alt}`,
		);
});

// documents/doc-3: on a mid-tone fill neither white nor the ink reaches 4.5:1, so text on it falls back to black.
const MID_TONES = ["#E53935", "#E91E63", "#D9534F"] as const;
const INK = makePalette(NEUTRAL_EXPORT_THEME.render).ink;

test("AC:CASE-BRD-003 text on a mid-tone brand fill reaches 4.5:1", () => {
	for (const fill of MID_TONES) {
		assert.ok(ratio("#FFFFFF", fill) < MIN_BODY && ratio(INK, fill) < MIN_BODY, `${fill} is a mid tone`);
		const on = textOn(fill, INK);
		assert.equal(on, "#000000", fill);
		assert.ok(ratio(on, fill) >= MIN_BODY, `${on} on ${fill} is ${ratio(on, fill).toFixed(2)}:1`);
	}
	// A fill white or the ink already clears keeps that color.
	assert.equal(textOn("#1F4E6B", INK), "#FFFFFF");
	assert.equal(textOn("#F4F1EA", INK), INK);
});

test("AC:CASE-BRD-006 the commitment card and the budget worksheet render with a mid-tone brand color", async () => {
	for (const color of MID_TONES)
		for (const slot of ["accent", "primary"] as const)
			for (const id of ["commitment-card", "budget-worksheet"]) {
				const doc = await forkTemplate(docTemplateById(id)!, { data: { church_name: "Harbor City Church" } });
				const theme = { ...NEUTRAL_EXPORT_THEME.render, name: "church", primary: "#1F4E6B", accent: "#D4731A" };
				const pdf = await renderDocPdf(doc, { ...theme, [slot]: color });
				assert.ok(pdf.pages >= 1, `${id} with ${slot} ${color}`);
			}
});
