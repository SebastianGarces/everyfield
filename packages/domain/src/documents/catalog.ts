import { loadStarter, referenceArtifactSha256 } from "@everyfield/reference/playbook";
import "server-only";
import { CHURCH_TEMPLATES } from "./templates/church.ts";
import { entryFor } from "./templates/registry.ts";
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

let loaded: ReturnType<typeof loadLibrary> | undefined;

/**
 * The template library: the frozen reference rows and the code-authored templates. Read once per process; a failed
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
	// The frozen reference row gives identity; the registry gives format, page count and layout facts (WP-036/api).
	const templates = z
		.array(templateSchema)
		.parse(starter.catalogs.documents)
		.map((template): CatalogTemplate => {
			const entry = entryFor(template.id);
			if (!entry) throw new Error(`Template ${template.id} is not in the document registry.`);
			return { ...template, formats: [entry.format], pageCount: entry.pageCount };
		});
	// Text templates authored in code with no frozen reference row (Bylaws, Prayer Letter) join the library under
	// Administrative, so "Save for your church" makes a file of them too (Sebastian, 2026-11-04: keep both paths).
	const listed = new Set(templates.map((template) => template.id));
	for (const church of CHURCH_TEMPLATES) {
		if (listed.has(church.id)) continue;
		const entry = entryFor(church.id);
		if (!entry) throw new Error(`Template ${church.id} is not in the document registry.`);
		templates.push({
			id: church.id,
			name: church.name,
			description: church.description,
			category: "administrative",
			formats: [entry.format],
			pageCount: entry.pageCount,
			mergeFields: church.mergeFields.map(({ autoFill, ...field }) => (autoFill ? { ...field, autoFill } : field)),
		});
	}
	return { version, templates };
}

export function templateView(template: CatalogTemplate) {
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
		...registryFacts(template.id),
	};
}

function registryFacts(id: string) {
	const entry = entryFor(id);
	if (!entry) throw new Error(`Template ${id} is not in the document registry.`);
	return {
		documentClass: entry.documentClass,
		pageSize: entry.pageSize,
		fillable: entry.fields.length > 0,
		outline: entry.outline,
	};
}
