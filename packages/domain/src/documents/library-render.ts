import {
	forkTemplate,
	ledgerTables,
	type BlockNode,
	type DocDocument,
	type DocTemplate,
} from "@everyfield/contracts/documents";
import type { AgendaMeeting } from "./agenda-meeting.ts";
import type { CatalogTemplate } from "./catalog.ts";
import { renderDocPdf } from "./doc-render.ts";
import { docTemplateById, sheetOf } from "./doc-templates.ts";
import { fieldValues, frozenData } from "./doc-values.ts";
import type { ResolvedMerge } from "./merge.ts";
import { fillStatementSlots } from "./network-statement.ts";
import { ARTIFACT_MAX, RenderFailed, renderContext, renderPdfElement, unsafe, type PdfRender } from "./render.ts";
import { entryFor, type LibraryFacts } from "./templates/registry.ts";
import { NEUTRAL_THEME, type RenderTheme } from "./theme.ts";
import { buildFirstYearBudget, buildLedgerWorkbook } from "./xlsx.ts";

// The template library ("Save for your church" and its preview). A library template with an everyfield.doc/1 file
// renders from that file through the Church Document renderer, so an unedited Church Document made from it prints the
// same pages. The templates with no file render from their code layout in the registry (D-922).

/** The library's one format of a template file: the first it exports. */
function libraryFormat(template: DocTemplate): LibraryFacts["format"] {
	const format = template.exports[0];
	if (format !== "pdf" && format !== "xlsx")
		throw new Error(`templates/${template.id}.json exports no PDF or Excel first`);
	return format;
}

/** The text of every heading in the file, in body order, without its merge fields. */
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
	// The page count and field names are what the file prints with its sample values.
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

const facts = new Map<string, Promise<LibraryFacts>>();

/**
 * What the library says about one template: from its file when it has one, else from its registry entry. A file's
 * facts are read from one render of it, once per process; a failed read is not kept.
 */
export function libraryFacts(id: string): Promise<LibraryFacts> | undefined {
	const template = docTemplateById(id);
	if (!template) {
		const entry = entryFor(id);
		return entry && Promise.resolve(entry);
	}
	let found = facts.get(id);
	if (!found) {
		found = docFacts(template).catch((error: unknown) => {
			facts.delete(id);
			throw error;
		});
		facts.set(id, found);
	}
	return found;
}

/**
 * The document a library render prints: the template file with the merge values an unedited Church Document of the
 * same church freezes (the church and pastor names, and the brand kit's legal name, tagline and contact line as the
 * theme carries them; else each field's fallback) and the network's statement of faith in its slot.
 */
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
		// The contact line a Church Document freezes from the kit: website, phone and email.
		contactLine: [l?.web, l?.phone, l?.email].filter(Boolean).join("  ·  ") || null,
		meetingDate: null,
	});
	return fillStatementSlots(await forkTemplate(template, { id: template.id, data }), statement);
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

/**
 * A library template's PDF with its layout details. The theme is an input; the default is the Everyfield-neutral theme.
 * The network's statement of faith fills a template's `statement-of-faith` slot; null leaves the marked blank. A
 * meeting prints only on an agenda.
 */
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
	const entry = file ? undefined : entryFor(template.id);
	if (file ? libraryFormat(file) !== "pdf" : entry?.format !== "pdf") throw new RenderFailed();
	try {
		if (file) return await renderDocPdf(await libraryDoc(file, values, theme, statement), theme);
		if (entry?.format !== "pdf") throw new RenderFailed();
		return await renderPdfElement(
			entry.build(renderContext(church, values, theme, entry.documentClass, meeting, statement)),
		);
	} catch (error) {
		if (error instanceof RenderFailed) throw error;
		throw new RenderFailed(error);
	}
}

const valuesOf = (resolved: Extract<ResolvedMerge, { ok: true }>) => {
	const values: Record<string, string> = {};
	for (const field of resolved.fields) if (field.value) values[field.key] = field.value;
	return values;
};

function sized(bytes: Uint8Array) {
	if (bytes.length > ARTIFACT_MAX) throw new RenderFailed();
	return Buffer.from(bytes);
}

/**
 * Null when a required field is missing. Bytes come only from the template file or registry, the resolved fields and
 * the network's statement of faith, read when the action runs (D-109, D-417).
 */
export async function renderPreview(
	template: CatalogTemplate,
	format: "pdf" | "docx" | "xlsx",
	resolved: Extract<ResolvedMerge, { ok: true }>,
	theme: RenderTheme = NEUTRAL_THEME,
	meeting?: AgendaMeeting,
	statement: string | null = null,
) {
	if (!resolved.complete) return null;
	const found = await libraryFacts(template.id);
	if (!found || found.format !== format) throw new RenderFailed();
	const values = valuesOf(resolved);
	if (Object.values(values).some(unsafe)) throw new RenderFailed();
	if (format === "pdf") return (await renderTemplatePdf(template, values, theme, meeting, statement)).bytes;
	const file = docTemplateById(template.id);
	try {
		if (!file) return sized(buildFirstYearBudget(values.church_name ?? "", theme));
		const doc = await libraryDoc(file, values, theme, statement);
		return sized(buildLedgerWorkbook(doc, fieldValues(doc), theme));
	} catch (error) {
		if (error instanceof RenderFailed) throw error;
		throw new RenderFailed(error);
	}
}
