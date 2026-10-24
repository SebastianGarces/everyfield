import type { Owner } from "@everyfield/contracts/common";
import type { SourceView } from "@everyfield/contracts/wiki";
import { sql, type SQL } from "@everyfield/db/query";
import "server-only";
import type { RequestActor } from "../access/session.ts";
import { GLOBAL, meSql, PAGE } from "./core.ts";

export type CorpusAccess = { authority: RequestActor; owner: Owner; admin?: boolean };

function sourceSql(source: SourceView) {
	const organizationId = source.kind === "organization" ? source.organizationId : GLOBAL;
	return {
		kind: source.kind,
		organizationId,
		inherited: source.kind === "organization",
	};
}

/** Visible articles for one actor. One statement. A rejoined affiliation does not reclaim a stored rank. */
export function corpusCtes(access: CorpusAccess, source: SourceView): SQL {
	const pick = sourceSql(source);
	const owner = access.owner;
	return sql`
		${meSql(access.authority, owner, access.admin ?? false)},
		release AS (
			SELECT a.release_id FROM reference_activation a ORDER BY a.activation_number DESC LIMIT 1
		),
		pref AS (
			SELECT
				COALESCE(e.churches, ARRAY[]::uuid[]) AS churches,
				COALESCE(e.networks, ARRAY[]::uuid[]) AS networks,
				COALESCE(e.revision, '0') AS revision,
				e.occurred_at
			FROM (SELECT 1) seed
			LEFT JOIN LATERAL (
				SELECT
					ARRAY(SELECT jsonb_array_elements_text(COALESCE(result->'churches', '[]'::jsonb))::uuid) AS churches,
					ARRAY(SELECT jsonb_array_elements_text(COALESCE(result->'networks', '[]'::jsonb))::uuid) AS networks,
					result->>'revision' AS revision,
					occurred_at
				FROM audit_event
				WHERE ${owner.kind} = 'plant'
					AND tenant_id = ${owner.id}::uuid
					AND action = 'wiki.source_order_changed'
				ORDER BY occurred_at DESC, id DESC
				LIMIT 1
			) e ON true
		),
		links AS (
			SELECT o.id AS org_id, o.kind, f.accepted_at
			FROM affiliation f
			JOIN organization o ON o.id = f.organization_id
			WHERE ${owner.kind} = 'plant'
				AND f.plant_id = ${owner.id}::uuid
				AND f.ended_at IS NULL
				AND f.share_wiki
				AND o.kind IN ('sending_church', 'sending_network')
				AND EXISTS (SELECT FROM me)
			UNION ALL
			SELECT o.id, o.kind, clock_timestamp()
			FROM organization o
			WHERE ${owner.kind} = 'organization'
				AND o.id = ${owner.id}::uuid
				AND EXISTS (SELECT FROM me)
		),
		global_rev AS (
			SELECT DISTINCT ON (r.article_id)
				r.article_id,
				r.id AS revision_id,
				r.title,
				r.slug,
				r.excerpt,
				r.body,
				r.phase,
				r.position,
				r.revision_number,
				r.meaningful,
				r.meaningful_sequence,
				r.content_type,
				r.parent_article_id,
				r.published_at,
				i.canonical_key AS section_key
			FROM article_revision r
			JOIN reference_item i ON i.id = r.section_id
			JOIN release rel ON r.release_id = rel.release_id
			WHERE r.tenant_id = ${GLOBAL}::uuid
				AND r.content_type = 'safe_mdx'
				AND r.published_at IS NOT NULL
				AND EXISTS (SELECT FROM me)
			ORDER BY r.article_id, r.revision_number DESC
		),
		overrides AS (
			SELECT
				e.article_id,
				COALESCE(rev.id, g.revision_id) AS revision_id,
				COALESCE(rev.title, g.title) AS title,
				COALESCE(rev.slug, g.slug) AS slug,
				CASE WHEN e.state = 'hide' THEN NULL ELSE COALESCE(rev.excerpt, g.excerpt) END AS excerpt,
				CASE WHEN e.state = 'hide' THEN NULL ELSE rev.body END AS body,
				COALESCE(rev.phase, g.phase) AS phase,
				COALESCE(rev.position, g.position, 0) AS position,
				COALESCE(rev.revision_number, g.revision_number, 1) AS revision_number,
				COALESCE(rev.meaningful, g.meaningful, false) AS meaningful,
				COALESCE(rev.meaningful_sequence, g.meaningful_sequence, 0) AS meaningful_sequence,
				COALESCE(rev.content_type, g.content_type, 'safe_mdx') AS content_type,
				COALESCE(rev.parent_article_id, g.parent_article_id) AS parent_article_id,
				COALESCE(rev.published_at, g.published_at) AS published_at,
				COALESCE(sec.canonical_key, g.section_key, 'section') AS section_key,
				l.org_id AS source_id,
				CASE WHEN l.kind = 'sending_church' THEN 'church' ELSE 'network' END AS source_kind,
				(e.state = 'hide') AS hidden,
				CASE WHEN e.state = 'hide' THEN 'hidden' ELSE 'published' END AS state,
				(
					CASE WHEN l.kind = 'sending_church' THEN 0 ELSE 1000000 END
					+ CASE
						WHEN pr.occurred_at IS NOT NULL AND l.accepted_at <= pr.occurred_at THEN COALESCE(
							array_position(
								CASE WHEN l.kind = 'sending_church' THEN pr.churches ELSE pr.networks END,
								l.org_id
							),
							100000
						)
						ELSE 100000
					END
				)::int AS rank,
				l.accepted_at
			FROM links l
			JOIN article_editor_state e ON e.organization_id = l.org_id AND e.state IN ('published', 'hide')
			LEFT JOIN global_rev g ON g.article_id = e.article_id
			LEFT JOIN article_revision rev ON rev.id = e.current_revision_id AND rev.tenant_id = l.org_id
			LEFT JOIN reference_item sec ON sec.id = rev.section_id
			CROSS JOIN pref pr
			WHERE (
				(e.state = 'hide' AND (rev.id IS NOT NULL OR g.article_id IS NOT NULL))
				OR (e.state = 'published' AND rev.id IS NOT NULL)
			)
			AND EXISTS (SELECT FROM me)
		),
		globals AS (
			SELECT
				g.article_id,
				g.revision_id,
				g.title,
				g.slug,
				g.excerpt,
				g.body,
				g.phase,
				g.position,
				g.revision_number,
				g.meaningful,
				g.meaningful_sequence,
				g.content_type,
				g.parent_article_id,
				g.published_at,
				g.section_key,
				${GLOBAL}::uuid AS source_id,
				'global'::text AS source_kind,
				false AS hidden,
				'published'::text AS state,
				(2000000 + g.position)::int AS rank,
				'epoch'::timestamptz AS accepted_at
			FROM global_rev g
		),
		inherited AS (
			SELECT
				g.article_id,
				g.revision_id,
				g.title,
				g.slug,
				g.excerpt,
				g.body,
				g.phase,
				g.position,
				g.revision_number,
				g.meaningful,
				g.meaningful_sequence,
				g.content_type,
				g.parent_article_id,
				g.published_at,
				g.section_key,
				${pick.organizationId}::uuid AS source_id,
				COALESCE(
					(SELECT CASE o.kind WHEN 'sending_church' THEN 'church' ELSE 'network' END
					 FROM organization o WHERE o.id = ${pick.organizationId}::uuid),
					'church'
				) AS source_kind,
				false AS hidden,
				'inherited'::text AS state,
				(3000000 + g.position)::int AS rank,
				clock_timestamp() AS accepted_at
			FROM global_rev g
			WHERE ${pick.inherited}::boolean
				AND EXISTS (SELECT FROM links l WHERE l.org_id = ${pick.organizationId}::uuid)
				AND NOT EXISTS (
					SELECT FROM overrides o
					WHERE o.article_id = g.article_id AND o.source_id = ${pick.organizationId}::uuid
				)
		),
		candidates AS (
			SELECT * FROM overrides
			UNION ALL
			SELECT * FROM globals
			UNION ALL
			SELECT * FROM inherited
		),
		chosen AS (
			SELECT DISTINCT ON (c.article_id) c.*
			FROM candidates c
			WHERE ${pick.kind} = 'current'
				OR (${pick.kind} = 'global' AND c.source_kind = 'global')
				OR (${pick.kind} = 'organization' AND c.source_id = ${pick.organizationId}::uuid)
			ORDER BY c.article_id, c.rank, c.accepted_at, c.source_id
		),
		picked AS (
			SELECT
				c.*,
				COALESCE((
					SELECT json_agg(json_build_object(
						'sourceId', a.source_id,
						'sourceKind', a.source_kind,
						'state', a.state,
						'title', a.title
					) ORDER BY a.rank, a.accepted_at, a.source_id)
					FROM candidates a
					WHERE a.article_id = c.article_id
						AND NOT a.hidden
						AND a.source_id IS DISTINCT FROM c.source_id
						AND a.state <> 'inherited'
				), '[]'::json) AS alternates,
				COALESCE((
					SELECT json_agg(x.id)
					FROM (
						SELECT DISTINCT m[1]::uuid AS id
						FROM regexp_matches(COALESCE(c.body, ''), 'wiki-related:[[:space:]]*([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})', 'g') AS m
						WHERE EXISTS (
							SELECT FROM chosen h
							WHERE h.article_id = m[1]::uuid AND h.article_id <> c.article_id
						)
					) x
				), '[]'::json) AS related_ids
			FROM chosen c
		)`;
}

export function articleJson(): SQL {
	return sql`json_build_object(
		'articleId', p.article_id,
		'sourceId', p.source_id,
		'sourceKind', p.source_kind,
		'hidden', p.hidden,
		'state', p.state,
		'body', CASE WHEN p.hidden THEN NULL ELSE p.body END,
		'title', p.title,
		'slug', p.slug,
		'excerpt', p.excerpt,
		'phase', p.phase,
		'position', p.position,
		'revisionId', p.revision_id,
		'revisionNumber', p.revision_number,
		'meaningful', p.meaningful,
		'meaningfulSequence', p.meaningful_sequence,
		'contentType', p.content_type,
		'parentArticleId', p.parent_article_id,
		'sectionKey', p.section_key,
		'publishedAt', to_char(p.published_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
		'updatedLabel', COALESCE(
			rd.completed_at IS NOT NULL AND p.meaningful AND p.meaningful_sequence > rd.last_read_meaningful_sequence,
			false
		),
		'completed', COALESCE(rd.completed_at IS NOT NULL, false),
		'observedFraction', COALESCE(rd.observed_fraction::text, '0'),
		'bookmarked', COALESCE(rd.bookmarked, false),
		'alternates', p.alternates,
		'credit', COALESCE(cr.source_credit, p.source_kind || ':' || p.source_id::text),
		'relatedIds', p.related_ids,
		'snippet', p.snippet
	)`;
}

export function articleFrom(extra: SQL = sql`true`): SQL {
	return sql`picked p
		LEFT JOIN reading rd ON rd.account_id = (SELECT account_id FROM me) AND rd.article_id = p.article_id
		LEFT JOIN LATERAL (
			SELECT v.source_credit
			FROM reference_version v
			WHERE v.item_id = p.article_id
				AND (
					v.release_id = (SELECT release_id FROM release)
					OR NOT EXISTS (SELECT FROM release)
				)
			ORDER BY v.version_number DESC
			LIMIT 1
		) cr ON true
		WHERE ${extra}`;
}

export function pageQuery(access: CorpusAccess, source: SourceView, page: number, where: SQL = sql`true`): SQL {
	const offset = (page - 1) * PAGE;
	return sql`WITH ${corpusCtes(access, source)},
		paged AS (
			SELECT p.*, NULL::text AS snippet
			FROM ${articleFrom(where)}
			ORDER BY p.section_key, p.phase NULLS LAST, p.position, p.title, p.article_id
			OFFSET ${offset} LIMIT ${PAGE}
		)
		SELECT
			EXISTS (SELECT FROM me) AS allowed,
			CASE WHEN EXISTS (SELECT FROM me)
				THEN COALESCE((
					SELECT json_agg(u.id ORDER BY u.ord)
					FROM unnest((SELECT churches FROM pref)) WITH ORDINALITY AS u(id, ord)
				), '[]'::json)
				ELSE '[]'::json END AS churches,
			CASE WHEN EXISTS (SELECT FROM me)
				THEN COALESCE((
					SELECT json_agg(u.id ORDER BY u.ord)
					FROM unnest((SELECT networks FROM pref)) WITH ORDINALITY AS u(id, ord)
				), '[]'::json)
				ELSE '[]'::json END AS networks,
			CASE WHEN EXISTS (SELECT FROM me) THEN (SELECT revision FROM pref) ELSE '0' END AS order_revision,
			(SELECT count(*)::int FROM picked p WHERE ${where}) AS total,
			(SELECT pl.phase FROM plant pl WHERE ${access.owner.kind} = 'plant' AND pl.id = ${access.owner.id}::uuid) AS plant_phase,
			COALESCE((
				SELECT json_agg(${articleJson()} ORDER BY p.section_key, p.phase NULLS LAST, p.position, p.title, p.article_id)
				FROM paged p
				LEFT JOIN reading rd ON rd.account_id = (SELECT account_id FROM me) AND rd.article_id = p.article_id
				LEFT JOIN LATERAL (
					SELECT v.source_credit FROM reference_version v
					WHERE v.item_id = p.article_id
					ORDER BY v.version_number DESC LIMIT 1
				) cr ON true
			), '[]'::json) AS articles`;
}
