import { createHash, randomUUID } from "node:crypto";
import type { Owner } from "@everyfield/contracts/common";
import {
	feedbackGetMineRequest,
	feedbackMine,
	feedbackSetMineRequest,
	organizationArticleCommand,
	organizationArticleResult,
	organizationDraft,
	organizationDraftRequest,
	upstreamReviewRequest,
	upstreamReviewResult,
	wikiError,
	type WikiReply,
} from "@everyfield/contracts/wiki";
import type { Database } from "@everyfield/db/client";
import { sql } from "@everyfield/db/query";
import "server-only";
import { z } from "zod";
import type { RequestActor } from "../access/session.ts";
import { GLOBAL, deny, meSql, parse, runRead, runWrite, WikiOutcome } from "./core.ts";

type OrgValue = z.infer<typeof organizationArticleResult>;
type Mine = z.infer<typeof feedbackMine>;
type Draft = z.infer<typeof organizationDraft>;
type Upstream = z.infer<typeof upstreamReviewResult>;

function refuse(code: "access_denied" | "invalid_input" = "access_denied"): WikiReply<never> {
	return {
		status: "refused",
		error: wikiError.parse({
			code,
			details: {},
			correlationId: randomUUID(),
			retry: "never",
		}),
	};
}
function mineValue(partial: Partial<Mine> & Pick<Mine, "articleId" | "currentVote" | "ownHistoryVotes">): Mine {
	return feedbackMine.parse({ phantomPlants: 0, foreignVoteBody: null, ...partial });
}
function orgValue(partial: Partial<OrgValue> = {}): OrgValue {
	return organizationArticleResult.parse({
		errorCode: null,
		publishedRevision: null,
		organizationId: null,
		additionalHistoryEntries: 0,
		publicationsAdded: 0,
		invalidationCalls: 0,
		state: null,
		...partial,
	});
}
function deniedOrg(): OrgValue {
	return orgValue({ errorCode: "editorial_access_denied" });
}
function orgEditor(authority: RequestActor, organizationId: string): Owner | null {
	const context = authority.actor.context;
	if (context.kind !== "seat" || context.owner.kind !== "organization") return null;
	if (context.role !== "owner" && context.role !== "admin") return null;
	if (context.owner.id !== organizationId) return null;
	if (context.owner.organizationKind !== "sending_church" && context.owner.organizationKind !== "sending_network")
		return null;
	return context.owner;
}
const voteList = z.array(z.enum(["helpful", "unhelpful"]));
function votesOf(raw: unknown): string[] {
	const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
	return voteList.parse(parsed ?? []);
}

export function getMine(db: Database, authority: RequestActor, raw: unknown) {
	const input = parse(feedbackGetMineRequest, raw);
	return runRead(async () => {
		const result = await db.execute(sql`
			WITH mine AS (
				SELECT i.account_id
				FROM live_session(${authority.session}::uuid) i
				WHERE i.registration_state = 'active'
					AND i.account_id = ${authority.actor.accountId}::uuid
			)
			SELECT
				EXISTS (SELECT FROM mine) AS allowed,
				COALESCE((
					SELECT json_agg(a.result->>'currentVote' ORDER BY a.occurred_at, a.id)
					FROM audit_event a
					WHERE a.actor_id = (SELECT account_id FROM mine)
						AND a.action = 'feedback.received'
						AND a.result->>'articleId' = ${input.articleId}
				), '[]'::json) AS votes`);
		const row = z.object({ allowed: z.boolean(), votes: z.unknown() }).parse(result.rows[0]);
		if (!row.allowed) deny();
		const votes = votesOf(row.votes);
		return mineValue({
			articleId: input.articleId,
			currentVote: votes.at(-1) ?? null,
			ownHistoryVotes: votes,
		});
	});
}

export function setMine(db: Database, authority: RequestActor, raw: unknown) {
	const input = parse(feedbackSetMineRequest, raw);
	const context = authority.actor.context;
	if (context.kind !== "seat" || context.owner.kind !== "plant") return Promise.resolve(refuse());
	const owner = context.owner;
	return runWrite(db, authority, owner, "wiki.feedback.setMine", input, feedbackMine, async (tx) => {
		const result = await tx.execute(sql`
			WITH ${meSql(authority, owner)},
			prior AS (
				SELECT a.result->>'currentVote' AS vote, a.occurred_at, a.id
				FROM audit_event a
				WHERE a.actor_id = ${authority.actor.accountId}::uuid
					AND a.action = 'feedback.received'
					AND a.result->>'articleId' = ${input.input.articleId}
					AND EXISTS (SELECT FROM me)
			)
			SELECT
				EXISTS (SELECT FROM me) AS allowed,
				COALESCE((SELECT json_agg(vote ORDER BY occurred_at, id) FROM prior), '[]'::json) AS votes`);
		const row = z.object({ allowed: z.boolean(), votes: z.unknown() }).parse(result.rows[0]);
		if (!row.allowed) deny();
		const votes = [...votesOf(row.votes), input.input.vote];
		return mineValue({
			articleId: input.input.articleId,
			currentVote: input.input.vote,
			ownHistoryVotes: votes,
		});
	});
}

async function mutate(
	db: Database,
	authority: RequestActor,
	raw: unknown,
	mode: "add" | "edit" | "publish" | "hide",
): Promise<WikiReply<OrgValue>> {
	const input = parse(organizationArticleCommand, raw);
	const owner = orgEditor(authority, input.input.organizationId);
	if (!owner) return { status: "ok", value: deniedOrg() };
	if (input.input.adapter === "Evry") return { status: "ok", value: orgValue({ errorCode: "review_required" }) };
	if (mode !== "hide" && !input.input.body) return refuse("invalid_input");
	const body = input.input.body ?? "";
	const contentHash = createHash("sha256").update(body).digest("hex");
	const operation = `wiki.organizationArticles.${mode}`;
	return runWrite(db, authority, owner, operation, input, organizationArticleResult, async (tx) => {
		if (mode === "hide") {
			const result = await tx.execute(sql`
				WITH ${meSql(authority, owner, true)},
				editor AS (
					SELECT id, revision::text AS revision
					FROM article_editor_state
					WHERE organization_id = ${owner.id}::uuid AND article_id = ${input.input.articleId}::uuid
					FOR UPDATE
				),
				updated AS (
					UPDATE article_editor_state e
					SET state = 'hide', revision = e.revision + 1
					FROM editor
					WHERE e.id = editor.id
						AND editor.revision = ${input.expectedRevision}
						AND EXISTS (SELECT FROM me)
					RETURNING e.state
				)
				SELECT
					EXISTS (SELECT FROM me) AS allowed,
					EXISTS (SELECT FROM editor) AS present,
					(SELECT revision FROM editor) AS stored_revision,
					(SELECT state FROM updated) AS state`);
			const row = z
				.object({
					allowed: z.boolean(),
					present: z.boolean(),
					stored_revision: z.string().nullable(),
					state: z.string().nullable(),
				})
				.parse(result.rows[0]);
			if (!row.allowed) deny();
			if (!row.present || row.stored_revision !== input.expectedRevision) deny("conflict");
			if (row.state !== "hide") deny("conflict");
			return orgValue({ organizationId: owner.id, state: "hide" });
		}
		const result = await tx.execute(sql`
			WITH ${meSql(authority, owner, true)},
			base AS (
				SELECT r.id AS upstream_id, r.title, r.slug, r.excerpt, r.phase, r.position, r.section_id
				FROM article_revision r
				WHERE r.article_id = ${input.input.articleId}::uuid
					AND (
						r.tenant_id = ${owner.id}::uuid
						OR (r.tenant_id = ${GLOBAL}::uuid AND r.published_at IS NOT NULL)
					)
				ORDER BY (r.tenant_id = ${owner.id}::uuid) DESC, r.revision_number DESC
				LIMIT 1
			),
			editor AS (
				SELECT id, state, revision::text AS revision, current_revision_id, draft_revision_id, based_on_upstream_id
				FROM article_editor_state
				WHERE organization_id = ${owner.id}::uuid AND article_id = ${input.input.articleId}::uuid
				FOR UPDATE
			),
			prior AS (
				SELECT COALESCE(MAX(revision_number), 0) AS n
				FROM article_revision
				WHERE article_id = ${input.input.articleId}::uuid AND tenant_id = ${owner.id}::uuid
			),
			ins AS (
				INSERT INTO article_revision (
					id, article_id, tenant_id, release_id, revision_number, upstream_revision_id, title, slug, excerpt,
					body, content_type, phase, position, content_hash, published_at, meaningful, meaningful_sequence, section_id
				)
				SELECT
					gen_random_uuid(),
					${input.input.articleId}::uuid,
					${owner.id}::uuid,
					NULL,
					prior.n + 1,
					base.upstream_id,
					base.title,
					base.slug,
					base.excerpt,
					${body},
					'safe_nodes',
					base.phase,
					base.position,
					${contentHash},
					CASE WHEN ${mode} = 'publish' THEN clock_timestamp() ELSE NULL END,
					${mode === "publish"},
					prior.n + 1,
					base.section_id
				FROM base
				CROSS JOIN prior
				WHERE EXISTS (SELECT FROM me)
					AND (
						(NOT EXISTS (SELECT FROM editor) AND ${input.expectedRevision} = '0')
						OR (SELECT revision FROM editor) = ${input.expectedRevision}
					)
				RETURNING id, revision_number
			),
			saved AS (
				UPDATE article_editor_state e SET
					state = CASE
						WHEN ${mode} = 'publish' THEN 'published'
						WHEN e.state IN ('published', 'hide') THEN e.state
						ELSE 'draft'
					END,
					current_revision_id = CASE WHEN ${mode} = 'publish' THEN (SELECT id FROM ins) ELSE e.current_revision_id END,
					draft_revision_id = CASE WHEN ${mode} = 'publish' THEN e.draft_revision_id ELSE (SELECT id FROM ins) END,
					based_on_upstream_id = COALESCE(e.based_on_upstream_id, (SELECT upstream_id FROM base)),
					revision = e.revision + 1
				WHERE e.id = (SELECT id FROM editor) AND EXISTS (SELECT FROM ins)
				RETURNING e.state
			),
			created AS (
				INSERT INTO article_editor_state (
					id, organization_id, article_id, state, current_revision_id, draft_revision_id, based_on_upstream_id, revision
				)
				SELECT
					gen_random_uuid(),
					${owner.id}::uuid,
					${input.input.articleId}::uuid,
					CASE WHEN ${mode} = 'publish' THEN 'published' ELSE 'draft' END,
					CASE WHEN ${mode} = 'publish' THEN ins.id ELSE NULL END,
					CASE WHEN ${mode} = 'publish' THEN NULL ELSE ins.id END,
					(SELECT upstream_id FROM base),
					1
				FROM ins
				WHERE NOT EXISTS (SELECT FROM editor)
				RETURNING state
			)
			SELECT
				EXISTS (SELECT FROM me) AS allowed,
				EXISTS (SELECT FROM base) AS has_base,
				EXISTS (SELECT FROM editor) AS has_editor,
				(SELECT revision FROM editor) AS stored_revision,
				(SELECT revision_number FROM ins) AS written_number,
				COALESCE((SELECT state FROM saved), (SELECT state FROM created)) AS state`);
		const row = z
			.object({
				allowed: z.boolean(),
				has_base: z.boolean(),
				has_editor: z.boolean(),
				stored_revision: z.string().nullable(),
				written_number: z.number().int().nullable(),
				state: z.enum(["published", "hide", "draft", "inherited"]).nullable(),
			})
			.parse(result.rows[0]);
		if (!row.allowed) deny();
		if (!row.has_base) deny("invalid_subject");
		const revisionOk = row.has_editor ? row.stored_revision === input.expectedRevision : input.expectedRevision === "0";
		if (!revisionOk || row.written_number == null || row.state == null) deny("conflict");
		return orgValue({
			publishedRevision: mode === "publish" ? row.written_number : null,
			organizationId: owner.id,
			additionalHistoryEntries: 1,
			state: row.state,
		});
	});
}

export function addOrganizationArticle(db: Database, authority: RequestActor, raw: unknown) {
	return mutate(db, authority, raw, "add");
}
export function editOrganizationArticle(db: Database, authority: RequestActor, raw: unknown) {
	return mutate(db, authority, raw, "edit");
}
export function hideOrganizationArticle(db: Database, authority: RequestActor, raw: unknown) {
	return mutate(db, authority, raw, "hide");
}
export function publishOrganizationArticle(db: Database, authority: RequestActor, raw: unknown) {
	return mutate(db, authority, raw, "publish");
}

export function getOrganizationDraft(db: Database, authority: RequestActor, raw: unknown) {
	const input = parse(organizationDraftRequest, raw);
	const owner = orgEditor(authority, input.organizationId);
	if (!owner)
		return Promise.resolve({
			status: "ok" as const,
			value: organizationDraft.parse({
				errorCode: "editorial_access_denied",
				articleId: input.articleId,
				organizationId: null,
				body: null,
				revisionNumber: null,
				state: null,
			}),
		});
	return runRead(async () => {
		const result = await db.execute(sql`
			WITH ${meSql(authority, owner, true)}
			SELECT
				EXISTS (SELECT FROM me) AS allowed,
				e.state,
				r.body,
				r.revision_number
			FROM article_editor_state e
			LEFT JOIN article_revision r ON r.id = e.draft_revision_id AND r.tenant_id = e.organization_id
			WHERE e.organization_id = ${owner.id}::uuid
				AND e.article_id = ${input.articleId}::uuid
				AND EXISTS (SELECT FROM me)`);
		const row = result.rows[0];
		if (!row) {
			const allowed = await db.execute(sql`
				WITH ${meSql(authority, owner, true)}
				SELECT EXISTS (SELECT FROM me) AS allowed`);
			if (!z.object({ allowed: z.boolean() }).parse(allowed.rows[0]).allowed) deny();
			return organizationDraft.parse({
				errorCode: null,
				articleId: input.articleId,
				organizationId: owner.id,
				body: null,
				revisionNumber: null,
				state: null,
			});
		}
		const parsed = z
			.object({
				allowed: z.boolean(),
				state: z.enum(["published", "hide", "draft", "inherited"]).nullable(),
				body: z.string().nullable(),
				revision_number: z.number().int().nullable(),
			})
			.parse(row);
		if (!parsed.allowed) deny();
		return organizationDraft.parse({
			errorCode: null,
			articleId: input.articleId,
			organizationId: owner.id,
			body: parsed.body,
			revisionNumber: parsed.revision_number,
			state: parsed.state,
		});
	});
}

export function emitUpstreamReview(db: Database, authority: RequestActor, raw: unknown) {
	const input = parse(upstreamReviewRequest, raw);
	const context = authority.actor.context;
	const owner = context.kind === "seat" ? context.owner : { kind: "account" as const, id: authority.actor.accountId };
	const plantId = context.kind === "seat" && context.owner.kind === "plant" ? context.owner.id : null;
	return runWrite(db, authority, owner, "wiki.emitUpstreamReview", input, upstreamReviewResult, async (tx) => {
		const result = await tx.execute(sql`
			WITH ${meSql(authority, owner)},
			globals AS (
				SELECT r.id, r.title, r.meaningful_sequence, r.revision_number
				FROM article_revision r
				WHERE r.article_id = ${input.input.articleId}::uuid
					AND r.tenant_id = ${GLOBAL}::uuid
					AND r.published_at IS NOT NULL
					AND EXISTS (SELECT FROM me)
			),
			custom AS (
				SELECT
					e.organization_id,
					COALESCE(
						(SELECT g.revision_number FROM globals g WHERE g.id = e.based_on_upstream_id),
						(SELECT MIN(revision_number) FROM globals)
					) AS forked
				FROM article_editor_state e
				WHERE e.article_id = ${input.input.articleId}::uuid
					AND e.state <> 'inherited'
			),
			editors AS (
				SELECT c.organization_id AS tenant_id, s.account_id, g.id AS revision_id, g.title, g.meaningful_sequence
				FROM custom c
				JOIN globals g ON g.revision_number > c.forked
				JOIN seat s ON s.organization_id = c.organization_id
					AND s.role IN ('owner', 'admin')
					AND s.ended_at IS NULL
					AND s.accepted_at <= clock_timestamp()
			),
			reader AS (
				SELECT ${plantId}::uuid AS tenant_id, ${authority.actor.accountId}::uuid AS account_id,
					g.id AS revision_id, g.title, g.meaningful_sequence
				FROM globals g
				WHERE ${plantId}::uuid IS NOT NULL
					AND g.revision_number > (SELECT MIN(revision_number) FROM globals)
			),
			inserted AS (
				INSERT INTO notice (
					tenant_id, recipient_id, category, purpose, logical_key, source_record_id, source_revision,
					title, eligible_at, created_at
				)
				SELECT n.tenant_id, n.account_id, 'reference_update', 'reference_update',
					n.tenant_id::text || '/wiki_upstream/' || n.revision_id::text || '/' || n.meaningful_sequence::text,
					n.tenant_id, n.meaningful_sequence, n.title, clock_timestamp(), clock_timestamp()
				FROM (
					SELECT * FROM editors
					UNION ALL
					SELECT * FROM reader
				) n
				ON CONFLICT (recipient_id, logical_key) DO NOTHING
				RETURNING recipient_id
			)
			SELECT
				EXISTS (SELECT FROM me) AS allowed,
				COALESCE((SELECT json_agg(DISTINCT recipient_id) FROM inserted), '[]'::json) AS recipients,
				(SELECT count(*)::int FROM inserted) AS cues`);
		const row = z
			.object({ allowed: z.boolean(), recipients: z.unknown(), cues: z.number().int() })
			.parse(result.rows[0]);
		if (!row.allowed) deny();
		const recipients = z.array(z.uuid()).parse(
			typeof row.recipients === "string" ? JSON.parse(row.recipients) : row.recipients,
		);
		return upstreamReviewResult.parse({
			inAppCues: row.cues,
			emailIntents: 0,
			autoAdoptions: 0,
			recipientIds: recipients,
		});
	});
}

