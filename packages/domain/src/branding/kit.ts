import {
	ASSET_SLOTS,
	LETTERHEAD_KEYS,
	DEFAULT_BODY_FONT,
	DEFAULT_HEADING_FONT,
	brandKit,
	assetSlot,
	type AssetSlot,
	type BrandKit,
	type BrandKitData,
	type LetterheadKey,
} from "@everyfield/contracts/branding";
import { sql } from "@everyfield/db/query";
import { colorView } from "./color.ts";

/** Database column of each letterhead field. */
export const LETTERHEAD_COLUMNS: Record<LetterheadKey, string> = {
	legalName: "legal_name",
	address: "address",
	website: "website",
	phone: "phone",
	email: "email",
	ein: "ein",
	tagline: "tagline",
	signerName: "signer_name",
	signerTitle: "signer_title",
};
export type KitRow = Record<string, unknown>;

const text = (value: unknown) => (typeof value === "string" ? value : null);

/** The saved values of a kit row, or the defaults when the church plant has no row. */
export function dataFromRow(row: KitRow | null): BrandKitData {
	const assets = Object.fromEntries(
		ASSET_SLOTS.map((slot) => {
			const id = text(row?.[`${slot}_object_id`]);
			const alt = text(row?.[`${slot}_alt`]);
			return [slot, id && alt ? { fileId: id, alt } : null];
		}),
	) as BrandKitData["assets"];
	return {
		primaryColor: text(row?.primary_color) as BrandKitData["primaryColor"],
		accentColor: text(row?.accent_color) as BrandKitData["accentColor"],
		headingFont: (text(row?.heading_font) ?? DEFAULT_HEADING_FONT) as BrandKitData["headingFont"],
		bodyFont: (text(row?.body_font) ?? DEFAULT_BODY_FONT) as BrandKitData["bodyFont"],
		...(Object.fromEntries(LETTERHEAD_KEYS.map((key) => [key, text(row?.[LETTERHEAD_COLUMNS[key]])])) as Record<
			LetterheadKey,
			never
		>),
		assets,
	};
}

/** `brand.get` and every kit-returning result: the saved values, the revision and a contrast badge for each color. */
export function kitFromRow(row: KitRow | null): BrandKit {
	const data = dataFromRow(row);
	const primary = data.primaryColor;
	return brandKit.parse({
		...data,
		kitState: row ? "saved" : "default",
		revision: row ? String(row.revision) : "0",
		colors: {
			primary: primary ? colorView(primary) : null,
			accent: primary ? colorView(data.accentColor ?? primary) : null,
		},
	});
}

export const assetColumn = (slot: AssetSlot) => sql.identifier(`${slot}_object_id`);
export const altColumn = (slot: AssetSlot) => sql.identifier(`${slot}_alt`);
export const SLOT_ID_COLUMNS = ASSET_SLOTS.map(assetColumn);

/** A file id of each slot, one row each, for a queued release (`v.id`). */
export const slotValues = (row: string) =>
	sql.join(
		ASSET_SLOTS.map((slot) => sql`(${sql.raw(row)}.${assetColumn(slot)})`),
		sql`, `,
	);

/** The most bytes a stored raster may have. The staged file reserves it, since the processed size is not known yet. */
export const STORED_MAX_BYTES = 10 * 1024 * 1024;
const EXTENSIONS = { "image/svg+xml": "svg", "image/png": "png", "image/webp": "webp" } as const;
/**
 * A staged file keeps its stored type and a reserved size (both frozen once staged), so the slot, the uploaded type and
 * the uploaded size travel in the upload key: `brand-asset/<slot>/<svg|png|webp>/<byte length>/<id>`.
 */
export const uploadKeyOf = (slot: AssetSlot, mediaType: keyof typeof EXTENSIONS, byteLength: number, id: string) =>
	`brand-asset/${slot}/${EXTENSIONS[mediaType]}/${byteLength}/${id}`;
export function stagedUpload(uploadKey: string) {
	const match = /^brand-asset\/([a-z_]+)\/(svg|png|webp)\/(\d{1,8})\/[0-9a-f-]{36}$/.exec(uploadKey);
	const slot = assetSlot.safeParse(match?.[1]);
	const mediaType = Object.entries(EXTENSIONS).find(([, extension]) => extension === match?.[2])?.[0];
	return slot.success && mediaType
		? { slot: slot.data, mediaType: mediaType as keyof typeof EXTENSIONS, byteLength: Number(match?.[3]) }
		: null;
}
