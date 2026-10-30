import assert from "node:assert/strict";
import { test } from "node:test";
import * as b from "@everyfield/contracts/branding";

const id = "7b0f1c2e-4d5a-4b6c-8d7e-9f0a1b2c3d4e";

test("AC:CASE-BRD-001 each brand request parses one valid and refuses one invalid value", () => {
	const cases: [string, import("zod").ZodType, unknown, unknown][] = [
		["get", b.getRequest, {}, { extra: 1 }],
		[
			"saveSettings",
			b.saveSettingsRequest,
			{ expectedRevision: "0", patch: { primaryColor: "#8b1e3f" } },
			{ expectedRevision: "0", patch: {} },
		],
		[
			"uploadRequest",
			b.uploadRequest,
			{ slot: "full_logo", mediaType: "image/png", byteLength: 1200, altText: "Harvest Point logo" },
			{ slot: "full_logo", mediaType: "image/gif", byteLength: 1200, altText: "x" },
		],
		[
			"finalizeUpload",
			b.finalizeUploadRequest,
			{ uploadId: id, slot: "mark", altText: "Mark", expectedRevision: "1" },
			{ uploadId: "nope", slot: "mark", altText: "Mark", expectedRevision: "1" },
		],
		["suggestColors", b.suggestColorsRequest, { assetKind: "full_logo" }, { assetKind: "banner" }],
		["reset", b.resetRequest, { expectedRevision: "3" }, { expectedRevision: -1 }],
		["resolveTheme", b.resolveThemeRequest, { documentClass: "email" }, { documentClass: "poster" }],
	];
	for (const [name, schema, valid, invalid] of cases) {
		assert.equal(schema.safeParse(valid).success, true, `${name} valid`);
		assert.equal(schema.safeParse(invalid).success, false, `${name} invalid`);
	}
});

test("colors are stored upper case and fonts come from the curated list", () => {
	assert.equal(b.hexColor.parse("#f2d74a"), "#F2D74A");
	assert.equal(b.hexColor.safeParse("red").success, false);
	assert.equal(b.fontId.safeParse("Papyrus").success, false);
	assert.deepEqual(
		b.FONTS.filter((font) => ["DM Serif Display", "DM Sans"].includes(font.id)).map((font) => font.style),
		["serif", "sans"],
	);
	assert.equal(b.resolveThemeRequest.parse({ documentClass: "email" }).useChurchBranding, true);
});

test("the document theme has no Everyfield logo field and a closed class union", () => {
	assert.deepEqual(b.documentClass.options, ["formal/legal", "outward-facing", "operational", "email"]);
	assert.deepEqual(
		b.documentTheme.options.map((o) => o.shape.kind.value),
		["church", "everyfield-neutral"],
	);
	const text = JSON.stringify(b.themeLayout.options.map((o) => Object.keys(o.shape)));
	assert.equal(/everyfield/i.test(text), false);
});
