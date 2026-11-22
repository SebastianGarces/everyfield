import { createHash } from "node:crypto";
import type { ReactElement } from "react";
import { renderDocumentWithLayout, type ElementInfo } from "@formepdf/core";
import { hash } from "../operations/canonical.ts";
import type { AgendaMeeting } from "./agenda-meeting.ts";
import { fontDigests } from "./fonts.ts";
import { finishForm } from "./pdf-post.ts";
import { ContrastLog } from "./contrast.ts";
import type { Ctx } from "./layouts/blocks.tsx";
import { contentSnapshot } from "./templates/registry.ts";
import { makePalette, themeTokensDigest, type RenderClass, type RenderTheme } from "./theme.ts";

export const RENDER_PROFILE = {
	engine: "forme",
	packages: { "@formepdf/core": "0.29.0", "@formepdf/react": "0.29.0", "pdf-lib": "1.17.1" },
	layout: 4,
} as const;

export const ARTIFACT_MAX = 8 * 1024 * 1024;

export class RenderFailed extends Error {
	constructor(cause?: unknown) {
		super("render_failed", cause === undefined ? undefined : { cause });
	}
}

export function engineVersionOf(content: unknown) {
	return hash({ profile: RENDER_PROFILE, fonts: fontDigests(), theme: themeTokensDigest(), content });
}
let engineVersion: ReturnType<typeof engineVersionOf> | undefined;
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
	text: string[][];
	fields: { name: string; type: "Sig" | "Tx" | "Btn"; tooltip: string }[];
};

export async function renderPdfElement(element: ReactElement): Promise<PdfRender> {
	const laid = await renderDocumentWithLayout(element);
	const text = laid.layout.pages.map((page) => {
		const lines: string[] = [];
		const walk = (node: ElementInfo) => {
			if (node.nodeType === "TextLine" && node.textContent) lines.push(node.textContent);
			for (const child of node.children ?? []) walk(child);
		};
		for (const node of page.elements) walk(node);
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
