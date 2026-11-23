ALTER TABLE "mail" DROP CONSTRAINT "mail_refusal";
ALTER TABLE "mail" ADD CONSTRAINT "mail_refusal" CHECK (((refusal IS NULL) OR ((refusal = ANY (ARRAY['unsubscribed'::text, 'child'::text])) AND (state = 'refused'::text))));
