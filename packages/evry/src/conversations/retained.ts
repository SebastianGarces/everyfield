import { sql, type SQL, type SqlLiteral } from "@everyfield/db/query";

import { rowLive } from "./liveness.ts";

const live = <RowName extends string>(row: SqlLiteral<RowName>) => rowLive(sql.raw(row), sql.raw("c.tenant_id"));

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
