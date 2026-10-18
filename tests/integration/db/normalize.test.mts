import test from "node:test";
import assert from "node:assert/strict";
import {
	qualifyVectorTypes,
	assertQualifiedVectorTypes,
	normalizeOwnTableReferences,
	assertUnqualifiedOwnTables,
} from "../../../packages/db/src/schema/normalize.ts";

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

test("vector qualification changes only type positions, including array types, casts and defaults", () => {
	const before = `CREATE TABLE "vector" ("vector" text, embedding vector(3) DEFAULT '[1,2,3]'::vector, vectors vector[] DEFAULT ARRAY[]::vector[], note text DEFAULT 'vector', x text DEFAULT vector_name());
ALTER TABLE "vector" ADD COLUMN "vector_column" vector;
ALTER TABLE "vector" ALTER COLUMN "vector_column" SET DATA TYPE vector(3);
SELECT vector, "vector", vector(3), public.vector_dims(embedding), '::vector', CAST('[1,2,3]' AS vector(3)), '$vector$' AS vector;
-- vector vector ::vector
SELECT $$CREATE TABLE vector (value vector);$$;
ALTER TABLE "vector" ADD COLUMN other_schema_vector other.vector;
`;
	const expected = `CREATE TABLE "vector" ("vector" text, embedding public.vector(3) DEFAULT '[1,2,3]'::public.vector, vectors public.vector[] DEFAULT ARRAY[]::public.vector[], note text DEFAULT 'vector', x text DEFAULT vector_name());
ALTER TABLE "vector" ADD COLUMN "vector_column" public.vector;
ALTER TABLE "vector" ALTER COLUMN "vector_column" SET DATA TYPE public.vector(3);
SELECT vector, "vector", vector(3), public.vector_dims(embedding), '::vector', CAST('[1,2,3]' AS public.vector(3)), '$vector$' AS vector;
-- vector vector ::vector
SELECT $$CREATE TABLE vector (value vector);$$;
ALTER TABLE "vector" ADD COLUMN other_schema_vector other.vector;
`;
	assert.equal(qualifyVectorTypes(before), expected);
	assert.equal(qualifyVectorTypes(expected), expected);
	assert.throws(() => assertQualifiedVectorTypes(before), /unqualified vector/);
	assert.doesNotThrow(() => assertQualifiedVectorTypes(expected));
});

test("normalization protects nested comments, escaped literals and vector constraint names", () => {
	const sql = String.raw`/* outer /* inner */ REFERENCES "public"."account" */
SELECT E'escaped \' REFERENCES "public"."account" ::vector';
ALTER TABLE "account" ADD CONSTRAINT vector CHECK (true);`;
	assert.equal(normalizeOwnTableReferences(sql, new Set(["account"])), sql);
	assert.equal(qualifyVectorTypes(sql), sql);
});

test("committed migration checks reject raw Kit qualification and frozen-byte changes", async () => {
	const { mkdtemp, mkdir, writeFile, rm } = await import("node:fs/promises");
	const { tmpdir } = await import("node:os");
	const { pathToFileURL } = await import("node:url");
	const { createHash } = await import("node:crypto");
	const { checkMigrationArtifacts, ownTableNames } = await import("../../../packages/db/src/schema/artifacts.ts");
	const directory = await mkdtemp(tmpdir() + "/db1-artifacts-");
	const url = pathToFileURL(directory + "/");
	try {
		await mkdir(directory + "/meta");
		const frozen = "SELECT 1;\n";
		await writeFile(directory + "/0001_baseline.sql", frozen);
		await writeFile(
			directory + "/meta/frozen.json",
			JSON.stringify({
				files: [{ name: "0001_baseline.sql", sha256: createHash("sha256").update(frozen).digest("hex") }],
			}),
		);
		await writeFile(
			directory + "/meta/_journal.json",
			JSON.stringify({
				entries: [
					{ idx: 1, tag: "0001_baseline" },
					{ idx: 2, tag: "0002_probe" },
				],
			}),
		);
		const kit = 'ALTER TABLE "public"."person" ADD COLUMN embedding vector[];';
		await writeFile(directory + "/0002_probe.sql", kit);
		await assert.rejects(checkMigrationArtifacts(url), /public-qualified/);
		await writeFile(directory + "/0002_probe.sql", normalizeOwnTableReferences(kit, ownTableNames));
		await assert.rejects(checkMigrationArtifacts(url), /unqualified vector/);
		await writeFile(directory + "/0002_probe.sql", qualifyVectorTypes(normalizeOwnTableReferences(kit, ownTableNames)));
		await assert.doesNotReject(checkMigrationArtifacts(url));
		await writeFile(directory + "/0001_baseline.sql", frozen + "-- changed\n");
		await assert.rejects(checkMigrationArtifacts(url), /Frozen migration changed/);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});
