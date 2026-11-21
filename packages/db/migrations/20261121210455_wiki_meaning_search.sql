CREATE TABLE "embedding_spend" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"day" date NOT NULL,
	"purpose" text NOT NULL,
	"usage" bigint NOT NULL,
	CONSTRAINT "embedding_spend_day_key" UNIQUE("day","purpose"),
	CONSTRAINT "embedding_spend_purpose" CHECK ("embedding_spend"."purpose" IN ('query','rebuild')),
	CONSTRAINT "embedding_spend_usage" CHECK ("embedding_spend"."usage" >= 0)
);
--> statement-breakpoint
CREATE INDEX "passage_embedding_1536" ON "passage" USING hnsw ((("embedding")::public.vector(1536)) public.vector_cosine_ops) WHERE public.vector_dims("passage"."embedding") = 1536;
--> statement-breakpoint
REVOKE ALL ON "embedding_spend" FROM everyfield_runtime, everyfield_cleanup;
--> statement-breakpoint
GRANT SELECT,INSERT,UPDATE ON "embedding_spend" TO everyfield_runtime;
