ALTER TABLE "article_revision" ADD COLUMN "search_vector" "tsvector";
--> statement-breakpoint
-- The words of a body for search: the text, callout labels and diagram source of organization nodes, in document
-- order, so node types and keys are never indexed; else the markdown itself. Older organization text that is not JSON
-- is read as markdown.
CREATE OR REPLACE FUNCTION wiki_search_words(content_type text, body text)
 RETURNS text
 LANGUAGE sql
 STABLE PARALLEL SAFE
 SET search_path FROM CURRENT
AS $function$
SELECT CASE
	WHEN content_type = 'safe_nodes' AND pg_input_is_valid(body, 'jsonb') THEN (
		SELECT string_agg(t #>> '{}', E'\n')
		FROM jsonb_path_query(body::jsonb, 'strict $.** ? (@.type() == "object").keyvalue() ? ((@.key == "text" || @.key == "label" || @.key == "source") && @.value.type() == "string").value', '{}', true) t
	)
	ELSE body
END
$function$;
--> statement-breakpoint
-- Wiki search matches and ranks on this vector: title A, excerpt B, body words C.
CREATE OR REPLACE FUNCTION article_revision_search_vector()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path FROM CURRENT
AS $function$
BEGIN
  NEW.search_vector := setweight(to_tsvector('english', coalesce(NEW.title, '')), 'A')
    || setweight(to_tsvector('english', coalesce(NEW.excerpt, '')), 'B')
    || setweight(to_tsvector('english', coalesce(wiki_search_words(NEW.content_type, NEW.body), '')), 'C');
  RETURN NEW;
END $function$;
--> statement-breakpoint
CREATE TRIGGER search_vector BEFORE INSERT OR UPDATE ON "article_revision" FOR EACH ROW EXECUTE FUNCTION article_revision_search_vector();
