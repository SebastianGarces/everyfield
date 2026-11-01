// OPS-107: the app installs the living Wiki seed. The old bootstrap generation stays reachable for rollback.
import { createDatabase, closeDatabase } from "../../../packages/db/src/client.ts";
import type { Database } from "../../../packages/db/src/client.ts";
import { sql } from "../../../packages/db/src/query.ts";
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { migrate } from "../../../packages/db/src/schema/migrate.ts";
import { approvedWiki } from "../../../packages/reference/src/starter/manifest/approved.ts";
import type { WikiSource } from "../../../packages/reference/src/starter/manifest/approved.ts";
import { referenceService } from "../../../packages/reference/src/starter/verify/service.ts";

const source = new URL(process.env.DATABASE_URL_UNPOOLED ?? process.env.DATABASE_URL ?? "about:blank");
const localCi =
	process.env.CI === "true" &&
	process.env.EARLY_ACCESS_TEST_DATABASE === "1" &&
	["localhost", "127.0.0.1"].includes(source.hostname) &&
	source.pathname === "/everyfield_ci";
if (
	(!localCi && source.hostname !== "ep-autumn-dew-b8ltidky.c-14.us-east-1.aws.neon.tech") ||
	process.env.NODE_ENV === "production"
)
	throw Error("Only shared development or disposable CI endpoint permitted");
if (!localCi) source.searchParams.set("sslmode", "verify-full");

// The pin the app installed before OPS-107, from git history. Only this test still builds it.
const bootstrapSource: WikiSource = {
	version: "wiki-starter-2026-10-03",
	manifestPath: "docs/reference/bootstrap/manifest.json",
	payloadPath: "docs/reference/bootstrap/global-seed-payload.json",
	manifestSha256: "b60b368d7c0ae901c26e429bcda314502e7e836bf97ad57525d9c8816724e68b",
	payloadSha256: "7933b93d693b73b3d8768aa2f7e2ad91fa665b6ec23127cb8b4856466d936f59",
	articles: 96,
	sections: 21,
	systemTemplates: 7,
};
const slug = "administrative/legal/setting-up-501c3";
const oldAdvice = "Make sure you qualify for Form 1023-EZ";

async function seedContent(path: string, wanted: string): Promise<string> {
	const file = JSON.parse(await readFile(new URL(`../../../${path}`, import.meta.url), "utf8")) as {
		articles: { slug: string; content: string }[];
	};
	const row = file.articles.find((article) => article.slug === wanted);
	assert.ok(row, wanted);
	return row.content;
}

const stores: { db: ReturnType<typeof createDatabase>; schema: string }[] = [];
after(async () => {
	for (const { db, schema } of stores) {
		await db.execute(sql.raw(`DROP SCHEMA IF EXISTS ${schema} CASCADE`));
		await closeDatabase(db);
	}
});

/** An empty reference store in its own schema, with one operator who holds reference_publish. */
async function emptyStore() {
	const schema = "ops107_test_" + randomUUID().replaceAll("-", "");
	const db = createDatabase({
		connectionString: source.href,
		max: 4,
		options: `-c search_path=${schema},pg_catalog,pg_temp`,
	});
	stores.push({ db, schema });
	await db.execute(sql.raw(`CREATE SCHEMA ${schema}`));
	await migrate(db, schema);
	const caller = { actorId: randomUUID(), userId: randomUUID(), sessionId: randomUUID() };
	await db.execute(
		sql`INSERT INTO auth_user(id, email, email_verified, name) VALUES (${caller.userId}::uuid, ${caller.userId + "@example.test"}, true, 'Publisher')`,
	);
	await db.execute(
		sql`INSERT INTO account(id, auth_user_id, registration_state, registration_kind) VALUES (${caller.actorId}::uuid, ${caller.userId}::uuid, 'active', 'discovery')`,
	);
	await db.execute(
		sql`INSERT INTO auth_session(id, user_id, token, expires_at) VALUES (${caller.sessionId}::uuid, ${caller.userId}::uuid, ${randomUUID()}, now() + interval '1 hour')`,
	);
	await db.execute(
		sql`INSERT INTO platform_grant(account_id, capability) VALUES (${caller.actorId}::uuid, 'reference_publish')`,
	);
	return { db, caller };
}

function command(
	pin: WikiSource,
	release: string,
	expected: string,
	kind: "install" | "rollback",
	requestKey = randomUUID(),
) {
	return {
		release,
		manifestSha256: pin.manifestSha256,
		payloadSha256: pin.payloadSha256,
		requestKey,
		expectedActivation: expected,
		target: approvedWiki.target,
		kind,
	};
}

/** The article body a reader gets: the revision in the currently active release. */
async function activeArticle(db: Database, wanted: string) {
	const selected = await db.execute(sql`
		SELECT r.release_key, ar.body FROM article_revision ar
		JOIN reference_release r ON r.id = ar.release_id
		WHERE ar.slug = ${wanted} AND ar.release_id = (
		  SELECT release_id FROM reference_activation ORDER BY activation_number DESC LIMIT 1
		)`);
	assert.equal(selected.rows.length, 1);
	return selected.rows[0] as { release_key: string; body: string };
}

test("OPS-107 criterion 10: an empty store gets the living seed's 501(c)(3) article byte for byte", async () => {
	const { db, caller } = await emptyStore();
	const receipt = await referenceService(db).installApprovedWiki(
		caller,
		command(approvedWiki, "LIVING", "0", "install"),
	);
	assert.equal(receipt.activeRelease, "LIVING");
	assert.equal(receipt.insertedArticles, 124);
	const stored = await activeArticle(db, slug);
	assert.equal(stored.body, await seedContent(approvedWiki.payloadPath, slug));
	assert.ok(stored.body.includes("Rev. Proc. 2026-8"));
	// Every sentence that names Form 1023-EZ says that a church cannot use it.
	const mentions = stored.body.split(/(?<=[.!?])\s+|\n+/).filter((sentence) => sentence.includes("1023-EZ"));
	assert.ok(mentions.length > 0);
	for (const sentence of mentions) assert.match(sentence, /not eligible|cannot use|ineligible/i, sentence);
	const ein = await activeArticle(db, "administrative/legal/getting-your-churchs-ein");
	assert.equal(ein.body, await seedContent(approvedWiki.payloadPath, "administrative/legal/getting-your-churchs-ein"));
});

test("OPS-107 criterion 11: the living generation replaces the bootstrap one, and rollback to it still works and replays", async () => {
	const { db, caller } = await emptyStore();
	const old = referenceService(db, { source: bootstrapSource });
	const living = referenceService(db);

	const first = await old.installApprovedWiki(caller, command(bootstrapSource, "BOOTSTRAP", "0", "install"));
	assert.equal(first.activationNumber, "1");
	assert.equal(first.insertedArticles, 96);
	assert.equal((await activeArticle(db, slug)).body, await seedContent(bootstrapSource.payloadPath, slug));
	assert.ok((await activeArticle(db, slug)).body.includes(oldAdvice));
	// The new pins refuse to install under the old source's digests.
	await assert.rejects(
		living.installApprovedWiki(caller, command(bootstrapSource, "LIVING", "1", "install")),
		(error: unknown) => error instanceof Error && error.message === "digest_conflict",
	);

	const second = await living.installApprovedWiki(caller, command(approvedWiki, "LIVING", "1", "install"));
	assert.equal(second.activationNumber, "2");
	assert.equal(second.activeRelease, "LIVING");
	const corrected = await activeArticle(db, slug);
	assert.equal(corrected.release_key, "LIVING");
	assert.equal(corrected.body, await seedContent(approvedWiki.payloadPath, slug));
	assert.equal(corrected.body.includes(oldAdvice), false);
	const exported = await living.exportApprovedWiki(caller);
	assert.equal(exported.articles, 124);
	assert.equal(exported.sections, 21);
	assert.equal(exported.systemTemplates, 7);
	assert.equal(exported.discoveryArticles, 6);

	const rollbackKey = randomUUID();
	const rollback = await old.installApprovedWiki(
		caller,
		command(bootstrapSource, "BOOTSTRAP", "2", "rollback", rollbackKey),
	);
	assert.equal(rollback.activationNumber, "3");
	assert.equal(rollback.activeRelease, "BOOTSTRAP");
	assert.equal(rollback.insertedArticles, 0);
	assert.ok((await activeArticle(db, slug)).body.includes(oldAdvice));
	const replay = await old.installApprovedWiki(
		caller,
		command(bootstrapSource, "BOOTSTRAP", "2", "rollback", rollbackKey),
	);
	assert.deepEqual(replay, { ...rollback, replayed: true });
	const history = await db.execute(sql`
		SELECT a.activation_number::text AS n, r.release_key FROM reference_activation a
		JOIN reference_release r ON r.id = a.release_id ORDER BY a.activation_number`);
	assert.deepEqual(
		history.rows.map((row) => [row.n, row.release_key]),
		[
			["1", "BOOTSTRAP"],
			["2", "LIVING"],
			["3", "BOOTSTRAP"],
		],
	);
});
