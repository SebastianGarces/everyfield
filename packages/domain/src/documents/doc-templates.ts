import { docTemplate, pageBox, type DocTemplate } from "@everyfield/contracts/documents";
import budgetWorksheet from "./templates/budget-worksheet.json" with { type: "json" };
import commitmentCard from "./templates/commitment-card.json" with { type: "json" };
import conflictOfInterestPolicy from "./templates/conflict-of-interest-policy.json" with { type: "json" };
import guestSignInSheet from "./templates/guest-sign-in-sheet.json" with { type: "json" };

// The built-in everyfield.doc/1 templates: one JSON file per template, `templates/<id>.json`. Each file is parsed
// with the contract parser when this module loads, so a file that does not validate stops the build and every
// server start. Sebastian approves each file (mergePolicy.documentTemplates).

/** The files, by the id their name gives. A test keeps this list equal to the folder. */
const FILES: Record<string, unknown> = {
	"budget-worksheet": budgetWorksheet,
	"commitment-card": commitmentCard,
	"conflict-of-interest-policy": conflictOfInterestPolicy,
	"guest-sign-in-sheet": guestSignInSheet,
};

/** Parse one template file. A fault names the file and every issue; a file whose id differs from its name fails. */
export function loadTemplate(id: string, raw: unknown): DocTemplate {
	const parsed = docTemplate.safeParse(raw);
	if (!parsed.success)
		throw new Error(`templates/${id}.json does not validate:\n${parsed.error.issues.map((i) => i.message).join("\n")}`);
	if (parsed.data.id !== id) throw new Error(`templates/${id}.json holds the template "${parsed.data.id}"`);
	return parsed.data;
}

/** Every built-in template, in a stable order (by id). */
export const DOC_TEMPLATES: readonly DocTemplate[] = Object.entries(FILES)
	.sort(([a], [b]) => a.localeCompare(b))
	.map(([id, raw]) => loadTemplate(id, raw));

export const docTemplateById = (id: string) => DOC_TEMPLATES.find((template) => template.id === id);

/** What the "New from template" picker shows for each built-in template. */
export type DocTemplateSummary = {
	id: string;
	version: number;
	title: string;
	description: string | null;
	documentClass: DocTemplate["class"];
	formats: DocTemplate["exports"];
	/** Sheets of paper: the page size in points and the cards per sheet (1 when not tiled). */
	page: { width: number; height: number; perSheet: number };
};

export function docTemplateSummaries(): DocTemplateSummary[] {
	return DOC_TEMPLATES.map((t) => {
		const box = pageBox(t.page) ?? { width: 612, height: 792 };
		return {
			id: t.id,
			version: t.version,
			title: t.title,
			description: t.description ?? null,
			documentClass: t.class,
			formats: t.exports,
			page: { ...box, perSheet: t.page.tile ? t.page.tile.across * t.page.tile.down : 1 },
		};
	});
}
