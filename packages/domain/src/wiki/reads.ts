import {
	contextGuideRequest,
	getArticleRequest,
	guideResult,
	listArticlesRequest,
	listResult,
	navigationRequest,
	navigationResult,
	neighborsRequest,
	neighborsResult,
	previewResult,
	publicPreviewRequest,
	recentResult,
	recommendRequest,
	recommendResult,
	referenceExcerptRequest,
	excerptResult,
	exportResult,
	resumeResult,
	searchRequest,
	searchResult,
	statsResult,
	tocRequest,
	tocResult,
	wikiArticle,
	type SourceView,
	type WikiArticle,
	type WikiReply,
} from "@everyfield/contracts/wiki";
import type { Database } from "@everyfield/db/client";
import { sql, type SQL } from "@everyfield/db/query";
import "server-only";
import { z } from "zod";
import type { RequestActor } from "../access/session.ts";
import { articleJson, catalogQuery, corpusCtes, navigationQuery, pageQuery, type CorpusAccess } from "./corpus.ts";
import { pdfFilename, printHtml, type PdfRenderer } from "./pdf.ts";
import { deny, GLOBAL, meSql, PAGE, parse, pgCode, runRead, selectedOwner } from "./core.ts";

const loaded = z.object({
	allowed: z.boolean(),
	churches: z.array(z.uuid()).nullable(),
	networks: z.array(z.uuid()).nullable(),
	order_revision: z.string(),
	total: z.coerce.number().int(),
	plant_phase: z.number().int().nullable(),
	articles: z.array(z.record(z.string(), z.unknown())).nullable(),
});

function stripNodes(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(stripNodes).filter((item) => !scriptNode(item));
	if (!value || typeof value !== "object") return value;
	const out: Record<string, unknown> = {};
	for (const [key, child] of Object.entries(value)) {
		if (key === "script" || key === "import") continue;
		out[key] = stripNodes(child);
	}
	return out;
}
function scriptNode(value: unknown): boolean {
	if (!value || typeof value !== "object" || !("type" in value)) return false;
	const type = (value as { type?: unknown }).type;
	return type === "script" || type === "import" || type === "mdxjsEsm";
}
function displayBody(contentType: unknown, hidden: unknown, body: unknown): string | null {
	if (hidden === true || body == null) return null;
	const text = String(body);
	if (contentType !== "safe_nodes") return text;
	try {
		return JSON.stringify(stripNodes(JSON.parse(text)));
	} catch {
		return text;
	}
}
export function headings(contentType: string, body: string | null): { level: 2 | 3; text: string }[] {
	if (!body) return [];
	if (contentType === "safe_nodes") {
		try {
			const found: { level: 2 | 3; text: string }[] = [];
			const walk = (value: unknown) => {
				if (Array.isArray(value)) return value.forEach(walk);
				if (!value || typeof value !== "object") return;
				const node = value as { type?: string; level?: number; text?: string };
				if (
					typeof node.text === "string" &&
					(node.level === 2 || node.level === 3 || node.type === "h2" || node.type === "h3")
				)
					found.push({ level: node.type === "h3" || node.level === 3 ? 3 : 2, text: node.text });
				for (const child of Object.values(node)) walk(child);
			};
			walk(JSON.parse(body));
			return found;
		} catch {
			return [];
		}
	}
	return body.split("\n").flatMap((line) => {
		const match = /^(#{2,3})\s+(.+)$/.exec(line);
		const marks = match?.[1];
		const text = match?.[2];
		return marks && text ? [{ level: marks.length === 3 ? 3 : 2, text: text.trim() }] : [];
	});
}
function present(raw: Record<string, unknown>): WikiArticle {
	const body = displayBody(raw.contentType, raw.hidden, raw.body);
	return wikiArticle.parse({
		...raw,
		body,
		phase: raw.phase == null ? null : Number(raw.phase),
		position: Number(raw.position),
		revisionNumber: Number(raw.revisionNumber),
		meaningfulSequence: Number(raw.meaningfulSequence),
		encodedSlug: encodeURIComponent(String(raw.slug ?? "")),
		snippet: raw.snippet == null ? null : String(raw.snippet),
	});
}
function sourceOf(source: SourceView | undefined): SourceView {
	return source ?? { kind: "current" };
}
async function readPage(db: Database, access: CorpusAccess, source: SourceView, page: number, where: SQL = sql`true`) {
	const result = await db.execute(pageQuery(access, source, page, where));
	const row = loaded.parse(result.rows[0]);
	if (!row.allowed) deny();
	const articles = (row.articles ?? []).map(present);
	const nextCursor = page * PAGE < row.total ? String(page + 1) : null;
	return { row, articles, nextCursor };
}
function listValue(articles: WikiArticle[], nextCursor: string | null, row: z.infer<typeof loaded>) {
	return listResult.parse({
		articles,
		nextCursor,
		churches: row.churches ?? [],
		networks: row.networks ?? [],
		orderRevision: row.order_revision,
	});
}
function accessFor(authority: RequestActor, owner = selectedOwner(authority)): CorpusAccess {
	return { authority, owner };
}

export function listArticles(
	db: Database,
	authority: RequestActor,
	raw: unknown,
): Promise<WikiReply<z.infer<typeof listResult>>> {
	return runRead(async () => {
		const input = parse(listArticlesRequest, raw);
		const page = await readPage(db, accessFor(authority), sourceOf(input.source), input.page ?? 1);
		return listValue(page.articles, page.nextCursor, page.row);
	});
}
export function getArticle(db: Database, authority: RequestActor, raw: unknown) {
	return runRead(async () => {
		const input = parse(getArticleRequest, raw);
		const page = await readPage(
			db,
			accessFor(authority),
			sourceOf(input.source),
			1,
			sql`p.article_id = ${input.articleId}::uuid`,
		);
		const article = page.articles[0] ?? null;
		return {
			article,
			errorCode: article ? null : ("content_access_denied" as const),
		};
	});
}
export function bookmarksList(db: Database, authority: RequestActor, raw: unknown) {
	return runRead(async () => {
		const input = parse(listArticlesRequest, raw);
		const owner = selectedOwner(authority);
		const page = await readPage(
			db,
			accessFor(authority, owner.kind === "account" ? owner : selectedOwner(authority)),
			sourceOf(input.source),
			input.page ?? 1,
			sql`NOT p.hidden AND EXISTS (
				SELECT FROM reading r
				WHERE r.account_id = (SELECT account_id FROM me) AND r.article_id = p.article_id AND r.bookmarked
			)`,
		);
		return listValue(page.articles, page.nextCursor, page.row);
	});
}
export async function search(db: Database, authority: RequestActor, raw: unknown) {
	return runRead(async () => {
		const input = parse(searchRequest, raw);
		const access = accessFor(authority);
		const source = sourceOf(input.source);
		if (input.query.trim() === "") {
			const gate = await db.execute(
				sql`WITH ${meSql(authority, access.owner)} SELECT EXISTS (SELECT FROM me) AS allowed`,
			);
			if (!z.object({ allowed: z.boolean() }).parse(gate.rows[0]).allowed) deny();
			return searchResult.parse({ status: "empty", results: [], nextCursor: null });
		}
		const page = input.page ?? 1;
		const offset = (page - 1) * PAGE;
		const phase = input.phase ?? null;
		try {
			const result = await db.transaction(async (tx) => {
				await tx.execute(sql`SELECT set_config('lock_timeout','1s',true)`);
				return tx.execute(sql`WITH ${corpusCtes(access, source)},
					scored AS (
						SELECT p.*,
							ts_rank(v.vector, websearch_to_tsquery('english', ${input.query})) AS text_rank,
							ts_headline('english', coalesce(p.body, p.excerpt, p.title, ''), websearch_to_tsquery('english', ${input.query}), 'MaxFragments=1, MinWords=5, MaxWords=20') AS snippet
						FROM picked p
						CROSS JOIN LATERAL (
							SELECT
								setweight(to_tsvector('english', coalesce(p.title, '')), 'A')
								|| setweight(to_tsvector('english', coalesce(p.excerpt, '')), 'B')
								|| setweight(to_tsvector('english', coalesce(p.body, '')), 'C') AS vector
						) v
						WHERE NOT p.hidden
							AND (${phase === null}::boolean OR p.phase = ${phase ?? 0})
							AND v.vector @@ websearch_to_tsquery('english', ${input.query})
					)
					SELECT
						EXISTS (SELECT FROM me) AS allowed,
						(SELECT count(*)::int FROM scored) AS total,
						COALESCE((
							SELECT json_agg(${articleJson()} ORDER BY p.text_rank DESC, p.article_id)
							FROM (
								SELECT * FROM scored
								ORDER BY text_rank DESC, article_id
								OFFSET ${offset} LIMIT ${PAGE}
							) p
							LEFT JOIN reading rd ON rd.account_id = (SELECT account_id FROM me) AND rd.article_id = p.article_id
							LEFT JOIN LATERAL (
								SELECT v.source_credit FROM reference_version v
								WHERE v.item_id = p.article_id
								ORDER BY v.version_number DESC LIMIT 1
							) cr ON true
						), '[]'::json) AS articles`);
			});
			const row = z
				.object({
					allowed: z.boolean(),
					total: z.coerce.number().int(),
					articles: z.array(z.record(z.string(), z.unknown())).nullable(),
				})
				.parse(result.rows[0]);
			if (!row.allowed) deny();
			const results = (row.articles ?? []).map(present);
			if (!results.length) return searchResult.parse({ status: "empty", results: [], nextCursor: null });
			return searchResult.parse({
				status: "results",
				results,
				nextCursor: page * PAGE < row.total ? String(page + 1) : null,
			});
		} catch (error) {
			const code = pgCode(error);
			if (code === "55P03" || code === "57014") return searchResult.parse({ status: "unavailable", results: null });
			throw error;
		}
	});
}
function groupName(article: { sectionKey: string; phase: number | null }): string {
	const key = article.sectionKey.toLowerCase();
	if (key.includes("framework")) return "Frameworks";
	if (key.includes("reference")) return "Reference";
	if (key.includes("resource")) return "Resources";
	if (article.phase != null) return `Journey ${article.phase}`;
	return "Getting started";
}
const navRow = z.object({
	articleId: z.uuid(),
	title: z.string(),
	slug: z.string(),
	phase: z.coerce.number().int().nullable(),
	sectionKey: z.string(),
	relatedIds: z.array(z.uuid()),
});
export function navigation(db: Database, authority: RequestActor, raw: unknown) {
	return runRead(async () => {
		const input = parse(navigationRequest, raw);
		const access = accessFor(authority);
		const result = await db.execute(navigationQuery(access, sourceOf(input.source)));
		const row = z.object({ allowed: z.boolean(), articles: z.array(navRow).nullable() }).parse(result.rows[0]);
		if (!row.allowed) deny();
		const articles = row.articles ?? [];
		const groups = new Map<string, typeof articles>();
		for (const article of articles) {
			const name = groupName({ sectionKey: article.sectionKey, phase: article.phase });
			groups.set(name, [...(groups.get(name) ?? []), article]);
		}
		return navigationResult.parse({
			groups: [...groups.entries()].map(([name, items]) => ({
				name,
				articles: items.map((item) => ({
					articleId: item.articleId,
					title: item.title,
					slug: item.slug,
					encodedSlug: encodeURIComponent(item.slug),
					phase: item.phase,
				})),
			})),
			breadcrumbs: articles.map((item) => ({ articleId: item.articleId, crumbs: [item.sectionKey, item.title] })),
			relatedIds: [...new Set(articles.flatMap((item) => item.relatedIds))],
		});
	});
}
export function articleNeighbors(db: Database, authority: RequestActor, raw: unknown) {
	return runRead(async () => {
		const input = parse(neighborsRequest, raw);
		const access = accessFor(authority);
		const result = await db.execute(sql`WITH ${corpusCtes(access, sourceOf(input.source))}
			SELECT
				EXISTS (SELECT FROM me) AS allowed,
				EXISTS (SELECT FROM picked WHERE article_id = ${input.articleId}::uuid) AS entitled,
				COALESCE((
					SELECT json_agg(json_build_object(
						'articleId', n.article_id, 'title', n.title, 'slug', n.slug, 'position', n.position
					) ORDER BY n.position, n.title)
					FROM picked n
					WHERE n.parent_article_id IS NOT DISTINCT FROM (
						SELECT parent_article_id FROM picked WHERE article_id = ${input.articleId}::uuid
					)
					AND n.article_id <> ${input.articleId}::uuid
					AND EXISTS (SELECT FROM picked WHERE article_id = ${input.articleId}::uuid)
				), '[]'::json) AS articles`);
		const row = z
			.object({
				allowed: z.boolean(),
				entitled: z.boolean(),
				articles: z.array(z.object({ articleId: z.uuid(), title: z.string(), slug: z.string(), position: z.number() })),
			})
			.parse(result.rows[0]);
		if (!row.allowed) deny();
		return neighborsResult.parse({
			articles: row.entitled ? row.articles : [],
			errorCode: row.entitled ? null : "content_access_denied",
		});
	});
}
export function tableOfContents(db: Database, authority: RequestActor, raw: unknown) {
	return runRead(async () => {
		const input = parse(tocRequest, raw);
		const page = await readPage(
			db,
			accessFor(authority),
			sourceOf(input.source),
			1,
			sql`p.article_id = ${input.articleId}::uuid`,
		);
		const article = page.articles[0] ?? null;
		return tocResult.parse({
			headings: article ? headings(article.contentType, article.body) : [],
			errorCode: article ? null : "content_access_denied",
		});
	});
}
export function contextGuide(db: Database, authority: RequestActor, raw: unknown) {
	return runRead(async () => {
		parse(contextGuideRequest, raw);
		const access = accessFor(authority);
		const result = await db.execute(
			sql`WITH ${meSql(authority, access.owner)} SELECT EXISTS (SELECT FROM me) AS allowed`,
		);
		const row = z.object({ allowed: z.boolean() }).parse(result.rows[0]);
		if (!row.allowed) deny();
		// No approved release maps an app route to an article.
		return guideResult.parse({
			found: false,
			missing: true,
			citation: null,
			articleId: null,
			body: null,
		});
	});
}
export function referenceExcerpt(db: Database, authority: RequestActor, raw: unknown) {
	return runRead(async () => {
		const input = parse(referenceExcerptRequest, raw);
		const page = await readPage(
			db,
			accessFor(authority),
			sourceOf(input.source),
			1,
			sql`p.article_id = ${input.articleId}::uuid`,
		);
		const body = page.articles[0]?.body ?? null;
		if (!body)
			return excerptResult.parse({
				excerpt: null,
				errorCode: page.articles[0] ? null : "content_access_denied",
			});
		if (!input.heading) return excerptResult.parse({ excerpt: body.slice(0, 500), errorCode: null });
		const lines = body.split("\n");
		const start = lines.findIndex((line) => line.replace(/^#{1,6}\s*/, "").trim() === input.heading);
		if (start < 0) return excerptResult.parse({ excerpt: body.slice(0, 500), errorCode: null });
		const opening = lines[start];
		if (opening == null) return excerptResult.parse({ excerpt: body.slice(0, 500), errorCode: null });
		const marks = /^(#+)\s/.exec(opening);
		const level = marks?.[1]?.length ?? 2;
		const taken = [opening];
		for (const line of lines.slice(start + 1)) {
			const next = /^(#+)\s/.exec(line)?.[1]?.length;
			if (next != null && next <= level) break;
			taken.push(line);
		}
		return excerptResult.parse({ excerpt: taken.join("\n").slice(0, 500), errorCode: null });
	});
}
export function readingRecent(db: Database, authority: RequestActor, raw: unknown) {
	return runRead(async () => {
		parse(z.strictObject({}).optional(), raw ?? {});
		const access = accessFor(authority);
		const result = await db.execute(sql`WITH ${corpusCtes(access, { kind: "current" })},
			recent AS (
				SELECT p.*, NULL::text AS snippet
				FROM picked p
				JOIN reading r ON r.article_id = p.article_id AND r.account_id = (SELECT account_id FROM me)
				WHERE r.last_viewed_at IS NOT NULL AND NOT p.hidden
				ORDER BY r.last_viewed_at DESC
				LIMIT ${PAGE}
			)
			SELECT
				EXISTS (SELECT FROM me) AS allowed,
				COALESCE((
					SELECT json_agg(${articleJson()} ORDER BY r.last_viewed_at DESC)
					FROM recent p
					JOIN reading r ON r.article_id = p.article_id AND r.account_id = (SELECT account_id FROM me)
					LEFT JOIN reading rd ON rd.account_id = r.account_id AND rd.article_id = p.article_id
					LEFT JOIN LATERAL (
						SELECT v.source_credit FROM reference_version v WHERE v.item_id = p.article_id
						ORDER BY v.version_number DESC LIMIT 1
					) cr ON true
				), '[]'::json) AS articles`);
		const row = z
			.object({ allowed: z.boolean(), articles: z.array(z.record(z.string(), z.unknown())).nullable() })
			.parse(result.rows[0]);
		if (!row.allowed) deny();
		return recentResult.parse({ articles: (row.articles ?? []).map(present) });
	});
}
export async function readingResume(db: Database, authority: RequestActor, raw: unknown) {
	const recent = await readingRecent(db, authority, raw ?? {});
	if (recent.status !== "ok") return recent;
	return { status: "ok" as const, value: resumeResult.parse({ article: recent.value.articles[0] ?? null }) };
}
export function readingStats(db: Database, authority: RequestActor, raw: unknown) {
	return runRead(async () => {
		parse(z.strictObject({}).optional(), raw ?? {});
		const access = accessFor(authority);
		const owner = access.owner;
		const result = await db.execute(sql`WITH ${corpusCtes(access, { kind: "current" })},
			disc AS (
				SELECT article_id, slug, meaningful_sequence FROM global_rev WHERE slug LIKE 'discovery/%'
			),
			caller AS (
				SELECT d.article_id, d.slug,
					COALESCE(rd.observed_fraction, 0)::text AS ratio,
					(rd.completed_at IS NOT NULL AND rd.observed_fraction > 0.80) AS completed
				FROM disc d
				LEFT JOIN reading rd ON rd.article_id = d.article_id AND rd.account_id = (SELECT account_id FROM me)
			),
			owner_seat AS (
				SELECT s.account_id FROM seat s
				WHERE ${owner.kind} = 'plant'
					AND s.plant_id = ${owner.id}::uuid
					AND s.role = 'owner'
					AND s.ended_at IS NULL
					AND s.accepted_at <= clock_timestamp()
				ORDER BY s.accepted_at
				LIMIT 1
			)
			SELECT
				EXISTS (SELECT FROM me) AS allowed,
				(SELECT pl.phase FROM plant pl WHERE ${owner.kind} = 'plant' AND pl.id = ${owner.id}::uuid) AS phase,
				COALESCE((SELECT json_agg(json_build_object(
					'articleId', article_id, 'slug', slug, 'ratio', ratio, 'completed', completed
				) ORDER BY slug) FROM caller), '[]'::json) AS articles,
				COALESCE((SELECT bool_and(completed) AND count(*) > 0 FROM caller), false) AS caller_complete,
				COALESCE((
					SELECT bool_and(rd.completed_at IS NOT NULL AND rd.observed_fraction > 0.80)
						AND count(d.article_id) = (SELECT count(*) FROM disc)
						AND (SELECT count(*) FROM disc) > 0
					FROM disc d
					JOIN owner_seat o ON true
					LEFT JOIN reading rd ON rd.article_id = d.article_id AND rd.account_id = o.account_id
				), false) AS owner_complete,
				COALESCE((
					SELECT bool_or(rd.completed_at IS NOT NULL AND d.meaningful_sequence > rd.last_read_meaningful_sequence)
					FROM disc d
					JOIN owner_seat o ON true
					JOIN reading rd ON rd.article_id = d.article_id AND rd.account_id = o.account_id
				), false) AS owner_reread,
				EXISTS (
					SELECT FROM seat s
					WHERE s.account_id = (SELECT account_id FROM me)
						AND s.ended_at IS NULL
						AND s.accepted_at <= clock_timestamp()
						AND s.role <> 'member'
						AND ${owner.kind} = 'plant'
						AND s.plant_id = ${owner.id}::uuid
				) AS seated_lead`);
		const row = z
			.object({
				allowed: z.boolean(),
				phase: z.number().int().nullable(),
				articles: z.array(
					z.object({ articleId: z.uuid(), slug: z.string(), ratio: z.string(), completed: z.boolean() }),
				),
				caller_complete: z.boolean(),
				owner_complete: z.boolean(),
				owner_reread: z.boolean(),
				seated_lead: z.boolean(),
			})
			.parse(result.rows[0]);
		if (!row.allowed) deny();
		return statsResult.parse({
			discoveryComplete: row.caller_complete,
			ownerRereadRequired: row.owner_reread,
			qualifyingReader: row.caller_complete && row.seated_lead,
			completionAtRatio: { owner: row.owner_complete, caller: row.caller_complete },
			phase: row.phase,
			articles: row.articles,
		});
	});
}
export function recommendForPhase(db: Database, authority: RequestActor, raw: unknown) {
	return runRead(async () => {
		const input = parse(recommendRequest, raw);
		const access = accessFor(authority);
		const where =
			input.phase == null
				? sql`(${access.owner.kind} <> 'plant' OR p.phase = (SELECT phase FROM plant WHERE id = ${access.owner.id}::uuid))`
				: sql`p.phase = ${input.phase}`;
		const result = await db.execute(catalogQuery(access, sourceOf(input.source), where));
		const row = z
			.object({
				allowed: z.boolean(),
				plant_phase: z.number().int().nullable(),
				articles: z.array(z.record(z.string(), z.unknown())).nullable(),
			})
			.parse(result.rows[0]);
		if (!row.allowed) deny();
		const articles = (row.articles ?? []).map(present);
		return recommendResult.parse({
			phase: input.phase ?? row.plant_phase,
			articles,
		});
	});
}
const CRAWLER = /facebookexternalhit|Twitterbot|Slackbot|LinkedInBot|Googlebot|bingbot/i;
function isCrawler(userAgent: string | undefined): boolean {
	if (!userAgent) return false;
	return userAgent === "crawler" || CRAWLER.test(userAgent);
}
function wikiPath(path: string): boolean {
	return /^\/wiki(\/|$)/.test(path);
}
function preview(value: {
	publicPreviewAllowed: boolean;
	crawler: boolean;
	title: string | null;
	excerpt?: string | null;
}) {
	return previewResult.parse({ excerpt: null, ...value });
}
export async function publicPreviewMetadata(_db: Database, raw: unknown) {
	const input = parse(publicPreviewRequest, raw);
	const allowed = wikiPath(input.path);
	return {
		status: "ok" as const,
		value: preview({
			publicPreviewAllowed: allowed,
			crawler: isCrawler(input.userAgent),
			title: allowed ? "Wiki" : null,
		}),
	};
}
export async function renderGlobalPreview(db: Database, raw: unknown) {
	const input = parse(publicPreviewRequest, raw);
	const allowed = wikiPath(input.path);
	const crawler = isCrawler(input.userAgent);
	if (!allowed) return { status: "ok" as const, value: preview({ publicPreviewAllowed: false, crawler, title: null }) };
	let slug = "";
	try {
		slug = decodeURIComponent(input.path.replace(/^\/wiki\/?/, "").replace(/\/$/, ""));
	} catch {
		return { status: "ok" as const, value: preview({ publicPreviewAllowed: false, crawler, title: null }) };
	}
	if (!slug) return { status: "ok" as const, value: preview({ publicPreviewAllowed: true, crawler, title: "Wiki" }) };
	const result = await db.execute(sql`WITH release AS (
			SELECT a.release_id FROM reference_activation a ORDER BY a.activation_number DESC LIMIT 1
		)
		SELECT r.title, r.excerpt
		FROM article_revision r
		JOIN release rel ON r.release_id = rel.release_id
		WHERE r.tenant_id = ${GLOBAL}::uuid
			AND r.content_type = 'safe_mdx'
			AND r.published_at IS NOT NULL
			AND r.slug = ${slug}
		ORDER BY r.revision_number DESC
		LIMIT 1`);
	const row = z.object({ title: z.string(), excerpt: z.string().nullable() }).safeParse(result.rows[0]);
	return {
		status: "ok" as const,
		value: preview({
			publicPreviewAllowed: true,
			crawler,
			title: row.success ? row.data.title : null,
			excerpt: row.success ? row.data.excerpt : null,
		}),
	};
}

function deniedExport() {
	return exportResult.parse({
		bytes: null,
		html: null,
		errorCode: "content_access_denied",
		fontFailureOffersPrintFallback: false,
	});
}
function exportMeta(article: WikiArticle) {
	return { filename: pdfFilename(article.slug), source: article.credit };
}
async function visibleBody(db: Database, authority: RequestActor, raw: unknown) {
	const input = parse(getArticleRequest, raw);
	const page = await readPage(
		db,
		accessFor(authority),
		sourceOf(input.source),
		1,
		sql`p.article_id = ${input.articleId}::uuid`,
	);
	const article = page.articles[0];
	if (!article || article.hidden || article.body == null) return null;
	return article;
}
export function exportPdf(db: Database, authority: RequestActor, raw: unknown, render: PdfRenderer) {
	return runRead(async () => {
		const article = await visibleBody(db, authority, raw);
		if (!article) return deniedExport();
		const meta = exportMeta(article);
		try {
			const bytes = Buffer.from(render(article.title, article.body!, meta)).toString("base64");
			return exportResult.parse({
				bytes,
				html: null,
				errorCode: null,
				fontFailureOffersPrintFallback: false,
			});
		} catch {
			return exportResult.parse({
				bytes: null,
				html: printHtml(article.title, article.body!, meta),
				errorCode: null,
				fontFailureOffersPrintFallback: true,
			});
		}
	});
}
export function printArticle(db: Database, authority: RequestActor, raw: unknown) {
	return runRead(async () => {
		const article = await visibleBody(db, authority, raw);
		if (!article) return deniedExport();
		const meta = exportMeta(article);
		return exportResult.parse({
			bytes: null,
			html: printHtml(article.title, article.body!, meta),
			errorCode: null,
			fontFailureOffersPrintFallback: false,
		});
	});
}
