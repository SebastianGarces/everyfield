import { testDatabase } from "../../support/test-database.mts";
import { sql, type SQL } from "../../../packages/db/src/query.ts";
import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { hash } from "../../../packages/reference/src/hash.ts";
import { localEmbedding } from "../../../packages/reference/src/starter/verify/embed.ts";
import { approvedWiki } from "../../../packages/reference/src/starter/manifest/approved.ts";
import { referenceService } from "../../../packages/reference/src/starter/verify/service.ts";
import { WikiRefusal } from "../../../packages/reference/src/starter/verify/snapshot.ts";

type Case = { id: string; expected: { result: Record<string, unknown>; event: null } };
const { cases } = JSON.parse(
	readFileSync(new URL("../../../docs/acceptance/schema.json", import.meta.url), "utf8"),
) as { cases: Case[] };
const c = cases.find((x) => x.id === "SCHEMA-014") ?? assert.fail("no SCHEMA-014");

const GLOBAL = "00000000-0000-0000-0000-000000000000";
const CANARY = "FORMER-SOURCE-CANARY-SCHEMA-014";
const database = await testDatabase({ prefix: "schema014", roles: {}, max: 6 });
const { admin: db } = database;
const actor = randomUUID(),
	user = randomUUID(),
	session = randomUUID();
const organization = randomUUID(),
	orgSection = randomUUID(),
	orgArticle = randomUUID(),
	orgRevision = randomUUID();
const publisher = { actorId: actor, userId: user, sessionId: session };
let dropVector = false;
const service = referenceService(db, { embed: (text: string) => (dropVector ? [] : localEmbedding(text)) });
const rows = async (q: SQL) => (await db.execute(q)).rows;
const one = async (q: SQL) => (await rows(q))[0] ?? assert.fail("no row");
const refusal = (code: string) => (error: unknown) => {
	assert.ok(error instanceof WikiRefusal, String(error));
	assert.equal(error.code, code, error.detail);
	return true;
};
const rebuild = (release: string, expectedActivation: string, requestKey = randomUUID()) =>
	service.rebuildEmbeddings(publisher, {
		release,
		manifestSha256: approvedWiki.manifestSha256,
		payloadSha256: approvedWiki.payloadSha256,
		requestKey,
		expectedActivation,
		target: approvedWiki.target,
	});
const install = (
	release: string,
	expectedActivation: string,
	kind: "install" | "rollback" = "install",
	fault?: "required_write_before_commit",
) =>
	service.installApprovedWiki(publisher, {
		release,
		manifestSha256: approvedWiki.manifestSha256,
		payloadSha256: approvedWiki.payloadSha256,
		requestKey: randomUUID(),
		expectedActivation,
		target: approvedWiki.target,
		kind,
		...(fault ? { fault } : {}),
	});
const active = async () => {
	const e = await service.exportApprovedWiki(publisher);
	return [e.activeRelease, e.activationNumber, e.partialActivation];
};
const history = async () =>
	(
		await rows(sql`SELECT a.activation_number::int AS n, r.release_key AS release FROM reference_activation a
			JOIN reference_release r ON r.id=a.release_id ORDER BY a.activation_number`)
	).map((r) => [r.n, r.release]);
const rejectsWith = (q: SQL, pattern: RegExp) =>
	assert.rejects(db.execute(q), (e: Error) => {
		assert.match(String((e.cause as Error | undefined)?.message ?? e.message), pattern);
		return true;
	});

before(async () => {
	await db.execute(
		sql`INSERT INTO auth_user(id,email,email_verified,name) VALUES(${user},${user + "@example.test"},true,'Publisher')`,
	);
	await db.execute(
		sql`INSERT INTO account(id,auth_user_id,registration_state,registration_kind) VALUES(${actor},${user},'active','discovery')`,
	);
	await db.execute(
		sql`INSERT INTO auth_session(id,user_id,token,expires_at) VALUES(${session},${user},${randomUUID()},now()+interval '1 hour')`,
	);
	await db.execute(sql`INSERT INTO platform_grant(account_id,capability) VALUES(${actor},'reference_publish')`);
	await db.execute(sql`INSERT INTO organization(id,kind,name,timezone,material_revision)
		VALUES(${organization},'sending_church','Former source','America/Chicago',1)`);
	await db.execute(sql`INSERT INTO reference_item(id,kind,canonical_key,tenant_id) VALUES
		(${orgSection},'section','former-source-section',${organization}),(${orgArticle},'article','former/source',${organization})`);
	await db.execute(sql`INSERT INTO article_revision(id,article_id,tenant_id,release_id,revision_number,title,slug,excerpt,body,
		content_type,phase,position,content_hash,meaningful,meaningful_sequence,section_id) VALUES(${orgRevision},${orgArticle},
		${organization},NULL,1,'Former source','former/source','',${CANARY},'safe_nodes',1,0,${hash(CANARY)},true,1,${orgSection})`);
});
after(database.close);

test("AC:SCHEMA-014 an incomplete candidate never activates, concurrent activations have one winner, a rollback appends activation 3 and keeps 1 and 2, and a former organization source body reaches no global release", async () => {
	const result: Record<string, unknown> = {};
	assert.equal((await install("R1", "0")).activationNumber, "1");
	assert.deepEqual(await active(), ["R1", "1", false]);

	dropVector = true;
	const missing = await rebuild("R2", "1");
	dropVector = false;
	await assert.rejects(install("R1", "1", "install", "required_write_before_commit"), refusal("incomplete_candidate"));
	assert.deepEqual([missing.activated, missing.reason], [false, "incomplete_candidate"]);
	result.incomplete_candidate_activated = missing.activated;
	result.active_generation_after_failure = (await active())[0];
	assert.deepEqual(await history(), [[1, "R1"]]);
	assert.deepEqual(await rows(sql`SELECT release_key FROM reference_release ORDER BY release_key`), [
		{ release_key: "R1" },
	]);

	const r1 = await one(sql`SELECT id FROM reference_release WHERE release_key='R1'`);
	const building = randomUUID();
	await db.execute(sql`INSERT INTO record(id,kind,tenant_id) VALUES(${building},'reference_release',${GLOBAL})`);
	await db.execute(sql`INSERT INTO reference_release(id,release_key,artifact_locator,manifest_hash,state,chunker_version,
		embedding_profile,embedding_dimensions,tenant_id,expected_passages) VALUES(${building},'C2','memory://c2','h','building',
		'1','local',8,${GLOBAL},1)`);
	const activate = (release: string, n: number) =>
		sql`INSERT INTO reference_activation(release_id,activation_number,activated_at,actor_id,reason,expected_prior_number)
			VALUES(${release},${n},clock_timestamp(),${actor},'test',${n - 1})`;
	await rejectsWith(activate(building, 2), /incomplete_reference_release/);
	await db.execute(sql`UPDATE reference_release SET state='validated',complete_at=clock_timestamp(),validated_at=clock_timestamp(),
		approval_hash='h',approval_locator='memory://approval' WHERE id=${building}`);
	await rejectsWith(activate(building, 2), /incomplete_reference_passages/);
	await rejectsWith(activate(String(r1.id), 1), /reference_activation_uq_0|duplicate key/);

	const raced = await Promise.allSettled([rebuild("R2", "1"), rebuild("R2", "1")]);
	const won = raced.flatMap((r) => (r.status === "fulfilled" && r.value.activated ? [r.value] : []));
	assert.equal(won.length, 1, JSON.stringify(raced));
	assert.deepEqual([won[0]!.activeRelease, won[0]!.activationNumber], ["R2", "2"]);
	assert.deepEqual(await history(), [
		[1, "R1"],
		[2, "R2"],
	]);

	const rollback = await install("R1", "2", "rollback");
	result.rollback_activation = Number(rollback.activationNumber);
	assert.deepEqual(await active(), ["R1", "3", false]);
	const kept = await history();
	assert.deepEqual(kept, [
		[1, "R1"],
		[2, "R2"],
		[3, "R1"],
	]);
	result.activation_history_retained = kept.filter(([, r], i) => i < 2 && r !== null).map(([n]) => n);
	await rejectsWith(sql`UPDATE reference_activation SET reason='rewritten' WHERE activation_number=1`, /immutable/);
	await assert.rejects(install("R2", "2", "rollback"), refusal("revision_conflict"));

	await rejectsWith(
		sql`INSERT INTO passage(release_id,revision_id,tenant_id,ordinal,content,content_hash,embedding,embedding_checksum)
			SELECT release_id,${orgRevision}::uuid,${GLOBAL}::uuid,999,${CANARY},content_hash,embedding,embedding_checksum FROM passage LIMIT 1`,
		/passage_fk_1|violates foreign key/,
	);
	await rejectsWith(sql`UPDATE article_revision SET body='Forged' WHERE id=${orgRevision}`, /immutable/);
	const exported = JSON.stringify(await service.exportApprovedWiki(publisher));
	const leaked = await one(sql`SELECT
		(SELECT count(*)::int FROM article_revision WHERE tenant_id=${GLOBAL} AND (body LIKE ${"%" + CANARY + "%"} OR slug='former/source')) AS revisions,
		(SELECT count(*)::int FROM passage WHERE content LIKE ${"%" + CANARY + "%"} OR revision_id=${orgRevision}) AS passages,
		(SELECT count(*)::int FROM reference_release WHERE source_revision_id=${orgRevision} OR artifact_locator LIKE ${"%" + CANARY + "%"}) AS releases,
		(SELECT count(*)::int FROM audit_event WHERE metadata::text LIKE ${"%" + CANARY + "%"}) AS events,
		(SELECT count(*)::int FROM file_object WHERE tenant_id=${GLOBAL}) AS files`);
	assert.deepEqual(leaked, { revisions: 0, passages: 0, releases: 0, events: 0, files: 0 });
	result.former_source_body = exported.includes(CANARY) || leaked.passages !== 0 ? CANARY : null;
	assert.deepEqual(result, c.expected.result);
	assert.equal(c.expected.event, null);
});
