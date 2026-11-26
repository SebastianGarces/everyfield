import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test, { after } from "node:test";
import sharp from "../../../packages/db/node_modules/sharp/dist/index.mjs";
import { sql, type SQL } from "../../../packages/db/src/query.ts";
import { RequestActor } from "../../../packages/domain/src/access/session.ts";
import {
	brandReader,
	brandWriter,
	readBrandAsset,
	uploadBrandAsset,
} from "../../../packages/domain/src/branding/index.ts";
import { documentsWriter } from "../../../packages/domain/src/documents/index.ts";
import { fixture, ok, refused, type Actor } from "../../support/fixture.mts";
import { pdfOperators } from "../documents/fixtures/readers.mts";
import { MemoryClient } from "../documents/storage.mts";

type Kit = {
	revision?: number;
	primary_color: string;
	accent_color?: string;
	heading_font?: string | null;
	body_font?: string | null;
	legal_name?: string;
	ein?: string | null;
	logo_alt_text?: string;
};
type Upload = { media_type: string; width: number; height: number; content_width: number; content_height: number };
type Step = {
	name?: string;
	given: {
		kit: Kit;
		"upload-logo": Upload;
		logo: { media_type: string; dominant_color: string };
		church_without_kit: { name: string };
		P: { timezone: string };
	};
	clock: { now: string };
	action: { operation: string; arguments: Record<string, unknown> };
	expected: { result: Record<string, unknown>; event: null };
};
type Case = Step & { id: string; subcases?: Step[] };

const { cases } = JSON.parse(
	readFileSync(new URL("../../../docs/acceptance/knowledge.json", import.meta.url), "utf8"),
) as { cases: Case[] };
const caseOf = (id: string) => cases.find((c) => c.id === id) ?? assert.fail(`no case ${id}`);
const subcase = (c: Case, name: string) =>
	c.subcases?.find((s) => s.name === name) ?? assert.fail(`no subcase ${name} of ${c.id}`);

const database = await fixture({ prefix: "brandcases" });
const { admin } = database;
const db = database.pools.runtime;
const client = new MemoryClient();
const storage = { bucket: "synthetic-only", client };
after(() => database.close());

const rowsOf = async (query: SQL) => (await admin.execute(query)).rows;
const rowOf = async (query: SQL) => (await rowsOf(query))[0] ?? assert.fail("the query returned no row");
const count = async (query: SQL) => Number((await rowOf(query)).n);
const authority = async (actor: Actor) => {
	const found = await RequestActor.resolve(db, actor.session);
	assert.ok(found instanceof RequestActor, JSON.stringify(found));
	return found;
};
const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const str = (value: unknown) => (typeof value === "string" ? value : assert.fail(JSON.stringify(value)));

async function church(name = "Harvest Point", kit?: Kit) {
	const plant = await database.plant({ name });
	const A = await database.actor(plant, "admin");
	if (kit)
		await admin.execute(sql`INSERT INTO church_brand_kit(tenant_id,revision,primary_color,accent_color,heading_font,body_font,legal_name,ein)
			VALUES(${plant.id},${kit.revision ?? 1},${kit.primary_color},${kit.accent_color ?? null},${kit.heading_font ?? sql`DEFAULT`},
				${kit.body_font ?? sql`DEFAULT`},${kit.legal_name ?? null},${kit.ein ?? null})`);
	return { P: plant.id, plant, A, admin: await authority(A) };
}
type Church = Awaited<ReturnType<typeof church>>;

const kitOf = async (c: Church) => (await rowsOf(sql`SELECT * FROM church_brand_kit WHERE tenant_id=${c.P}`))[0];
const revisionOf = async (c: Church) => str(ok(await brandReader.get(db, c.admin, {})).revision);
const events = async (c: Church) => ({
	audits: await count(sql`SELECT count(*)::int AS n FROM audit_event WHERE tenant_id=${c.P}`),
	files: await count(sql`SELECT count(*)::int AS n FROM file_object WHERE tenant_id=${c.P}`),
	notices: await count(sql`SELECT count(*)::int AS n FROM notice WHERE recipient_id=${c.A.id}`),
	mail: await count(sql`SELECT count(*)::int AS n FROM mail`),
});
async function unchanged<T>(c: Church, body: () => Promise<T>) {
	const before = { kit: await kitOf(c), events: await events(c) };
	const value = await body();
	assert.deepEqual({ kit: await kitOf(c), events: await events(c) }, before);
	return value;
}

async function attach(c: Church, slot: string, mediaType: string, bytes: Buffer, altText: string) {
	const ticket = ok(
		await brandWriter.requestUpload(db, c.admin, { slot, mediaType, byteLength: bytes.length, altText }),
	);
	const row = sql`SELECT purpose,state,opaque_key,media_type,sha256 FROM file_object WHERE id=${ticket.uploadId}`;
	ok(await uploadBrandAsset(db, storage, c.admin, { uploadId: ticket.uploadId, bytes }));
	const kit = ok(
		await brandWriter.finalizeUpload(db, c.admin, {
			uploadId: ticket.uploadId,
			slot,
			altText,
			expectedRevision: await revisionOf(c),
		}),
	);
	return { kit, file: await rowOf(row), fileId: ticket.uploadId };
}
const solid = (color: string, width = 600, height = 200) =>
	sharp({ create: { width, height, channels: 4, background: color } })
		.png()
		.toBuffer();

async function savedPdf(c: Church, requestKey: string) {
	const made = ok(
		await documentsWriter.generate(db, c.admin, { templateId: "commitment-card", format: "pdf", requestKey }, storage),
	);
	const file = async () => {
		const row = await rowOf(
			sql`SELECT f.id,f.sha256,f.revision::text AS revision,f.opaque_key FROM generated_document g JOIN file_object f ON f.id=g.object_id WHERE g.id=${made.id}`,
		);
		const bytes = client.objects.get(str(row.opaque_key)) ?? assert.fail("the saved PDF has no bytes");
		assert.equal(sha(bytes), row.sha256);
		return { row, bytes };
	};
	return { id: made.id, file };
}
const paint = (hex: string) =>
	[1, 3, 5].map((at) => String(Number((parseInt(hex.slice(at, at + 2), 16) / 255).toFixed(3)))).join(" ");
const channel = (value: number) => (value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
const luminance = (hex: string) => {
	const [r = 0, g = 0, b = 0] = [1, 3, 5].map((at) => channel(parseInt(hex.slice(at, at + 2), 16) / 255));
	return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const ratio = (a: string, b: string) => {
	const [high = 0, low = 0] = [luminance(a), luminance(b)].sort((x, y) => y - x);
	return (high + 0.05) / (low + 0.05);
};

test("AC:CASE-BRD-001 an Admin resets the saved kit to the neutral theme, no saved document changes, and a Member cannot open the settings", async (t) => {
	const brd = caseOf("CASE-BRD-001");
	const c = await church("Harvest Point", brd.given.kit);
	const logo = await attach(c, "full_logo", "image/png", await solid("#1F4E79"), str(brd.given.kit.logo_alt_text));
	await admin.execute(sql`UPDATE church_brand_kit SET revision=${brd.given.kit.revision} WHERE tenant_id=${c.P}`);
	const saved = await savedPdf(c, "brd-001");

	await t.test("member-refused", async () => {
		const M = await authority(await database.actor(c.plant, "member"));
		const { result } = subcase(brd, "member-refused").expected;
		await unchanged(c, async () => {
			refused(await brandReader.get(db, M, {}), str(result.error_code));
			refused(await brandReader.getSettings(db, M, {}), str(result.error_code));
		});
		assert.equal(result.kit_changed, false);
	});

	const before = { file: await saved.file(), events: await events(c) };
	const documents = sql`SELECT * FROM generated_document WHERE tenant_id=${c.P} ORDER BY id`;
	const generated = await rowsOf(documents);
	const { result } = brd.expected;
	const reset = ok(
		await brandWriter.reset(db, c.admin, { expectedRevision: String(brd.action.arguments.expected_revision) }),
	);
	assert.equal(reset.kitState, result.kit_state);
	assert.equal(await kitOf(c), undefined);
	assert.equal(
		ok(await brandReader.resolveTheme(db, c.admin, { documentClass: "formal/legal" })).kind,
		result.theme_after_reset,
	);
	const now = await rowsOf(documents);
	const changed = generated.filter((row, at) => JSON.stringify(row) !== JSON.stringify(now[at]));
	assert.deepEqual([now.length, changed.length], [generated.length, result.saved_documents_changed]);
	assert.deepEqual(await saved.file(), before.file);
	assert.deepEqual(await events(c), { ...before.events, audits: before.events.audits + 1 });
	assert.equal(
		await count(sql`SELECT count(*)::int AS n FROM job WHERE producer_key=${"brand-asset-release/" + logo.fileId}`),
		1,
	);
});

test("AC:CASE-BRD-002 a wide SVG logo is trimmed to a private 3:1 PNG with its alt text, and a PNG with no alt text stores nothing", async (t) => {
	const brd = caseOf("CASE-BRD-002");
	const upload = brd.given["upload-logo"];
	const args = brd.action.arguments;
	const { result } = brd.expected;
	const c = await church();
	const svg = Buffer.from(
		`<svg xmlns="http://www.w3.org/2000/svg" width="${upload.width}" height="${upload.height}" viewBox="0 0 ${upload.width} ${upload.height}"><rect x="30" y="40" width="${upload.content_width}" height="${upload.content_height}" fill="#1F4E79"/></svg>`,
	);
	const before = await events(c);
	const made = await attach(c, str(args.asset_kind), upload.media_type, svg, str(args.alt_text));
	assert.equal(made.file.purpose, result.stored_purpose);
	assert.deepEqual(made.kit.assets.full_logo, { fileId: made.fileId, alt: "Harvest Point Church logo" });
	const bytes = client.objects.get(str(made.file.opaque_key)) ?? assert.fail("the logo has no bytes");
	const meta = await sharp(bytes).metadata();
	assert.deepEqual([meta.format, made.file.media_type], [result.rasterized_format, "image/png"]);
	assert.equal(meta.width / meta.height, result.aspect_ratio);
	const { data } = await sharp(bytes).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
	assert.equal(
		data.every((value, at) => at % 4 !== 3 || value === 255),
		result.margin_trimmed,
	);
	assert.equal(str(made.file.opaque_key).split("/")[0], result.storage);
	const stranger = await church("Other Church");
	refused(await readBrandAsset(db, storage, stranger.admin, made.fileId), "unavailable");
	refused(await readBrandAsset(db, storage, stranger.admin, made.fileId, "theme"), "unavailable");
	assert.deepEqual(Buffer.from(ok(await readBrandAsset(db, storage, c.admin, made.fileId)).bytes), bytes);
	assert.deepEqual(await events(c), { ...before, audits: before.audits + 2, files: before.files + 1 });
	assert.deepEqual(await rowsOf(sql`SELECT action FROM audit_event WHERE tenant_id=${c.P} ORDER BY action`), [
		{ action: "branding.changed" },
		{ action: "files.finalized" },
	]);

	await t.test("alt-text-required", async () => {
		const sub = subcase(brd, "alt-text-required");
		const { media_type, width, height } = sub.given["upload-logo"];
		const png = await solid("#1F4E79", width, height);
		const objects = client.objects.size;
		await unchanged(c, async () =>
			refused(
				await brandWriter.requestUpload(db, c.admin, {
					slot: sub.action.arguments.asset_kind,
					mediaType: media_type,
					byteLength: png.length,
					altText: sub.action.arguments.alt_text,
				}),
				str(sub.expected.result.error_code),
			),
		);
		assert.equal(client.objects.size !== objects, sub.expected.result.asset_stored);
	});
});

test("AC:CASE-BRD-003 a pale yellow primary with no accent is the accent, fails the text badge, carries black text and is only used for fills and rules", async (t) => {
	const brd = caseOf("CASE-BRD-003");
	const { result } = brd.expected;
	const args = brd.action.arguments;
	const c = await church("Harvest Point", brd.given.kit);
	const before = await events(c);
	const kit = ok(
		await brandWriter.saveSettings(db, c.admin, {
			expectedRevision: String(args.expected_revision),
			patch: { primaryColor: args.primary_color, accentColor: args.accent_color },
		}),
	);
	assert.equal(kit.colors.accent?.hex, result.accent_color);
	assert.equal(kit.colors.primary?.contrast, result.contrast_vs_white);
	assert.equal(kit.colors.primary?.badge, result.contrast_badge);
	assert.equal(kit.colors.primary?.textColor, result.derived_text_on_primary);
	assert.deepEqual(await events(c), { ...before, audits: before.audits + 1 });
	for (const documentClass of ["formal/legal", "outward-facing", "operational", "email"]) {
		const theme = ok(await brandReader.resolveTheme(db, c.admin, { documentClass }));
		const asText = [theme.colors.ink, theme.colors.heading];
		assert.equal(asText.includes("#F2D74A"), result.primary_used_as_text, documentClass);
		assert.equal(theme.colors.rule === "#F2D74A", result.primary_used_for_fills_and_rules, documentClass);
		const { layout } = theme;
		if (layout.documentClass === "operational")
			for (const { fill, text } of [layout.tableHeader, layout.checkbox]) {
				assert.equal(fill === "#F2D74A", result.primary_used_for_fills_and_rules);
				assert.notEqual(text, "#F2D74A");
			}
		if (layout.documentClass === "email")
			assert.deepEqual(layout.button, { fill: "#F2D74A", text: result.derived_text_on_primary });
	}

	await t.test("suggest-from-logo", async () => {
		const sub = subcase(brd, "suggest-from-logo");
		const { logo } = sub.given;
		const bare = await church();
		await attach(bare, "full_logo", logo.media_type, await solid(logo.dominant_color), "Harvest Point Church logo");
		const suggested = await unchanged(bare, async () =>
			ok(await brandReader.suggestColors(db, bare.admin, { assetKind: sub.action.arguments.asset_kind }, storage)),
		);
		assert.equal(suggested.suggestedPrimary, sub.expected.result.suggested_primary);
		assert.equal(suggested.suggestedFrom, sub.expected.result.suggested_from);
	});
});

test("AC:CASE-BRD-004 a font outside the list changes nothing, a kit with no font choice uses the default pair, and no font file is taken", async (t) => {
	const brd = caseOf("CASE-BRD-004");
	const args = brd.action.arguments;
	const c = await church("Harvest Point", brd.given.kit);
	await unchanged(c, async () =>
		refused(
			await brandWriter.saveSettings(db, c.admin, {
				expectedRevision: String(args.expected_revision),
				patch: { headingFont: args.heading_font },
			}),
			str(brd.expected.result.error_code),
		),
	);
	assert.equal(brd.expected.result.kit_changed, false);

	await t.test("default-fonts", async () => {
		const sub = subcase(brd, "default-fonts");
		const { result } = sub.expected;
		const plain = await church("Harvest Point", sub.given.kit);
		const kit = ok(
			await brandWriter.saveSettings(db, plain.admin, {
				expectedRevision: String(sub.action.arguments.expected_revision),
				patch: { primaryColor: sub.action.arguments.primary_color },
			}),
		);
		assert.deepEqual([kit.headingFont, kit.bodyFont], [result.heading_font, result.body_font]);
		const fonts = ok(await brandReader.resolveTheme(db, plain.admin, { documentClass: "formal/legal" })).fonts;
		assert.deepEqual(fonts, { heading: result.heading_font, body: result.body_font });
		const first = ok(
			await brandWriter.saveSettings(db, (await church()).admin, {
				expectedRevision: "0",
				patch: { primaryColor: sub.action.arguments.primary_color },
			}),
		);
		assert.deepEqual([first.headingFont, first.bodyFont], [result.heading_font, result.body_font]);
		const offered = await unchanged(plain, async () => {
			const replies = [];
			for (const [slot, mediaType] of [
				["full_logo", "font/woff2"],
				["full_logo", "font/ttf"],
				["heading_font", "image/png"],
				["body_font", "font/otf"],
			])
				replies.push(
					await brandWriter.requestUpload(db, plain.admin, { slot, mediaType, byteLength: 10, altText: "Font" }),
				);
			return replies.some((reply) => reply.status === "ok");
		});
		assert.equal(offered, result.font_upload_offered);
	});
});

test("AC:CASE-BRD-005 letterhead details save with the EIN and no signature block or cover photo, and a malformed EIN changes nothing", async (t) => {
	const brd = caseOf("CASE-BRD-005");
	const args = brd.action.arguments as {
		expected_revision: number;
		primary_color: string;
		letterhead: Record<string, string>;
	};
	const { result } = brd.expected;
	const c = await church("Harvest Point", brd.given.kit);
	const before = await events(c);
	const patch = ({ legal_name, ...rest }: Record<string, string>) =>
		legal_name === undefined ? rest : { legalName: legal_name, ...rest };
	ok(
		await brandWriter.saveSettings(db, c.admin, {
			expectedRevision: String(args.expected_revision),
			patch: { primaryColor: args.primary_color, ...patch(args.letterhead) },
		}),
	);
	const kit = ok(await brandReader.get(db, c.admin, {}));
	const { legalName: legal_name, address, website, phone, email, ein, tagline } = kit;
	assert.deepEqual({ legal_name, address, website, phone, email, ein, tagline }, args.letterhead);
	assert.equal(result.letterhead_saved, true);
	assert.equal(kit.ein, result.ein);
	assert.equal(kit.assets.cover_photo, result.cover_photo);
	for (const part of [kit.assets.signature, kit.signerName, kit.signerTitle])
		assert.equal(part, result.signature_block);
	assert.deepEqual(await events(c), { ...before, audits: before.audits + 1 });

	await t.test("malformed-ein", async () => {
		const sub = subcase(brd, "malformed-ein");
		const letterhead = sub.action.arguments.letterhead as Record<string, string>;
		const other = await church("Harvest Point", sub.given.kit);
		await unchanged(other, async () =>
			refused(
				await brandWriter.saveSettings(db, other.admin, {
					expectedRevision: String(sub.action.arguments.expected_revision),
					patch: patch(letterhead),
				}),
				str(sub.expected.result.error_code),
			),
		);
		assert.equal((await kitOf(other))?.ein, null);
		assert.equal(sub.expected.result.kit_changed, false);
	});
});

test("AC:CASE-BRD-006 each document class of a church with a full kit resolves by its own rules", async (t) => {
	const brd = caseOf("CASE-BRD-006");
	const { kit } = brd.given;
	const c = await church("Harvest Point", kit);
	ok(
		await brandWriter.saveSettings(db, c.admin, {
			expectedRevision: "1",
			patch: {
				address: "12 Main Street, Austin, TX 78701",
				website: "https://harvestpoint.example",
				phone: "+1 512 555 0100",
				email: "office@harvestpoint.example",
				tagline: "Grow, pray, give.",
			},
		}),
	);
	const alt = str(kit.logo_alt_text);
	const logo = { fileId: (await attach(c, "full_logo", "image/png", await solid("#1F4E79"), alt)).fileId, alt };
	const mark = {
		fileId: (await attach(c, "mark", "image/png", await solid("#1F4E79", 200, 200), "Mark")).fileId,
		alt: "Mark",
	};
	const photo = {
		fileId: (await attach(c, "cover_photo", "image/png", await solid("#556677", 900, 600), "Sunday")).fileId,
		alt: "Sunday",
	};
	const resolve = async (step: Step) => {
		const theme = await unchanged(c, async () =>
			ok(await brandReader.resolveTheme(db, c.admin, { documentClass: step.action.arguments.document_class })),
		);
		assert.equal(theme.kind, step.expected.result.theme);
		assert.equal(theme.layout.documentClass, step.action.arguments.document_class);
		return theme;
	};

	const formal = await resolve(brd);
	const { result } = brd.expected;
	if (formal.layout.documentClass !== "formal/legal") assert.fail("the formal class has its own layout");
	assert.deepEqual([formal.layout.headerLogo, formal.layout.headerLogoHeightMm], [logo, 14]);
	assert.equal(result.header_logo, "small");
	const painted = { rules: formal.colors.rule, headings: formal.colors.heading };
	assert.deepEqual(
		Object.entries(painted).flatMap(([part, color]) => (color === "#1F4E79" ? [part] : [])),
		result.primary_applied_to,
	);
	assert.equal(formal.colors.ink, "#1A1A1A");
	assert.equal(result.body_text, "neutral");
	assert.deepEqual(formal.layout.footer, {
		name: "Harvest Point Church",
		address: "12 Main Street, Austin, TX 78701",
		ein: "12-3456789",
	});
	assert.equal(result.footer, "letterhead with EIN");
	assert.equal(formal.layout.pageNumbers, result.page_numbers);

	await t.test("outward-facing", async () => {
		const sub = subcase(brd, "outward-facing");
		const theme = await resolve(sub);
		if (theme.layout.documentClass !== "outward-facing") assert.fail("the outward class has its own layout");
		const { coverLogo, coverLogoHeightMm, coverPhoto, tagline, contact } = theme.layout;
		assert.deepEqual([coverLogo, coverLogoHeightMm], [logo, 40]);
		assert.deepEqual([theme.colors.primary, theme.colors.accent], ["#1F4E79", "#D4A017"]);
		assert.deepEqual(theme.fonts, { heading: "DM Serif Display", body: "DM Sans" });
		assert.equal(theme.fallbackUsed, false);
		assert.deepEqual(
			{ photo: coverPhoto, tagline, contact },
			{
				photo,
				tagline: "Grow, pray, give.",
				contact: {
					address: "12 Main Street, Austin, TX 78701",
					website: "https://harvestpoint.example",
					phone: "+1 512 555 0100",
					email: "office@harvestpoint.example",
				},
			},
		);
		assert.deepEqual(Object.keys({ photo: coverPhoto, tagline, contact }), sub.expected.result.extras);
		assert.equal(sub.expected.result.cover, "large logo");
		assert.equal(sub.expected.result.colors, "full primary and accent");
		assert.equal(sub.expected.result.fonts, "brand");
	});

	await t.test("operational", async () => {
		const sub = subcase(brd, "operational");
		const theme = await resolve(sub);
		if (theme.layout.documentClass !== "operational") assert.fail("the operational class has its own layout");
		const { mark: shown, markHeightMm, tableHeader, checkbox } = theme.layout;
		assert.deepEqual([shown, markHeightMm], [mark, 10]);
		assert.equal(sub.expected.result.mark, "small");
		const accented = { "table headers": tableHeader, checkboxes: checkbox };
		assert.deepEqual(
			Object.entries(accented).flatMap(([part, { fill }]) => (fill === "#D4A017" ? [part] : [])),
			sub.expected.result.accent_applied_to,
		);
		for (const { fill, text } of Object.values(accented))
			assert.equal(ratio(fill, text) >= 4.5, sub.expected.result.grayscale_safe);
	});

	await t.test("email", async () => {
		const sub = subcase(brd, "email");
		const theme = await resolve(sub);
		if (theme.layout.documentClass !== "email") assert.fail("the email class has its own layout");
		assert.deepEqual(theme.layout.headerLogo, logo);
		assert.equal(theme.layout.logoMaxWidthPx, sub.expected.result.header_logo_max_width_px);
		assert.deepEqual(theme.layout.button, {
			fill: sub.expected.result.button_color,
			text: sub.expected.result.button_text_color,
		});
		assert.deepEqual(theme.fonts, {
			heading: "Georgia, 'Times New Roman', serif",
			body: "Arial, Helvetica, sans-serif",
		});
		assert.equal(sub.expected.result.fonts, "web-safe");
		assert.deepEqual(theme.layout.footer, {
			churchName: "Harvest Point",
			address: "12 Main Street, Austin, TX 78701",
		});
		assert.equal(sub.expected.result.footer, "church name and address");
	});
});

test("AC:CASE-BRD-006-NEUTRAL a church that never saved a kit gets the neutral theme with its name in type, no logo and the same slots", async () => {
	const brd = caseOf("CASE-BRD-006-NEUTRAL");
	const { result } = brd.expected;
	const c = await church(brd.given.church_without_kit.name);
	const request = { documentClass: brd.action.arguments.document_class };
	const theme = await unchanged(c, async () => ok(await brandReader.resolveTheme(db, c.admin, request)));
	assert.equal(await kitOf(c), undefined);
	assert.equal(theme.kind, result.theme);
	assert.equal(theme.churchName === "Harvest Point", result.church_name_set_in_type);
	const { layout } = theme;
	if (layout.documentClass !== "outward-facing") assert.fail("the outward class has its own layout");
	assert.deepEqual([layout.coverLogo, layout.coverPhoto, layout.tagline], [null, null, null]);
	assert.equal(JSON.stringify(theme).includes("fileId"), result.everyfield_logo_present);
	const branded = await church("Harvest Point", caseOf("CASE-BRD-006").given.kit);
	await attach(branded, "full_logo", "image/png", await solid("#1F4E79"), "Harvest Point Church logo");
	const full = ok(await brandReader.resolveTheme(db, branded.admin, request)).layout;
	if (full.documentClass !== "outward-facing") assert.fail("the outward class has its own layout");
	assert.notEqual(full.coverLogo, null);
	assert.deepEqual([layout.coverLogoHeightMm, full.coverLogoHeightMm], [40, 40]);
	assert.equal(result.slots, "fixed-size");
});

test("AC:CASE-BRD-006-SAVED a changed primary color keeps the saved PDF's bytes and paints the next PDF", async () => {
	const brd = caseOf("CASE-BRD-006-SAVED");
	const { result } = brd.expected;
	const c = await church("Harvest Point", brd.given.kit);
	const saved = await savedPdf(c, "brd-saved-1");
	const before = await saved.file();
	assert.ok((await pdfOperators(before.bytes)).includes(paint("#1F4E79")));
	const counts = await events(c);
	const kit = ok(
		await brandWriter.saveSettings(db, c.admin, {
			expectedRevision: String(brd.action.arguments.expected_revision),
			patch: { primaryColor: brd.action.arguments.primary_color },
		}),
	);
	assert.deepEqual([kit.revision, kit.primaryColor], ["3", "#8B1E3F"]);
	assert.deepEqual(await events(c), { ...counts, audits: counts.audits + 1 });
	const kept = await saved.file();
	assert.deepEqual(kept.row, before.row);
	assert.equal(!kept.bytes.equals(before.bytes), result.saved_pdf_bytes_changed);
	const next = await (await savedPdf(c, "brd-saved-2")).file();
	const operators = await pdfOperators(next.bytes);
	assert.ok(operators.includes(paint(str(result.next_generated_pdf_primary))));
	assert.equal(operators.includes(paint("#1F4E79")), false);
});
