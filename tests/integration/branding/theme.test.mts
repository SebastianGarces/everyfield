import {
	documentTheme,
	type BrandKitData,
	type DocumentClass,
} from "../../../packages/contracts/src/branding/index.ts";
import { badgeFor, colorView, contrastOnWhite, textOn } from "../../../packages/domain/src/branding/color.ts";
import { resolveDocumentTheme } from "../../../packages/domain/src/branding/theme.ts";
import test, { describe } from "node:test";
import assert from "node:assert/strict";

const asset = (name: string) => ({
	fileId: `00000000-0000-4000-8000-00000000000${name.length % 10}`,
	alt: `${name} alt`,
});
// The CASE-BRD-006 kit.
const kit = (over: Partial<BrandKitData> = {}): BrandKitData => ({
	primaryColor: "#1F4E79",
	accentColor: "#D4A017",
	headingFont: "DM Serif Display",
	bodyFont: "DM Sans",
	legalName: "Harvest Point Church",
	address: "12 Main St, Austin, TX",
	website: "https://harvestpoint.example",
	phone: "512-555-0100",
	email: "hello@harvestpoint.example",
	ein: "12-3456789",
	tagline: "Come home",
	signerName: "Ada Pastor",
	signerTitle: "Lead Pastor",
	assets: {
		full_logo: asset("Full logo"),
		full_logo_dark: null,
		mark: asset("Mark"),
		mark_dark: null,
		cover_photo: asset("Cover"),
		signature: asset("Signature"),
	},
	...over,
});
const church = (k: BrandKitData | null) => ({ name: "Harvest Point", kit: k });
const CLASSES: DocumentClass[] = ["formal/legal", "outward-facing", "operational", "email"];
const ink = "#1A1A1A";

describe("WP-104/api colors and contrast", () => {
	test("AC:CASE-BRD-003 contrast follows WCAG 2.x against white, with the derived text color", () => {
		assert.equal(colorView("#F2D74A").contrast, 1.44);
		assert.deepEqual(colorView("#F2D74A"), {
			hex: "#F2D74A",
			contrast: 1.44,
			badge: "fails_text",
			textColor: "#000000",
		});
		assert.equal(contrastOnWhite("#FFFFFF"), 1);
		assert.equal(contrastOnWhite("#000000"), 21);
		assert.deepEqual(
			[badgeFor(4.5), badgeFor(4.49), badgeFor(3), badgeFor(2.99)],
			["passes_text", "large_text_only", "large_text_only", "fails_text"],
		);
		assert.equal(colorView("#1F4E79").badge, "passes_text");
		assert.equal(textOn("#1F4E79"), "#FFFFFF");
		assert.equal(colorView("#C9A227").badge, "fails_text");
	});

	test("the derived text color reaches 4.5:1 on any fill", () => {
		for (let r = 0; r < 256; r += 51)
			for (let g = 0; g < 256; g += 51)
				for (let b = 0; b < 256; b += 51) {
					const fill =
						"#" +
						[r, g, b]
							.map((v) => v.toString(16).padStart(2, "0"))
							.join("")
							.toUpperCase();
					const text = textOn(fill);
					const l = (hex: string) => (contrastOnWhite(hex) === 0 ? 0 : 1.05 / contrastOnWhite(hex) - 0.05);
					const [hi, lo] = [Math.max(l(fill), l(text)), Math.min(l(fill), l(text))];
					assert.ok((hi + 0.05) / (lo + 0.05) >= 4.5, `${fill} on ${text}`);
				}
	});
});

describe("WP-104/api resolveDocumentTheme", () => {
	test("AC:CASE-BRD-006 formal/legal: small header logo, primary on rules and headings, neutral body, EIN footer, page numbers", () => {
		const theme = resolveDocumentTheme(church(kit()), "formal/legal");
		assert.equal(theme.kind, "church");
		assert.equal(theme.colors.heading, "#1F4E79");
		assert.equal(theme.colors.rule, "#1F4E79");
		assert.equal(theme.colors.ink, ink);
		assert.equal(theme.layout.documentClass, "formal/legal");
		if (theme.layout.documentClass !== "formal/legal") return;
		assert.deepEqual(theme.layout.headerLogo, { fileId: kit().assets.full_logo?.fileId, alt: "Full logo alt" });
		assert.equal(theme.layout.headerLogoHeightMm, 14);
		assert.deepEqual(theme.layout.footer, {
			name: "Harvest Point Church",
			address: "12 Main St, Austin, TX",
			ein: "12-3456789",
		});
		assert.equal(theme.layout.pageNumbers, true);
		assert.equal(theme.layout.signature.name, "Ada Pastor");
		assert.equal(theme.layout.signature.image?.alt, "Signature alt");
	});

	test("AC:CASE-BRD-006 outward-facing: large cover logo, both colors, brand fonts, photo, tagline and contact details", () => {
		const theme = resolveDocumentTheme(church(kit()), "outward-facing");
		assert.deepEqual([theme.colors.primary, theme.colors.accent], ["#1F4E79", "#D4A017"]);
		assert.deepEqual(theme.fonts, { heading: "DM Serif Display", body: "DM Sans" });
		assert.equal(theme.fallbackUsed, false);
		if (theme.layout.documentClass !== "outward-facing") throw Error("class");
		assert.equal(theme.layout.coverLogoHeightMm, 40);
		assert.equal(theme.layout.coverLogo?.alt, "Full logo alt");
		assert.equal(theme.layout.coverPhoto?.alt, "Cover alt");
		assert.equal(theme.layout.tagline, "Come home");
		assert.deepEqual(theme.layout.contact, {
			address: "12 Main St, Austin, TX",
			website: "https://harvestpoint.example",
			phone: "512-555-0100",
			email: "hello@harvestpoint.example",
		});
	});

	test("AC:CASE-BRD-006 operational: small mark, accent fill on table headers and checkboxes with the derived text color", () => {
		const theme = resolveDocumentTheme(church(kit()), "operational");
		if (theme.layout.documentClass !== "operational") throw Error("class");
		assert.equal(theme.layout.mark?.alt, "Mark alt");
		assert.equal(theme.layout.markHeightMm, 10);
		assert.deepEqual(theme.layout.tableHeader, { fill: "#D4A017", text: "#000000" });
		assert.deepEqual(theme.layout.checkbox, { fill: "#D4A017", text: "#000000" });
	});

	test("AC:CASE-BRD-006 email: logo at most 200 px, primary-color button with derived text, web-safe stacks, footer with name and address", () => {
		const theme = resolveDocumentTheme(church(kit()), "email");
		assert.equal(theme.fonts.heading, "Georgia, 'Times New Roman', serif");
		assert.equal(theme.fonts.body, "Arial, Helvetica, sans-serif");
		assert.equal(theme.fallbackUsed, true);
		if (theme.layout.documentClass !== "email") throw Error("class");
		assert.equal(theme.layout.logoMaxWidthPx, 200);
		assert.deepEqual(theme.layout.button, { fill: "#1F4E79", text: "#FFFFFF" });
		// The button follows the primary color of any kit, not the example value.
		for (const [primaryColor, text] of [["#8B1E3F", "#FFFFFF"], ["#F2D74A", "#000000"]] as const) {
			const other = resolveDocumentTheme(church(kit({ primaryColor })), "email").layout;
			if (other.documentClass !== "email") throw Error("class");
			assert.deepEqual(other.button, { fill: primaryColor, text });
		}
		assert.deepEqual(theme.layout.footer, { churchName: "Harvest Point", address: "12 Main St, Austin, TX" });
	});

	test("AC:CASE-BRD-006 a color under 3:1 is never a heading or text color in any class", () => {
		const yellow = kit({ primaryColor: "#F2D74A", accentColor: null });
		for (const documentClass of CLASSES) {
			const theme = resolveDocumentTheme(church(yellow), documentClass);
			assert.equal(theme.kind, "church");
			assert.equal(theme.colors.heading, ink, documentClass);
			assert.equal(theme.colors.ink, ink);
			// The color stays on rules and fills, with the derived text color on the fill.
			assert.equal(theme.colors.rule, "#F2D74A");
			if (theme.layout.documentClass === "operational") {
				assert.deepEqual(theme.layout.tableHeader, { fill: "#F2D74A", text: "#000000" });
				assert.deepEqual(theme.layout.checkbox, { fill: "#F2D74A", text: "#000000" });
			}
		}
		// A color at 3:1 or more may head a section.
		assert.equal(
			resolveDocumentTheme(church(kit({ primaryColor: "#8B1E3F" })), "formal/legal").colors.heading,
			"#8B1E3F",
		);
	});

	test("every logo in a theme carries its alt text", () => {
		for (const documentClass of CLASSES) {
			const layout = resolveDocumentTheme(church(kit()), documentClass).layout as Record<string, unknown>;
			const logos = Object.values(layout).filter((value) => value && typeof value === "object" && "fileId" in value);
			assert.ok(logos.length >= 1, documentClass);
			for (const logo of logos as { alt: string }[]) assert.ok(logo.alt.length > 0);
		}
	});

	test("AC:CASE-BRD-006-NEUTRAL the neutral theme sets the church name in type, has no logo and keeps the slot sizes", () => {
		const cases = [
			resolveDocumentTheme(church(null), "outward-facing"),
			resolveDocumentTheme(church(kit({ primaryColor: null })), "outward-facing"),
			resolveDocumentTheme(church(kit()), "outward-facing", { useChurchBranding: false }),
		];
		for (const theme of cases) {
			assert.equal(theme.kind, "everyfield-neutral");
			assert.equal(theme.churchName, "Harvest Point");
			assert.deepEqual([theme.colors.primary, theme.colors.accent], [null, null]);
			if (theme.layout.documentClass !== "outward-facing") throw Error("class");
			assert.deepEqual([theme.layout.coverLogo, theme.layout.coverPhoto, theme.layout.tagline], [null, null, null]);
			assert.equal(theme.layout.coverLogoHeightMm, 40);
		}
		for (const documentClass of CLASSES) {
			const neutral = resolveDocumentTheme(church(null), documentClass);
			const branded = resolveDocumentTheme(church(kit()), documentClass);
			const sizes = (layout: object) =>
				Object.fromEntries(Object.entries(layout).filter(([key]) => /Mm$|Px$/.test(key)));
			assert.deepEqual(sizes(neutral.layout), sizes(branded.layout), documentClass);
			documentTheme.parse(neutral);
			documentTheme.parse(branded);
		}
	});

	test("AC:CASE-DOC-017-CHURCH the church theme for the CASE-DOC-017 kit", () => {
		const doc017 = kit({ primaryColor: "#8B1E3F", accentColor: "#C9A227" });
		const theme = resolveDocumentTheme(church(doc017), "outward-facing", { useChurchBranding: true });
		assert.equal(theme.kind, "church");
		assert.deepEqual(
			[theme.colors.primary, theme.colors.accent, theme.fonts.heading, theme.fallbackUsed],
			["#8B1E3F", "#C9A227", "DM Serif Display", false],
		);
	});

	test("an accent that is absent resolves to the primary color", () => {
		const theme = resolveDocumentTheme(church(kit({ accentColor: null })), "operational");
		assert.equal(theme.colors.accent, "#1F4E79");
	});
});
