import {
	MERGE_BYTES_MAX,
	type contextResult,
	type documentCategory,
	type documentFormat,
	type generatedDocument,
	type ownedDocument,
	type ownedListItem,
	type templateView,
} from "@everyfield/contracts/documents";
import type { z } from "zod";

// Launch is the screen name for the operational category. The catalog has no "launch" value.

export type Template = z.infer<typeof templateView>;
export type Format = z.infer<typeof documentFormat>;
export type Category = z.infer<typeof documentCategory>;
export type CategoryFilter = Category | "all";
export type FieldSource = z.infer<typeof contextResult>["fields"][number]["source"];

export type Resolved = {
	templateId: string;
	format: Format;
	fields: z.infer<typeof contextResult>["fields"];
	missing: string[];
	complete: boolean;
};

export type DocumentsQuery = {
	template: string | null;
	category: CategoryFilter;
	wiki: string | null;
	phase: number | null;
	q: string;
	format: Format | null;
};

export const CATEGORIES: { value: CategoryFilter; label: string }[] = [
	{ value: "all", label: "All" },
	{ value: "vision_meeting", label: "Vision meetings" },
	{ value: "commitment", label: "Commitment" },
	{ value: "administrative", label: "Administrative" },
	{ value: "operational", label: "Launch" },
];

const CATEGORY_VALUES = new Set<string>(CATEGORIES.map((item) => item.value));
const FORMATS = new Set<string>(["pdf", "docx", "xlsx"]);

export const FORMAT_LABEL: Record<Format, string> = { pdf: "PDF", docx: "Word", xlsx: "Excel" };

export const SOURCE_LABEL: Record<Exclude<FieldSource, "absent">, string> = {
	church_name: "From church",
	pastor_name: "From pastor",
	launch_date: "From launch date",
	meeting: "From meeting",
	override: "Your text",
};

export const MIME: Record<Format, string> = {
	pdf: "application/pdf",
	docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
	xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
};

const FIELD_ERROR: Record<string, string> = {
	church_name: "Enter the church name.",
	pastor_name: "Enter the pastor name.",
	launch_date: "Enter the launch date.",
	meeting_date: "Enter the meeting date.",
	meeting_number: "Enter the meeting number.",
};

export function fieldError(key: string, label: string) {
	return FIELD_ERROR[key] ?? `Enter ${label}.`;
}

export function categoryLabel(category: Category) {
	return CATEGORIES.find((item) => item.value === category)?.label ?? category;
}

export function phaseText(phase: number | null) {
	return phase === null ? null : `Phase ${phase}`;
}

function isCategory(value: string): value is CategoryFilter {
	return CATEGORY_VALUES.has(value);
}

function isFormat(value: string): value is Format {
	return FORMATS.has(value);
}

/** Read the documents address. An unknown category, phase, or format is omitted. */
export function parseQuery(params: URLSearchParams): DocumentsQuery {
	const category = params.get("category");
	const format = params.get("format");
	const phaseRaw = params.get("phase");
	const phase = phaseRaw !== null && /^[0-6]$/.test(phaseRaw) ? Number(phaseRaw) : null;
	const wiki = params.get("wiki")?.trim() || null;
	return {
		template: params.get("template"),
		category: category && isCategory(category) ? category : "all",
		wiki: wiki ? wiki.slice(0, 200) : null,
		phase,
		q: (params.get("q") ?? "").slice(0, 80),
		format: format && isFormat(format) ? format : null,
	};
}

export type TemplateFilter = {
	category: CategoryFilter;
	wiki: string | null;
	phase: number | null;
	q: string;
};

/** Category, article, phase, and search run on the loaded library. Search is not an API filter. */
export function filterTemplates(templates: Template[], filter: TemplateFilter) {
	const q = filter.q.trim().toLowerCase();
	return templates.filter((template) => {
		if (filter.category !== "all" && template.category !== filter.category) return false;
		if (filter.wiki && template.wikiSlug !== filter.wiki) return false;
		if (filter.phase !== null && template.phase !== filter.phase) return false;
		if (q && !`${template.name} ${template.description}`.toLowerCase().includes(q)) return false;
		return true;
	});
}

/** The address template when it is in the filtered list. Otherwise the first match. An unknown id is omitted. */
export function choose(templates: Template[], templateId: string | null) {
	if (templates.length === 0) return null;
	return templates.find((template) => template.id === templateId) ?? templates[0];
}

export function offeredFormat(template: Template, format: Format | null): Format {
	if (format && template.formats.includes(format)) return format;
	const first = template.formats[0];
	if (!first) throw new Error("Template has no format.");
	return first;
}

export function draftsFrom(resolved: Resolved | null) {
	const drafts: Record<string, string> = {};
	for (const field of resolved?.fields ?? []) drafts[field.key] = field.value ?? "";
	return drafts;
}

/**
 * Text the person changed. A blank field is omitted so the church value can fill it again.
 * An unchanged church, pastor, or launch value is also omitted, so the file still prints that value.
 */
export function overridesOf(template: Template, drafts: Record<string, string>, resolved: Resolved | null) {
	const overrides: Record<string, string> = {};
	for (const field of template.mergeFields) {
		const value = (drafts[field.key] ?? "").trim();
		if (!value) continue;
		const known =
			resolved?.templateId === template.id ? resolved.fields.find((item) => item.key === field.key) : undefined;
		const unchanged =
			known && known.source !== "override" && known.source !== "absent" && value === (known.value ?? "").trim();
		if (!unchanged) overrides[field.key] = value;
	}
	return overrides;
}

export function combinedTooLong(overrides: Record<string, string>) {
	const bytes = Object.values(overrides).reduce((sum, value) => sum + new TextEncoder().encode(value).length, 0);
	return bytes > MERGE_BYTES_MAX;
}

/** What the person reads when the merge fields together pass the byte cap. */
export const MERGE_TOO_LONG = `Shorten the fields. Together they must stay under ${MERGE_BYTES_MAX / 1024} KB.`;

/** The server refuses merge values over the byte cap at the path "overrides" (an unknown key is "overrides.<key>"). */
export function mergeTooLong(code: string, path: string | undefined) {
	return code === "invalid_input" && path === "overrides";
}

export function fileName(name: string, format: Format) {
	const safe = name
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-|-$/g, "");
	return `${safe || "document"}.${format}`;
}

export type SavedFile = Pick<
	z.infer<typeof generatedDocument>,
	"id" | "savedTemplateName" | "format" | "generatedAt" | "downloadName"
>;

/** One row of the written-documents list. The list links to the document's own page and carries no body. */
export type OwnedView = Pick<z.infer<typeof ownedListItem>, "id" | "kind" | "title" | "archived">;
/** A plain native document on its own page: the body node, its revision, and where it came from. */
export type WrittenView = Pick<
	z.infer<typeof ownedDocument>,
	"id" | "kind" | "title" | "body" | "revision" | "archived" | "textRevision"
> & {
	/** True for a church copy made with Use for this church. */
	copied: boolean;
};
/** What the native page shows of a stored document. The tenant and the hashes stay on the server. */
export function writtenView(value: z.infer<typeof ownedDocument>): WrittenView {
	return {
		id: value.id,
		kind: value.kind,
		title: value.title,
		body: value.body,
		revision: value.revision,
		archived: value.archived,
		textRevision: value.textRevision,
		copied: value.copiedFromHash !== null,
	};
}
/** One of your account documents Use for this church can copy. */
export type CopySource = { id: string; title: string; revisionId: string };

/**
 * A sentence for a refused document action. Invalid input keeps the server's problem.
 * A conflict always tells the person to reload.
 */
export function documentProblem(code: string, problem: string | undefined, fallback: string) {
	if (code === "invalid_input" && problem) return problem;
	if (code === "unavailable" && problem) return problem;
	if (code === "conflict") return "This document changed. Reload it, then try again.";
	return fallback;
}

export function savedWhen(iso: string) {
	const date = new Date(iso);
	if (Number.isNaN(date.getTime())) return iso;
	return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(date);
}

/**
 * The church's own values a library render prints, by where each comes from, as the page's resolved fields name them.
 * A typed override is not the church's value, and an absent field has none.
 */
export function churchValues(resolved: Resolved | null): Record<string, string> {
	const values: Record<string, string> = {};
	for (const field of resolved?.fields ?? [])
		if (field.source !== "override" && field.source !== "absent" && field.value !== null)
			values[field.source] = field.value;
	return values;
}

const sorted = (record: Record<string, string>) => Object.entries(record).sort(([a], [b]) => (a < b ? -1 : 1));

/**
 * What one library render depends on: the template and the library version it belongs to, the format, the typed
 * overrides and the church's own values. Equal keys mean equal bytes, so a thumbnail and the preview of the same
 * template share one render, and a change to any of them makes a new one.
 */
export function renderKey(input: {
	templateId: string;
	version: string;
	format: Format;
	overrides: Record<string, string>;
	church: Record<string, string>;
}) {
	return JSON.stringify([input.templateId, input.version, input.format, sorted(input.overrides), sorted(input.church)]);
}
