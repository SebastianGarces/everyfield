import type { BlockNode, EveryfieldDoc, FieldDecl, IfNode } from "@everyfield/contracts/documents";

const text = (value: unknown) =>
	typeof value === "string" ? value : typeof value === "number" && Number.isFinite(value) ? String(value) : "";

function fill(source: string, value: (key: string) => string) {
	return source.replace(/\{([a-z][a-z0-9_]*)\}/g, (_, key: string) => value(key));
}

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
		if (doc.kind === "document" && doc.data && Object.hasOwn(doc.data, field.key) && !stored(field.key)) {
			out[field.key] = "";
			continue;
		}
		const value = stored(field.key) || fill(field.fallback ?? "", stored);
		out[field.key] = value || `[${field.label.toLowerCase()}]`;
	}
	return out;
}

export function listValues(doc: EveryfieldDoc, key: string): Record<string, unknown>[] {
	const raw = doc.kind === "document" ? doc.data?.[key] : doc.fields.find((f) => f.key === key)?.sample;
	return Array.isArray(raw)
		? raw.filter((row): row is Record<string, unknown> => !!row && typeof row === "object")
		: [];
}

const asNumber = (text: string) => (/^-?\d+(\.\d+)?$/.test(text.trim()) ? Number(text) : null);

export function conditionHolds(
	doc: EveryfieldDoc,
	condition: IfNode["attrs"],
	values: Record<string, string> = fieldValues(doc),
): boolean {
	const field = doc.fields.find((f) => f.key === condition.field);
	if (!field) return false;
	const count = field.type === "list" ? listValues(doc, field.key).length : null;
	const printed = values[field.key] ?? "";
	const hasValue = count !== null ? count > 0 : printed !== "" && printed !== `[${field.label.toLowerCase()}]`;
	switch (condition.test) {
		case "has-value":
			return hasValue;
		case "is-empty":
			return !hasValue;
		case "more-than": {
			const amount = count ?? asNumber(printed);
			return amount !== null && amount > (condition.value ?? 0);
		}
	}
}

export function printedDoc<T extends EveryfieldDoc>(doc: T): T {
	const values = fieldValues(doc);
	let found = false;
	const walk = (nodes: readonly BlockNode[]): BlockNode[] =>
		nodes.flatMap((node): BlockNode[] => {
			if (node.type === "if") {
				found = true;
				return conditionHolds(doc, node.attrs, values) ? walk(node.content) : [];
			}
			if (node.type === "columns")
				return [{ ...node, content: node.content.map((col) => ({ ...col, content: walk(col.content ?? []) })) }];
			if (node.type === "box") return [{ ...node, content: walk(node.content ?? []) }];
			return [node];
		});
	const content = walk(doc.body.content ?? []);
	return found ? { ...doc, body: { ...doc.body, content } } : doc;
}

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

export const INSERTABLE_FIELDS = [
	{ key: "church_name", label: "Church name", type: "text", source: "church.name" },
	{ key: "pastor_name", label: "Pastor", type: "text", source: "church.pastor" },
	{ key: "church_tagline", label: "Tagline", type: "text", source: "brand.tagline" },
	{ key: "contact_line", label: "Contact line", type: "text", source: "brand.contactLine" },
	{ key: "meeting_date", label: "Meeting date", type: "date", source: "meeting.date" },
] as const satisfies readonly FieldDecl[];

export function insertableValues(sources: MergeSources): Record<string, string> {
	const out: Record<string, string> = {};
	for (const field of INSERTABLE_FIELDS) {
		const value = SOURCE[field.source]?.(sources)?.trim();
		if (value) out[field.key] = value;
	}
	return out;
}

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

export const SLOT_BLANK_NOTE =
	"Not filled in yet. Your church or its sending network adds this text. It stays blank until then.";

export const PLACEHOLDER = /\[[^\[\]\n]{1,60}\]/g;

export const PLACEHOLDER_FILL = "#FDF0A6";

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
