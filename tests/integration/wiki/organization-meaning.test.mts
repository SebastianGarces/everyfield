import { fixture, ok } from "../../support/fixture.mts";
import { sql } from "../../../packages/db/node_modules/drizzle-orm/index.js";
import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { RequestActor } from "../../../packages/domain/src/access/session.ts";
import { createWikiProducer } from "../../../packages/domain/src/wiki/index.ts";
import { runDueWikiEmbedding } from "../../../packages/domain/src/wiki/embedding.ts";
import { search } from "../../../packages/domain/src/wiki/reads.ts";
import { wikiPassageEmbedder, wikiQueryEmbedder } from "../../../packages/reference/src/starter/verify/query.ts";
import type { WikiEmbedFetch } from "../../../packages/reference/src/starter/verify/openai.ts";

const GLOBAL = "00000000-0000-0000-0000-000000000000";
const DIMENSIONS = 1536;
const KEY = "sk-test-organization-meaning";
const OPENAI = { EVF_WIKI_EMBEDDINGS: "openai", OPENAI_API_KEY: KEY };
const PUBLISH_CAP_TOKENS = 12_500_000;
const database = await fixture({ prefix: "t552", max: 4 });
const { admin } = database;
const db = database.pools.runtime;
const P = database.tenant.id;
const N1 = randomUUID();
const N2 = randomUUID();
const Q = (await database.plant({ name: "Other network church" })).id;
const R = (await database.plant({ name: "Unaffiliated church" })).id;
const release = randomUUID();
const section = randomUUID();
const affiliation = randomUUID();
const hash = () => randomBytes(32).toString("hex");
const api = createWikiProducer();

const axis = (index: number) => Array.from({ length: DIMENSIONS }, (_, at) => (at === index ? 1 : 0));
const vectorText = (vector: number[]) => `[${vector.join(",")}]`;
const mix = (a: number, b: number, weight: number) => {
	const norm = Math.hypot(weight, 1 - weight);
	return Array.from({ length: DIMENSIONS }, (_, at) => (at === a ? weight / norm : at === b ? (1 - weight) / norm : 0));
};
const CROWDED = "someone to talk things through with";

type Piece = { id: string; slug: string; title: string; body: string; vector: number[] };
const piece = (slug: string, title: string, body: string, vector: number[]): Piece => ({
	id: randomUUID(),
	slug,
	title,
	body,
	vector,
});
const ARTICLES = {
	coaching: piece("core/coaching", "Weekly Check-ins", "Meet your coach every week.", axis(9)),
	draft: piece("core/draft", "Planning Retreats", "Book a cabin for the planning retreat.", axis(9)),
	hidden: piece("core/hidden", "Prayer Partners", "Find two prayer partners.", axis(9)),
	revised: piece("core/revised", "Finding a Venue", "Look for a school gym.", axis(9)),
	failing: piece("core/failing", "Volunteer Teams", "Build volunteer teams.", axis(9)),
	capped: piece("core/capped", "Launch Sunday", "Plan your launch Sunday.", axis(9)),
	daily: piece("core/daily", "Core Group", "Gather a core group.", axis(9)),
	other: piece("core/other", "Other Guidance", "Guidance from elsewhere.", axis(9)),
};

const VERSIONS = {
	coaching: "Harvest leaders phone their mentor on Tuesdays.",
	draft: "Harvest teams rent lakeside lodges each spring.",
	hidden: "Harvest intercessors gather at dawn.",
	revisedOld: "Harvest crews scout warehouses downtown.",
	revisedNew: "Harvest crews lease storefronts uptown.",
	failing: "Harvest stewards rotate ushers monthly.",
	capped: "Harvest heralds rehearse greetings twice.",
	daily: "Harvest disciples share breakfast Saturdays.",
	other: "Northern elders pray over maps.",
};
const PASSAGE_VECTORS: Record<string, number[]> = {
	[VERSIONS.coaching]: axis(0),
	[VERSIONS.draft]: axis(1),
	[VERSIONS.hidden]: axis(2),
	[VERSIONS.revisedOld]: axis(3),
	[VERSIONS.revisedNew]: axis(4),
	[VERSIONS.failing]: axis(5),
	[VERSIONS.capped]: axis(6),
	[VERSIONS.daily]: axis(7),
	[VERSIONS.other]: axis(0),
};
const QUESTIONS = {
	coaching: "who helps me when I feel stuck",
	draft: "where should we go to get away",
	hidden: "early morning intercession",
	revisedOld: "industrial buildings in the city center",
	revisedNew: "retail spaces north of the city",
	daily: "eating together on weekends",
};
const QUESTION_VECTORS: Record<string, number[]> = {
	[QUESTIONS.coaching]: axis(0),
	[QUESTIONS.draft]: axis(1),
	[QUESTIONS.hidden]: axis(2),
	[QUESTIONS.revisedOld]: axis(3),
	[QUESTIONS.revisedNew]: axis(4),
	[QUESTIONS.daily]: axis(7),
	ushers: axis(10),
	[CROWDED]: mix(0, 11, 0.9),
};

type Calls = { count: number; inputs: string[] };
const counter = (): Calls => ({ count: 0, inputs: [] });
function provider(table: Record<string, number[]>, calls: Calls, usage = 7): WikiEmbedFetch {
	return async (_url, init) => {
		calls.count += 1;
		const { input } = JSON.parse(String(init.body)) as { input: string[] };
		calls.inputs.push(...input);
		const vectors = input.map((text) => table[text]);
		if (vectors.some((vector) => !vector)) return new Response("unknown", { status: 500 });
		return new Response(
			JSON.stringify({
				data: vectors.map((embedding, index) => ({ index, embedding })),
				usage: { total_tokens: usage },
			}),
			{ status: 200 },
		);
	};
}
const passages = (calls: Calls, usage?: number) => wikiPassageEmbedder(OPENAI, provider(PASSAGE_VECTORS, calls, usage));
const questions = (calls = counter()) => wikiQueryEmbedder(OPENAI, provider(QUESTION_VECTORS, calls));
const forbidden: WikiEmbedFetch = async () => assert.fail("the provider is never called here");

const people = {
	planter: database.actors.owner,
	otherNetwork: await database.actor({ kind: "plant", id: Q }, "owner"),
	unaffiliated: await database.actor({ kind: "plant", id: R }, "owner"),
};

before(async () => {
	await admin.execute(
		sql`INSERT INTO reference_item(id,kind,canonical_key,tenant_id) VALUES(${section},'section','core',${GLOBAL})`,
	);
	await admin.execute(sql`INSERT INTO reference_release(id,release_key,artifact_locator,manifest_hash,state,complete_at,validated_at,approval_locator,approval_hash,chunker_version,embedding_profile,embedding_dimensions,tenant_id,expected_passages)
		VALUES(${release},${"release-" + release},'memory://synthetic',${hash()},'validated',clock_timestamp(),clock_timestamp(),'memory://approval',${hash()},'v','openai-text-embedding-3-small',${DIMENSIONS},${GLOBAL},${Object.keys(ARTICLES).length})`);
	for (const a of Object.values(ARTICLES)) {
		await admin.execute(
			sql`INSERT INTO reference_item(id,kind,canonical_key,tenant_id) VALUES(${a.id},'article',${a.slug},${GLOBAL})`,
		);
		const revision = randomUUID();
		await admin.execute(sql`INSERT INTO article_revision(id,article_id,tenant_id,release_id,revision_number,title,slug,excerpt,body,content_type,phase,position,content_hash,published_at,meaningful,meaningful_sequence,section_id)
			VALUES(${revision},${a.id},${GLOBAL},${release},1,${a.title},${a.slug},${a.title},${a.body},'safe_mdx',1,1,${hash()},clock_timestamp(),true,1,${section})`);
		await admin.execute(sql`INSERT INTO passage(release_id,revision_id,tenant_id,ordinal,content,content_hash,embedding,embedding_checksum)
			VALUES(${release},${revision},${GLOBAL},0,${a.body},${hash()},${vectorText(a.vector)}::public.vector,${hash()})`);
	}
	await admin.execute(sql`INSERT INTO reference_activation(id,release_id,activation_number,activated_at,actor_tombstone,reason,expected_prior_number)
		VALUES(${randomUUID()},${release},1,clock_timestamp(),'synthetic','test',0)`);
});
after(() => database.close());

await database.organization("sending_network", { id: N1, name: "Harvest Network", timezone: "America/Chicago" });
await database.organization("sending_network", { id: N2, name: "Northern Network", timezone: "America/Chicago" });
const editor = await database.actor({ kind: "organization", id: N1, organizationKind: "sending_network" }, "admin");
const otherEditor = await database.actor(
	{ kind: "organization", id: N2, organizationKind: "sending_network" },
	"admin",
);
await admin.execute(sql`INSERT INTO affiliation(id,plant_id,organization_id,accepted_at,share_people,share_meetings,share_tasks,share_ministry_teams,share_wiki,share_activity,shared_findings)
	VALUES(${affiliation},${P},${N1},clock_timestamp()-interval '1 day',false,false,false,false,true,false,false)`);
await admin.execute(sql`INSERT INTO affiliation(id,plant_id,organization_id,accepted_at,share_people,share_meetings,share_tasks,share_ministry_teams,share_wiki,share_activity,shared_findings)
	VALUES(${randomUUID()},${Q},${N2},clock_timestamp()-interval '1 day',false,false,false,false,true,false,false)`);

async function actor(who: { session: Parameters<typeof RequestActor.resolve>[1] }) {
	const resolved = await RequestActor.resolve(db, who.session);
	assert.ok(resolved instanceof RequestActor);
	return resolved;
}
const editions = new Map<string, string>();
async function write(
	mode: "publish" | "add",
	org: string,
	who: typeof editor,
	article: Piece,
	body: string,
): Promise<{ reply: unknown; revision: string }> {
	const key = `${org}:${article.id}`;
	const reply = ok(
		await (mode === "publish" ? api.publishOrganizationArticle : api.addOrganizationArticle)(db, await actor(who), {
			requestKey: randomUUID(),
			expectedRevision: editions.get(key) ?? "0",
			input: { articleId: article.id, organizationId: org, body },
		}),
	);
	const row = (
		await admin.execute(sql`SELECT e.revision::text AS revision, r.id AS written FROM article_editor_state e
			JOIN article_revision r ON r.article_id = e.article_id AND r.tenant_id = e.organization_id
			WHERE e.organization_id = ${org} AND e.article_id = ${article.id}
			ORDER BY r.revision_number DESC LIMIT 1`)
	).rows[0] as { revision: string; written: string };
	editions.set(key, row.revision);
	return { reply, revision: row.written };
}
const publish = (article: Piece, body: string, org = N1, who = editor) => write("publish", org, who, article, body);
async function hide(article: Piece) {
	const key = `${N1}:${article.id}`;
	ok(
		await api.hideOrganizationArticle(db, await actor(editor), {
			requestKey: randomUUID(),
			expectedRevision: editions.get(key) ?? "0",
			input: { articleId: article.id, organizationId: N1 },
		}),
	);
	editions.set(key, String(Number(editions.get(key)) + 1));
}

type Hit = {
	articleId: string;
	sourceKind: string;
	sourceId: string;
	title: string;
	slug: string;
	revisionId: string;
	snippet: string | null;
};
const view = (h: Hit) => ({
	articleId: h.articleId,
	sourceKind: h.sourceKind,
	sourceId: h.sourceId,
	title: h.title,
	slug: h.slug,
	revisionId: h.revisionId,
	snippet: h.snippet,
});
async function searched(who: typeof editor, query: string, embedder = questions()) {
	return ok(await search(db, await actor(who), { query }, embedder));
}
const hits = async (who: typeof editor, query: string, embedder = questions()) =>
	((await searched(who, query, embedder)).results as Hit[]).map(view);
const expected = (article: Piece, revision: string, snippet: string, sourceId = N1) => ({
	articleId: article.id,
	sourceKind: "network",
	sourceId,
	title: article.title,
	slug: article.slug,
	revisionId: revision,
	snippet,
});

type JobRow = { state: string; error_code: string | null; attempt_count: number; deferred: boolean };
async function jobsFor(revision: string): Promise<JobRow[]> {
	return (
		await admin.execute(sql`SELECT state, error_code, attempt_count,
			eligible_at = (((clock_timestamp() AT TIME ZONE 'UTC')::date + 1)::timestamp AT TIME ZONE 'UTC') AS deferred
			FROM job WHERE kind = 'wiki_embedding' AND subject_record_id = ${revision}`)
	).rows as JobRow[];
}
async function passageCount(revision: string) {
	return Number(
		(await admin.execute(sql`SELECT count(*)::int AS n FROM passage WHERE revision_id = ${revision}`)).rows[0]?.n,
	);
}
const spent = async (purpose: "publish" | "query") =>
	Number(
		(
			await admin.execute(
				sql`SELECT COALESCE(sum(usage),0)::text AS n FROM embedding_spend WHERE purpose=${purpose} AND day=(clock_timestamp() AT TIME ZONE 'UTC')::date`,
			)
		).rows[0]?.n,
	);
async function logged<T>(run: () => Promise<T>) {
	const lines: string[] = [];
	const original = console.error;
	console.error = (...args: unknown[]) => void lines.push(args.map(String).join(" "));
	try {
		return { value: await run(), lines: lines.map((line) => JSON.parse(line) as Record<string, unknown>) };
	} finally {
		console.error = original;
	}
}
async function withoutNetwork<T>(run: () => Promise<T>) {
	const original = globalThis.fetch;
	globalThis.fetch = (() => assert.fail("no provider call during a publish")) as typeof fetch;
	try {
		return await run();
	} finally {
		globalThis.fetch = original;
	}
}
const drain = (embedder: ReturnType<typeof wikiPassageEmbedder>, runCapUsd?: number) =>
	runDueWikiEmbedding(db, embedder, 20, Date.now() + 30_000, runCapUsd);

let coaching = "";

test("a network's published version is found by meaning by a planter who shares its Wiki, with its own title, text and link", async () => {
	const published = await withoutNetwork(() => publish(ARTICLES.coaching, VERSIONS.coaching));
	coaching = published.revision;
	assert.deepEqual(published.reply, {
		errorCode: null,
		publishedRevision: 1,
		organizationId: N1,
		additionalHistoryEntries: 1,
		publicationsAdded: 0,
		invalidationCalls: 0,
		state: "published",
	});
	assert.deepEqual(await jobsFor(coaching), [{ state: "ready", error_code: null, attempt_count: 0, deferred: false }]);
	assert.deepEqual(await hits(database.actors.owner, QUESTIONS.coaching), [], "nothing finds it before the job");
	assert.deepEqual(await hits(database.actors.owner, QUESTIONS.coaching, null), [], "keyword search never finds it");
	const before = await spent("publish");
	const calls = counter();
	assert.equal(await drain(passages(calls)), 1);
	assert.deepEqual(calls.inputs, [VERSIONS.coaching], "the version's text is embedded in one call");
	assert.equal(await spent("publish"), before + 7, "the reported tokens are recorded under publish");
	assert.deepEqual(await jobsFor(coaching), [
		{ state: "succeeded", error_code: null, attempt_count: 1, deferred: false },
	]);
	assert.deepEqual(await hits(database.actors.owner, QUESTIONS.coaching), [
		expected(ARTICLES.coaching, coaching, VERSIONS.coaching),
	]);
});

test("a meaning hit on organization text never shows to a church outside that Wiki, or after sharing ends", async () => {
	assert.deepEqual(await hits(people.unaffiliated, QUESTIONS.coaching), [], "a church that shares no Wiki");
	const other = await publish(ARTICLES.other, VERSIONS.other, N2, otherEditor);
	await drain(passages(counter()));
	assert.equal(await passageCount(other.revision), 1);
	assert.deepEqual(
		await hits(people.otherNetwork, QUESTIONS.coaching),
		[expected(ARTICLES.other, other.revision, VERSIONS.other, N2)],
		"a church in another network sees only its own network's version",
	);
	assert.deepEqual(
		await hits(database.actors.owner, QUESTIONS.coaching),
		[expected(ARTICLES.coaching, coaching, VERSIONS.coaching)],
		"the other network's version never shows here",
	);
	await admin.execute(sql`UPDATE affiliation SET share_wiki = false WHERE id = ${affiliation}`);
	try {
		assert.deepEqual(await hits(database.actors.owner, QUESTIONS.coaching), [], "sharing turned off");
	} finally {
		await admin.execute(sql`UPDATE affiliation SET share_wiki = true WHERE id = ${affiliation}`);
	}
	await admin.execute(sql`UPDATE affiliation SET ended_at = clock_timestamp() WHERE id = ${affiliation}`);
	try {
		assert.deepEqual(await hits(database.actors.owner, QUESTIONS.coaching), [], "affiliation ended");
	} finally {
		await admin.execute(sql`UPDATE affiliation SET ended_at = NULL WHERE id = ${affiliation}`);
	}
	assert.deepEqual(await hits(database.actors.owner, QUESTIONS.coaching), [
		expected(ARTICLES.coaching, coaching, VERSIONS.coaching),
	]);
});

test("other organizations' passages never crowd a church's own network version out of its meaning hits", async () => {
	const other = (
		await admin.execute(
			sql`SELECT current_revision_id AS id FROM article_editor_state WHERE organization_id=${N2} AND article_id=${ARTICLES.other.id}`,
		)
	).rows[0] as { id: string };
	const closer = vectorText(mix(0, 11, 0.9));
	for (let ordinal = 1; ordinal <= 45; ordinal++)
		await admin.execute(sql`INSERT INTO passage(revision_id,tenant_id,ordinal,content,content_hash,embedding,embedding_checksum)
			VALUES(${other.id},${N2},${ordinal},${VERSIONS.other},${hash()},${closer}::public.vector,${hash()})`);
	try {
		assert.deepEqual(await hits(database.actors.owner, CROWDED), [
			expected(ARTICLES.coaching, coaching, VERSIONS.coaching),
		]);
	} finally {
		await admin.execute(sql`DELETE FROM passage WHERE revision_id=${other.id} AND ordinal > 0`);
	}
});

test("a draft that was never published is never embedded or found", async () => {
	const draft = await write("add", N1, editor, ARTICLES.draft, VERSIONS.draft);
	assert.deepEqual(await jobsFor(draft.revision), [], "saving a draft queues no embedding");
	const calls = counter();
	assert.equal(await drain(passages(calls)), 0);
	assert.equal(calls.count, 0);
	assert.deepEqual(await hits(database.actors.owner, QUESTIONS.draft), []);
});

test("a version the organization hid is never found by meaning, even with its passages stored", async () => {
	const shown = await publish(ARTICLES.hidden, VERSIONS.hidden);
	await drain(passages(counter()));
	assert.deepEqual(await hits(database.actors.owner, QUESTIONS.hidden), [
		expected(ARTICLES.hidden, shown.revision, VERSIONS.hidden),
	]);
	await hide(ARTICLES.hidden);
	assert.equal(await passageCount(shown.revision), 1);
	assert.deepEqual(await hits(database.actors.owner, QUESTIONS.hidden), []);
	assert.deepEqual(await hits(database.actors.owner, "intercessors", null), [], "nor by keyword");
});

test("a new revision is matched by its own text and no longer by text only the replaced revision had", async () => {
	const first = await publish(ARTICLES.revised, VERSIONS.revisedOld);
	await drain(passages(counter()));
	assert.deepEqual(await hits(database.actors.owner, QUESTIONS.revisedOld), [
		expected(ARTICLES.revised, first.revision, VERSIONS.revisedOld),
	]);
	const second = await publish(ARTICLES.revised, VERSIONS.revisedNew);
	assert.deepEqual(
		await hits(database.actors.owner, QUESTIONS.revisedOld),
		[],
		"the replaced revision stops matching as soon as the new one is published",
	);
	await drain(passages(counter()));
	assert.deepEqual(await hits(database.actors.owner, QUESTIONS.revisedNew), [
		expected(ARTICLES.revised, second.revision, VERSIONS.revisedNew),
	]);
	assert.deepEqual(await hits(database.actors.owner, QUESTIONS.revisedOld), []);
	assert.equal(await passageCount(first.revision), 0, "the replaced revision's passages are removed");
});

test("a job for a revision replaced before it ran is superseded without a provider call", async () => {
	const first = await publish(ARTICLES.revised, VERSIONS.revisedOld);
	const second = await publish(ARTICLES.revised, VERSIONS.revisedNew);
	const calls = counter();
	await drain(passages(calls));
	assert.deepEqual(calls.inputs, [VERSIONS.revisedNew]);
	assert.deepEqual(await jobsFor(first.revision), [
		{ state: "superseded", error_code: "stale", attempt_count: 1, deferred: false },
	]);
	assert.deepEqual(await hits(database.actors.owner, QUESTIONS.revisedNew), [
		expected(ARTICLES.revised, second.revision, VERSIONS.revisedNew),
	]);
});

test("with embedding unconfigured or a release on another profile, the job ends without reaching the provider", async () => {
	const unconfigured = await withoutNetwork(() => publish(ARTICLES.daily, VERSIONS.daily));
	assert.equal(wikiPassageEmbedder({ OPENAI_API_KEY: KEY }, forbidden), null);
	await drain(wikiPassageEmbedder({ OPENAI_API_KEY: KEY }, forbidden));
	assert.deepEqual(await jobsFor(unconfigured.revision), [
		{ state: "cancelled", error_code: "not_configured", attempt_count: 1, deferred: false },
	]);
	await admin.execute(sql`UPDATE reference_release SET embedding_profile='local-deterministic-v1' WHERE id=${release}`);
	try {
		const other = await withoutNetwork(() => publish(ARTICLES.daily, VERSIONS.daily));
		await drain(wikiPassageEmbedder(OPENAI, forbidden));
		assert.deepEqual(await jobsFor(other.revision), [
			{ state: "cancelled", error_code: "profile_mismatch", attempt_count: 1, deferred: false },
		]);
		assert.equal(await passageCount(other.revision), 0);
	} finally {
		await admin.execute(
			sql`UPDATE reference_release SET embedding_profile='openai-text-embedding-3-small' WHERE id=${release}`,
		);
	}
});

const neverAnswers: WikiEmbedFetch = (_url, init) =>
	new Promise((_resolve, reject) => {
		init.signal?.addEventListener("abort", () => reject(init.signal?.reason));
	});
const FAILURES: [string, ReturnType<typeof wikiPassageEmbedder>, string, string][] = [
	["a timeout", wikiPassageEmbedder(OPENAI, neverAnswers, 20), "openai_timeout", "provider_unknown"],
	[
		"a refusal",
		wikiPassageEmbedder(OPENAI, async () => new Response(`rate limited ${KEY}: secret detail`, { status: 429 })),
		"openai_http_429",
		"provider_refused",
	],
	[
		"a short vector",
		wikiPassageEmbedder(
			OPENAI,
			async () =>
				new Response(JSON.stringify({ data: [{ index: 0, embedding: [0.1, 0.2] }], usage: { total_tokens: 3 } }), {
					status: 200,
				}),
		),
		"openai_dimensions",
		"provider_refused",
	],
	[
		"a body that is not JSON",
		wikiPassageEmbedder(OPENAI, async () => new Response(`<html>${KEY} secret</html>`, { status: 200 })),
		"openai_response",
		"provider_refused",
	],
];

for (const [name, embedder, reason, code] of FAILURES)
	test(`after ${name}, the version stays published and keyword-searchable, and the job retries`, async () => {
		const version = await publish(ARTICLES.failing, VERSIONS.failing);
		const baseline = (await searched(database.actors.owner, "ushers", null)).results;
		assert.deepEqual((baseline as Hit[]).map(view), [
			expected(ARTICLES.failing, version.revision, "Harvest stewards rotate <b>ushers</b> monthly"),
		]);
		const { lines } = await logged(() => drain(embedder));
		assert.deepEqual(lines, [{ component: "wiki", outcome: "embedding-failed", reason }]);
		assert.ok(!JSON.stringify(lines).includes(KEY) && !JSON.stringify(lines).includes("secret"));
		assert.deepEqual(await jobsFor(version.revision), [
			{ state: "retry_wait", error_code: code, attempt_count: 1, deferred: false },
		]);
		assert.equal(await passageCount(version.revision), 0);
		assert.deepEqual((await searched(database.actors.owner, "ushers")).results, baseline);
		const editorState = await admin.execute(
			sql`SELECT state, current_revision_id AS current FROM article_editor_state WHERE organization_id=${N1} AND article_id=${ARTICLES.failing.id}`,
		);
		assert.deepEqual(editorState.rows, [{ state: "published", current: version.revision }]);
		await admin.execute(
			sql`UPDATE job SET next_attempt_at = clock_timestamp() WHERE kind='wiki_embedding' AND subject_record_id=${version.revision}`,
		);
		await drain(passages(counter()));
		assert.deepEqual(await jobsFor(version.revision), [
			{ state: "succeeded", error_code: null, attempt_count: 2, deferred: false },
		]);
		assert.equal(await passageCount(version.revision), 1, "the retry embeds it");
	});

test("a job whose estimate passes the run cap refuses before any call and names the estimate", async () => {
	const version = await publish(ARTICLES.capped, VERSIONS.capped);
	const before = await spent("publish");
	const calls = counter();
	const estimated = Math.ceil(Buffer.byteLength(VERSIONS.capped) / 3) + 1;
	const { lines } = await logged(() => drain(passages(calls), 0.0000001));
	assert.equal(calls.count, 0);
	assert.deepEqual(lines, [
		{ component: "wiki", outcome: "embedding-skipped", reason: "estimated_cost_over_cap", estimatedTokens: estimated },
	]);
	assert.equal(await spent("publish"), before, "no ledger row");
	assert.deepEqual(await jobsFor(version.revision), [
		{ state: "failed", error_code: "over_cap", attempt_count: 1, deferred: false },
	]);
});

test("once the day's publish spend reaches $0.25 the job waits for the next UTC day, and query spend is separate", async () => {
	const today = sql`(clock_timestamp() AT TIME ZONE 'UTC')::date`;
	const publishSpent = await spent("publish");
	await admin.execute(sql`INSERT INTO embedding_spend(day,purpose,usage) VALUES(${today},'publish',${PUBLISH_CAP_TOKENS - publishSpent})
		ON CONFLICT (day,purpose) DO UPDATE SET usage = embedding_spend.usage + EXCLUDED.usage`);
	try {
		const version = await publish(ARTICLES.daily, VERSIONS.daily);
		const calls = counter();
		const { lines } = await logged(() => drain(passages(calls)));
		assert.equal(calls.count, 0, "no provider call that day");
		assert.deepEqual(lines, [{ component: "wiki", outcome: "embedding-skipped", reason: "daily_limit" }]);
		assert.deepEqual(await jobsFor(version.revision), [
			{ state: "ready", error_code: null, attempt_count: 0, deferred: true },
		]);
		await drain(passages(calls));
		assert.equal(calls.count, 0, "the deferred job is not due again today");
		const queryCalls = counter();
		assert.deepEqual(
			await hits(database.actors.owner, QUESTIONS.coaching, questions(queryCalls)),
			[expected(ARTICLES.coaching, coaching, VERSIONS.coaching)],
			"search still embeds its question while publish spend is at its cap",
		);
		assert.equal(queryCalls.count, 1);
		await admin.execute(sql`UPDATE embedding_spend SET day = day - 1 WHERE purpose='publish' AND day=${today}`);
		await admin.execute(
			sql`UPDATE job SET eligible_at = clock_timestamp() WHERE kind='wiki_embedding' AND subject_record_id=${version.revision}`,
		);
		await drain(passages(calls));
		assert.deepEqual(calls.inputs, [VERSIONS.daily], "the next day the job embeds the version");
		assert.deepEqual(await hits(database.actors.owner, QUESTIONS.daily), [
			expected(ARTICLES.daily, version.revision, VERSIONS.daily),
		]);
	} finally {
		await admin.execute(sql`DELETE FROM embedding_spend WHERE purpose='publish'`);
	}
});

test("query spend at its cap leaves publish embedding running", async () => {
	const today = sql`(clock_timestamp() AT TIME ZONE 'UTC')::date`;
	await admin.execute(sql`INSERT INTO embedding_spend(day,purpose,usage) VALUES(${today},'query',${PUBLISH_CAP_TOKENS})
		ON CONFLICT (day,purpose) DO UPDATE SET usage = EXCLUDED.usage`);
	try {
		const version = await publish(ARTICLES.capped, VERSIONS.capped);
		const calls = counter();
		await drain(passages(calls));
		assert.deepEqual(calls.inputs, [VERSIONS.capped]);
		assert.equal(await passageCount(version.revision), 1);
	} finally {
		await admin.execute(sql`DELETE FROM embedding_spend WHERE purpose='query'`);
	}
});
