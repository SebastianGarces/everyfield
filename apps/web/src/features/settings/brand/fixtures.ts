import {
	ASSET_SLOTS,
	DEFAULT_BODY_FONT,
	DEFAULT_HEADING_FONT,
	LETTERHEAD_KEYS,
	brandError,
	brandKit,
	finalizeUploadRequest,
	saveSettingsRequest,
	suggestColorsRequest,
	suggestedColors,
	uploadRequest,
	uploadTicket,
	type BrandKitData,
	type HexColor,
} from "@everyfield/contracts/branding";
import { colorView } from "@everyfield/domain/branding/color";
import type { BrandError, BrandKit, BrandPort, BrandReply } from "../port";

// The brand kit fixture for the design preview. It answers like the branding contract says (every kit is parsed by
// brandKit, every patch by saveSettingsRequest) and keeps one kit in memory per preview load. It is a stand-in for the
// design review only; the server's own rules live in packages/domain.

export type PreviewKit = "none" | "saved" | "pale";
const PREVIEW_KITS: readonly PreviewKit[] = ["none", "saved", "pale"];
export const parsePreviewKit = (value: string | null | undefined): PreviewKit =>
	(PREVIEW_KITS as readonly string[]).includes(value ?? "") ? (value as PreviewKit) : "none";

const EMPTY: BrandKitData = {
	primaryColor: null,
	accentColor: null,
	headingFont: DEFAULT_HEADING_FONT,
	bodyFont: DEFAULT_BODY_FONT,
	...(Object.fromEntries(LETTERHEAD_KEYS.map((key) => [key, null])) as Record<(typeof LETTERHEAD_KEYS)[number], never>),
	assets: Object.fromEntries(ASSET_SLOTS.map((slot) => [slot, null])) as BrandKitData["assets"],
};

/** The CASE-BRD-006 kit, and the CASE-BRD-003 pale yellow primary with no accent. */
const START: Record<PreviewKit, BrandKitData> = {
	none: EMPTY,
	saved: {
		...EMPTY,
		primaryColor: "#1F4E79" as HexColor,
		accentColor: "#D4A017" as HexColor,
		headingFont: "Playfair Display",
		bodyFont: "Source Sans 3",
		legalName: "Harvest Point Church, Inc.",
		address: "1200 Main Street, Austin, TX 78701",
		website: "https://harvestpoint.org",
		phone: "(512) 555-0142",
		email: "hello@harvestpoint.org",
		ein: "12-3456789",
		tagline: "A church for the neighborhood",
		signerName: "Daniel Reyes",
		signerTitle: "Lead pastor",
	},
	pale: { ...EMPTY, primaryColor: "#FFF3B0" as HexColor },
};

const kitOf = (data: BrandKitData, revision: string): BrandKit =>
	brandKit.parse({
		...data,
		kitState: revision === "0" ? "default" : "saved",
		revision,
		colors: {
			primary: data.primaryColor ? colorView(data.primaryColor) : null,
			accent: data.primaryColor ? colorView(data.accentColor ?? data.primaryColor) : null,
		},
	});

export type BrandFault = BrandError["code"] | "offline";
export type BrandOperation =
	"getBrand" | "saveBrand" | "resetBrand" | "requestUpload" | "uploadBytes" | "finalizeUpload" | "suggestColors";

/** The colors the fixture suggests for any logo: the dominant color first, as the server's function returns them. */
const SUGGESTION = ["#2E7D32", "#8BC34A", "#1B5E20"] as const;

/**
 * `tick(op)` counts the call, waits and applies a queued fault: it returns the refusal code or null, and throws
 * for a lost connection.
 */
export function createFixtureBrand({
	kit,
	churchName,
	canAdmin,
	tick,
	nextId,
}: {
	kit: PreviewKit;
	churchName: string;
	canAdmin: boolean;
	tick: (op: BrandOperation) => Promise<BrandFault | null>;
	nextId: () => string;
}): BrandPort {
	let data = START[kit];
	let revision = kit === "none" ? "0" : "1";
	// Staged uploads by id, and the object URL of each stored file (the fixture's "served asset").
	const staged = new Map<string, { slot: string; byteLength: number }>();
	const served = new Map<string, string>();
	const refuse = (code: BrandError["code"]): BrandReply<never> => ({
		status: "refused",
		error: brandError.parse({
			code,
			details: code === "invalid_input" ? { issues: [] } : {},
			correlationId: nextId(),
			retry: code === "conflict" ? "refresh" : "never",
		}),
	});
	const gate = async (op: BrandOperation) => {
		const fault = await tick(op);
		if (fault) return refuse(fault as BrandError["code"]);
		return canAdmin ? null : refuse("access_denied");
	};

	return {
		async get() {
			const refused = await gate("getBrand");
			return refused ?? { status: "ok", value: { kit: kitOf(data, revision), churchName } };
		},
		async save(raw) {
			const refused = await gate("saveBrand");
			if (refused) return refused;
			const parsed = saveSettingsRequest.safeParse(raw);
			if (!parsed.success)
				return refuse(parsed.error.issues.some((i) => i.path[1] === "ein") ? "invalid_ein" : "invalid_input");
			if (parsed.data.expectedRevision !== revision) return refuse("conflict");
			const next = { ...data, assets: { ...data.assets } };
			for (const [key, value] of Object.entries(parsed.data.patch))
				if (key !== "assets" && value !== undefined) Object.assign(next, { [key]: value });
			for (const slot of Object.keys(parsed.data.patch.assets ?? {}) as (keyof BrandKitData["assets"])[])
				next.assets[slot] = null;
			if (!next.primaryColor) return refuse("primary_required");
			data = next;
			revision = String(BigInt(revision) + 1n);
			return { status: "ok", value: kitOf(data, revision) };
		},
		async requestUpload(raw) {
			const refused = await gate("requestUpload");
			if (refused) return refused;
			const given = (raw ?? {}) as Record<string, unknown>;
			if (typeof given.altText !== "string" || !given.altText.trim()) return refuse("alt_text_required");
			const parsed = uploadRequest.safeParse(raw);
			if (!parsed.success)
				return refuse(
					parsed.error.issues.some((i) => i.path[0] === "mediaType") ? "unsupported_media_type" : "invalid_input",
				);
			const uploadId = nextId();
			staged.set(uploadId, { slot: parsed.data.slot, byteLength: parsed.data.byteLength });
			return {
				status: "ok",
				value: uploadTicket.parse({ uploadId, expiresAt: new Date(Date.now() + 15 * 60_000).toISOString() }),
			};
		},
		async uploadBytes(uploadId, file) {
			const refused = await gate("uploadBytes");
			if (refused) return refused;
			const request = staged.get(uploadId);
			if (!request || request.byteLength !== file.size) return refuse("invalid_file");
			served.set(uploadId, URL.createObjectURL(file));
			return { status: "ok", value: null };
		},
		async finalizeUpload(raw) {
			const refused = await gate("finalizeUpload");
			if (refused) return refused;
			const given = (raw ?? {}) as Record<string, unknown>;
			if (typeof given.altText !== "string" || !given.altText.trim()) return refuse("alt_text_required");
			const parsed = finalizeUploadRequest.safeParse(raw);
			if (!parsed.success) return refuse("invalid_input");
			const { uploadId, slot, altText, expectedRevision } = parsed.data;
			if (expectedRevision !== revision) return refuse("conflict");
			if (!served.has(uploadId) || staged.get(uploadId)?.slot !== slot) return refuse("unavailable");
			data = { ...data, assets: { ...data.assets, [slot]: { fileId: uploadId, alt: altText } } };
			revision = String(BigInt(revision) + 1n);
			return { status: "ok", value: kitOf(data, revision) };
		},
		async suggestColors(raw) {
			const refused = await gate("suggestColors");
			if (refused) return refused;
			const parsed = suggestColorsRequest.safeParse(raw);
			if (!parsed.success) return refuse("invalid_input");
			if (!data.assets[parsed.data.assetKind]) return refuse("unavailable");
			return {
				status: "ok",
				value: suggestedColors.parse({
					suggestedPrimary: SUGGESTION[0],
					palette: SUGGESTION,
					suggestedFrom: parsed.data.assetKind,
				}),
			};
		},
		assetSrc: (fileId) => served.get(fileId) ?? "",
		async reset(raw) {
			const refused = await gate("resetBrand");
			if (refused) return refused;
			if ((raw as { expectedRevision: string }).expectedRevision !== revision) return refuse("conflict");
			data = EMPTY;
			revision = "0";
			return { status: "ok", value: kitOf(data, revision) };
		},
	};
}
