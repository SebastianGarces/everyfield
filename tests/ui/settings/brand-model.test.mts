// WP-104/ui: the pure rules of the Brand kit section (apps/web/src/features/settings/brand/model.ts and the Settings
// access rule). No browser, no database.
//   INV-brand-offered: only an Owner or Admin of a plant is offered "Brand kit", directly after "Church profile".
//   AC:CASE-BRD-005 (client half): a malformed EIN, website or email is refused with the contract's own schema.
//   AC:CASE-BRD-003 (client half): the pale yellow primary reads "fails text" and no preview text uses it.
//   AC:CASE-BRD-006: the email button of the full kit is the primary color with white text; no kit is neutral.
//   BUG-T123: the preview's text on a brand fill is the color the PDF renderer prints there (#767676 included).
//   INV-brand-patch: a save sends only changed fields, and a cleared optional field is null.
import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_BODY_FONT, DEFAULT_HEADING_FONT } from "../../../packages/contracts/src/branding/values.ts";
import { colorView, DOCUMENT_INK, textOn } from "../../../packages/domain/src/branding/color.ts";
import { makePalette } from "../../../packages/domain/src/documents/theme.ts";
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
	firstSection,
	offeredSections,
	sectionAt,
	sectionRequest,
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
	for (const role of ["owner", "admin"] as const)
		assert.deepEqual(offeredSections({ context: "plant", accountId: "a", plant: PLANT, role }, []), [
			"church",
			"brand",
			"notifications",
			"account",
		]);
	const others = [
		[{ context: "plant", accountId: "a", plant: PLANT, role: "member" }, ["notifications", "account"]],
		[
			{ context: "organization", accountId: "a", organization: ORG, role: "owner" },
			["organization", "notifications", "account"],
		],
		[{ context: "account", accountId: "a" }, ["notifications", "account"]],
	] as const;
	for (const [viewer, sections] of others)
		assert.deepEqual(offeredSections(viewer, []), sections, JSON.stringify(viewer));
});

test("INV-settings-seats-link: a viewer with a workspace is offered Seats; an account-context viewer is not", () => {
	const member = { context: "plant", accountId: "a", plant: PLANT, role: "member" } as const;
	assert.deepEqual(offeredSections(member, ["seats"]), ["seats", "notifications", "account"]);
	const account = { context: "account", accountId: "a" } as const;
	assert.deepEqual(offeredSections(account, ["seats"]), ["notifications", "account"]);
});

test("INV-settings-sharing-link: a plant viewer is offered Sharing after Notifications; nobody else is", () => {
	const pages = ["seats", "sharing"] as const;
	const owner = { context: "plant", accountId: "a", plant: PLANT, role: "owner" } as const;
	assert.deepEqual(offeredSections(owner, pages), ["church", "brand", "seats", "notifications", "sharing", "account"]);
	const member = { context: "plant", accountId: "a", plant: PLANT, role: "member" } as const;
	assert.deepEqual(offeredSections(member, pages), ["seats", "notifications", "sharing", "account"]);
	const organization = { context: "organization", accountId: "a", organization: ORG, role: "owner" } as const;
	assert.deepEqual(offeredSections(organization, pages), ["organization", "seats", "notifications", "account"]);
	const account = { context: "account", accountId: "a" } as const;
	assert.deepEqual(offeredSections(account, pages), ["notifications", "account"]);
});

test("INV-settings-sharing-link: /settings never opens on a page section", () => {
	const plant = { context: "plant", accountId: "a", plant: PLANT } as const;
	assert.equal(firstSection({ ...plant, role: "owner" }), "church");
	assert.equal(firstSection({ ...plant, role: "member" }), "notifications");
});

test("INV-brand-offered: a /settings/brand address opens the brand section and makes no settings-section read", () => {
	const owner = { context: "plant", accountId: "a", plant: PLANT, role: "owner" } as const;
	assert.equal(sectionAt("/settings/brand", owner), "brand");
	assert.equal(sectionRequest(owner, "brand"), null);
});

test("AC:CASE-BRD-005 the EIN, website and email follow the contract and show on their own field", () => {
	assert.deepEqual(
		validate({ ...full, ein: "123456789", website: "http://example.org", email: "nope" }, { required: true }),
		{
			ein: "Use the format 12-3456789.",
			website: "Start with https://, for example https://example.org.",
			email: "Enter a full email address.",
		},
	);
	assert.deepEqual(validate(full, { required: true }), {});
	// Every letterhead field is optional: an empty one is no error.
	assert.deepEqual(validate({ ...full, ein: "", website: "", email: "" }, { required: true }), {});
});

test("INV-brand-form: a color must be #RRGGBB; a missing primary color shows only when Save was pressed", () => {
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

test("AC:CASE-BRD-003 the contrast badge equals the server's colorView, to two decimals", () => {
	const pale = colorOf("#FFF3B0");
	assert.equal(pale?.badge, "fails_text");
	assert.deepEqual(pale, colorView("#FFF3B0" as never));
	assert.equal(formatRatio(colorOf("#767676")!.contrast), "4.54:1");
	assert.equal(colorOf("#1F4E79")?.badge, "passes_text");
	assert.equal(colorOf("#1F4E"), null);
});

test("AC:CASE-BRD-003 with the pale yellow primary and no accent, no text is set in it and the accent falls back", () => {
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

test("AC:CASE-BRD-006 the full kit's email button is the primary color with white text; no kit is the neutral theme", () => {
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

test("BUG-58bc5acb8: on #767676 the preview sets the text the PDF prints: white, by the renderer's rule and ink", () => {
	for (const fill of ["#767676", "#1F4E79", "#D4A017", "#FFF3B0", "#9CA3AF", "#E5E7EB"]) {
		const palette = makePalette({ name: "church", primary: fill, accent: fill });
		assert.equal(DOCUMENT_INK, palette.ink, "the preview's ink is the renderer's");
		// The cover band of the outward-facing preview: textOn(band, DOCUMENT_INK).
		assert.equal(textOn(fill, DOCUMENT_INK), palette.onPrimary, `text on ${fill}`);
		const operational = themeOf("Harvest Point Church", { ...defaults, primaryColor: fill }, "operational");
		assert.ok(operational.layout.documentClass === "operational");
		assert.equal(operational.layout.tableHeader.text, palette.onAccent, `table header text on ${fill}`);
		assert.equal(operational.layout.checkbox.text, palette.onAccent);
	}
	assert.equal(textOn("#767676", DOCUMENT_INK), "#FFFFFF");
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
