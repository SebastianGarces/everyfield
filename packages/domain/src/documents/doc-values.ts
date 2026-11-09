import type { EveryfieldDoc, FieldDecl } from "@everyfield/contracts/documents";

// What a `field` node prints, for the PDF, the Word file and the workbook alike. A document prints the value it froze at
// creation (`data`), then the field's fallback. A template prints its sample. A field with no value prints its label in
// brackets, never an invented name.

const text = (value: unknown) =>
	typeof value === "string" ? value : typeof value === "number" && Number.isFinite(value) ? String(value) : "";

/** `{key}` tokens in a fallback, replaced by the other fields' values. Only one level deep, so no loop. */
function fill(source: string, value: (key: string) => string) {
	return source.replace(/\{([a-z][a-z0-9_]*)\}/g, (_, key: string) => value(key));
}

/** The text every field prints, by key. */
export function fieldValues(doc: EveryfieldDoc): Record<string, string> {
	const byKey = new Map(doc.fields.map((field) => [field.key, field]));
	const stored = (key: string) => {
		const field = byKey.get(key);
		if (!field) return "";
		return doc.kind === "document" ? text(doc.data?.[key]) : text(field.sample);
	};
	const out: Record<string, string> = {};
	for (const field of doc.fields) {
		if (field.type === "list") continue;
		// A frozen empty value is deliberate (an empty fallback): the field prints nothing.
		if (doc.kind === "document" && doc.data && Object.hasOwn(doc.data, field.key) && !stored(field.key)) {
			out[field.key] = "";
			continue;
		}
		const value = stored(field.key) || fill(field.fallback ?? "", stored);
		out[field.key] = value || `[${field.label.toLowerCase()}]`;
	}
	return out;
}

/** The entries of a list field, for a table with `source`. Each entry is an object keyed by column id. */
export function listValues(doc: EveryfieldDoc, key: string): Record<string, unknown>[] {
	const raw = doc.kind === "document" ? doc.data?.[key] : doc.fields.find((f) => f.key === key)?.sample;
	return Array.isArray(raw)
		? raw.filter((row): row is Record<string, unknown> => !!row && typeof row === "object")
		: [];
}

/** Where the app fills each field from, at creation. */
export type MergeSources = {
	churchName: string;
	pastorName: string | null;
	tagline: string | null;
	legalName: string | null;
	contactLine: string | null;
	meetingDate: string | null;
};

const SOURCE: Record<string, (s: MergeSources) => string | null> = {
	"church.name": (s) => s.churchName,
	"church.pastor": (s) => s.pastorName,
	"brand.tagline": (s) => s.tagline,
	"brand.legalName": (s) => s.legalName,
	"brand.contactLine": (s) => s.contactLine,
	"meeting.date": (s) => s.meetingDate,
};

/**
 * The merge values a new document freezes: each field's source, then its fallback (which may name other fields in
 * braces). An empty fallback is a value: the field prints nothing. A field with neither is left out of `data`.
 * `from` says where each value came from: the source name, or "fallback".
 */
export function frozenData(fields: readonly FieldDecl[], sources: MergeSources) {
	const raw: Record<string, string> = {};
	const from: Record<string, string> = {};
	for (const field of fields) {
		const value = field.source ? SOURCE[field.source]?.(sources) : null;
		if (field.source && value?.trim()) {
			raw[field.key] = value.trim();
			from[field.key] = field.source;
		}
	}
	const data: Record<string, string> = { ...raw };
	for (const field of fields) {
		if (raw[field.key] !== undefined || field.fallback === undefined || field.type === "list") continue;
		data[field.key] = fill(field.fallback, (key) => raw[key] ?? "");
		from[field.key] = "fallback";
	}
	return { data, from };
}

// ---------------------------------------------------------------- placeholders

/**
 * A bracketed prompt such as [date], [number] or [low amount]: text in square brackets, 1 to 60 characters, on one line.
 * The highlight comes from the text itself, so the editor, the PDF and the Word file mark the same spans and nothing is
 * stored for it. The PDF hands `source` to Forme's Rust regex engine, which needs the inner `[` escaped.
 */
export const PLACEHOLDER = /\[[^\[\]\n]{1,60}\]/g;

/**
 * The fill every placeholder prints on, whatever the brand: a pale yellow that reads on paper and in grayscale, with the
 * document's ink on it (contrast above 13:1 with any dark ink).
 */
export const PLACEHOLDER_FILL = "#FDF0A6";

/** A run of text cut where its placeholders start and end. Text with none is one plain part. */
export function placeholderParts(text: string): { text: string; placeholder: boolean }[] {
	const parts: { text: string; placeholder: boolean }[] = [];
	let at = 0;
	for (const match of text.matchAll(PLACEHOLDER)) {
		if (match.index > at) parts.push({ text: text.slice(at, match.index), placeholder: false });
		parts.push({ text: match[0], placeholder: true });
		at = match.index + match[0].length;
	}
	if (at < text.length || parts.length === 0) parts.push({ text: text.slice(at), placeholder: false });
	return parts;
}
