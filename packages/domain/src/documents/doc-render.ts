import { ledgerTables, type EveryfieldDoc } from "@everyfield/contracts/documents";
import { renderDocumentWithLayout } from "@formepdf/core";
import type { ExportTheme } from "./church-theme.ts";
import { renderDocDocx } from "./doc-docx.ts";
import { fieldValues, printedDoc } from "./doc-values.ts";
import {
	CHECK_MARK,
	CHECK_SIZE,
	PROBE_MARK,
	docElement,
	hasCheckColumn,
	needsSplit,
	type CheckOffsets,
	type FlowMode,
} from "./layouts/doc.tsx";
import { ARTIFACT_MAX, RenderFailed, renderContext, renderPdfElement, unsafe, type PdfRender } from "./render.ts";
import { NEUTRAL_THEME, type RenderTheme } from "./theme.ts";
import { buildLedgerWorkbook } from "./xlsx.ts";

type LaidElement = { bookmark?: string; nodeType?: string; y: number; height: number; children?: LaidElement[] };

async function splitPoint(ctx: ReturnType<typeof renderContext>, doc: EveryfieldDoc): Promise<FlowMode> {
	const laid = await renderDocumentWithLayout(docElement(ctx, doc, { kind: "probe" }) as never);
	const pages = laid.layout.pages as unknown as { elements: LaidElement[] }[];
	if (pages.length < 2) return { kind: "single" };
	const mark = (e: LaidElement | undefined) =>
		e?.bookmark?.startsWith(PROBE_MARK) ? Number(e.bookmark.slice(PROBE_MARK.length)) : null;
	const marks = (pages[0]?.elements ?? []).map(mark).filter((m): m is number => m !== null);
	const last = marks.at(-1);
	if (last === undefined) return { kind: "single" };
	const continued = mark(pages[1]?.elements[0]) === null && (pages[1]?.elements.length ?? 0) > 0;
	return { kind: "split", at: continued && last > 0 ? last : last + 1 };
}

async function checkOffsets(ctx: ReturnType<typeof renderContext>, doc: EveryfieldDoc, mode: FlowMode) {
	const laid = await renderDocumentWithLayout(docElement(ctx, doc, mode, "probe") as never);
	const offsets = new Map<string, number>();
	const walk = (node: LaidElement, cell: LaidElement | null) => {
		if (node.bookmark?.startsWith(CHECK_MARK) && cell && !offsets.has(node.bookmark)) {
			const offset = cell.y + cell.height / 2 - (node.y + CHECK_SIZE / 2);
			offsets.set(node.bookmark.slice(CHECK_MARK.length), Math.max(0, +offset.toFixed(2)));
		}
		for (const child of node.children ?? []) walk(child, node.nodeType === "TableCell" ? node : cell);
	};
	for (const page of laid.layout.pages as unknown as { elements: LaidElement[] }[])
		for (const element of page.elements) walk(element, null);
	return offsets as CheckOffsets;
}

export async function renderDocPdf(source: EveryfieldDoc, theme: RenderTheme = NEUTRAL_THEME): Promise<PdfRender> {
	const doc = printedDoc(source);
	const values = fieldValues(doc);
	if (Object.values(values).some(unsafe)) throw new RenderFailed();
	const context = () => renderContext(values.church_name ?? doc.title, values, theme, doc.class);
	try {
		const mode = needsSplit(doc) ? await splitPoint(context(), doc) : ({ kind: "single" } as const);
		const checks = hasCheckColumn(doc) ? await checkOffsets(context(), doc, mode) : new Map();
		return await renderPdfElement(docElement(context(), doc, mode, checks));
	} catch (error) {
		if (error instanceof RenderFailed) throw error;
		throw new RenderFailed(error);
	}
}

export type DocFormat = "pdf" | "docx" | "xlsx";

export function offeredFormats(exports: readonly DocFormat[], ledger: boolean): DocFormat[] {
	return (["pdf", "docx", "xlsx"] as const).filter((format) => (format === "xlsx" ? ledger : exports.includes(format)));
}

export function docFormats(doc: EveryfieldDoc): DocFormat[] {
	return offeredFormats(doc.exports, ledgerTables(doc.body).length > 0);
}

export async function renderDocFile(doc: EveryfieldDoc, format: DocFormat, theme: ExportTheme, created: Date) {
	if (!docFormats(doc).includes(format)) throw new RenderFailed();
	if (format === "pdf") return (await renderDocPdf(doc, theme.render)).bytes;
	try {
		const bytes =
			format === "docx" ? renderDocDocx(doc, theme, created) : buildLedgerWorkbook(doc, fieldValues(doc), theme.render);
		if (bytes.length > ARTIFACT_MAX) throw new RenderFailed();
		return bytes;
	} catch (error) {
		if (error instanceof RenderFailed) throw error;
		throw new RenderFailed(error);
	}
}
