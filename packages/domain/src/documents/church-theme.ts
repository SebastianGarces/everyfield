import type { BrandKitData, DocumentClass, DocumentTheme } from "@everyfield/contracts/branding";
import type { Database } from "@everyfield/db/client";
import type { PrivateStorage } from "@everyfield/db/schema";
import "server-only";
import type { RequestActor } from "../access/session.ts";
import { readBrandAsset } from "../branding/files.ts";
import { resolveDocumentTheme } from "../branding/theme.ts";
import { NEUTRAL_THEME, type RenderClass, type RenderTheme, type ThemeImage } from "./theme.ts";

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
