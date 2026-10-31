import type {
	contextResult,
	documentCategory,
	documentFormat,
	generatedDocument,
	ownedDocument,
	templateView,
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
	return bytes > 16 * 1024;
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

export type OwnedView = Pick<z.infer<typeof ownedDocument>, "id" | "kind" | "title" | "body" | "revision" | "archived">;

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
