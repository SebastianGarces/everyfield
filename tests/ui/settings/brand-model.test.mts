// WP-104/ui: the pure rules of the Brand kit section (apps/web/src/features/settings/brand/model.ts and the Settings
// access rule). No browser, no database.
//   INV-brand-offered: only an Owner or Admin of a plant is offered "Brand kit", directly after "Church profile".
//   AC:CASE-BRD-005 (client half): a malformed EIN, website or email is refused with the contract's own schema.
//   AC:CASE-BRD-003 (client half): the pale yellow primary reads "fails text" and no preview text uses it.
//   AC:CASE-BRD-006: the email button of the full kit is the primary color with white text; no kit is neutral.
//   INV-brand-patch: a save sends only changed fields, and a cleared optional field is null.
import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_BODY_FONT, DEFAULT_HEADING_FONT } from "../../../packages/contracts/src/branding/values.ts";
import { colorView } from "../../../packages/domain/src/branding/color.ts";
import {
	colorOf,
	formOf,
	formatRatio,
	normalizeHex,
	optimisticKit,
	patchOf,
	themeOf,
	validate,
	type BrandForm,
} from "../../../apps/web/src/features/settings/brand/model.ts";
import {
	offeredSections,
	sectionAt,
	sectionRequest,
	SECTION_ORDER,
} from "../../../apps/web/src/features/settings/model.ts";

const PLANT = { kind: "plant", id: "00000000-0000-4000-8000-000000000001" } as const;
const ORG = {
	kind: "organization",
	id: "00000000-0000-4000-8000-000000000002",
	organizationKind: "sending_church",
} as const;
const empty = {
	primaryColor: null,
	accentColor: null,
	headingFont: DEFAULT_HEADING_FONT,
	bodyFont: DEFAULT_BODY_FONT,
	legalName: null,
	address: null,
	website: null,
	phone: null,
	email: null,
	ein: null,
	tagline: null,
	signerName: null,
	signerTitle: null,
	assets: { full_logo: null, full_logo_dark: null, mark: null, mark_dark: null, cover_photo: null, signature: null },
	kitState: "default",
	revision: "0",
	colors: { primary: null, accent: null },
} as const;
const defaults = formOf(empty as never);
const full: BrandForm = {
	...defaults,
	primaryColor: "#1F4E79",
	accentColor: "#D4A017",
	address: "1200 Main Street, Austin, TX 78701",
	ein: "12-3456789",
};

test("INV-brand-offered: Owner and Admin of a plant see Brand kit after Church profile; nobody else does", () => {
	for (const role of ["owner", "admin"] as const) {
		const offered = offeredSections({ context: "plant", accountId: "a", plant: PLANT, role }, []);
		assert.equal(offered[offered.indexOf("church") + 1], "brand");
	}
	const others = [
		{ context: "plant", accountId: "a", plant: PLANT, role: "member" },
		{ context: "organization", accountId: "a", organization: ORG, role: "owner" },
		{ context: "account", accountId: "a" },
	] as const;
	for (const viewer of others) assert.ok(!offeredSections(viewer, []).includes("brand"), JSON.stringify(viewer));
	assert.deepEqual(SECTION_ORDER.slice(0, 2), ["church", "brand"]);
});

test("a /settings/brand address opens the brand section and makes no settings-section read", () => {
	const owner = { context: "plant", accountId: "a", plant: PLANT, role: "owner" } as const;
	assert.equal(sectionAt("/settings/brand", owner), "brand");
	assert.equal(sectionRequest(owner, "brand"), null);
});

test("CASE-BRD-005: the EIN, website and email follow the contract and show on their own field", () => {
	const errors = validate(
		{ ...full, ein: "123456789", website: "http://example.org", email: "nope" },
		{ required: true },
	);
	assert.equal(errors.ein, "Use the format 12-3456789.");
	assert.ok(errors.website?.includes("https://"));
	assert.equal(errors.email, "Enter a full email address.");
	assert.deepEqual(validate(full, { required: true }), {});
	// Every letterhead field is optional: an empty one is no error.
	assert.deepEqual(validate({ ...full, ein: "", website: "", email: "" }, { required: true }), {});
});

test("a color must be #RRGGBB; a missing primary color shows only when Save was pressed", () => {
	assert.equal(
		validate({ ...defaults, primaryColor: "#12" }, { required: false }).primaryColor,
		"Use the form #RRGGBB.",
	);
	assert.equal(validate({ ...defaults, accentColor: "red" }, { required: false }).accentColor, "Use the form #RRGGBB.");
	assert.equal(validate(defaults, { required: false }).primaryColor, undefined);
	assert.equal(validate(defaults, { required: true }).primaryColor, "Choose a primary color.");
	assert.equal(normalizeHex(" 1f4e79 "), "#1F4E79");
	assert.equal(normalizeHex(""), "");
});

test("CASE-BRD-003: the contrast badge equals the server's colorView, to two decimals", () => {
	const pale = colorOf("#FFF3B0");
	assert.equal(pale?.badge, "fails_text");
	assert.deepEqual(pale, colorView("#FFF3B0" as never));
	assert.equal(formatRatio(colorOf("#767676")!.contrast), "4.54:1");
	assert.equal(colorOf("#1F4E79")?.badge, "passes_text");
	assert.equal(colorOf("#1F4E"), null);
});

test("CASE-BRD-003: with the pale yellow primary and no accent, no text is set in it and the accent falls back", () => {
	const form = { ...defaults, primaryColor: "#FFF3B0" };
	for (const documentClass of ["formal/legal", "outward-facing", "operational", "email"] as const) {
		const theme = themeOf("Harvest Point Church", form, documentClass);
		assert.equal(theme.kind, "church");
		assert.notEqual(theme.colors.heading, "#FFF3B0");
		assert.notEqual(theme.colors.ink, "#FFF3B0");
		assert.equal(theme.colors.accent, "#FFF3B0");
	}
	const kit = optimisticKit(empty as never, form);
	assert.equal(kit.colors.accent?.hex, "#FFF3B0");
	assert.equal(kit.colors.accent?.badge, "fails_text");
});

test("CASE-BRD-006: the full kit's email button is the primary color with white text; no kit is the neutral theme", () => {
	const email = themeOf("Harvest Point Church", full, "email");
	assert.equal(email.layout.documentClass === "email" && email.layout.button.fill, "#1F4E79");
	assert.equal(email.layout.documentClass === "email" && email.layout.button.text, "#FFFFFF");
	assert.equal(email.layout.documentClass === "email" && email.layout.logoMaxWidthPx, 200);
	const operational = themeOf("Harvest Point Church", full, "operational");
	assert.equal(operational.layout.documentClass === "operational" && operational.layout.tableHeader.fill, "#D4A017");
	for (const documentClass of ["formal/legal", "outward-facing", "operational", "email"] as const) {
		const neutral = themeOf("Harvest Point Church", defaults, documentClass);
		assert.equal(neutral.kind, "everyfield-neutral");
		assert.equal(neutral.churchName, "Harvest Point Church");
	}
});

test("INV-brand-patch: only changed fields are sent, and a cleared optional field is null", () => {
	const saved = full;
	assert.deepEqual(patchOf(saved, saved), {});
	assert.deepEqual(patchOf({ ...saved, accentColor: "", ein: "", tagline: " Hello " }, saved), {
		accentColor: null,
		ein: null,
		tagline: "Hello",
	});
	assert.deepEqual(patchOf({ ...saved, primaryColor: "#000000", headingFont: "Lora" }, saved), {
		primaryColor: "#000000",
		headingFont: "Lora",
	});
});

test("the default kit shows DM Serif Display and DM Sans and empty controls", () => {
	assert.equal(defaults.headingFont, DEFAULT_HEADING_FONT);
	assert.equal(defaults.bodyFont, DEFAULT_BODY_FONT);
	assert.equal(defaults.primaryColor, "");
	assert.equal(defaults.accentColor, "");
});
