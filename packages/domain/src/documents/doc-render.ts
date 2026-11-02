import type { EveryfieldDoc } from "@everyfield/contracts/documents";
import { renderDocumentWithLayout } from "@formepdf/core";
import type { ExportTheme } from "./church-theme.ts";
import { renderDocDocx } from "./doc-docx.ts";
import { fieldValues } from "./doc-values.ts";
import { PROBE_MARK, docElement, needsSplit, type FlowMode } from "./layouts/doc.tsx";
import { ARTIFACT_MAX, RenderFailed, renderContext, renderPdfElement, unsafe, type PdfRender } from "./render.ts";
import { NEUTRAL_THEME, type RenderTheme } from "./theme.ts";
import { buildLedgerWorkbook, ledgerTables } from "./xlsx.ts";

type LaidElement = { bookmark?: string; children?: LaidElement[] };

/**
 * Where a document with a `first` or `rest` region splits: after the last top-level body element that ends on page 1.
 * Forme repeats a fixed region on every page from where it starts and never stops it, so the first page and the rest
 * run as two pages. A probe layout marks each top-level element; a continued element carries no mark on page 2.
 */
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

/**
 * The PDF of one everyfield.doc/1 document or template. The Church Document preview, "Download PDF" and the saved
 * export all call this function, so the same revision and theme give the same bytes.
 */
export async function renderDocPdf(doc: EveryfieldDoc, theme: RenderTheme = NEUTRAL_THEME): Promise<PdfRender> {
	const values = fieldValues(doc);
	if (Object.values(values).some(unsafe)) throw new RenderFailed();
	const context = () => renderContext(values.church_name ?? doc.title, values, theme, doc.class);
	try {
		const mode = needsSplit(doc) ? await splitPoint(context(), doc) : ({ kind: "single" } as const);
		return await renderPdfElement(docElement(context(), doc, mode));
	} catch (error) {
		if (error instanceof RenderFailed) throw error;
		throw new RenderFailed(error);
	}
}

export type DocFormat = "pdf" | "docx" | "xlsx";

/** The formats a document offers: PDF and Word always, Excel when the body holds a ledger table (a budget). */
export function docFormats(doc: EveryfieldDoc): DocFormat[] {
	return ledgerTables(doc).length ? ["pdf", "docx", "xlsx"] : ["pdf", "docx"];
}

/**
 * The bytes of one document in one format. The preview, every download and the saved export call this function, so
 * one revision with one theme gives one set of bytes. A format the document does not offer is a failed render.
 */
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
