import {
	forkTemplate,
	ledgerTables,
	type BlockNode,
	type DocDocument,
	type DocTemplate,
} from "@everyfield/contracts/documents";
import type { AgendaMeeting } from "./agenda-meeting.ts";
import type { CatalogTemplate, LibraryTemplate } from "./catalog.ts";
import { renderDocPdf } from "./doc-render.ts";
import { docTemplateById, sheetOf } from "./doc-templates.ts";
import { fieldValues, frozenData } from "./doc-values.ts";
import type { ResolvedMerge } from "./merge.ts";
import { fillStatementSlots } from "./network-statement.ts";
import { finish, RenderFailed, renderContext, renderPdfElement, unsafe, type PdfRender } from "./render.ts";
import { entryFor, type LibraryFacts } from "./templates/registry.ts";
import { NEUTRAL_THEME, type RenderTheme } from "./theme.ts";
import { buildFirstYearBudget, buildLedgerWorkbook } from "./xlsx.ts";

function libraryFormat(template: DocTemplate): LibraryFacts["format"] {
	const format = template.exports[0];
	if (format !== "pdf" && format !== "xlsx")
		throw new Error(`templates/${template.id}.json exports no PDF or Excel first`);
	return format;
}

function headings(nodes: readonly BlockNode[] | undefined, out: string[] = []) {
	for (const node of nodes ?? []) {
		if (node.type === "heading") {
			const text = (node.content ?? [])
				.map((n) => (n.type === "text" ? n.text : ""))
				.join("")
				.trim();
			if (text) out.push(text);
		} else if (node.type === "columns") for (const column of node.content) headings(column.content, out);
		else if (node.type === "box") headings(node.content, out);
	}
	return out;
}

async function docFacts(template: DocTemplate): Promise<LibraryFacts> {
	const format = libraryFormat(template);
	const outline = headings(template.body.content).slice(0, 20);
	const base = { documentClass: template.class, outline: outline.length ? outline : [template.title] };
	if (format === "xlsx")
		return { ...base, format, pageSize: null, pageCount: ledgerTables(template.body).length, fields: [] };
	const pdf = await renderDocPdf(template);
	const { width, height } = sheetOf(template.page);
	return {
		...base,
		format,
		pageSize: { width, height },
		pageCount: pdf.pages,
		fields: pdf.fields.map((field) => field.name),
	};
}

export function libraryFacts(id: string): Promise<LibraryFacts> | undefined {
	const template = docTemplateById(id);
	if (template) return docFacts(template);
	const entry = entryFor(id);
	return entry && Promise.resolve(entry);
}

export async function libraryDoc(
	template: DocTemplate,
	values: Record<string, string>,
	theme: RenderTheme,
	statement: string | null,
): Promise<DocDocument> {
	const l = theme.letterhead;
	const { data } = frozenData(template.fields, {
		churchName: values.church_name ?? "",
		pastorName: values.pastor_name ?? null,
		tagline: theme.tagline ?? null,
		legalName: l?.legalName ?? null,
		contactLine: [l?.web, l?.phone, l?.email].filter(Boolean).join("  ·  ") || null,
		meetingDate: null,
	});
	return fillStatementSlots(await forkTemplate(template, { id: template.id, data }), statement);
}

async function rendering<T>(render: () => Promise<T>): Promise<T> {
	try {
		return await render();
	} catch (error) {
		if (error instanceof RenderFailed) throw error;
		throw new RenderFailed(error);
	}
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

export async function renderTemplatePdf(
	template: Pick<CatalogTemplate, "id">,
	values: Record<string, string>,
	theme: RenderTheme = NEUTRAL_THEME,
	meeting?: AgendaMeeting,
	statement: string | null = null,
): Promise<PdfRender> {
	const church = values.church_name ?? "";
	if (
		Object.values(values).some(unsafe) ||
		unsafe(church) ||
		(meeting && unsafeMeeting(meeting)) ||
		(statement !== null && unsafe(statement))
	)
		throw new RenderFailed();
	const file = docTemplateById(template.id);
	if (file) {
		if (libraryFormat(file) !== "pdf") throw new RenderFailed();
		return rendering(async () => renderDocPdf(await libraryDoc(file, values, theme, statement), theme));
	}
	const entry = entryFor(template.id);
	if (entry?.format !== "pdf") throw new RenderFailed();
	return rendering(() =>
		renderPdfElement(entry.build(renderContext(church, values, theme, entry.documentClass, meeting))),
	);
}

const valuesOf = (resolved: Extract<ResolvedMerge, { ok: true }>) => {
	const values: Record<string, string> = {};
	for (const field of resolved.fields) if (field.value) values[field.key] = field.value;
	return values;
};

export async function renderPreview(
	template: LibraryTemplate,
	format: "pdf" | "docx" | "xlsx",
	resolved: Extract<ResolvedMerge, { ok: true }>,
	theme: RenderTheme = NEUTRAL_THEME,
	meeting?: AgendaMeeting,
	statement: string | null = null,
) {
	if (!resolved.complete) return null;
	if (template.facts.format !== format) throw new RenderFailed();
	const values = valuesOf(resolved);
	if (Object.values(values).some(unsafe)) throw new RenderFailed();
	if (format === "pdf") return (await renderTemplatePdf(template, values, theme, meeting, statement)).bytes;
	const file = docTemplateById(template.id);
	return rendering(async () => {
		if (!file) return finish(buildFirstYearBudget(values.church_name ?? "", theme));
		const doc = await libraryDoc(file, values, theme, statement);
		return finish(buildLedgerWorkbook(doc, fieldValues(doc), theme));
	});
}
