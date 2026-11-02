import type { BrandKitData, DocumentClass, DocumentTheme } from "@everyfield/contracts/branding";
import type { Database } from "@everyfield/db/client";
import type { PrivateStorage } from "@everyfield/db/schema";
import "server-only";
import type { RequestActor } from "../access/session.ts";
import { readBrandAsset } from "../branding/files.ts";
import { resolveDocumentTheme } from "../branding/theme.ts";
import type { DocBrand } from "@everyfield/contracts/documents";
import { textOn } from "./contrast.ts";
import { makePalette, NEUTRAL_THEME, type RenderClass, type RenderTheme, type ThemeImage } from "./theme.ts";

/** A theme for a render: what the PDF paints, what the DOCX names, and what the record keeps. */
export type ExportTheme = {
	render: RenderTheme;
	fonts: { heading: string; body: string };
	kind: "church" | "everyfield-neutral";
	/** The primary color of a church theme, upper case. */
	primary: string | null;
};

export const NEUTRAL_EXPORT_THEME: ExportTheme = {
	render: NEUTRAL_THEME,
	fonts: { heading: "DM Serif Display", body: "DM Sans" },
	kind: "everyfield-neutral",
	primary: null,
};

/** Width over height of a PNG or JPEG. Null when the bytes are neither. */
function imageAspect(bytes: Uint8Array): number | null {
	const b = Buffer.from(bytes);
	if (b.length > 24 && b.readUInt32BE(0) === 0x89504e47) {
		const w = b.readUInt32BE(16);
		const h = b.readUInt32BE(20);
		return w > 0 && h > 0 ? w / h : null;
	}
	if (b.length > 4 && b[0] === 0xff && b[1] === 0xd8) {
		let at = 2;
		while (at + 9 < b.length) {
			if (b[at] !== 0xff) return null;
			const marker = b[at + 1] ?? 0;
			if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
				const h = b.readUInt16BE(at + 5);
				const w = b.readUInt16BE(at + 7);
				return w > 0 && h > 0 ? w / h : null;
			}
			at += 2 + b.readUInt16BE(at + 2);
		}
	}
	return null;
}

/** The one asset a class prints in the header slot: the full logo, or the mark for an operational document. */
function logoRef(layout: DocumentTheme["layout"]) {
	switch (layout.documentClass) {
		case "formal/legal":
			return layout.headerLogo;
		case "outward-facing":
			return layout.coverLogo;
		case "operational":
			return layout.mark;
		case "email":
			return layout.headerLogo;
	}
}

/** The image nodes' sources a document uses, so the render reads only those brand assets. */
export type ImageSource = "logo" | "mark" | "photo";
const KIT_SLOT = { logo: "full_logo", mark: "mark", photo: "cover_photo" } as const;

/**
 * The palette the renderer paints for a document and the brand-kit images it may show: the church theme when the
 * document uses church branding and the church has a primary color, else the neutral theme. Pure, no I/O.
 */
export function documentBrand(kit: BrandKitData | null, useChurchBranding: boolean): DocBrand {
	const themed = useChurchBranding && kit !== null && kit.primaryColor !== null;
	const render: RenderTheme = themed
		? { name: "church", primary: kit.primaryColor as string, accent: kit.accentColor ?? (kit.primaryColor as string) }
		: NEUTRAL_THEME;
	const p = makePalette(render);
	const asset = (source: ImageSource) => (themed ? (kit.assets[KIT_SLOT[source]] ?? null) : null);
	return {
		palette: {
			ink: p.ink,
			mutedText: p.mutedText,
			muted: p.muted,
			border: p.border,
			primary: p.primary,
			accent: p.accent,
			primaryText: p.primaryText,
			accentLine: p.accentLine,
			// The renderer's own rule for text on a fill: the palette's ink on white or muted, else the legible one.
			on: {
				ink: textOn(p.ink, p.ink),
				"muted-text": textOn(p.mutedText, p.ink),
				primary: p.onPrimary,
				accent: p.onAccent,
				muted: p.ink,
				border: textOn(p.border, p.ink),
			},
			themed,
		},
		assets: { logo: asset("logo"), mark: asset("mark"), photo: asset("photo") },
	};
}

/**
 * `resolveDocumentTheme(church, documentClass)` picks the church theme or the Everyfield-neutral theme; this adds the
 * logo bytes the church theme points at. With the toggle off, or with no brand kit, the neutral theme renders.
 */
export async function exportTheme(
	db: Database,
	storage: PrivateStorage | null,
	authority: RequestActor,
	church: { name: string; kit: BrandKitData | null },
	documentClass: RenderClass,
	useChurchBranding: boolean,
	images: ReadonlySet<ImageSource> = new Set(),
): Promise<ExportTheme> {
	const theme = resolveDocumentTheme(church, documentClass as DocumentClass, { useChurchBranding });
	const kit = church.kit;
	if (theme.kind !== "church" || !kit || !theme.colors.primary) return NEUTRAL_EXPORT_THEME;
	const ref = logoRef(theme.layout);
	let logo: ThemeImage | undefined;
	if (ref && storage) {
		const read = await readBrandAsset(db, storage, authority, ref.fileId, "theme");
		const aspect = read.status === "ok" ? imageAspect(read.value.bytes) : null;
		if (read.status === "ok" && aspect)
			logo = { bytes: read.value.bytes, mediaType: read.value.mediaType, alt: ref.alt, aspect };
	}
	// The format's image node reads the kit's own assets: the full logo, the mark and the cover photo. Only the ones the
	// document uses are read, and an asset the class slot already read is not read twice.
	const own: NonNullable<RenderTheme["images"]> = {};
	for (const source of images) {
		const asset = kit.assets[KIT_SLOT[source]];
		if (!asset || !storage) continue;
		if (ref && ref.fileId === asset.fileId && logo) {
			own[source] = logo;
			continue;
		}
		const read = await readBrandAsset(db, storage, authority, asset.fileId, "theme");
		const aspect = read.status === "ok" ? imageAspect(read.value.bytes) : null;
		if (read.status === "ok" && aspect)
			own[source] = { bytes: read.value.bytes, mediaType: read.value.mediaType, alt: asset.alt, aspect };
	}
	const serif = (id: string) =>
		["DM Serif Display", "Playfair Display", "Lora", "Merriweather", "Source Serif 4"].includes(id);
	return {
		kind: "church",
		primary: theme.colors.primary,
		fonts: { heading: theme.fonts.heading, body: theme.fonts.body },
		render: {
			name: "church",
			primary: theme.colors.primary,
			accent: theme.colors.accent ?? theme.colors.primary,
			// Only the embedded families can print in the PDF; a serif choice maps to the serif face.
			headingFont: serif(theme.fonts.heading) ? "DM Serif Display" : "DM Sans",
			bodyFont: serif(theme.fonts.body) ? "DM Serif Display" : "DM Sans",
			...(logo ? { logo } : {}),
			images: own,
			...(kit.tagline ? { tagline: kit.tagline } : {}),
			letterhead: {
				...(kit.legalName ? { legalName: kit.legalName } : {}),
				...(kit.address ? { address: kit.address } : {}),
				...(kit.ein ? { ein: kit.ein } : {}),
				...(kit.phone ? { phone: kit.phone } : {}),
				...(kit.email ? { email: kit.email } : {}),
				...(kit.website ? { web: kit.website } : {}),
			},
		},
	};
}
