import { testDatabase } from "../../support/test-database.mts";
import { sql } from "../../../packages/db/src/query.ts";
import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { approvedWiki } from "../../../packages/reference/src/starter/manifest/approved.ts";
import { referenceService } from "../../../packages/reference/src/starter/verify/service.ts";
import type { WikiEmbedFetch } from "../../../packages/reference/src/starter/verify/openai.ts";

const database = await testDatabase({ prefix: "t339_spend", roles: {}, max: 4 });
const { admin: db } = database;
const publisher = { actorId: randomUUID(), userId: randomUUID(), sessionId: randomUUID() };
const OPENAI = { EVF_WIKI_EMBEDDINGS: "openai", OPENAI_API_KEY: "sk-test-rebuild" };
const TOKENS_PER_TEXT = 7;
const SIGNED_ZERO = 4242;

function provider() {
	const seen = { calls: 0, texts: 0 };
	const fetch: WikiEmbedFetch = async (_url, init) => {
		const { input } = JSON.parse(String(init.body)) as { input: string[] };
		seen.calls += 1;
		seen.texts += input.length;
		const body = JSON.stringify({
			data: input.map((_, index) => ({
				index,
				embedding: Array.from({ length: 1536 }, (_, at) => (at === 0 ? SIGNED_ZERO : (at * 7 + index) / 9973)),
			})),
			usage: { total_tokens: input.length * TOKENS_PER_TEXT },
		});
		return new Response(body.replaceAll(`[${SIGNED_ZERO},`, "[-0.0,"), { status: 200 });
	};
	return { seen, fetch };
}
const command = (release: string, expectedActivation: string) => ({
	release,
	manifestSha256: approvedWiki.manifestSha256,
	payloadSha256: approvedWiki.payloadSha256,
	requestKey: randomUUID(),
	expectedActivation,
	target: approvedWiki.target,
});
const ledger = async () =>
	(await db.execute(sql`SELECT purpose, usage::text AS tokens FROM embedding_spend ORDER BY purpose`)).rows;

before(async () => {
	await db.execute(sql`INSERT INTO auth_user(id, email, email_verified, name)
		VALUES (${publisher.userId}::uuid, ${publisher.userId + "@example.test"}, true, 'Publisher')`);
	await db.execute(sql`INSERT INTO account(id, auth_user_id, registration_state, registration_kind)
		VALUES (${publisher.actorId}::uuid, ${publisher.userId}::uuid, 'active', 'discovery')`);
	await db.execute(sql`INSERT INTO auth_session(id, user_id, token, expires_at)
		VALUES (${publisher.sessionId}::uuid, ${publisher.userId}::uuid, ${randomUUID()}, now() + interval '1 hour')`);
	await db.execute(
		sql`INSERT INTO platform_grant(account_id, capability) VALUES (${publisher.actorId}::uuid, 'reference_publish')`,
	);
	await referenceService(db).installApprovedWiki(publisher, { ...command("R1", "0"), kind: "install" });
});
after(database.close);

test("an OpenAI rebuild whose estimate passes the run cap refuses before any call and names the estimate", async () => {
	const { seen, fetch } = provider();
	const refused = await referenceService(db, { env: OPENAI, fetch, runCapUsd: 0.001 }).rebuildEmbeddings(
		publisher,
		command("R2", "1"),
	);
	assert.equal(refused.activated, false);
	assert.equal(refused.reason, "estimated_cost_over_cap");
	assert.ok(refused.estimatedTokens > 0);
	assert.equal(refused.estimatedUsd, (refused.estimatedTokens * 0.02) / 1_000_000);
	assert.ok(refused.estimatedUsd > 0.001);
	assert.deepEqual([refused.usageTokens, refused.costUsd], [0, 0]);
	assert.equal(seen.calls, 0);
	assert.deepEqual(await ledger(), []);
});

test("an OpenAI rebuild under the $1.00 cap, with vectors holding -0.0 as OpenAI sends them, activates and records the tokens and cost its provider reported", async () => {
	const { seen, fetch } = provider();
	const rebuilt = await referenceService(db, { env: OPENAI, fetch }).rebuildEmbeddings(publisher, command("R2", "1"));
	assert.equal(rebuilt.activated, true);
	assert.equal(rebuilt.reason, null);
	assert.ok(rebuilt.estimatedUsd < 1);
	assert.equal(rebuilt.passages, seen.texts);
	assert.equal(rebuilt.usageTokens, seen.texts * TOKENS_PER_TEXT);
	assert.equal(rebuilt.costUsd, (seen.texts * TOKENS_PER_TEXT * 0.02) / 1_000_000);
	assert.deepEqual(await ledger(), [{ purpose: "rebuild", tokens: String(seen.texts * TOKENS_PER_TEXT) }]);
	const stored = await db.execute(sql`SELECT r.embedding_profile, r.embedding_dimensions, count(p.id)::int AS passages
		FROM reference_release r JOIN passage p ON p.release_id = r.id WHERE r.release_key = 'R2'
		GROUP BY r.embedding_profile, r.embedding_dimensions`);
	assert.deepEqual(stored.rows, [
		{ embedding_profile: "openai-text-embedding-3-small", embedding_dimensions: 1536, passages: seen.texts },
	]);
});
