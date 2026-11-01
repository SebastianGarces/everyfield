import { createHash } from "node:crypto";
import { renderDocumentWithLayout } from "@formepdf/core";
import { hash } from "../operations/canonical.ts";
import type { AgendaMeeting } from "./agenda-meeting.ts";
import type { CatalogTemplate } from "./catalog.ts";
import { fontDigests } from "./fonts.ts";
import type { ResolvedMerge } from "./merge.ts";
import { finishForm } from "./pdf-post.ts";
import { ContrastLog } from "./contrast.ts";
import type { Ctx } from "./layouts/blocks.tsx";
import { entryFor, contentSnapshot } from "./templates/registry.ts";
import { NEUTRAL_THEME, makePalette, themeTokensDigest, type RenderClass, type RenderTheme } from "./theme.ts";
import { buildBudget } from "./xlsx.ts";

/**
 * Exact pins of the engine packages (see packages/domain/package.json) and a layout revision. A test compares the
 * pins with package.json. Bump `layout` when a layout file changes bytes without changing the registry content.
 */
export const RENDER_PROFILE = {
	engine: "forme",
	packages: { "@formepdf/core": "0.29.0", "@formepdf/react": "0.29.0", "pdf-lib": "1.17.1" },
	layout: 3,
} as const;

/** The largest file one render may give, in bytes. */
export const ARTIFACT_MAX = 8 * 1024 * 1024;

export class RenderFailed extends Error {
	constructor(cause?: unknown) {
		super("render_failed", cause === undefined ? undefined : { cause });
	}
}

/** The version of a render engine over one content snapshot. Saved records keep the version they were made with. */
export function engineVersionOf(content: unknown) {
	return hash({ profile: RENDER_PROFILE, fonts: fontDigests(), theme: themeTokensDigest(), content });
}
export function renderEngineVersion() {
	return engineVersionOf(contentSnapshot());
}

export function unsafe(value: string) {
	if (value.includes("\0")) return true;
	for (let i = 0; i < value.length; i++) {
		const code = value.charCodeAt(i);
		if (code >= 0xd800 && code <= 0xdbff) {
			const next = value.charCodeAt(i + 1);
			if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
			i += 1;
		} else if (code >= 0xdc00 && code <= 0xdfff) return true;
	}
	return false;
}

const unsafeMeeting = (m: AgendaMeeting) =>
	[
		m.title,
		m.date,
		m.time,
		m.place ?? "",
		...m.sections.map((s) => s.title),
		...m.attendees.flatMap((a) => [a.name, a.role ?? ""]),
	].some(unsafe);

function finish(bytes: Uint8Array) {
	if (bytes.length > ARTIFACT_MAX) throw new RenderFailed();
	return Buffer.from(bytes);
}

export type PdfRender = {
	bytes: Buffer;
	pages: number;
	/** The text lines of each page, as laid out. */
	text: string[][];
	fields: { name: string; type: "Sig" | "Tx" | "Btn"; tooltip: string }[];
};

/** Lay out a Forme document element, then finish the form (tooltips, signature fields, /DR). */
export async function renderPdfElement(element: unknown): Promise<PdfRender> {
	const laid = await renderDocumentWithLayout(element as never);
	const text = laid.layout.pages.map((page) => {
		const lines: string[] = [];
		const walk = (node: { textContent?: string; nodeType?: string; children?: unknown[] }) => {
			if (node.nodeType === "TextLine" && node.textContent) lines.push(node.textContent);
			for (const child of node.children ?? []) walk(child as never);
		};
		for (const node of page.elements) walk(node as never);
		return lines;
	});
	const done = await finishForm(laid.pdf);
	return { bytes: finish(done.bytes), pages: laid.layout.pages.length, text, fields: done.fields };
}

export function renderContext(
	church: string,
	values: Record<string, string>,
	theme: RenderTheme,
	documentClass: RenderClass,
	meeting?: AgendaMeeting,
): Ctx {
	return { p: makePalette(theme), theme, documentClass, church, values, log: new ContrastLog(), meeting };
}

const valuesOf = (resolved: Extract<ResolvedMerge, { ok: true }>) => {
	const values: Record<string, string> = {};
	for (const field of resolved.fields) if (field.value) values[field.key] = field.value;
	return values;
};

/** A template's PDF with its layout details. The theme is an input; the default is the Everyfield-neutral theme. */
export async function renderTemplatePdf(
	template: Pick<CatalogTemplate, "id">,
	values: Record<string, string>,
	theme?: RenderTheme,
	meeting?: AgendaMeeting,
) {
	const entry = entryFor(template.id);
	if (!entry || entry.format !== "pdf") throw new RenderFailed();
	const church = values.church_name ?? "";
	if (Object.values(values).some(unsafe) || unsafe(church) || (meeting && unsafeMeeting(meeting)))
		throw new RenderFailed();
	const use = theme ?? NEUTRAL_THEME;
	try {
		return await renderPdfElement(entry.build(renderContext(church, values, use, entry.documentClass, meeting)));
	} catch (error) {
		if (error instanceof RenderFailed) throw error;
		throw new RenderFailed();
	}
}

/** Null when a required field is missing. Bytes come only from the template registry and the resolved fields. */
export async function renderPreview(
	template: CatalogTemplate,
	format: "pdf" | "docx" | "xlsx",
	resolved: Extract<ResolvedMerge, { ok: true }>,
	theme?: RenderTheme,
	meeting?: AgendaMeeting,
) {
	if (!resolved.complete) return null;
	const entry = entryFor(template.id);
	if (!entry || entry.format !== format) throw new RenderFailed();
	const values = valuesOf(resolved);
	if (Object.values(values).some(unsafe)) throw new RenderFailed();
	if (entry.format === "pdf") return (await renderTemplatePdf(template, values, theme, meeting)).bytes;
	const church = values.church_name ?? "";
	const use = theme ?? NEUTRAL_THEME;
	return finish(buildBudget(entry.budget, church, use));
}

export function digestOf(bytes: Buffer) {
	return createHash("sha256").update(bytes).digest("hex");
}
