import { createHash } from "node:crypto";
import { renderDocumentWithLayout } from "@formepdf/core";
import { hash } from "../operations/canonical.ts";
import type { AgendaMeeting } from "./agenda-meeting.ts";
import { fontDigests } from "./fonts.ts";
import { finishForm } from "./pdf-post.ts";
import { ContrastLog } from "./contrast.ts";
import type { Ctx } from "./layouts/blocks.tsx";
import { contentSnapshot } from "./templates/registry.ts";
import { makePalette, themeTokensDigest, type RenderClass, type RenderTheme } from "./theme.ts";

/**
 * Exact pins of the engine packages (see packages/domain/package.json) and a layout revision. A test compares the
 * pins with package.json. Bump `layout` when a layout file changes bytes without changing the registry content.
 */
export const RENDER_PROFILE = {
	engine: "forme",
	packages: { "@formepdf/core": "0.29.0", "@formepdf/react": "0.29.0", "pdf-lib": "1.17.1" },
	layout: 4,
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
let engineVersion: ReturnType<typeof engineVersionOf> | undefined;
/** The version of this process's engine: its pins, fonts, tokens and template content never change while it runs. */
export function renderEngineVersion() {
	engineVersion ??= engineVersionOf(contentSnapshot());
	return engineVersion;
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

export function finish(bytes: Uint8Array) {
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

export function digestOf(bytes: Buffer) {
	return createHash("sha256").update(bytes).digest("hex");
}
