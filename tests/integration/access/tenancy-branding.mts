// The branding reads of INV-tenancy (tenancy.test.mts): church A's saved brand kit with a ready logo, written through
// the branding writes as its owner, and one case per read. The cases read through the test's throwing storage; only
// the seed's upload saves bytes.
import assert from "node:assert/strict";
import sharp from "../../../packages/db/node_modules/sharp/dist/index.mjs";
import {
	brandReader,
	brandWriter,
	readBrandAsset,
	readBrandAssetIfChanged,
	uploadBrandAsset,
} from "../../../packages/domain/src/branding/index.ts";

/** Private storage for the seed's upload, as a local fake of the object store (as the branding suite uses). */
const seedStorage = {
	bucket: "tenancy-brand-seed",
	client: {
		async send(command) {
			switch (command.constructor.name) {
				case "GetBucketAclCommand":
					return { Grants: [{ Grantee: { ID: "private-owner" }, Permission: "FULL_CONTROL" }] };
				case "PutObjectCommand":
					return {};
				default:
					throw Error(`unexpected provider operation ${command.constructor.name}`);
			}
		},
	},
};
// A flat #2E7D32 block on a transparent canvas, as the branding suite's logo.
const logo = await sharp({
	create: { width: 200, height: 120, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
})
	.composite([{ input: { create: { width: 120, height: 60, channels: 4, background: "#2E7D32" } }, left: 40, top: 30 }])
	.png()
	.toBuffer();
const PRIMARY = "#1F4E79";
const noLetterhead = Object.fromEntries(
	["legalName", "address", "website", "phone", "email", "ein", "tagline", "signerName", "signerTitle"].map((k) => [
		k,
		null,
	]),
);
const noAssets = Object.fromEntries(
	["full_logo", "full_logo_dark", "mark", "mark_dark", "cover_photo", "signature"].map((slot) => [slot, null]),
);

/** Church A's owner saves a kit, then requests, uploads and finalizes a full logo into it. */
export async function seedBranding(t) {
	const { a, MARK, ok } = t;
	const owner = t.ownerA.actor;
	const db = t.f.db;
	const altText = `${MARK} logo`;
	ok(
		await brandWriter.saveSettings(db, owner, {
			expectedRevision: "0",
			patch: { primaryColor: PRIMARY, tagline: `${MARK} tagline` },
		}),
	);
	const ticket = ok(
		await brandWriter.requestUpload(db, owner, {
			slot: "full_logo",
			mediaType: "image/png",
			byteLength: logo.length,
			altText,
		}),
	);
	const uploaded = ok(await uploadBrandAsset(db, seedStorage, owner, { uploadId: ticket.uploadId, bytes: logo }));
	ok(
		await brandWriter.finalizeUpload(db, owner, {
			uploadId: ticket.uploadId,
			slot: "full_logo",
			altText,
			expectedRevision: "1",
		}),
	);
	Object.assign(a, { brandAsset: ticket.uploadId, brandSha: uploaded.sha256 });
}

export function brandingCases(t, who) {
	const { a, MARK, storage } = t;
	const db = t.f.db;
	const r = (name, run, expected) => [`branding:brandReader.${name}`, { run, expected }];
	return [
		r("get", () => brandReader.get(db, who.actor, {}), {
			// Church B saved no kit, so it gets the default kit.
			value: {
				primaryColor: null,
				accentColor: null,
				headingFont: "DM Serif Display",
				bodyFont: "DM Sans",
				...noLetterhead,
				assets: noAssets,
				kitState: "default",
				revision: "0",
				colors: { primary: null, accent: null },
			},
			control: (value) => {
				assert.deepEqual([value.kitState, value.primaryColor, value.tagline], ["saved", PRIMARY, `${MARK} tagline`]);
				assert.deepEqual(value.assets.full_logo, { fileId: a.brandAsset, alt: `${MARK} logo` });
			},
		}),
		r("resolveTheme", () => brandReader.resolveTheme(db, who.actor, { documentClass: "formal/legal" }), {
			// Church B's own neutral theme, named for church B (the fixture's plant name).
			value: {
				kind: "everyfield-neutral",
				churchName: "Synthetic plant",
				fallbackUsed: true,
				fonts: { heading: "DM Serif Display", body: "DM Sans" },
				colors: { primary: null, accent: null, ink: "#1A1A1A", heading: "#1A1A1A", rule: "#9CA3AF" },
				layout: {
					documentClass: "formal/legal",
					headerLogo: null,
					headerLogoHeightMm: 14,
					footer: { name: "Synthetic plant", address: null, ein: null },
					signature: { image: null, name: null, title: null },
					pageNumbers: true,
				},
			},
			control: (value) => {
				assert.deepEqual([value.churchName, value.layout.footer.name], [`${MARK} Church`, `${MARK} Church`]);
				assert.deepEqual(value.layout.headerLogo, { fileId: a.brandAsset, alt: `${MARK} logo` });
			},
		}),
		r("suggestColors", () => brandReader.suggestColors(db, who.actor, { assetKind: "full_logo" }, storage), {
			// Church B's own kit has no logo in the slot, so the read refuses before any storage read.
			refused: "unavailable",
			// Church A's colors come from the logo's bytes in private storage, which stays the throwing fake here.
			control: null,
		}),
		[
			"branding:readBrandAsset",
			{
				run: () => readBrandAsset(db, storage, who.actor, a.brandAsset),
				// The bytes are in private storage, which stays the throwing fake here.
				expected: { refused: "unavailable", control: null },
			},
		],
		[
			"branding:readBrandAssetIfChanged",
			{
				run: () => readBrandAssetIfChanged(db, storage, who.actor, a.brandAsset, () => true),
				expected: {
					refused: "unavailable",
					// The caller holds the current version, so church A gets the stored hash with no storage read.
					control: (value) => assert.deepEqual(value, { sha256: a.brandSha, mediaType: "image/png", bytes: null }),
				},
			},
		],
	];
}
