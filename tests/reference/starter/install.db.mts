import { createDatabase, closeDatabase } from "../../../packages/db/src/client.ts";
import { sql } from "../../../packages/db/src/query.ts";
import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { migrate } from "../../../packages/db/src/schema/migrate.ts";
import { hash, vectorHash } from "../../../packages/reference/src/hash.ts";
import { localEmbedding } from "../../../packages/reference/src/starter/verify/embed.ts";
import { approvedWiki } from "../../../packages/reference/src/starter/manifest/approved.ts";
import { referenceService } from "../../../packages/reference/src/starter/verify/service.ts";
import { loadApprovedSnapshot, WikiRefusal } from "../../../packages/reference/src/starter/verify/snapshot.ts";

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
const schema = "wp033_test_" + randomUUID().replaceAll("-", "");
const db = createDatabase({
	connectionString: source.href,
	max: 4,
	options: `-c search_path=${schema},pg_catalog,pg_temp`,
});
const actor = randomUUID();
const user = randomUUID();
const session = randomUUID();
const foreignActor = randomUUID();
const foreignUser = randomUUID();
const foreignSession = randomUUID();
const plant = randomUUID();
const organization = randomUUID();
const orgSection = randomUUID();
const orgArticle = randomUUID();
const orgRevision = randomUUID();
const global = "00000000-0000-0000-0000-000000000000";
const publisher = { actorId: actor, userId: user, sessionId: session };
const foreign = { actorId: foreignActor, userId: foreignUser, sessionId: foreignSession };
let dropVector = false;
let failProvider = false;
const service = referenceService(db, {
	embed(text: string) {
		if (failProvider) throw Error("provider_timeout");
		return dropVector ? [] : localEmbedding(text);
	},
});

function command(
	release: string,
	expected: string,
	kind: "install" | "rollback" = "install",
	requestKey = randomUUID(),
	fault?: "required_source_unavailable" | "required_write_before_commit",
) {
	return {
		release,
		manifestSha256: approvedWiki.manifestSha256,
		payloadSha256: approvedWiki.payloadSha256,
		requestKey,
		expectedActivation: expected,
		target: approvedWiki.target,
		kind,
		...(fault ? { fault } : {}),
	};
}
function refusal(code: string) {
	return (error: unknown) => {
		assert.ok(error instanceof WikiRefusal, error instanceof Error ? `${error.name}: ${error.message}` : String(error));
		assert.equal(error.code, code, error.detail);
		return true;
	};
}
async function counts() {
	const selected = await db.execute(sql`SELECT
    (SELECT count(*)::int FROM reference_release) AS releases,
    (SELECT count(*)::int FROM reference_activation) AS activations,
    (SELECT count(*)::int FROM reference_item WHERE kind = 'article' AND tenant_id = ${global}::uuid) AS articles,
    (SELECT count(*)::int FROM reference_item WHERE kind = 'section' AND tenant_id = ${global}::uuid) AS sections,
    (SELECT count(*)::int FROM reference_item WHERE kind = 'mail_template' AND tenant_id = ${global}::uuid) AS templates,
    (SELECT count(*)::int FROM reference_item WHERE kind = 'document_template') AS documents,
    (SELECT count(*)::int FROM passage) AS passages,
    (SELECT count(*)::int FROM audit_event) AS events,
    (SELECT count(*)::int FROM mail) AS mail,
    (SELECT count(*)::int FROM article_revision WHERE tenant_id = ${global}::uuid AND body = 'Organization edition.') AS leaked`);
	return selected.rows[0];
}

before(async () => {
	await db.execute(sql.raw(`CREATE SCHEMA ${schema}`));
	await migrate(db, schema);
	await db.execute(
		sql`INSERT INTO auth_user(id, email, email_verified, name) VALUES
      (${user}::uuid, ${user + "@example.test"}, true, 'Publisher'),
      (${foreignUser}::uuid, ${foreignUser + "@example.test"}, true, 'Foreign')`,
	);
	await db.execute(
		sql`INSERT INTO account(id, auth_user_id, registration_state, registration_kind) VALUES
      (${actor}::uuid, ${user}::uuid, 'active', 'discovery'),
      (${foreignActor}::uuid, ${foreignUser}::uuid, 'active', 'discovery')`,
	);
	await db.execute(
		sql`INSERT INTO auth_session(id, user_id, token, expires_at) VALUES
      (${session}::uuid, ${user}::uuid, ${randomUUID()}, now() + interval '1 hour'),
      (${foreignSession}::uuid, ${foreignUser}::uuid, ${randomUUID()}, now() + interval '1 hour')`,
	);
	await db.execute(
		sql`INSERT INTO platform_grant(account_id, capability) VALUES (${actor}::uuid, 'reference_publish')`,
	);
	await db.execute(sql`INSERT INTO plant(id, name, timezone, warning_days, alert_days, digest_weekday, digest_hour, phase, material_revision)
    VALUES (${plant}::uuid, 'Synthetic existing plant', 'America/Chicago', 7, 14, 1, 8, 1, 1)`);
	await db.execute(
		sql`INSERT INTO organization(id, kind, name, timezone, material_revision) VALUES (${organization}::uuid, 'sending_church', 'Synthetic organization', 'America/Chicago', 1)`,
	);
	await db.execute(
		sql`INSERT INTO reference_item(id, kind, canonical_key, tenant_id) VALUES
      (${orgSection}::uuid, 'section', 'org-only-section', ${organization}::uuid),
      (${orgArticle}::uuid, 'article', 'org/edition', ${organization}::uuid)`,
	);
	await db.execute(
		sql`INSERT INTO article_revision(
      id, article_id, tenant_id, release_id, revision_number, title, slug, excerpt, body, content_type,
      phase, position, content_hash, meaningful, meaningful_sequence, section_id
    ) VALUES (
      ${orgRevision}::uuid, ${orgArticle}::uuid, ${organization}::uuid, NULL, 1, 'Organization edition', 'org/edition', '',
      'Organization edition.', 'safe_nodes', 1, 0, ${hash("Organization edition.")}, true, 1, ${orgSection}::uuid
    )`,
	);
});
after(async () => {
	await db.execute(sql.raw(`DROP SCHEMA IF EXISTS ${schema} CASCADE`));
	await closeDatabase(db);
});

test("AC:REF-CASE-002 AC:GAP-REF-002 AC:CASE-WIKI-010 AC:SCHEMA-014 approved wiki snapshot installs, replays, refuses a changed digest, and rolls back without vectors or an organization edition", async () => {
	const empty = await counts();
	assert.equal(empty?.articles, 0);
	assert.equal(empty?.mail, 0);
	await assert.rejects(service.installApprovedWiki(foreign, command("R1", "0")), refusal("access_denied"));
	await assert.rejects(
		service.installApprovedWiki(publisher, command("R1", "0", "install", randomUUID(), "required_source_unavailable")),
		refusal("source_unavailable"),
	);
	assert.deepEqual(await counts(), empty);

	const firstKey = randomUUID();
	const first = await service.installApprovedWiki(publisher, command("R1", "0", "install", firstKey));
	assert.equal(first.activationNumber, "1");
	assert.equal(first.activeRelease, "R1");
	assert.equal(first.insertedArticles, approvedWiki.articles);
	assert.equal(first.replayed, false);
	assert.deepEqual(await counts(), {
		releases: 1,
		activations: 1,
		articles: 96,
		sections: 21,
		templates: 7,
		documents: 0,
		passages: 0,
		events: 1,
		mail: 0,
		leaked: 0,
	});
	const discovery = await db.execute(
		sql`SELECT count(*)::int AS n FROM reference_item WHERE kind = 'article' AND tenant_id = ${global}::uuid AND id IN (
      SELECT value::uuid FROM jsonb_array_elements_text(${JSON.stringify((await loadApprovedSnapshot()).discoveryIds)}::jsonb)
    )`,
	);
	assert.equal(discovery.rows[0]?.n, approvedWiki.discoveryArticles);
	assert.deepEqual(await service.installApprovedWiki(publisher, command("R1", "0", "install", firstKey)), {
		...first,
		replayed: true,
	});
	assert.equal((await counts())?.events, 1);

	const replay = await service.installApprovedWiki(publisher, command("R1", "1"));
	assert.equal(replay.replayed, false);
	assert.equal(replay.insertedArticles, 0);
	assert.equal(replay.activationNumber, "1");
	assert.equal((await counts())?.activations, 1);
	assert.equal((await counts())?.articles, 96);

	await assert.rejects(
		service.installApprovedWiki(publisher, { ...command("R1", "1"), payloadSha256: "0".repeat(64) }),
		refusal("digest_conflict"),
	);
	const real = await loadApprovedSnapshot();
	const changed = structuredClone(real);
	const target = changed.articles[0];
	assert.ok(target);
	target.content += "\nchanged";
	target.contentSha256 = hash(target.content);
	const mutated = referenceService(db, { loadSnapshot: async () => changed });
	await assert.rejects(mutated.installApprovedWiki(publisher, command("R1", "1")), refusal("immutable_conflict"));
	assert.equal((await counts())?.articles, 96);
	assert.equal((await counts())?.activations, 1);

	const exported = await service.exportApprovedWiki(publisher);
	assert.equal(exported.activeRelease, "R1");
	assert.equal(exported.activationNumber, "1");
	assert.equal(exported.partialActivation, false);
	assert.equal(exported.orgAdoptionRequired, false);
	assert.equal(exported.articles, 96);
	assert.equal(exported.sections, 21);
	assert.equal(exported.systemTemplates, 7);
	assert.equal(exported.passages, 0);
	assert.equal(exported.discoveryArticles, 6);
	assert.equal(exported.documentTemplatesSeparate, 11);

	const rebuilt = await service.rebuildEmbeddings(publisher, {
		release: "R2",
		manifestSha256: approvedWiki.manifestSha256,
		payloadSha256: approvedWiki.payloadSha256,
		requestKey: randomUUID(),
		expectedActivation: "1",
		target: approvedWiki.target,
	});
	assert.equal(rebuilt.activated, true);
	assert.equal(rebuilt.activeRelease, "R2");
	assert.equal(rebuilt.activationNumber, "2");
	assert.equal(rebuilt.reason, null);
	assert.equal(rebuilt.usageTokens, 0);
	assert.ok((rebuilt.passages ?? 0) > 0);
	const vectors = await db.execute(
		sql`SELECT p.content, p.embedding_checksum, r.embedding_profile, r.embedding_dimensions, r.expected_passages
      FROM passage p JOIN reference_release r ON r.id = p.release_id WHERE r.release_key = 'R2'`,
	);
	assert.equal(vectors.rows.length, rebuilt.passages);
	for (const row of vectors.rows) {
		const passage = zRow(row);
		assert.equal(passage.embedding_profile, approvedWiki.embeddingProfile);
		assert.equal(passage.embedding_dimensions, approvedWiki.embeddingDimensions);
		assert.equal(passage.embedding_checksum, vectorHash(localEmbedding(passage.content)));
		assert.equal(passage.expected_passages, vectors.rows.length);
	}
	assert.equal((await counts())?.articles, 96);
	const r1Passages = await db.execute(
		sql`SELECT count(*)::int AS n FROM passage p JOIN reference_release r ON r.id = p.release_id WHERE r.release_key = 'R1'`,
	);
	assert.equal(r1Passages.rows[0]?.n, 0);

	dropVector = true;
	const missing = await service.rebuildEmbeddings(publisher, {
		release: "R3",
		manifestSha256: approvedWiki.manifestSha256,
		payloadSha256: approvedWiki.payloadSha256,
		requestKey: randomUUID(),
		expectedActivation: "2",
		target: approvedWiki.target,
	});
	dropVector = false;
	assert.deepEqual(missing, {
		activated: false,
		activeRelease: null,
		activationNumber: null,
		passages: 0,
		reason: "incomplete_candidate",
		usageTokens: 0,
	});
	failProvider = true;
	const timedOut = await service.rebuildEmbeddings(publisher, {
		release: "R4",
		manifestSha256: approvedWiki.manifestSha256,
		payloadSha256: approvedWiki.payloadSha256,
		requestKey: randomUUID(),
		expectedActivation: "2",
		target: approvedWiki.target,
	});
	failProvider = false;
	assert.equal(timedOut.activated, false);
	assert.equal(timedOut.reason, "provider_timeout");
	assert.equal(timedOut.usageTokens, 0);
	assert.equal((await counts())?.releases, 2);
	assert.equal((await counts())?.activations, 2);

	await assert.rejects(
		service.installApprovedWiki(publisher, command("R1", "2", "install", randomUUID(), "required_write_before_commit")),
		refusal("incomplete_candidate"),
	);
	assert.equal((await counts())?.activations, 2);
	assert.equal((await counts())?.releases, 2);

	const rollback = await service.installApprovedWiki(publisher, command("R1", "2", "rollback"));
	assert.equal(rollback.activationNumber, "3");
	assert.equal(rollback.activeRelease, "R1");
	assert.equal(rollback.insertedArticles, 0);
	const history = await db.execute(
		sql`SELECT a.activation_number::text AS n, r.release_key FROM reference_activation a
      JOIN reference_release r ON r.id = a.release_id ORDER BY a.activation_number`,
	);
	assert.deepEqual(
		history.rows.map((row) => [row.n, row.release_key]),
		[
			["1", "R1"],
			["2", "R2"],
			["3", "R1"],
		],
	);
	const r1AfterRollback = await db.execute(
		sql`SELECT count(*)::int AS n FROM passage p JOIN reference_release r ON r.id = p.release_id WHERE r.release_key = 'R1'`,
	);
	assert.equal(r1AfterRollback.rows[0]?.n, 0);

	const restored = await service.exportApprovedWiki(publisher);
	assert.equal(restored.activeRelease, "R1");
	assert.equal(restored.activationNumber, "3");
	assert.equal(restored.partialActivation, false);
	assert.equal(restored.orgAdoptionRequired, false);
	assert.equal(restored.passages, 0);
	const cached = await service.invalidateWikiCache(publisher, { requestKey: randomUUID() });
	assert.equal(cached.activeRelease, "R1");
	assert.equal(cached.activationNumber, "3");
	assert.equal(cached.cacheGeneration, 1);
	assert.equal((await service.exportApprovedWiki(publisher)).activationNumber, "3");

	const org = await db.execute(
		sql`SELECT body, tenant_id::text AS tenant_id FROM article_revision WHERE slug = 'org/edition'`,
	);
	assert.deepEqual(org.rows, [{ body: "Organization edition.", tenant_id: organization }]);
	assert.equal((await counts())?.leaked, 0);
	assert.equal((await counts())?.mail, 0);
	assert.equal((await counts())?.documents, 0);
});

function zRow(row: Record<string, unknown>): {
	content: string;
	embedding_checksum: string;
	embedding_profile: string;
	embedding_dimensions: number;
	expected_passages: number;
} {
	assert.equal(typeof row.content, "string");
	assert.equal(typeof row.embedding_checksum, "string");
	assert.equal(typeof row.embedding_profile, "string");
	assert.equal(typeof row.embedding_dimensions, "number");
	assert.equal(typeof row.expected_passages, "number");
	return row as {
		content: string;
		embedding_checksum: string;
		embedding_profile: string;
		embedding_dimensions: number;
		expected_passages: number;
	};
}
