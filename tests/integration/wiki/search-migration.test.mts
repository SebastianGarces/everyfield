import { testDatabase, type Database } from "../../support/test-database.mts";
import { ok, seeds } from "../../support/fixture.mts";
import { sql } from "../../../packages/db/node_modules/drizzle-orm/index.js";
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { copyFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { migrate, migrationArtifact } from "../../../packages/db/src/schema/migrate.ts";
import { RequestActor } from "../../../packages/domain/src/access/session.ts";
import { createWikiProducer } from "../../../packages/domain/src/wiki/index.ts";

const TARGET = "20261112031340_article_revision_search_vector.sql";
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

async function folder(files: readonly string[]) {
	const directory = await mkdtemp(tmpdir() + "/evf-wiki-search-");
	directories.push(directory);
	const url = pathToFileURL(directory + "/");
	for (const name of files) await copyFile(source(name), new URL(name, url));
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

test("a plain-text organization body migrates through wiki search and is found by its words", async () => {
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
