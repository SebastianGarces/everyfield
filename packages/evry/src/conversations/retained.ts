import { sql, type SQL } from "@everyfield/db/query";

import { rowLive } from "./liveness.ts";

const live = (row: string) => rowLive(sql.raw(row), sql.raw("c.tenant_id"));

/**
 * Saved events as they may be shown or sent to a model now. A result card keeps only rows whose source is still live
 * in the conversation's tenant; a withheld row also withholds the card's total. Assistant text of a turn that used a
 * source no longer available is withheld, so replay and later model calls never repeat a retired or removed body.
 * `events` selects conversation_event rows; the outer query names the conversation `c`. Still one statement.
 *
 * The card-row check joins on the page's tool results alone and checks each row once (the withheld count is the rows
 * it drops). Postgres plans every row array at 100 rows, so a check planned for every event of a 200-event page passed
 * jit_above_cost once the tables had statistics, and each poll of an open stream spent about a second compiling.
 */
export function retainedEvents(events: SQL): SQL {
	return sql`SELECT e.sequence,e.turn_id,e.kind,e.created_at,
		CASE WHEN k.withheld>0
				THEN jsonb_set(e.body,'{result}',(e.body->'result')||jsonb_build_object('rows',k.rows,'total',NULL,'completeness','partial','withheldRows',k.withheld))
			WHEN g.gone THEN e.body||'{"text":"","withheld":true}'::jsonb
			ELSE e.body END AS body
		FROM (${events}) e
		LEFT JOIN (
			SELECT t.conversation_id, t.sequence, k.rows, jsonb_array_length(coalesce(t.body->'result'->'rows','[]'::jsonb))-jsonb_array_length(k.rows) AS withheld
			FROM (${events}) t CROSS JOIN LATERAL (
				SELECT coalesce(jsonb_agg(r) FILTER (WHERE ${live("r")}),'[]'::jsonb) AS rows
				FROM jsonb_array_elements(coalesce(t.body->'result'->'rows','[]'::jsonb)) r
			) k WHERE t.kind='tool_result'
		) k ON k.conversation_id=e.conversation_id AND k.sequence=e.sequence
		LEFT JOIN LATERAL (
			SELECT EXISTS(SELECT FROM conversation_event t CROSS JOIN jsonb_array_elements(coalesce(t.body->'result'->'rows','[]'::jsonb)) r
				WHERE t.conversation_id=e.conversation_id AND t.turn_id=e.turn_id AND t.kind='tool_result' AND NOT ${live("r")}) AS gone
		) g ON e.kind IN ('assistant_text','status')`;
}
