import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { inspect, isDeepStrictEqual } from "node:util";
import foundations from "../../../docs/reference/discovery-foundations.json" with { type: "json" };
import test, { after } from "node:test";
import { sql } from "../../../packages/db/src/query.ts";
import { localEmbedding } from "../../../packages/reference/src/starter/verify/embed.ts";
import { approvedWiki, type WikiSource } from "../../../packages/reference/src/starter/manifest/approved.ts";
import { referenceService } from "../../../packages/reference/src/starter/verify/service.ts";
import { loadApprovedSnapshot, WikiRefusal } from "../../../packages/reference/src/starter/verify/snapshot.ts";
import { chunkEntries } from "../../../packages/reference/src/bundle.ts";
import { wikiEntries } from "../../../packages/reference/src/starter/verify/generation.ts";
import type { WikiEmbedFetch } from "../../../packages/reference/src/starter/verify/openai.ts";
import { wikiQueryEmbedder } from "../../../packages/reference/src/starter/verify/query.ts";
import { RequestActor } from "../../../packages/domain/src/access/session.ts";
import { search } from "../../../packages/domain/src/wiki/reads.ts";
import { ok, seeds } from "../../support/fixture.mts";
import { NOTHING, recorded, touched, untouched } from "../../support/recorded.mts";
import { testDatabase, type TestDatabase } from "../../support/test-database.mts";

const GLOBAL = "00000000-0000-0000-0000-000000000000";
const json = (path: string) => JSON.parse(readFileSync(new URL(`../../../${path}`, import.meta.url), "utf8"));
const { cases } = json("docs/acceptance/knowledge.json");
const reference = json("docs/acceptance/reference-release.json").cases;
const referenceCase = (id: string) => reference.find((row: { id: string }) => row.id === id);
const subcase = (id: string, name: string) =>
	referenceCase(id).subcases.find((row: { name: string }) => row.name === name);
const nowhere = new URL("./no-such-checkout/", import.meta.url);
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
	const database = await testDatabase({
		prefix: "wikicases",
		roles: {},
		clock: new Date("2026-10-13T16:00:00Z"),
	});
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
	const command = (
		release: string,
		expectedActivation: string,
		requestKey: string = randomUUID(),
		source: WikiSource = bootstrap,
	) => ({
		release,
		manifestSha256: source.manifestSha256,
		payloadSha256: source.payloadSha256,
		requestKey,
		expectedActivation,
		target: approvedWiki.target,
	});
	const seed = seeds(db);
	const foreigner = async () => {
		const who = await seed.actor(await seed.plant({ name: "Quarry Hill", timezone: "America/New_York" }), "member");
		return { actorId: who.id, userId: who.user, sessionId: who.session };
	};
	return { db, caller, rows, command, seed, foreigner };
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
	const installed = await service.installApprovedWiki(caller, {
		...command(active_release, "0"),
		kind: "install",
	});
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

test("AC:GAP-REF-002 the six foundation articles install once with their exact source hashes beside an organization's edition that is never promoted", async () => {
	const { given, action, expected } = referenceCase("GAP-REF-002");
	const { db, caller, rows, command, seed, foreigner } = await store();
	const service = referenceService(db, { source: bootstrap });
	const six = foundations.articles;
	assert.equal(six.length, given.R1.canonical_ids.length);
	const g1 = six[0]!;
	const edition = {
		id: randomUUID(),
		org: (await seed.organization("sending_church", { name: "S1" })).id,
	};
	await db.execute(sql`INSERT INTO reference_item(id,kind,canonical_key,tenant_id) VALUES
		(${g1.section_id},'section',${g1.section_id},${GLOBAL}),(${g1.id},'article',${g1.id},${GLOBAL})`);
	await db.execute(sql`INSERT INTO article_revision(id,article_id,tenant_id,revision_number,title,slug,excerpt,body,content_type,
		position,content_hash,published_at,meaningful,meaningful_sequence,section_id)
		VALUES(${edition.id},${g1.id},${edition.org},1,${g1.title},${g1.slug},'',${given.edition.body},'safe_nodes',1,
		${sha(given.edition.body)},clock_timestamp(),true,1,${g1.section_id})`);
	await db.execute(sql`INSERT INTO article_editor_state(id,organization_id,article_id,state,current_revision_id,revision)
		VALUES(${randomUUID()},${edition.org},${g1.id},'published',${edition.id},1)`);
	const owned = () =>
		rows(sql`SELECT to_jsonb(r) AS revision,to_jsonb(e) AS state FROM article_revision r
			JOIN article_editor_state e ON e.current_revision_id=r.id WHERE r.tenant_id=${edition.org}`);
	const before = await owned();

	const { release, repeat } = action.arguments;
	for (let n = 0; n < repeat; n++) {
		const { value, added } = await recorded(db, () =>
			touched(db, () =>
				service.installApprovedWiki(caller, {
					...command(release, n === 0 ? "0" : "1"),
					kind: "install",
				}),
			),
		);
		assert.deepEqual(added, { ...NOTHING, audits: ["reference.activated"] });
		assert.equal(value.value.insertedArticles, n === 0 ? bootstrap.articles : 0);
		if (n > 0) assert.deepEqual(value.tables, ["audit_event", "record"]);
	}
	const ids = six.map((a) => a.id);
	const published = await rows<{ id: string; slug: string; hash: string }>(
		sql`SELECT article_id AS id,slug,encode(sha256(convert_to(body,'UTF8')),'hex') AS hash FROM article_revision
			WHERE tenant_id=${GLOBAL} AND article_id=ANY(${sql.param(ids)}::uuid[])`,
	);
	assert.equal(published.length, expected.result.canonical_articles);
	assert.deepEqual(
		published.toSorted(byId),
		six.map((a) => ({ id: a.id, slug: a.slug, hash: a.content_sha256 })).toSorted(byId),
	);
	const [twice] = await rows<{ n: number }>(sql`SELECT
		(SELECT count(*) FROM (SELECT 1 FROM article_revision WHERE tenant_id=${GLOBAL} GROUP BY slug HAVING count(*)>1) s)::int
		+(SELECT count(*) FROM (SELECT 1 FROM reference_item WHERE kind='article' GROUP BY canonical_key HAVING count(*)>1) s)::int AS n`);
	assert.equal(twice?.n, expected.result.duplicate_articles);
	const promoted = await rows(
		sql`SELECT 1 FROM article_revision WHERE tenant_id=${GLOBAL} AND (body=${given.edition.body} OR id=${edition.id})`,
	);
	assert.equal(promoted.length > 0, expected.result.org_edition_promoted);
	assert.deepEqual(await owned(), before);

	const foreign = subcase("GAP-REF-002", "foreign-context-refused").expected.result;
	const stranger = await foreigner();
	const error = await untouched(db, () =>
		service.installApprovedWiki(stranger, { ...command("R2", "1"), kind: "install" }).then(
			() => assert.fail("installed"),
			(thrown: unknown) => thrown,
		),
	);
	assert.ok(refusal(foreign.error_code)(error), inspect(error));
	for (const secret of [given.edition.body, g1.slug, edition.org])
		assert.equal(inspect(error).includes(secret), false, secret);

	const boundary = subcase("GAP-REF-002", "required-boundary-failure");
	await untouched(db, () =>
		assert.rejects(
			service.installApprovedWiki(caller, {
				...command("R2", "1"),
				kind: "install",
				fault: boundary.action.arguments.fault,
			}),
			refusal(boundary.expected.result.error_code),
		),
	);
	const missing = referenceService(db, { source: bootstrap, root: nowhere });
	await untouched(db, () =>
		assert.rejects(
			missing.installApprovedWiki(caller, { ...command("R2", "1"), kind: "install" }),
			refusal(boundary.expected.result.error_code),
		),
	);
	const kept = await untouched(db, () => service.exportApprovedWiki(caller));
	assert.deepEqual([kept.activeRelease, kept.activationNumber, kept.discoveryArticles], [release, "1", 6]);
	const recovered = await service.installApprovedWiki(caller, {
		...command(release, "1"),
		kind: "install",
	});
	assert.deepEqual([recovered.activationNumber, recovered.insertedArticles], ["1", 0]);
});

test("AC:GAP-REF-007 a failed rebuild keeps R1 active, and search falls back to bounded text with no older embedding and nothing foreign", async () => {
	const { given, action, expected } = referenceCase("GAP-REF-007");
	const { db, caller, rows, command, seed, foreigner } = await store();
	const env = { EVF_WIKI_EMBEDDINGS: "openai", OPENAI_API_KEY: "sk-test-cases" };
	const QUESTION = "qqzephyr unmatched wording";
	const old = await loadApprovedSnapshot(undefined, bootstrap);
	const target = chunkEntries(wikiEntries(old, "R0"))[0]!.text;
	const axis = (text: string) => Number.parseInt(sha(text).slice(0, 8), 16) % 1536;
	const calls: string[] = [];
	const provider: WikiEmbedFetch = async (_url, init) => {
		const { input } = JSON.parse(String(init.body)) as { input: string[] };
		calls.push(...input);
		const data = input.map((text, index) => ({
			index,
			embedding: Array.from({ length: 1536 }, (_, at) => (at === axis(text === QUESTION ? target : text) ? 1 : 0)),
		}));
		return new Response(JSON.stringify({ data, usage: { total_tokens: 1 } }), { status: 200 });
	};
	const P = await seed.plant();
	const A = await RequestActor.resolve(db, (await seed.actor(P, "admin")).session);
	assert.ok(A instanceof RequestActor);
	const embedder = wikiQueryEmbedder(env, provider);
	const found = async (query: string, meaning: typeof embedder) => {
		const value = ok(await search(db, A, { query }, meaning));
		assert.notEqual(value.status, "unavailable");
		return value;
	};
	const built = await referenceService(db, {
		source: bootstrap,
		env,
		fetch: provider,
	}).rebuildEmbeddings(caller, command(given.index.release, "0"));
	assert.deepEqual([built.activated, built.activeRelease], [true, "R0"]);
	assert.equal((await found(QUESTION, embedder)).status, "results", "the old index answers while R0 is active");

	const living = (fetch: WikiEmbedFetch) => referenceService(db, { env, fetch });
	const release = action.arguments.release;
	const installed = await living(provider).installApprovedWiki(caller, {
		...command(release, "1", randomUUID(), approvedWiki),
		kind: "install",
	});
	assert.equal(installed.activationNumber, "2");
	const S1 = await seed.organization("sending_church", { name: "S1" });
	const draft = randomUUID();
	await db.execute(
		sql`INSERT INTO reference_item(id,kind,canonical_key,tenant_id) VALUES(${draft},'article','foreign',${S1.id})`,
	);
	await db.execute(sql`INSERT INTO article_revision(id,article_id,tenant_id,revision_number,title,slug,excerpt,body,content_type,
		position,content_hash,meaningful,meaningful_sequence,section_id)
		SELECT gen_random_uuid(),${draft},${S1.id},1,'Foreign draft','foreign','','Zephyrdraft church guidance.','safe_nodes',1,
		${sha("draft")},true,1,section_id FROM article_revision LIMIT 1`);
	const passages = () => rows(sql`SELECT count(*)::int AS n FROM passage`);
	const before = await passages();
	assert.equal(given.index.rebuild_outcome, "failed");
	const { added, value } = await recorded(db, () =>
		touched(db, () =>
			living(async () => {
				throw new DOMException("timed out", "TimeoutError");
			}).rebuildEmbeddings(caller, command(release, "2", randomUUID(), approvedWiki)),
		),
	);
	assert.deepEqual(added, NOTHING);
	assert.deepEqual(value.tables, []);
	assert.deepEqual([value.value.activated, value.value.reason], [false, "openai_timeout"]);
	assert.deepEqual(await passages(), before);
	const active = await untouched(db, () => referenceService(db).exportApprovedWiki(caller));
	assert.deepEqual([active.activeRelease, active.partialActivation], [expected.result.active_release, false]);

	calls.length = 0;
	await untouched(db, async () => {
		const stale = new Set(
			(
				await rows<{ id: string }>(
					sql`SELECT v.id FROM article_revision v JOIN reference_release r ON r.id=v.release_id WHERE r.release_key='R0'`,
				)
			).map((row) => row.id),
		);
		assert.equal(stale.size, 96);
		assert.deepEqual((await found(QUESTION, embedder)).results, expected.result.stale_embedding_results);
		const wide = await found("church", embedder);
		assert.deepEqual(wide, await found("church", null));
		const bounded = wide.results!.length === 20 && wide.nextCursor === "2";
		assert.equal(bounded ? "bounded_text_search" : null, expected.result.fallback);
		assert.deepEqual(
			wide.results!.filter((hit) => stale.has(hit.revisionId)),
			expected.result.stale_embedding_results,
		);
		for (const query of ["zephyrdraft", "Foreign draft"]) {
			const hits = (await found(query, embedder)).results!;
			assert.deepEqual(
				hits.filter((hit) => hit.articleId === draft || hit.sourceKind !== "global"),
				expected.result.foreign_results,
			);
		}
	});
	assert.deepEqual(calls, [], "no provider call for an index of another release");

	const foreign = subcase("GAP-REF-007", "foreign-context-refused").expected.result;
	const stranger = await foreigner();
	const refused = await untouched(db, () =>
		living(provider)
			.rebuildEmbeddings(stranger, command("R2", "2", randomUUID(), approvedWiki))
			.then(
				() => assert.fail("rebuilt"),
				(thrown: unknown) => thrown,
			),
	);
	assert.ok(refusal(foreign.error_code)(refused), inspect(refused));
	assert.equal(calls.length, foreign.provider_effects);

	const boundary = subcase("GAP-REF-007", "required-boundary-failure").expected.result;
	await untouched(db, () =>
		assert.rejects(
			referenceService(db, { env, fetch: provider, root: nowhere }).rebuildEmbeddings(
				caller,
				command("R2", "2", randomUUID(), approvedWiki),
			),
			refusal(boundary.error_code),
		),
	);
	assert.equal(calls.length, boundary.new_provider_effects);
	assert.deepEqual(
		await untouched(db, () => referenceService(db).exportApprovedWiki(caller)),
		active,
		"the earlier release is kept",
	);
	const recovered = await living(provider).rebuildEmbeddings(caller, command("R2", "2", randomUUID(), approvedWiki));
	assert.deepEqual([recovered.activated, recovered.activeRelease, recovered.activationNumber], [true, "R2", "3"]);
});

const schemaCases: {
	id: string;
	given: Record<string, { value?: unknown }>;
	action: { arguments: Record<string, unknown> };
	expected: { result: Record<string, unknown> };
}[] = json("docs/acceptance/schema.json").cases;
const schemaCase = (id: string) => schemaCases.find((row) => row.id === id) ?? assert.fail(`no case ${id}`);
const fileSha = (path: string) => sha(readFileSync(new URL(`../../../${path}`, import.meta.url)).toString("utf8"));

test("AC:REF-CASE-002 the pinned bootstrap installs its 96 articles, 21 sections and 7 templates once; a same-hash replay inserts nothing and a changed digest imports nothing, with no church row and no vector", async () => {
	const { action, expected } = schemaCase("REF-CASE-002");
	const args = action.arguments as {
		counts: { articles: number; sections: number; system_templates: number };
		manifest_sha256: string;
		payload_sha256: string;
		target: string;
		attempts: string[];
	};
	const { result } = expected;
	assert.deepEqual(
		[fileSha(bootstrap.manifestPath), fileSha(bootstrap.payloadPath)],
		[args.manifest_sha256, args.payload_sha256],
	);
	assert.deepEqual(
		[payload.articles.length, payload.sections.length, payload.templates.length],
		[args.counts.articles, args.counts.sections, args.counts.system_templates],
	);
	assert.equal(args.target, approvedWiki.target);
	const living = new Set((await loadApprovedSnapshot()).articles.map((a) => a.id));
	assert.deepEqual(
		payload.articles.filter((a) => !living.has(a.id)),
		[],
		"the living seed keeps every bootstrap id",
	);
	const { db, caller, rows, command } = await store();
	const service = referenceService(db, { source: bootstrap });
	const install = (
		expectedActivation: string,
		from = service,
		pins: Partial<WikiSource> = {},
		requestKey: string = randomUUID(),
	) =>
		from.installApprovedWiki(caller, {
			...command("R1", expectedActivation, requestKey, { ...bootstrap, ...pins }),
			kind: "install",
		});
	const installed = async () =>
		(
			await rows<{
				articles: number;
				sections: number;
				system_templates: number;
				customers: number;
				vectors: number;
				stored: number;
			}>(sql`SELECT
			(SELECT count(*)::int FROM reference_item WHERE kind='article' AND tenant_id=${GLOBAL}) AS articles,
			(SELECT count(*)::int FROM reference_item WHERE kind='section' AND tenant_id=${GLOBAL}) AS sections,
			(SELECT count(*)::int FROM reference_item WHERE kind='mail_template' AND tenant_id=${GLOBAL}) AS system_templates,
			(SELECT count(*) FROM reference_item WHERE tenant_id<>${GLOBAL})::int+(SELECT count(*) FROM article_revision WHERE tenant_id<>${GLOBAL})::int
				+(SELECT count(*) FROM plant)::int+(SELECT count(*) FROM organization)::int+(SELECT count(*) FROM person)::int AS customers,
			(SELECT count(*)::int FROM passage) AS vectors,
			(SELECT count(*) FROM reference_item)::int+(SELECT count(*) FROM article_revision)::int+(SELECT count(*) FROM reference_version)::int
				+(SELECT count(*) FROM reference_release)::int+(SELECT count(*) FROM reference_activation)::int AS stored`)
		)[0]!;
	assert.deepEqual(args.attempts, ["first", "same_hash_replay", "unexpected_differing_hash"]);
	const firstKey = randomUUID();
	const first = await recorded(db, () => install("0", service, {}, firstKey));
	assert.deepEqual(first.added, { ...NOTHING, audits: ["reference.activated"] });
	assert.equal(first.value.insertedArticles, result.articles);
	const once = await installed();
	assert.deepEqual(
		[once.articles, once.sections, once.system_templates],
		[result.articles, result.sections, result.system_templates],
	);
	const hashes = await rows<{ id: string; hash: string }>(
		sql`SELECT i.id,encode(sha256(convert_to(r.body,'UTF8')),'hex') AS hash FROM reference_item i
			JOIN article_revision r ON r.article_id=i.id WHERE i.kind='article' ORDER BY i.id`,
	);
	assert.deepEqual(hashes, payload.articles.map((a) => ({ id: a.id, hash: sha(a.content) })).toSorted(byId));

	const same = await untouched(db, () => install("0", service, {}, firstKey));
	assert.deepEqual([same.insertedArticles, same.replayed], [first.value.insertedArticles, true]);
	const replay = await install("1");
	assert.deepEqual([replay.insertedArticles, replay.activationNumber], [result.replay_inserts, "1"]);
	assert.equal((await installed()).stored - once.stored, result.replay_inserts);

	const changed = structuredClone(await loadApprovedSnapshot(undefined, bootstrap));
	changed.articles[0]!.content += "\nUnexpected edit.";
	changed.articles[0]!.contentSha256 = sha(changed.articles[0]!.content);
	const differing = [
		() => install("1", service, { payloadSha256: sha("unexpected payload") }),
		() => install("1", service, { manifestSha256: sha("unexpected manifest") }),
		() => install("1", referenceService(db, { source: bootstrap, loadSnapshot: async () => changed })),
	];
	for (const attempt of differing)
		await untouched(db, () =>
			assert.rejects(attempt(), (e) => refusal("digest_conflict")(e) || refusal("immutable_conflict")(e)),
		);
	const [edited] = await rows<{ n: number }>(
		sql`SELECT count(*)::int AS n FROM article_revision WHERE body LIKE '%Unexpected edit.%'`,
	);
	assert.equal(edited!.n > 0, result.changed_digest_imported);
	const final = await installed();
	assert.deepEqual(final, once);
	assert.deepEqual([final.customers, final.vectors], [result.customer_rows_imported, result.vectors_imported]);
});

test("AC:REF-CASE-007 a partial rebuild leaves the old chunks active; the complete candidate's chunks are exactly current, with no stale trailing chunk and no old vector; a rollback appends an activation", async () => {
	const { action, expected } = schemaCase("REF-CASE-007");
	const args = action.arguments as {
		old_active_keys: string[];
		candidate_keys: string[];
		candidate_model_dimensions: number;
		missing_model_provenance_old_vectors: boolean;
		partial_build_missing: string;
	};
	const { result } = expected;
	const base = await loadApprovedSnapshot(undefined, bootstrap);
	const related = new Set(base.articles.flatMap((a) => a.relatedSlugs));
	const [a, b] = base.articles.filter((x) => !base.discoveryIds.includes(x.id) && !related.has(x.slug));
	const text = (label: string, length: number) =>
		Array.from({ length }, (_, n) => `${label}${n % 10}`)
			.join("")
			.slice(0, length);
	const edit = <T extends { content: string; contentSha256: string }>(row: T, content: string): T => ({
		...row,
		content,
		contentSha256: sha(content),
	});
	const c = { ...edit(b!, text("Cnew", 700)), id: randomUUID(), slug: `${b!.slug}-candidate`, title: `${b!.title} C` };
	const old = {
		...base,
		articles: base.articles.map((x) =>
			x.id === a!.id ? edit(x, text("Aold", 1800)) : x.id === b!.id ? edit(x, text("Bold", 600)) : x,
		),
	};
	const candidate = {
		...base,
		articles: [
			...old.articles.filter((x) => x.id !== b!.id).map((x) => (x.id === a!.id ? edit(x, text("Anew", 900)) : x)),
			c,
		],
	};
	const label = new Map([
		[a!.slug, "A"],
		[b!.slug, "B"],
		[c.slug, "C"],
	]);
	const keysOf = (snapshot: typeof old) => {
		const entries = wikiEntries(snapshot, "probe");
		const slugOf = new Map(entries.map((e) => [e.revisionId, e.slug]));
		return chunkEntries(entries).map((chunk) => {
			const slug = slugOf.get(chunk.revisionId) ?? "";
			return { key: `${label.get(slug) ?? slug}#${chunk.ordinal}`, text: chunk.text };
		});
	};
	const named = (keys: { key: string }[]) =>
		keys
			.map((k) => k.key)
			.filter((k) => /^[ABC]#/.test(k))
			.toSorted();
	assert.deepEqual(named(keysOf(old)), args.old_active_keys);
	assert.deepEqual(named(keysOf(candidate)), args.candidate_keys);

	const { db, caller, rows, command } = await store();
	const oldService = referenceService(db, { source: bootstrap, loadSnapshot: async () => old });
	const R1 = await oldService.rebuildEmbeddings(caller, command("R1", "0"));
	assert.deepEqual([R1.activated, R1.activationNumber], [true, "1"]);
	const current = async () =>
		(
			await rows<{ key: string; dims: number; checksum: string; release: string; profile: string }>(
				sql`SELECT r.slug||'#'||p.ordinal AS key,public.vector_dims(p.embedding) AS dims,p.embedding_checksum AS checksum,
				rel.release_key AS release,rel.embedding_profile AS profile
				FROM passage p JOIN article_revision r ON r.id=p.revision_id JOIN reference_release rel ON rel.id=p.release_id
				WHERE p.release_id=(SELECT release_id FROM reference_activation ORDER BY activation_number DESC LIMIT 1) ORDER BY r.slug,p.ordinal`,
			)
		).map((row) => ({ ...row, key: row.key.replace(/^(.*)#/, (_, slug: string) => `${label.get(slug) ?? slug}#`) }));
	const oldRows = await current();
	assert.deepEqual(named(oldRows), args.old_active_keys);
	assert.ok(
		oldRows.every(
			(row) => row.dims !== args.candidate_model_dimensions && row.profile !== "openai-text-embedding-3-small",
		),
	);

	const axis = (value: string) => Number.parseInt(sha(value).slice(0, 8), 16) % args.candidate_model_dimensions;
	const missingText = keysOf(candidate).find((k) => k.key === args.partial_build_missing)!.text;
	let partial = true;
	const candidateService = referenceService(db, {
		source: bootstrap,
		loadSnapshot: async () => candidate,
		embeddingProfile: "openai-text-embedding-3-small",
		embeddingDimensions: args.candidate_model_dimensions,
		embed: (chunk: string) =>
			partial && chunk === missingText
				? []
				: Array.from({ length: args.candidate_model_dimensions }, (_, at) => (at === axis(chunk) ? 1 : 0)),
	});
	const failed = await untouched(db, () => candidateService.rebuildEmbeddings(caller, command("R2", "1")));
	assert.deepEqual([failed.activated, failed.reason], [false, "incomplete_candidate"]);
	assert.deepEqual(named(await current()), result.active_keys_after_partial);
	assert.deepEqual(await current(), oldRows);

	partial = false;
	const R2 = await candidateService.rebuildEmbeddings(caller, command("R2", "1"));
	assert.deepEqual([R2.activated, R2.activeRelease, R2.activationNumber], [true, "R2", "2"]);
	const now = await current();
	assert.deepEqual(named(now), result.valid_candidate_current_keys);
	const planned = new Set(keysOf(candidate).map((k) => k.key));
	assert.deepEqual(
		now.filter((row) => !planned.has(row.key)).map((row) => row.key),
		result.stale_trailing_current_keys,
	);
	assert.equal(now.length, planned.size);
	const oldChecksums = new Set(oldRows.map((row) => row.checksum));
	const imported = now.some((row) => oldChecksums.has(row.checksum) || row.dims !== args.candidate_model_dimensions);
	assert.equal(args.missing_model_provenance_old_vectors, true);
	assert.equal(imported, result.old_vectors_without_provenance_imported);
	assert.ok(now.every((row) => row.profile === "openai-text-embedding-3-small" && row.release === "R2"));

	const history = () =>
		rows<{
			n: string;
			release: string;
			row: string;
		}>(sql`SELECT a.activation_number::text AS n,r.release_key AS release,
			a::text AS row FROM reference_activation a JOIN reference_release r ON r.id=a.release_id ORDER BY a.activation_number`);
	const two = await history();
	const back = await oldService.rebuildEmbeddings(caller, command("R1", "2"));
	assert.deepEqual([back.activated, back.activeRelease, back.activationNumber], [true, "R1", "3"]);
	const three = await history();
	assert.equal(
		three.length === two.length + 1 && isDeepStrictEqual(three.slice(0, 2), two),
		result.rollback_appends_activation,
	);
	assert.deepEqual(
		three.map((h) => [h.n, h.release]),
		[
			["1", "R1"],
			["2", "R2"],
			["3", "R1"],
		],
	);
	assert.deepEqual(await current(), oldRows);
});
