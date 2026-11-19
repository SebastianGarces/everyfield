import { loadStarter, referenceArtifactSha256 } from "@everyfield/reference/playbook";
import "server-only";
import type { DocTemplate } from "@everyfield/contracts/documents";
import { docTemplateById } from "./doc-templates.ts";
import { libraryFacts } from "./library-render.ts";
import type { LibraryFacts } from "./templates/registry.ts";
import { z } from "zod";

const mergeField = z.strictObject({
	key: z.string().min(1).max(80),
	label: z.string().min(1).max(200),
	required: z.boolean(),
	autoFill: z.string().min(1).max(80).optional(),
	placeholder: z.string().max(200).optional(),
	description: z.string().max(500).optional(),
});
const templateSchema = z.strictObject({
	id: z.string().min(1).max(80),
	name: z.string().min(1).max(200),
	description: z.string().min(1).max(2000),
	category: z.enum(["commitment", "vision_meeting", "administrative", "operational"]),
	phase: z.number().int().min(0).max(6).optional(),
	formats: z
		.array(z.enum(["pdf", "docx", "xlsx"]))
		.min(1)
		.max(3),
	pageCount: z.number().int().min(1).max(20),
	relatedWikiSlug: z.string().min(1).max(200).optional(),
	mergeFields: z.array(mergeField).max(20),
});
export type CatalogTemplate = z.infer<typeof templateSchema>;
export type LibraryTemplate = CatalogTemplate & { facts: LibraryFacts };

const FILE_ONLY = ["bylaws", "prayer-letter"];

const AUTO_FILL: Record<string, string> = { "church.name": "church_name", "church.pastor": "pastor_name" };

function fieldRefs(node: unknown, out = new Set<string>()): Set<string> {
	if (Array.isArray(node)) for (const child of node) fieldRefs(child, out);
	else if (node && typeof node === "object") {
		const { type, attrs } = node as { type?: unknown; attrs?: { key?: unknown } };
		if (type === "field" && typeof attrs?.key === "string") out.add(attrs.key);
		for (const value of Object.values(node)) fieldRefs(value, out);
	}
	return out;
}

function fileFills(file: DocTemplate) {
	const placed = fieldRefs([file.page, file.body]).add("church_name");
	return new Set(
		file.fields.flatMap((field) =>
			field.source && AUTO_FILL[field.source] === field.key && placed.has(field.key) ? [field.key] : [],
		),
	);
}

let loaded: ReturnType<typeof loadLibrary> | undefined;

export function library() {
	loaded ??= loadLibrary().catch((error: unknown) => {
		loaded = undefined;
		throw error;
	});
	return loaded;
}

async function loadLibrary() {
	const starter = await loadStarter();
	const version = await referenceArtifactSha256();
	const withFacts = async (template: CatalogTemplate): Promise<LibraryTemplate> => {
		const facts = await libraryFacts(template.id);
		if (!facts) throw new Error(`Template ${template.id} has no template file and no registry entry.`);
		const file = docTemplateById(template.id);
		const fills = file && fileFills(file);
		const mergeFields = fills ? template.mergeFields.filter((field) => fills.has(field.key)) : template.mergeFields;
		return { ...template, mergeFields, formats: [facts.format], pageCount: facts.pageCount, facts };
	};
	const rows = z.array(templateSchema).parse(starter.catalogs.documents);
	const files = FILE_ONLY.filter((id) => !rows.some((row) => row.id === id)).map((id): CatalogTemplate => {
		const file = docTemplateById(id);
		if (!file) throw new Error(`templates/${id}.json is missing.`);
		const fills = fileFills(file);
		return {
			id,
			name: file.title,
			description: file.description ?? file.title,
			category: "administrative",
			formats: [],
			pageCount: 1,
			mergeFields: file.fields.flatMap((field) =>
				fills.has(field.key)
					? [{ key: field.key, label: field.label, required: field.required ?? false, autoFill: field.key }]
					: [],
			),
		};
	});
	const templates: LibraryTemplate[] = [];
	for (const template of [...rows, ...files]) templates.push(await withFacts(template));
	return { version, templates };
}

export function templateView(template: LibraryTemplate) {
	return {
		id: template.id,
		name: template.name,
		description: template.description,
		category: template.category,
		phase: template.phase ?? null,
		formats: template.formats,
		pageCount: template.pageCount,
		wikiSlug: template.relatedWikiSlug ?? null,
		mergeFields: template.mergeFields.map((field) => ({
			key: field.key,
			label: field.label,
			required: field.required,
			autoFill: field.autoFill ?? null,
		})),
		documentClass: template.facts.documentClass,
		pageSize: template.facts.pageSize,
		fillable: template.facts.fields.length > 0,
		outline: template.facts.outline,
	};
}
