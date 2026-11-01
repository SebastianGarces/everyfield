import { generation } from "@everyfield/contracts/reference";
import type {
	ReferenceEntry,
	ReferenceGeneration,
	ReferencePassage,
	ReferenceProfile,
} from "@everyfield/contracts/reference";
import type { ValidationPolicy } from "../../bundle.ts";
import { canonical, hash, stableId } from "../../hash.ts";
import type { WikiSource } from "../manifest/approved.ts";
import type { ApprovedSnapshot } from "./snapshot.ts";
import { WikiRefusal } from "./snapshot.ts";

export type WikiRecord = Omit<ReferenceEntry, "revisionId">;

/** The Wiki rows of a snapshot. Each caller sets its own revision id. */
export function wikiRecords(snapshot: ApprovedSnapshot): WikiRecord[] {
	const sourcePath = snapshot.source.payloadPath;
	const sourceHash = snapshot.source.payloadSha256;
	const rows: WikiRecord[] = [];
	for (const section of snapshot.sections) {
		const body = canonical({
			id: section.id,
			name: section.name,
			parent_section_id: section.parentId,
			phase: section.phase,
			slug: section.slug,
			sort_order: section.position,
		});
		const contentHash = hash(body);
		rows.push({
			id: section.id,
			kind: "section",
			key: section.id,
			body,
			contentHash,
			sourcePath,
			sourceHash,
			format: "catalog",
			slug: section.slug,
			parentId: section.parentId,
		});
	}
	for (const article of snapshot.articles) {
		const body = canonical({
			church_id: null,
			content: article.content,
			excerpt: article.excerpt,
			id: article.id,
			phase: article.phase,
			related_article_slugs: [...article.relatedSlugs],
			section_id: article.sectionId,
			slug: article.slug,
			sort_order: article.position,
			status: "published",
			title: article.title,
		});
		const contentHash = hash(body);
		rows.push({
			id: article.id,
			kind: "article",
			key: article.id,
			body,
			contentHash,
			sourcePath,
			sourceHash,
			format: "safe_mdx",
			slug: article.slug,
			sectionId: article.sectionId,
		});
	}
	for (const template of snapshot.templates) {
		const id = stableId(`mail_template:${template.name}`);
		const body = canonical({
			body: template.body,
			category: template.category,
			churchId: null,
			isSystem: true,
			name: template.name,
			sourceTemplateId: null,
			subject: template.subject,
		});
		const contentHash = hash(body);
		rows.push({
			id,
			kind: "mail_template",
			key: template.name,
			body,
			contentHash,
			sourcePath,
			sourceHash,
			format: "catalog",
		});
	}
	return rows.sort((left, right) => left.id.localeCompare(right.id, "en"));
}

export function wikiEntries(snapshot: ApprovedSnapshot, release: string): ReferenceEntry[] {
	return wikiRecords(snapshot).map((row) => ({
		...row,
		revisionId: stableId(`${release}:${row.id}:${row.contentHash}`),
	}));
}

export function wikiBundle(
	snapshot: ApprovedSnapshot,
	release: string,
	profile: ReferenceProfile,
	passages: readonly ReferencePassage[],
): ReferenceGeneration {
	const parsed = generation.safeParse({
		version: 1,
		key: release,
		sourceManifestSha256: snapshot.source.manifestSha256,
		catalogSha256: snapshot.source.payloadSha256,
		profile,
		discoveryIds: [...snapshot.discoveryIds],
		entries: wikiEntries(snapshot, release),
		passages: [...passages],
	});
	if (!parsed.success) throw new WikiRefusal("incomplete_candidate", "generation");
	return parsed.data;
}

export function wikiPolicy(
	source: WikiSource,
	bundle: ReferenceGeneration,
	deferDerivatives: boolean,
): ValidationPolicy {
	return {
		identities: {
			sourceManifestSha256: source.manifestSha256,
			catalogSha256: source.payloadSha256,
		},
		plan: {
			profile: bundle.profile,
			entries: bundle.entries,
			discoveryIds: bundle.discoveryIds,
		},
		editorial: { approved: true, originalAvailable: true, conflicts: [] },
		deferDerivatives,
	};
}
