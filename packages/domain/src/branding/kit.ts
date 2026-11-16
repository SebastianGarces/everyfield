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
type KitRow = Record<string, unknown>;

const text = (value: unknown) => (typeof value === "string" ? value : null);

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

export const slotValues = (row: string) =>
	sql.join(
		ASSET_SLOTS.map((slot) => sql`(${sql.raw(row)}.${assetColumn(slot)})`),
		sql`, `,
	);

export const STORED_MAX_BYTES = 10 * 1024 * 1024;
const EXTENSIONS = { "image/svg+xml": "svg", "image/png": "png", "image/webp": "webp" } as const;
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
