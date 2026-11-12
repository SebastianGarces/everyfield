import { testDatabase, type Database } from "../../support/test-database.mts";
import { ok, seeds } from "../../support/fixture.mts";
import { sql } from "../../../packages/db/node_modules/drizzle-orm/index.js";
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { copyFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { inspectMigrationProvenance, migrate, migrationArtifact } from "../../../packages/db/src/schema/migrate.ts";
import { RequestActor } from "../../../packages/domain/src/access/session.ts";
import { createWikiProducer } from "../../../packages/domain/src/wiki/index.ts";

// T-275: the wiki search migration reaches head on a database whose revisions include a plain-text organization body,
// which PostgreSQL 18 failed to cast under the first version's CASE guard.
const TARGET = "20261112031340_article_revision_search_vector.sql";
const FOLLOW_UP = "20261112073258_wiki_search_words_plain_text.sql";
// The statements the first version of TARGET ended with. Its bytes are the current file followed by these.
const ORIGINAL_TAIL = `--> statement-breakpoint
-- The search_vector trigger fills every existing row.
UPDATE "article_revision" SET "search_vector" = NULL;
--> statement-breakpoint
ALTER TABLE "article_revision" ALTER COLUMN "search_vector" SET NOT NULL;
`;
const GLOBAL = "00000000-0000-0000-0000-000000000000";
const source = (name: string) => new URL("../../../packages/db/migrations/" + name, import.meta.url);

const database = await testDatabase({ prefix: "t275_test", migrate: false, max: 3 });
const { admin, schema } = database;
const names = (await migrationArtifact()).map(({ name }) => name);
const before = names.filter((name) => name < TARGET);
const directories: string[] = [];
after(async () => {
	for (const directory of directories) await rm(directory, { recursive: true, force: true });
	await database.close();
});

/** A migration folder holding `files`, each copied from the repository unless `bytes` gives its contents. */
async function folder(files: readonly string[], bytes: Record<string, string> = {}) {
	const directory = await mkdtemp(tmpdir() + "/evf-wiki-search-");
	directories.push(directory);
	const url = pathToFileURL(directory + "/");
	for (const name of files)
		if (name in bytes) await writeFile(new URL(name, url), bytes[name]!);
		else await copyFile(source(name), new URL(name, url));
	return url;
}

const ORGANIZATION = randomUUID();
const RELEASE = randomUUID();
const articles = { plain: randomUUID(), nodes: randomUUID(), markdown: randomUUID() };
const revisions = { plain: randomUUID(), nodes: randomUUID(), markdown: randomUUID() };
const nodesBody = JSON.stringify({
	type: "quokkablock",
	content: [{ type: "callout", label: "kingfisher", wombatkey: "pangolin", content: [{ type: "p", text: "osprey" }] }],
});

/** A sending church's two editions, one plain text and one JSON nodes, and a global markdown article. */
async function writeRevisions(db: Database) {
	const section = randomUUID();
	const hash = () => randomBytes(32).toString("hex");
	await seeds(db).organization("sending_church", { id: ORGANIZATION });
	await db.execute(
		sql`INSERT INTO reference_item(id,kind,canonical_key,tenant_id) VALUES(${section},'section','framework/start',${GLOBAL})`,
	);
	await db.execute(sql`INSERT INTO reference_release(id,release_key,artifact_locator,manifest_hash,state,complete_at,validated_at,approval_locator,approval_hash,chunker_version,embedding_profile,embedding_dimensions,tenant_id,expected_passages)
		VALUES(${RELEASE},${"release-" + RELEASE},'memory://synthetic',${hash()},'validated',clock_timestamp(),clock_timestamp(),'memory://approval',${hash()},'v','profile',1,${GLOBAL},0)`);
	for (const [key, body, tenant, content, release] of [
		["plain", "Plain organization notes about lanternfish.", ORGANIZATION, "safe_nodes", null],
		["nodes", nodesBody, ORGANIZATION, "safe_nodes", null],
		["markdown", "Markdown about **heronword**.", GLOBAL, "safe_mdx", RELEASE],
	] as const) {
		await db.execute(
			sql`INSERT INTO reference_item(id,kind,canonical_key,tenant_id) VALUES(${articles[key]},'article',${key},${tenant})`,
		);
		await db.execute(sql`INSERT INTO article_revision(id,article_id,tenant_id,release_id,revision_number,title,slug,excerpt,body,content_type,phase,position,content_hash,published_at,meaningful,meaningful_sequence,section_id)
			VALUES(${revisions[key]},${articles[key]},${tenant},${release},1,${"Article " + key},${key},${"Article " + key},${body},${content},1,1,${hash()},clock_timestamp(),true,1,${section})`);
	}
}

/** Each revision's search vector, by revision id. */
async function vectors(db: Database) {
	return (await db.execute(sql`SELECT id::text, search_vector::text AS vector FROM article_revision ORDER BY id`)).rows;
}

test("T-275 a plain-text organization body migrates through wiki search and is found by its words", async () => {
	await migrate(admin, schema, await folder(before));
	await writeRevisions(admin);

	assert.deepEqual(
		await migrate(admin, schema),
		names.filter((name) => name >= TARGET),
	);
	const filled = await admin.execute(
		sql`SELECT count(*)::int AS total, count(search_vector)::int AS filled FROM article_revision`,
	);
	assert.deepEqual(filled.rows[0], { total: 3, filled: 3 });

	// A plant reads the church's published editions through a wiki-sharing affiliation, and the active global release.
	const seed = seeds(admin);
	const plant = await seed.plant();
	const owner = await seed.actor(plant, "owner");
	await admin.execute(sql`INSERT INTO reference_activation(id,release_id,activation_number,activated_at,actor_tombstone,reason,expected_prior_number)
		VALUES(${randomUUID()},${RELEASE},1,clock_timestamp(),'synthetic','test',0)`);
	await admin.execute(sql`INSERT INTO affiliation(id,plant_id,organization_id,accepted_at,share_people,share_meetings,share_tasks,share_ministry_teams,share_wiki,share_activity,shared_findings)
		VALUES(${randomUUID()},${plant.id},${ORGANIZATION},clock_timestamp(),false,false,false,false,true,false,false)`);
	for (const key of ["plain", "nodes"] as const)
		await admin.execute(sql`INSERT INTO article_editor_state(id,organization_id,article_id,state,current_revision_id,revision)
			VALUES(${randomUUID()},${ORGANIZATION},${articles[key]},'published',${revisions[key]},1)`);
	const reader = await RequestActor.resolve(database.pools.runtime, owner.session);
	assert.ok(reader instanceof RequestActor);
	const wiki = createWikiProducer();
	const found = async (query: string) =>
		(ok(await wiki.search(database.pools.runtime, reader, { query })).results as { articleId: string }[]).map(
			(result) => result.articleId,
		);
	assert.deepEqual(await found("lanternfish"), [articles.plain], "a plain-text body is read as markdown");
	assert.deepEqual(await found("heronword"), [articles.markdown]);
	assert.deepEqual(await found("kingfisher"), [articles.nodes], "a callout label is indexed");
	assert.deepEqual(await found("osprey"), [articles.nodes], "node text is indexed");
	for (const word of ["quokkablock", "callout", "wombatkey", "pangolin"])
		assert.deepEqual(await found(word), [], `${word} is a node type, key or unindexed value`);
});

const server = Number(
	((await admin.execute(sql`SELECT current_setting('server_version_num') AS v`)).rows[0] as { v: string }).v,
);
test(
	"T-275 a database that applied the first version of the migration migrates to head with the same vectors",
	// The first version's backfill fails on any table with revisions (pending record-binding events block its ALTER),
	// so a database applied it with none and wrote them later, through its SQL function, which PostgreSQL 18 cannot run
	// on a plain-text body. Such a database can only exist on PostgreSQL 17, so this case skips on 18, which CI and
	// shared dev run (T-276); there the test above covers a plain-text body migrating to head.
	{ skip: server >= 180000 && "PostgreSQL 18 cannot write a plain-text body through the first version" },
	async () => {
		const upgraded = await database.createSchema("t275_upgraded_" + randomUUID().replaceAll("-", ""));
		const original = (await readFile(source(TARGET), "utf8")) + ORIGINAL_TAIL;
		// Main's head before T-275: the first version of TARGET and no follow-up. The runner accepts its bytes.
		const mainHead = names.filter((name) => name !== FOLLOW_UP);
		await migrate(admin, upgraded, await folder(mainHead, { [TARGET]: original }));
		const db = database.connect("admin", { schema: upgraded, max: 1 });
		await writeRevisions(db);

		assert.deepEqual(await migrate(admin, upgraded), [FOLLOW_UP]);
		assert.equal((await inspectMigrationProvenance(admin, upgraded)).state, "current");
		assert.deepEqual(await vectors(db), await vectors(admin));
	},
);
