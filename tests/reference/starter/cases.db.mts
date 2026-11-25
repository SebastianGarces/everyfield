import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import test, { after } from "node:test";
import { sql } from "../../../packages/db/src/query.ts";
import { localEmbedding } from "../../../packages/reference/src/starter/verify/embed.ts";
import { approvedWiki, type WikiSource } from "../../../packages/reference/src/starter/manifest/approved.ts";
import { referenceService } from "../../../packages/reference/src/starter/verify/service.ts";
import { loadApprovedSnapshot, WikiRefusal } from "../../../packages/reference/src/starter/verify/snapshot.ts";
import { NOTHING, recorded, touched, untouched } from "../../support/recorded.mts";
import { testDatabase, type TestDatabase } from "../../support/test-database.mts";

const GLOBAL = "00000000-0000-0000-0000-000000000000";
const json = (path: string) => JSON.parse(readFileSync(new URL(`../../../${path}`, import.meta.url), "utf8"));
const { cases } = json("docs/acceptance/knowledge.json");
const knowledgeCase = (id: string) => cases.find((row: { id: string }) => row.id === id);
const PAYLOAD = "docs/reference/bootstrap/global-seed-payload.json";
type Starter = {
	articles: {
		id: string;
		slug: string;
		content: string;
		section_id: string;
		phase: number;
		sort_order: number;
		related_article_slugs: string[] | null;
	}[];
	sections: { id: string }[];
	templates: { name: string }[];
};
const payload: Starter = json(PAYLOAD);
const bootstrap: WikiSource = {
	version: "wiki-starter-2026-10-03",
	manifestPath: "docs/reference/bootstrap/manifest.json",
	payloadPath: PAYLOAD,
	manifestSha256: "b60b368d7c0ae901c26e429bcda314502e7e836bf97ad57525d9c8816724e68b",
	payloadSha256: "7933b93d693b73b3d8768aa2f7e2ad91fa665b6ec23127cb8b4856466d936f59",
	articles: 96,
	sections: 21,
	systemTemplates: 7,
};
const stores: TestDatabase<never>[] = [];
after(async () => {
	for (const store of stores) await store.close();
});
async function store() {
	const database = await testDatabase({ prefix: "wikicases", roles: {}, clock: new Date("2026-10-13T16:00:00Z") });
	stores.push(database);
	const db = database.admin;
	const caller = { actorId: randomUUID(), userId: randomUUID(), sessionId: randomUUID() };
	await db.execute(
		sql`INSERT INTO auth_user(id,email,email_verified,name) VALUES(${caller.userId},'publisher@example.test',true,'Publisher')`,
	);
	await db.execute(
		sql`INSERT INTO account(id,auth_user_id,registration_state,registration_kind) VALUES(${caller.actorId},${caller.userId},'active','discovery')`,
	);
	await db.execute(
		sql`INSERT INTO auth_session(id,user_id,token,expires_at) VALUES(${caller.sessionId},${caller.userId},${randomUUID()},clock_timestamp()+interval '1 hour')`,
	);
	await db.execute(
		sql`INSERT INTO platform_grant(account_id,capability) VALUES(${caller.actorId},'reference_publish')`,
	);
	const rows = async <T extends Record<string, unknown>>(query: ReturnType<typeof sql>) =>
		(await db.execute<T>(query)).rows;
	const command = (release: string, expectedActivation: string, requestKey: string = randomUUID()) => ({
		release,
		manifestSha256: bootstrap.manifestSha256,
		payloadSha256: bootstrap.payloadSha256,
		requestKey,
		expectedActivation,
		target: approvedWiki.target,
	});
	return { db, caller, rows, command };
}
const refusal = (code: string) => (error: unknown) => error instanceof WikiRefusal && error.code === code;
const byId = (a: { id: string }, b: { id: string }) => a.id.localeCompare(b.id);
const sha = (text: string) => createHash("sha256").update(text).digest("hex");

test("AC:CONTENT50-001 the starter activates exactly its 96 articles, 21 sections and 7 mail templates, with no church's row", async () => {
	const { action, expected } = knowledgeCase("CONTENT50-001");
	const { result } = expected;
	const { db, caller, rows, command } = await store();
	const service = referenceService(db, { source: bootstrap });
	const { expected_activation, request_key } = action.arguments;
	const first = await recorded(db, () =>
		touched(db, () =>
			service.installApprovedWiki(caller, {
				...command("R1", String(expected_activation), request_key),
				kind: "install",
			}),
		),
	);
	assert.deepEqual(first.added, { ...NOTHING, audits: ["reference.activated"] });
	assert.deepEqual(first.value.tables, [
		"article_revision",
		"audit_event",
		"record",
		"reference_activation",
		"reference_item",
		"reference_release",
		"reference_version",
	]);
	const articles = await rows<{ id: string }>(
		sql`SELECT i.id,r.slug,r.section_id,encode(sha256(convert_to(r.body,'UTF8')),'hex') AS hash,r.phase,r.position,r.related_slugs AS related
			FROM reference_item i JOIN article_revision r ON r.article_id=i.id WHERE i.kind='article'`,
	);
	assert.equal(articles.length, result.article_count);
	assert.deepEqual(
		articles.toSorted(byId),
		payload.articles
			.map((a) => ({
				id: a.id,
				slug: a.slug,
				section_id: a.section_id,
				hash: sha(a.content),
				phase: a.phase,
				position: a.sort_order,
				related: a.related_article_slugs ?? [],
			}))
			.toSorted(byId),
	);
	const kind = (name: string) =>
		rows<{ id: string; canonical_key: string }>(sql`SELECT id,canonical_key FROM reference_item WHERE kind=${name}`);
	const sections = await kind("section");
	assert.equal(sections.length, result.section_count);
	assert.deepEqual(sections.map((s) => s.id).toSorted(), payload.sections.map((s) => s.id).toSorted());
	const templates = await kind("mail_template");
	assert.equal(templates.length, result.mail_template_count);
	assert.deepEqual(templates.map((t) => t.canonical_key).toSorted(), payload.templates.map((t) => t.name).toSorted());
	assert.equal((await kind("document_template")).length, 0);
	const exported = await untouched(db, () => service.exportApprovedWiki(caller));
	assert.equal(exported.documentTemplatesSeparate, result.base_document_template_count);
	const [owned] = await rows<{
		n: number;
	}>(sql`SELECT (SELECT count(*) FROM reference_item WHERE tenant_id<>${GLOBAL})::int
		+(SELECT count(*) FROM article_revision WHERE tenant_id<>${GLOBAL})::int+(SELECT count(*) FROM plant)::int
		+(SELECT count(*) FROM organization)::int+(SELECT count(*) FROM person)::int AS n`);
	assert.equal(owned?.n, result.customer_rows);
});

test("AC:CASE-WIKI-010 a candidate without a vector or with a changed article leaves R1 whole, a coherent R2 activates, and a rollback is activation 3", async () => {
	const { action, expected } = knowledgeCase("CASE-WIKI-010");
	const { active_release, candidate, article_count, section_count, template_count } = action.arguments;
	const { db, caller, rows, command } = await store();
	let dropped = action.arguments.candidate_missing_vector;
	let embedded = 0;
	const service = referenceService(db, {
		source: bootstrap,
		embed: (text: string) => (dropped && ++embedded === 2 ? [] : localEmbedding(text)),
	});
	const installed = await service.installApprovedWiki(caller, { ...command(active_release, "0"), kind: "install" });
	const exported = () => untouched(db, () => service.exportApprovedWiki(caller));
	const initial = await exported();
	assert.deepEqual(
		[initial.articles, initial.sections, initial.systemTemplates, initial.activationNumber],
		[article_count, section_count, template_count, "1"],
	);
	const stays = async () => {
		const now = await exported();
		assert.deepEqual(now, initial);
		assert.deepEqual(
			[now.activeRelease, now.partialActivation, now.orgAdoptionRequired],
			[expected.result.active_release, expected.result.partial_activation, expected.result.org_adoption_required],
		);
		const [held] = await rows(
			sql`SELECT count(*)::int AS n,(SELECT count(*)::int FROM passage) AS passages FROM reference_release`,
		);
		assert.deepEqual(held, { n: 1, passages: 0 });
	};
	const missing = await untouched(db, () => service.rebuildEmbeddings(caller, command(candidate, "1")));
	assert.deepEqual([missing.activated, missing.reason, embedded >= 2], [false, "incomplete_candidate", true]);
	await stays();
	await untouched(db, () =>
		assert.rejects(
			service.installApprovedWiki(caller, {
				...command(candidate, "1"),
				kind: "install",
				fault: action.arguments.fault,
			}),
			refusal("incomplete_candidate"),
		),
	);
	const changed = structuredClone(await loadApprovedSnapshot(undefined, bootstrap));
	changed.articles[0]!.content += "\nchanged";
	changed.articles[0]!.contentSha256 = sha(changed.articles[0]!.content);
	const mutated = referenceService(db, { source: bootstrap, loadSnapshot: async () => changed });
	await untouched(db, () =>
		assert.rejects(
			mutated.installApprovedWiki(caller, { ...command(active_release, "1"), kind: "install" }),
			refusal("immutable_conflict"),
		),
	);
	await stays();

	dropped = false;
	const rebuilt = await recorded(db, () => service.rebuildEmbeddings(caller, command(candidate, "1")));
	assert.deepEqual(rebuilt.added, { ...NOTHING, audits: ["reference.activated"] });
	assert.deepEqual(
		[rebuilt.value.activated, rebuilt.value.activeRelease, rebuilt.value.activationNumber],
		[true, candidate, "2"],
	);
	const back = await recorded(db, () =>
		service.installApprovedWiki(caller, { ...command(active_release, "2"), kind: "rollback" }),
	);
	assert.deepEqual(back.added, { ...NOTHING, audits: ["reference.activated"] });
	assert.equal(Number(back.value.activationNumber), expected.result.rollback_new_activation_sequence);
	assert.deepEqual([back.value.activeRelease, back.value.insertedArticles], [active_release, 0]);
	assert.deepEqual(await exported(), {
		...initial,
		activationNumber: "3",
	});
	assert.equal(installed.activationNumber, "1");
	assert.equal((await rows<{ n: number }>(sql`SELECT count(*)::int AS n FROM article_editor_state`))[0]?.n, 0);
});
