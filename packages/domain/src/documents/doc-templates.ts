import { docTemplate, pageBox, templateHash, type DocTemplate, type PageSetup } from "@everyfield/contracts/documents";
import budgetWorksheet from "./templates/budget-worksheet.json" with { type: "json" };
import bylaws from "./templates/bylaws.json" with { type: "json" };
import commitmentCard from "./templates/commitment-card.json" with { type: "json" };
import conflictOfInterestPolicy from "./templates/conflict-of-interest-policy.json" with { type: "json" };
import followUpLetter from "./templates/follow-up-letter.json" with { type: "json" };
import guestSignInSheet from "./templates/guest-sign-in-sheet.json" with { type: "json" };
import launchTeamCommitment from "./templates/launch-team-commitment.json" with { type: "json" };
import memberExpectations from "./templates/member-expectations.json" with { type: "json" };
import prayerLetter from "./templates/prayer-letter.json" with { type: "json" };
import { PUBLISHED, SUPERSEDED, type PublishedVersion } from "./templates/published/index.ts";

// The built-in everyfield.doc/1 templates: one JSON file per template, `templates/<id>.json`. Each file is parsed
// with the contract parser when this module loads, so a file that does not validate stops the build and every
// server start. Sebastian approves each file (mergePolicy.documentTemplates).

/** The files, by the id their name gives. A test keeps this list equal to the folder. */
const FILES: Record<string, unknown> = {
	"budget-worksheet": budgetWorksheet,
	bylaws,
	"commitment-card": commitmentCard,
	"conflict-of-interest-policy": conflictOfInterestPolicy,
	"follow-up-letter": followUpLetter,
	"guest-sign-in-sheet": guestSignInSheet,
	"launch-team-commitment": launchTeamCommitment,
	"member-expectations": memberExpectations,
	"prayer-letter": prayerLetter,
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

/** The superseded versions' bodies, parsed when this module loads, like the template files. */
const SUPERSEDED_TEMPLATES = new Map(Object.entries(SUPERSEDED).map(([name, raw]) => [name, docTemplate.parse(raw)]));

/**
 * A published version of a built-in template, found by its id and the hash a document records (D-421, D-422): the
 * template file for the current version, else the stored body of a superseded one. Undefined when the store has no
 * such version, so a compare has no base.
 */
export function publishedTemplate(id: string, hash: string): DocTemplate | undefined {
	const entry = PUBLISHED[id]?.find((published) => published.hash === hash);
	if (!entry) return undefined;
	const current = docTemplateById(id);
	return current?.version === entry.version ? current : SUPERSEDED_TEMPLATES.get(`${id}.v${entry.version}`);
}

/**
 * Where a store of published versions disagrees with the template files, one line each; empty when it agrees. Each
 * template's versions run 1, 2, 3 with no gap and end at the file's version, whose hash is the file's; so a file whose
 * content changes without a new version fails. Every earlier version has its stored body, with that version's hash.
 */
export async function publishedProblems(
	templates: readonly DocTemplate[],
	published: Readonly<Record<string, readonly PublishedVersion[]>>,
	superseded: Readonly<Record<string, unknown>>,
): Promise<string[]> {
	const problems: string[] = [];
	for (const template of templates) {
		const versions = published[template.id] ?? [];
		if (versions.map((v) => v.version).join() !== Array.from(versions, (_, i) => i + 1).join())
			problems.push(`${template.id}: versions must run 1, 2, 3 with no gap`);
		const last = versions.at(-1);
		if (last?.version !== template.version)
			problems.push(`${template.id}: the file is version ${template.version}, the store ends at ${last?.version}`);
		else if (last.hash !== (await templateHash(template)))
			problems.push(`${template.id}: the file changed but its version did not go up from ${template.version}`);
		for (const earlier of versions.slice(0, -1)) {
			const name = `${template.id}.v${earlier.version}`;
			const body = docTemplate.safeParse(superseded[name]);
			// The hash covers the id and version too, so a body of another template or version fails here.
			if (!body.success) problems.push(`${name}: the superseded body is missing or does not validate`);
			else if ((await templateHash(body.data)) !== earlier.hash)
				problems.push(`${name}: the body's hash is not the one published`);
		}
	}
	return problems;
}

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

/** One sheet of paper: its size in points (Letter when the setup names none) and the cards it holds. */
export function sheetOf(page: PageSetup) {
	const box = pageBox(page) ?? { width: 612, height: 792 };
	return { ...box, perSheet: page.tile ? page.tile.across * page.tile.down : 1 };
}

export function docTemplateSummaries(): DocTemplateSummary[] {
	return DOC_TEMPLATES.map((t) => ({
		id: t.id,
		version: t.version,
		title: t.title,
		description: t.description ?? null,
		documentClass: t.class,
		formats: t.exports,
		page: sheetOf(t.page),
	}));
}
