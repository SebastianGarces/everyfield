import { generation } from "@everyfield/contracts/reference";
import type {
	ReferenceEntry,
	ReferenceGeneration,
	ReferencePassage,
	ReferenceProfile,
} from "@everyfield/contracts/reference";
import type { ValidationPolicy } from "../../bundle.ts";
import { canonical, hash, stableId } from "../../hash.ts";
import { approvedWiki } from "../manifest/approved.ts";
import type { ApprovedSnapshot } from "./snapshot.ts";
import { WikiRefusal } from "./snapshot.ts";

export function wikiEntries(snapshot: ApprovedSnapshot, release: string): ReferenceEntry[] {
	const sourcePath = approvedWiki.payloadPath;
	const sourceHash = approvedWiki.payloadSha256;
	const rows: ReferenceEntry[] = [];
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
			revisionId: stableId(`${release}:${section.id}:${contentHash}`),
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
			revisionId: stableId(`${release}:${article.id}:${contentHash}`),
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
			revisionId: stableId(`${release}:${id}:${contentHash}`),
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

export function wikiBundle(
	snapshot: ApprovedSnapshot,
	release: string,
	profile: ReferenceProfile,
	passages: readonly ReferencePassage[],
): ReferenceGeneration {
	const parsed = generation.safeParse({
		version: 1,
		key: release,
		sourceManifestSha256: approvedWiki.manifestSha256,
		catalogSha256: approvedWiki.payloadSha256,
		profile,
		discoveryIds: [...snapshot.discoveryIds],
		entries: wikiEntries(snapshot, release),
		passages: [...passages],
	});
	if (!parsed.success) throw new WikiRefusal("incomplete_candidate", "generation");
	return parsed.data;
}

export function wikiPolicy(bundle: ReferenceGeneration, deferDerivatives: boolean): ValidationPolicy {
	return {
		identities: {
			sourceManifestSha256: approvedWiki.manifestSha256,
			catalogSha256: approvedWiki.payloadSha256,
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
