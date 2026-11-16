import type { AssetSlot } from "@everyfield/contracts/branding";

export type Pick = {
	file: File;
	url: string;
	name: string;
	size: number;
	alt: string;
	status: "ready" | "uploading";
	altError?: string;
};

export type Note = { message: string; reference?: string; conflict?: boolean };

export type AssetFlow = {
	picks: Partial<Record<AssetSlot, Pick>>;
	notes: Partial<Record<AssetSlot, Note>>;
};

export const EMPTY_FLOW: AssetFlow = { picks: {}, notes: {} };
export const ASSET_FLOW = "brand.assets";

export const pickFile = (file: File): Pick => ({
	file,
	url: URL.createObjectURL(file),
	name: file.name,
	size: file.size,
	alt: "",
	status: "ready",
});

export const releasePick = (pick: Pick | undefined) => pick && URL.revokeObjectURL(pick.url);

export const hasPicks = (flow: unknown): boolean =>
	Object.keys((flow as AssetFlow | undefined)?.picks ?? {}).length > 0;

export function releaseAll(flow: unknown) {
	for (const pick of Object.values((flow as AssetFlow | undefined)?.picks ?? {})) releasePick(pick);
}
