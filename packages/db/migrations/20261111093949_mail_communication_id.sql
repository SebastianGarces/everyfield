ALTER TABLE "mail" ADD COLUMN "communication_id" uuid;--> statement-breakpoint
ALTER TABLE "mail" ADD CONSTRAINT "mail_fk_8" FOREIGN KEY ("communication_id","tenant_id") REFERENCES "communication"("id","plant_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "mail_communication" ON "mail" USING btree ("tenant_id","communication_id");--> statement-breakpoint
-- A Messages recipient send names its message in logical_key as communication/<communication id>/<person id>.
UPDATE "mail" m SET "communication_id" = c."id"
FROM "communication" c
WHERE m."purpose" = 'communication' AND m."communication_id" IS NULL
AND c."plant_id" = m."tenant_id" AND m."logical_key" LIKE 'communication/' || c."id"::text || '/%';
--> statement-breakpoint
-- The text part reads like the message (plainText): the five text entities first, then &amp; last, so &amp;lt; stays
-- the literal text &lt;. A replacement never writes "&", so this order matches plainText's single pass.
UPDATE "communication" SET "body_text" = btrim(regexp_replace(
	replace(replace(replace(replace(replace(replace("body_text",
		'&lt;', '<'), '&gt;', '>'), '&quot;', '"'), '&#39;', ''''), '&nbsp;', ' '), '&amp;', '&'),
	'\s+', ' ', 'g'))
WHERE "body_text" ~ '&(lt|gt|quot|#39|nbsp|amp);';
