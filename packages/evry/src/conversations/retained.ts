import { sql, type SQL } from "@everyfield/db/query";

const live = (row: string) =>
	sql.raw(
		`EXISTS(SELECT FROM person p WHERE p.id=(${row}->>'id')::uuid AND p.tenant_id=c.tenant_id AND p.plant_id=c.tenant_id AND p.state='live')`,
	);

/**
 * Saved events as they may be shown or sent to a model now. A result card keeps only rows whose source is still live
 * in the conversation's tenant; a withheld row also withholds the card's total. Assistant text of a turn that used a
 * source no longer available is withheld, so replay and later model calls never repeat a retired or removed body.
 * `events` selects conversation_event rows; the outer query names the conversation `c`. Still one statement.
 */
export function retainedEvents(events: SQL): SQL {
	return sql`SELECT e.sequence,e.turn_id,e.kind,e.created_at,
		CASE WHEN e.kind='tool_result' AND k.withheld>0
				THEN jsonb_set(e.body,'{result}',(e.body->'result')||jsonb_build_object('rows',k.rows,'total',NULL,'completeness','partial','withheldRows',k.withheld))
			WHEN g.gone THEN e.body||'{"text":"","withheld":true}'::jsonb
			ELSE e.body END AS body
		FROM (${events}) e
		LEFT JOIN LATERAL (
			SELECT coalesce(jsonb_agg(r) FILTER (WHERE ${live("r")}),'[]'::jsonb) AS rows, count(*) FILTER (WHERE NOT ${live("r")}) AS withheld
			FROM jsonb_array_elements(coalesce(e.body->'result'->'rows','[]'::jsonb)) r
		) k ON e.kind='tool_result'
		LEFT JOIN LATERAL (
			SELECT EXISTS(SELECT FROM conversation_event t CROSS JOIN jsonb_array_elements(coalesce(t.body->'result'->'rows','[]'::jsonb)) r
				WHERE t.conversation_id=e.conversation_id AND t.turn_id=e.turn_id AND t.kind='tool_result' AND NOT ${live("r")}) AS gone
		) g ON e.kind IN ('assistant_text','status')`;
}
