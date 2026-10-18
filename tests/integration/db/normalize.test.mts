import test from "node:test";
import assert from "node:assert/strict";
import { normalizeOwnTableReferences, assertUnqualifiedOwnTables } from "../../../packages/db/src/schema/normalize.ts";

test("Kit output follows the selected application schema without changing extensions, literals or custom schemas", () => {
	const own = new Set(["account", "person"]);
	const before = `CREATE TABLE "person" ("embedding" public.vector(1536), "note" text DEFAULT 'REFERENCES "public"."account"');
ALTER TABLE "public"."person" ADD CONSTRAINT "person_account_fk" FOREIGN KEY ("id") REFERENCES "public"."account"("id");
CREATE INDEX "person_id_idx" ON "public"."person" ("id");
-- REFERENCES "public"."account"
/* REFERENCES "public"."person" */
SELECT $$REFERENCES "public"."account"$$, public.vector_dims(embedding);
ALTER TABLE "person" ADD FOREIGN KEY ("id") REFERENCES "other"."account"("id");
ALTER TABLE "person" ADD FOREIGN KEY ("id") REFERENCES "public"."extension_table"("id");
`;
	const expected = `CREATE TABLE "person" ("embedding" public.vector(1536), "note" text DEFAULT 'REFERENCES "public"."account"');
ALTER TABLE "person" ADD CONSTRAINT "person_account_fk" FOREIGN KEY ("id") REFERENCES "account"("id");
CREATE INDEX "person_id_idx" ON "person" ("id");
-- REFERENCES "public"."account"
/* REFERENCES "public"."person" */
SELECT $$REFERENCES "public"."account"$$, public.vector_dims(embedding);
ALTER TABLE "person" ADD FOREIGN KEY ("id") REFERENCES "other"."account"("id");
ALTER TABLE "person" ADD FOREIGN KEY ("id") REFERENCES "public"."extension_table"("id");
`;
	assert.equal(normalizeOwnTableReferences(before, own), expected);
	assert.equal(normalizeOwnTableReferences(expected, own), expected);
	assert.throws(() => assertUnqualifiedOwnTables(before, own), /public-qualified/);
	assert.doesNotThrow(() => assertUnqualifiedOwnTables(expected, own));
});
