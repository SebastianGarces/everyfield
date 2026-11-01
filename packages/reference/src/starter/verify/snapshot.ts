import { readFile } from "node:fs/promises";
import { z } from "zod";
import { hash } from "../../hash.ts";
import { safeMdx } from "../../content.ts";
import { approvedWiki } from "../manifest/approved.ts";

export type WikiErrorCode =
	| "access_denied"
	| "source_unavailable"
	| "digest_conflict"
	| "immutable_conflict"
	| "revision_conflict"
	| "incomplete_candidate"
	| "rollback_unavailable"
	| "idempotency_conflict";

export class WikiRefusal extends Error {
	readonly code: WikiErrorCode;
	readonly detail: string;
	constructor(code: WikiErrorCode, detail: string = code) {
		super(detail === code ? code : `${code}: ${detail}`);
		this.name = "WikiRefusal";
		this.code = code;
		this.detail = detail;
	}
}

const sha = z.string().regex(/^[a-f0-9]{64}$/);
const manifestSchema = z
	.object({
		revision: z.literal(approvedWiki.provenanceRevision),
		seedPayloadSHA256: z.literal(approvedWiki.payloadSha256),
		playbookSHA256: z.literal(approvedWiki.playbookSha256),
		articles: z
			.array(z.object({ id: z.uuid(), slug: z.string(), sectionId: z.uuid(), contentSHA256: sha }).passthrough())
			.length(approvedWiki.articles),
		sections: z
			.array(z.object({ id: z.uuid(), slug: z.string(), parent: z.uuid().nullable(), recordSHA256: sha }).passthrough())
			.length(approvedWiki.sections),
		templates: z
			.array(z.object({ name: z.string().min(1), sha256: sha }).passthrough())
			.length(approvedWiki.systemTemplates),
	})
	.passthrough();
const payloadSchema = z
	.object({
		articles: z
			.array(
				z
					.object({
						id: z.uuid(),
						slug: z.string().min(1),
						title: z.string().min(1),
						excerpt: z.string(),
						content: z.string(),
						section_id: z.uuid(),
						phase: z.number().int().min(0).max(6),
						sort_order: z.number().int(),
						church_id: z.null(),
						status: z.literal("published"),
						content_type: z.string(),
						related_article_slugs: z.array(z.string()),
					})
					.passthrough(),
			)
			.length(approvedWiki.articles),
		sections: z
			.array(
				z
					.object({
						id: z.uuid(),
						slug: z.string().min(1),
						name: z.string().min(1),
						parent_section_id: z.uuid().nullable(),
						phase: z.number().int().min(0).max(6),
						sort_order: z.number().int(),
						description: z.string().nullable(),
						icon: z.string().nullable(),
					})
					.passthrough(),
			)
			.length(approvedWiki.sections),
		templates: z
			.array(
				z
					.object({
						name: z.string().min(1),
						subject: z.string(),
						body: z.string(),
						category: z.string(),
						churchId: z.null(),
						isSystem: z.literal(true),
						sourceTemplateId: z.null(),
					})
					.passthrough(),
			)
			.length(approvedWiki.systemTemplates),
	})
	.strict();
const discoverySchema = z.object({
	articles: z.array(z.object({ id: z.uuid() }).passthrough()).length(approvedWiki.discoveryArticles),
});

export interface ApprovedArticle {
	id: string;
	slug: string;
	title: string;
	excerpt: string;
	content: string;
	sectionId: string;
	phase: number;
	position: number;
	contentSha256: string;
	relatedSlugs: readonly string[];
}
export interface ApprovedSection {
	id: string;
	slug: string;
	name: string;
	parentId: string | null;
	phase: number;
	position: number;
	recordSha256: string;
}
export interface ApprovedTemplate {
	name: string;
	subject: string;
	body: string;
	category: string;
	sha256: string;
}
export interface ApprovedSnapshot {
	articles: readonly ApprovedArticle[];
	sections: readonly ApprovedSection[];
	templates: readonly ApprovedTemplate[];
	discoveryIds: readonly string[];
}

function repoRoot(): URL {
	return new URL("../../../../../", import.meta.url);
}
function refuseIo(error: unknown): never {
	if (error instanceof WikiRefusal) throw error;
	const code = error instanceof Error && "code" in error ? error.code : undefined;
	if (code === "ENOENT") throw new WikiRefusal("source_unavailable");
	throw new WikiRefusal("incomplete_candidate", "snapshot_parse");
}
async function readBytes(root: URL, path: string): Promise<Buffer> {
	try {
		return await readFile(new URL(path, root));
	} catch (error) {
		refuseIo(error);
	}
}

export function checkSnapshot(snapshot: ApprovedSnapshot): void {
	const articles = snapshot.articles;
	const sections = snapshot.sections;
	const slugs = new Set(articles.map((article) => article.slug));
	const sectionIds = new Map(sections.map((section) => [section.id, section.parentId]));
	if (articles.length !== approvedWiki.articles) throw new WikiRefusal("incomplete_candidate", "article_count");
	if (sections.length !== approvedWiki.sections) throw new WikiRefusal("incomplete_candidate", "section_count");
	if (snapshot.templates.length !== approvedWiki.systemTemplates)
		throw new WikiRefusal("incomplete_candidate", "template_count");
	if (slugs.size !== articles.length) throw new WikiRefusal("incomplete_candidate", "article_slug");
	if (new Set(sections.map((section) => section.slug)).size !== sections.length)
		throw new WikiRefusal("incomplete_candidate", "section_slug");
	if (new Set(snapshot.templates.map((template) => template.name)).size !== snapshot.templates.length)
		throw new WikiRefusal("incomplete_candidate", "template_name");
	for (const section of sections) {
		if (section.parentId !== null && !sectionIds.has(section.parentId))
			throw new WikiRefusal("incomplete_candidate", "section_parent");
		const seen = new Set<string>();
		let current: string | null = section.id;
		while (current) {
			if (seen.has(current)) throw new WikiRefusal("incomplete_candidate", "section_cycle");
			seen.add(current);
			const parent = sectionIds.get(current);
			if (parent === undefined) throw new WikiRefusal("incomplete_candidate", "section_parent");
			current = parent;
		}
	}
	const articleIds = new Set(articles.map((article) => article.id));
	for (const article of articles) {
		if (!sectionIds.has(article.sectionId)) throw new WikiRefusal("incomplete_candidate", "article_section");
		if (hash(article.content) !== article.contentSha256) throw new WikiRefusal("incomplete_candidate", "article_hash");
		if (article.relatedSlugs.some((slug) => !slugs.has(slug)))
			throw new WikiRefusal("incomplete_candidate", "related_slug");
		if (!safeMdx(article.content, slugs)) throw new WikiRefusal("incomplete_candidate", "mdx");
	}
	if (snapshot.discoveryIds.length !== approvedWiki.discoveryArticles)
		throw new WikiRefusal("incomplete_candidate", "discovery_count");
	if (snapshot.discoveryIds.some((id) => !articleIds.has(id)))
		throw new WikiRefusal("incomplete_candidate", "discovery_article");
}

export async function loadApprovedSnapshot(root = repoRoot()): Promise<ApprovedSnapshot> {
	try {
		const manifestBytes = await readBytes(root, approvedWiki.manifestPath);
		const payloadBytes = await readBytes(root, approvedWiki.payloadPath);
		const playbookBytes = await readBytes(root, approvedWiki.playbookPath);
		if (hash(manifestBytes) !== approvedWiki.manifestSha256)
			throw new WikiRefusal("incomplete_candidate", "manifest_hash");
		if (hash(payloadBytes) !== approvedWiki.payloadSha256)
			throw new WikiRefusal("incomplete_candidate", "payload_hash");
		if (hash(playbookBytes) !== approvedWiki.playbookSha256)
			throw new WikiRefusal("incomplete_candidate", "playbook_hash");
		const manifest = manifestSchema.parse(JSON.parse(manifestBytes.toString("utf8")));
		const payload = payloadSchema.parse(JSON.parse(payloadBytes.toString("utf8")));
		const discovery = discoverySchema.parse(
			JSON.parse((await readBytes(root, approvedWiki.discoveryPath)).toString("utf8")),
		);
		const manifestArticles = new Map(manifest.articles.map((article) => [article.id, article]));
		const manifestSections = new Map(manifest.sections.map((section) => [section.id, section]));
		const manifestTemplates = new Map(manifest.templates.map((template) => [template.name, template.sha256]));
		if (payload.articles.some((article) => Object.hasOwn(article, "embedding") || Object.hasOwn(article, "vector")))
			throw new WikiRefusal("incomplete_candidate", "stored_vector");
		const articles: ApprovedArticle[] = payload.articles.map((article) => {
			const recorded = manifestArticles.get(article.id);
			if (!recorded || recorded.slug !== article.slug || recorded.sectionId !== article.section_id)
				throw new WikiRefusal("incomplete_candidate", "article_manifest");
			if (hash(article.content) !== recorded.contentSHA256)
				throw new WikiRefusal("incomplete_candidate", "article_hash");
			return {
				id: article.id,
				slug: article.slug,
				title: article.title,
				excerpt: article.excerpt,
				content: article.content,
				sectionId: article.section_id,
				phase: article.phase,
				position: article.sort_order,
				contentSha256: recorded.contentSHA256,
				relatedSlugs: article.related_article_slugs,
			};
		});
		const sections: ApprovedSection[] = payload.sections.map((section) => {
			const recorded = manifestSections.get(section.id);
			if (!recorded || recorded.slug !== section.slug || recorded.parent !== section.parent_section_id)
				throw new WikiRefusal("incomplete_candidate", "section_manifest");
			return {
				id: section.id,
				slug: section.slug,
				name: section.name,
				parentId: section.parent_section_id,
				phase: section.phase,
				position: section.sort_order,
				recordSha256: recorded.recordSHA256,
			};
		});
		const templates: ApprovedTemplate[] = payload.templates.map((template) => {
			const recorded = manifestTemplates.get(template.name);
			if (!recorded) throw new WikiRefusal("incomplete_candidate", "template_manifest");
			return {
				name: template.name,
				subject: template.subject,
				body: template.body,
				category: template.category,
				sha256: recorded,
			};
		});
		const snapshot = { articles, sections, templates, discoveryIds: discovery.articles.map((article) => article.id) };
		checkSnapshot(snapshot);
		return snapshot;
	} catch (error) {
		refuseIo(error);
	}
}
