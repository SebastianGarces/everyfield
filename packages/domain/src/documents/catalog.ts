import { loadStarter, referenceArtifactSha256 } from "@everyfield/reference/playbook";
import "server-only";
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

export async function library() {
	const starter = await loadStarter();
	const version = await referenceArtifactSha256();
	// The frozen reference row gives identity; the registry gives format, page count and layout facts (WP-036/api).
	const templates = z
		.array(templateSchema)
		.parse(starter.catalogs.documents)
		.map((template) => {
			const entry = entryFor(template.id);
			return entry ? { ...template, formats: [entry.format], pageCount: entry.pageCount } : template;
		});
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
