import { loadStarter, referenceArtifactSha256 } from "@everyfield/reference/playbook";
import "server-only";
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

/** The em dash the frozen descriptions use to introduce a heading list. */
const HEADING_MARK = " \u2014 ";

/**
 * Headings are the clause after the description's em dash, split on commas.
 * Each heading must already appear in the description. No em dash means one block: the description.
 */
export function outlinePhrases(description: string): string[] {
	const at = description.indexOf(HEADING_MARK);
	if (at < 0) return [description];
	const phrases = description
		.slice(at + HEADING_MARK.length)
		.split(",")
		.map((part) => part.trim().replace(/^and\s+/, ""))
		.filter((part) => part.length > 0);
	if (phrases.length === 0 || phrases.some((phrase) => !description.includes(phrase))) return [description];
	return phrases;
}

export async function library() {
	const starter = await loadStarter();
	const version = await referenceArtifactSha256();
	return { version, templates: z.array(templateSchema).parse(starter.catalogs.documents) };
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
		outline: outlinePhrases(template.description),
	};
}
