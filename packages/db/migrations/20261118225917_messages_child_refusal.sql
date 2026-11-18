-- Messages never email a person marked as a child (NTF-016): their mail row is refused with refusal 'child'.
ALTER TABLE "mail" DROP CONSTRAINT "mail_refusal";--> statement-breakpoint
ALTER TABLE "mail" ADD CONSTRAINT "mail_refusal" CHECK (((refusal IS NULL) OR ((refusal = ANY (ARRAY['unsubscribed'::text, 'child'::text])) AND (state = 'refused'::text))));