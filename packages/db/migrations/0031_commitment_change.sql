CREATE TABLE "commitment_change" (
	"id" uuid NOT NULL,
	"plant_id" uuid NOT NULL,
	"person_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"effective_on" date NOT NULL,
	"actor_id" uuid,
	"recorded_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
	CONSTRAINT "commitment_change_pkey" PRIMARY KEY("id"),
	CONSTRAINT "commitment_change_kind" CHECK ("commitment_change"."kind" IN ('withdrawn','reactivated'))
);
--> statement-breakpoint
CREATE TABLE "schema_backfill" (
	"name" text NOT NULL,
	"applied_at" timestamp with time zone DEFAULT now() NOT NULL,
	"changed" integer NOT NULL,
	CONSTRAINT "schema_backfill_pkey" PRIMARY KEY("name"),
	CONSTRAINT "schema_backfill_name" CHECK ("schema_backfill"."name" ~ '^[a-z][a-z0-9_]{0,62}$'),
	CONSTRAINT "schema_backfill_changed" CHECK ("schema_backfill"."changed" >= 0)
);
--> statement-breakpoint
ALTER TABLE "commitment_change" ADD CONSTRAINT "commitment_change_plant_id_plant_id_fk" FOREIGN KEY ("plant_id") REFERENCES "plant"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commitment_change" ADD CONSTRAINT "commitment_change_actor_id_account_id_fk" FOREIGN KEY ("actor_id") REFERENCES "account"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commitment_change" ADD CONSTRAINT "commitment_change_person" FOREIGN KEY ("person_id","plant_id") REFERENCES "person"("id","tenant_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "commitment_change_person_order" ON "commitment_change" USING btree ("person_id","plant_id","effective_on","recorded_at");--> statement-breakpoint
-- C100: a withdrawal or reactivation is its own append-only row. Only the Person it belongs to may change, so a merge
-- and its Unmerge move it with its Person; kind and date stay as written.
GRANT SELECT,INSERT ON commitment_change TO everyfield_runtime;
--> statement-breakpoint
GRANT UPDATE (person_id) ON commitment_change TO everyfield_runtime;
--> statement-breakpoint
GRANT SELECT,UPDATE,DELETE ON commitment_change TO everyfield_cleanup;
--> statement-breakpoint
-- Backfill once from the audit rows that recorded each withdrawal and reactivation, under the same ID. A merged
-- Person's change belongs to its survivor. A rerun inserts nothing again.
INSERT INTO commitment_change(id,plant_id,person_id,kind,effective_on,actor_id,recorded_at)
SELECT a.id,p.plant_id,coalesce(p.merged_into_person_id,p.id),
 CASE a.metadata->>'event' WHEN 'commitment_withdrawn' THEN 'withdrawn' ELSE 'reactivated' END,
 (a.after_value->'commitment'->>'effectiveOn')::date,a.actor_id,a.occurred_at
FROM audit_event a JOIN person p ON p.id=a.subject_id AND p.tenant_id=a.tenant_id
WHERE a.kind<>'noop' AND a.metadata->>'event' IN ('commitment_withdrawn','commitment_reactivated')
 AND a.after_value->'commitment'->>'effectiveOn' IS NOT NULL AND p.plant_id IS NOT NULL
ON CONFLICT (id) DO NOTHING;
