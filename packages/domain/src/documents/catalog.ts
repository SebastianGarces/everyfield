import { loadStarter, referenceArtifactSha256 } from "@everyfield/reference/playbook";
import "server-only";
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
/** A library template with its facts: from its template file when it has one, else its registry entry. */
export type LibraryTemplate = CatalogTemplate & { facts: LibraryFacts };

/**
 * Template files with no frozen reference row (Bylaws, Prayer Letter). They join the library under Administrative, so
 * "Save for your church" makes a file of them too (Sebastian, 2026-11-04: keep both paths).
 */
const FILE_ONLY = ["bylaws", "prayer-letter"];

/** The library merge fields a file's fields fill from: the church and pastor names. */
const AUTO_FILL: Record<string, string> = { "church.name": "church_name", "church.pastor": "pastor_name" };

let loaded: ReturnType<typeof loadLibrary> | undefined;

/**
 * The template library: the frozen reference rows and the template files with no row. Read once per process; a failed
 * read is not kept, so the next call tries again.
 */
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
		return { ...template, formats: [facts.format], pageCount: facts.pageCount, facts };
	};
	// The frozen reference row gives identity and merge fields; the template file or the registry gives the rest.
	const rows = z.array(templateSchema).parse(starter.catalogs.documents);
	const files = FILE_ONLY.filter((id) => !rows.some((row) => row.id === id)).map((id): CatalogTemplate => {
		const file = docTemplateById(id);
		if (!file) throw new Error(`templates/${id}.json is missing.`);
		return {
			id,
			name: file.title,
			description: file.description ?? file.title,
			category: "administrative",
			formats: [],
			pageCount: 1,
			mergeFields: file.fields.flatMap((field) => {
				const autoFill = field.source && AUTO_FILL[field.source];
				return autoFill && autoFill === field.key
					? [{ key: field.key, label: field.label, required: field.required ?? false, autoFill }]
					: [];
			}),
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
