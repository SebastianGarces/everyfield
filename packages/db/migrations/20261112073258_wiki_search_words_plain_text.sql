-- The words of a body for search: the text, callout labels and diagram source of organization nodes, in document
-- order, so node types and keys are never indexed; else the markdown itself. Older organization text that is not JSON
-- is read as markdown (D-860). The IF runs before the cast is planned: PostgreSQL 18 plans a SQL function's cast of a
-- plain-text body even under a CASE that rules it out, and fails (T-275).
CREATE OR REPLACE FUNCTION wiki_search_words(content_type text, body text)
 RETURNS text
 LANGUAGE plpgsql
 STABLE PARALLEL SAFE
 SET search_path FROM CURRENT
AS $function$
BEGIN
	IF content_type = 'safe_nodes' AND pg_input_is_valid(body, 'jsonb') THEN
		RETURN (
			SELECT string_agg(t #>> '{}', E'\n')
			FROM jsonb_path_query(body::jsonb, 'strict $.** ? (@.type() == "object").keyvalue() ? ((@.key == "text" || @.key == "label" || @.key == "source") && @.value.type() == "string").value', '{}', true) t
		);
	END IF;
	RETURN body;
END $function$;
--> statement-breakpoint
-- The search_vector trigger fills every existing row, again on a database that applied 20261112031340 with its backfill.
UPDATE "article_revision" SET "search_vector" = NULL;
--> statement-breakpoint
-- Run the deferred record-binding checks the update queued now: a table with pending trigger events cannot be altered
-- in the same transaction.
SET CONSTRAINTS ALL IMMEDIATE;
--> statement-breakpoint
ALTER TABLE "article_revision" ALTER COLUMN "search_vector" SET NOT NULL;
