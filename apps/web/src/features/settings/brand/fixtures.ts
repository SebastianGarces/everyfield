import {
	ASSET_SLOTS,
	DEFAULT_BODY_FONT,
	DEFAULT_HEADING_FONT,
	LETTERHEAD_KEYS,
	brandError,
	brandKit,
	saveSettingsRequest,
	type BrandKitData,
	type HexColor,
} from "@everyfield/contracts/branding";
import { colorView } from "@everyfield/domain/branding/color";
import type { BrandError, BrandKit, BrandPort, BrandReply } from "../port";

// The brand kit fixture for the design preview. It answers like the branding contract says (every kit is parsed by
// brandKit, every patch by saveSettingsRequest) and keeps one kit in memory per preview load. It is a stand-in for the
// design review only; the server's own rules live in packages/domain.

export type PreviewKit = "none" | "saved" | "pale";
export const PREVIEW_KITS: readonly PreviewKit[] = ["none", "saved", "pale"];
export const parsePreviewKit = (value: string | null | undefined): PreviewKit =>
	(PREVIEW_KITS as readonly string[]).includes(value ?? "") ? (value as PreviewKit) : "none";

const hex = (digits: string) => `#${digits}` as HexColor;

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
		primaryColor: hex("1F4E79"),
		accentColor: hex("D4A017"),
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
	pale: { ...EMPTY, primaryColor: hex("FFF3B0") },
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
export type BrandOperation = "getBrand" | "saveBrand" | "resetBrand";

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
	const refuse = (code: BrandError["code"]): BrandReply<never> => ({
		status: "refused",
		error: brandError.parse({
			code,
			details: {},
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
			const next = { ...data };
			for (const [key, value] of Object.entries(parsed.data.patch))
				if (key !== "assets" && value !== undefined) Object.assign(next, { [key]: value });
			if (!next.primaryColor) return refuse("primary_required");
			data = next;
			revision = String(BigInt(revision) + 1n);
			return { status: "ok", value: kitOf(data, revision) };
		},
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
