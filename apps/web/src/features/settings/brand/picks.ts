import type { AssetSlot } from "@everyfield/contracts/branding";

// Files picked in the "Logos and images" group but not yet uploaded. The record in the settings store holds plain data
// (so the draft book and the nav mark can read it); the File rides on its pick.

export type Pick = {
	file: File;
	/** The local object URL the slot shows at once (optimistic). */
	url: string;
	name: string;
	size: number;
	alt: string;
	status: "ready" | "uploading";
	/** The message on the alt text field: set by Confirm with blank alt text, or by a server `alt_text_required`. */
	altError?: string;
};

/** What a slot says after a refusal, with the error reference. `conflict` also offers Load latest. */
export type Note = { message: string; reference?: string; conflict?: boolean };

export type AssetFlow = {
	picks: Partial<Record<AssetSlot, Pick>>;
	notes: Partial<Record<AssetSlot, Note>>;
};

export const EMPTY_FLOW: AssetFlow = { picks: {}, notes: {} };
export const ASSET_FLOW = "brand.assets";

/** The pick for a file, shown at once from a local object URL. */
export const pickFile = (file: File): Pick => ({
	file,
	url: URL.createObjectURL(file),
	name: file.name,
	size: file.size,
	alt: "",
	status: "ready",
});

export function releasePick(pick: Pick | undefined) {
	if (!pick) return;
	URL.revokeObjectURL(pick.url);
}

/** True when at least one file is picked and not yet uploaded: Brand kit is unsaved (REQ-IDN-010). */
export const hasPicks = (flow: unknown): boolean =>
	Object.keys((flow as AssetFlow | undefined)?.picks ?? {}).length > 0;

export function releaseAll(flow: unknown) {
	for (const pick of Object.values((flow as AssetFlow | undefined)?.picks ?? {})) releasePick(pick);
}
