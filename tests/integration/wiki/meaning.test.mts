import { fixture, ok } from "../../support/fixture.mts";
import { sql } from "../../../packages/db/node_modules/drizzle-orm/index.js";
import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { RequestActor } from "../../../packages/domain/src/access/session.ts";
import { createWikiProducer } from "../../../packages/domain/src/wiki/index.ts";
import { wikiQueryEmbedder } from "../../../packages/reference/src/starter/verify/query.ts";
import type { WikiEmbedFetch } from "../../../packages/reference/src/starter/verify/openai.ts";

const GLOBAL = "00000000-0000-0000-0000-000000000000";
const DIMENSIONS = 1536;
const KEY = "sk-test-meaning-search";
const OPENAI = { EVF_WIKI_EMBEDDINGS: "openai", OPENAI_API_KEY: KEY };
const database = await fixture({ prefix: "t339", max: 4 });
const { admin } = database;
const db = database.pools.runtime;
const P = database.tenant.id;
const N1 = randomUUID();
const N2 = randomUUID();
const release = randomUUID();
const section = randomUUID();
const hash = () => randomBytes(32).toString("hex");

const axis = (index: number) => Array.from({ length: DIMENSIONS }, (_, at) => (at === index ? 1 : 0));
const mix = (a: number, b: number, weight: number) => {
	const norm = Math.hypot(weight, 1 - weight);
	return Array.from({ length: DIMENSIONS }, (_, at) =>
		at === a ? weight / norm : at === b ? (1 - weight) / norm : 0,
	);
};
type Article = { id: string; title: string; slug: string; body: string; vector: number[]; published?: boolean };
const article = (title: string, slug: string, body: string, vector: number[], published = true): Article => ({
	id: randomUUID(),
	title,
	slug,
	body,
	vector,
	published,
});
const A = {
	vision: article(
		"Running Your Vision Meeting",
		"core/vision",
		"Share the story of the church you are planting and invite people to join the core gathering.",
		axis(0),
	),
	checklist: article(
		"Vision Meeting Checklist",
		"core/checklist",
		"A vision meeting checklist: chairs, coffee and sign-up cards.",
		axis(3),
	),
	story: article("Telling Your Story", "core/story", "Practice telling why this church matters to the city.", mix(0, 5, 0.5)),
	budget: article("Budget Basics", "core/budget", "Plan the first year of giving and spending.", mix(0, 6, 0.9)),
	coaching: article("Weekly Check-ins", "core/coaching", "Meet your coach every week.", axis(0)),
	hidden: article("Hidden Guidance", "core/hidden", "Guidance this network hides.", axis(0)),
	draft: article("Draft Plan", "core/draft", "A plan that is not published yet.", axis(0), false),
	far: article("Far Away", "core/far", "Nothing near any question here.", axis(9)),
};
const NETWORK_TITLE = "Harvest Coaching Calls";
const NETWORK_BODY = "Harvest planters phone their zephyrcoach weekly.";
const OTHER_TITLE = "Other Network Budget";
const OTHER_BODY = "Other network guidance this church never sees.";

const QUESTION = "how do I cast vision to a new group";
const QUESTIONS: Record<string, number[]> = {
	[QUESTION]: axis(0),
	"vision meeting": axis(5),
	zephyrcoach: axis(0),
};

type Calls = { count: number; inputs: string[] };
function openAi(calls: Calls, usage = 5): WikiEmbedFetch {
	return async (_url, init) => {
		calls.count += 1;
		const { input } = JSON.parse(String(init.body)) as { input: string[] };
		calls.inputs.push(...input);
		const vector = QUESTIONS[input[0] ?? ""];
		if (!vector) return new Response("unknown", { status: 500 });
		return new Response(
			JSON.stringify({ data: [{ index: 0, embedding: vector }], usage: { total_tokens: usage } }),
			{ status: 200 },
		);
	};
}
const counter = (): Calls => ({ count: 0, inputs: [] });

async function insertRevision(row: {
	article: string;
	tenant: string;
	title: string;
	slug: string;
	body: string;
	published: boolean;
}) {
	const id = randomUUID();
	await admin.execute(sql`INSERT INTO article_revision(id,article_id,tenant_id,release_id,revision_number,title,slug,excerpt,body,content_type,phase,position,content_hash,published_at,meaningful,meaningful_sequence,section_id)
		VALUES(${id},${row.article},${row.tenant},${row.tenant === GLOBAL ? release : null},1,${row.title},${row.slug},${row.title},${row.body},${row.tenant === GLOBAL ? "safe_mdx" : "safe_nodes"},1,1,${hash()},
			${row.published ? sql`clock_timestamp()` : sql`NULL`},true,1,${section})`);
	return id;
}
async function edition(org: string, articleId: string, state: "published" | "hide", current: string | null) {
	await admin.execute(sql`INSERT INTO article_editor_state(id,organization_id,article_id,state,current_revision_id,revision)
		VALUES(${randomUUID()},${org},${articleId},${state},${current},1)`);
}

before(async () => {
	await database.organization("sending_network", { id: N1, name: "Harvest Network", timezone: "America/Chicago" });
	await database.organization("sending_network", { id: N2, name: "Other Network", timezone: "America/Chicago" });
	await admin.execute(sql`INSERT INTO affiliation(id,plant_id,organization_id,accepted_at,share_people,share_meetings,share_tasks,share_ministry_teams,share_wiki,share_activity,shared_findings)
		VALUES(${randomUUID()},${P},${N1},clock_timestamp()-interval '1 day',false,false,false,false,true,false,false)`);
	await admin.execute(
		sql`INSERT INTO reference_item(id,kind,canonical_key,tenant_id) VALUES(${section},'section','core',${GLOBAL})`,
	);
	await admin.execute(sql`INSERT INTO reference_release(id,release_key,artifact_locator,manifest_hash,state,complete_at,validated_at,approval_locator,approval_hash,chunker_version,embedding_profile,embedding_dimensions,tenant_id,expected_passages)
		VALUES(${release},${"release-" + release},'memory://synthetic',${hash()},'validated',clock_timestamp(),clock_timestamp(),'memory://approval',${hash()},'v','openai-text-embedding-3-small',${DIMENSIONS},${GLOBAL},${Object.keys(A).length})`);
	for (const a of Object.values(A)) {
		await admin.execute(
			sql`INSERT INTO reference_item(id,kind,canonical_key,tenant_id) VALUES(${a.id},'article',${a.slug},${GLOBAL})`,
		);
		const revision = await insertRevision({ article: a.id, tenant: GLOBAL, ...a, published: a.published ?? true });
		await admin.execute(sql`INSERT INTO passage(release_id,revision_id,tenant_id,ordinal,content,content_hash,embedding,embedding_checksum)
			VALUES(${release},${revision},${GLOBAL},0,${a.body},${hash()},${`[${a.vector.join(",")}]`}::public.vector,${hash()})`);
	}
	const network = await insertRevision({
		article: A.coaching.id,
		tenant: N1,
		title: NETWORK_TITLE,
		slug: A.coaching.slug,
		body: NETWORK_BODY,
		published: true,
	});
	await edition(N1, A.coaching.id, "published", network);
	await edition(N1, A.hidden.id, "hide", null);
	const other = await insertRevision({
		article: A.budget.id,
		tenant: N2,
		title: OTHER_TITLE,
		slug: A.budget.slug,
		body: OTHER_BODY,
		published: true,
	});
	await edition(N2, A.budget.id, "published", other);
	await admin.execute(sql`INSERT INTO reference_activation(id,release_id,activation_number,activated_at,actor_tombstone,reason,expected_prior_number)
		VALUES(${randomUUID()},${release},1,clock_timestamp(),'synthetic','test',0)`);
});
after(() => database.close());

async function reader() {
	const resolved = await RequestActor.resolve(db, database.actors.owner.session);
	assert.ok(resolved instanceof RequestActor);
	return resolved;
}
type Hit = { articleId: string; title: string; slug: string; snippet: string | null; sourceKind: string };
async function searched(embedder: ReturnType<typeof wikiQueryEmbedder>, query: string) {
	const value = ok(await createWikiProducer({ queryEmbedder: embedder }).search(db, await reader(), { query }));
	return { value, hits: (value.results ?? []) as Hit[] };
}
const keywordOnly = (query: string) => searched(null, query);
async function logged<T>(run: () => Promise<T>) {
	const lines: string[] = [];
	const original = console.error;
	console.error = (...args: unknown[]) => void lines.push(args.map(String).join(" "));
	try {
		return { value: await run(), lines };
	} finally {
		console.error = original;
	}
}
const spent = async () =>
	Number(
		(
			await admin.execute(
				sql`SELECT COALESCE(sum(usage),0)::text AS n FROM embedding_spend WHERE purpose='query' AND day=(clock_timestamp() AT TIME ZONE 'UTC')::date`,
			)
		).rows[0]?.n,
	);

test("a question that shares no keyword with an article finds it by meaning, with its title, a snippet of its text and its link", async () => {
	assert.deepEqual((await keywordOnly(QUESTION)).hits, [], "keyword search alone finds nothing");
	const calls = counter();
	const before = await spent();
	const { hits } = await searched(wikiQueryEmbedder(OPENAI, openAi(calls)), QUESTION);
	assert.deepEqual(
		hits.map((h) => [h.articleId, h.title, h.slug, h.sourceKind]),
		[
			[A.vision.id, A.vision.title, A.vision.slug, "global"],
			[A.budget.id, A.budget.title, A.budget.slug, "global"],
			[A.story.id, A.story.title, A.story.slug, "global"],
		],
	);
	assert.equal(
		hits[0]?.snippet,
		"Share the story of the church you are planting and invite people to join the core gathering.",
	);
	assert.deepEqual(calls.inputs, [QUESTION], "one provider round trip with the question");
	assert.equal(await spent(), before + 5, "the reported tokens are recorded for the day");
});

test("meaning hits never show a network's own version, a hidden or draft article, or another network's version", async () => {
	const { hits } = await searched(wikiQueryEmbedder(OPENAI, openAi(counter())), QUESTION);
	const text = JSON.stringify(hits);
	for (const excluded of [A.coaching, A.hidden, A.draft])
		assert.ok(!hits.some((h) => h.articleId === excluded.id), `${excluded.title} is not a meaning hit`);
	for (const words of [A.coaching.title, A.coaching.body, A.hidden.title, A.draft.title, OTHER_TITLE, OTHER_BODY])
		assert.ok(!text.includes(words), `${words} is never shown`);
	assert.ok(!hits.some((h) => h.articleId === A.far.id), "a far passage is not a hit");
});

test("the network's own version still appears once when keyword search finds it, with its own title and words", async () => {
	const { hits } = await searched(wikiQueryEmbedder(OPENAI, openAi(counter())), "zephyrcoach");
	const coaching = hits.filter((h) => h.articleId === A.coaching.id);
	assert.deepEqual(
		coaching.map((h) => [h.title, h.sourceKind, h.snippet]),
		[[NETWORK_TITLE, "network", "Harvest planters phone their <b>zephyrcoach</b> weekly"]],
	);
	assert.equal(hits[0]?.articleId, A.coaching.id, "the keyword hit ranks first");
	assert.ok(!JSON.stringify(hits).includes(A.coaching.body), "the global text never shows");
});

test("a query keyword search answers keeps its first result first and never repeats an article", async () => {
	const keyword = await keywordOnly("vision meeting");
	assert.ok(keyword.hits.length >= 2);
	const { hits } = await searched(wikiQueryEmbedder(OPENAI, openAi(counter())), "vision meeting");
	assert.equal(hits[0]?.articleId, keyword.hits[0]?.articleId);
	assert.equal(new Set(hits.map((h) => h.articleId)).size, hits.length);
	for (const hit of keyword.hits)
		assert.deepEqual(
			hits.find((h) => h.articleId === hit.articleId),
			hit,
		);
	assert.deepEqual(
		hits.filter((h) => !keyword.hits.some((k) => k.articleId === h.articleId)).map((h) => h.articleId),
		[A.story.id],
	);
});

const neverAnswers: WikiEmbedFetch = (_url, init) =>
	new Promise((_resolve, reject) => {
		init.signal?.addEventListener("abort", () => reject(init.signal?.reason));
	});
const FAILURES: [string, Record<string, string>, WikiEmbedFetch, string][] = [
	["no key", { EVF_WIKI_EMBEDDINGS: "openai" }, openAi(counter()), "openai_key_missing"],
	["a timeout", OPENAI, neverAnswers, "openai_timeout"],
	[
		"a refusal",
		OPENAI,
		async () => new Response(`rate limited for ${KEY}: secret detail`, { status: 429 }),
		"openai_http_429",
	],
	[
		"a network failure",
		OPENAI,
		async () => {
			throw Error(`ECONNRESET ${KEY}`);
		},
		"openai_request_failed",
	],
	[
		"a short vector",
		OPENAI,
		async () =>
			new Response(JSON.stringify({ data: [{ index: 0, embedding: [0.1, 0.2] }], usage: { total_tokens: 3 } }), {
				status: 200,
			}),
		"openai_dimensions",
	],
	["a body that is not JSON", OPENAI, async () => new Response(`<html>${KEY}</html>`, { status: 200 }), "openai_response"],
];

test("with the provider unconfigured, search is exactly today's keyword search and calls nothing", async () => {
	const calls = counter();
	assert.equal(wikiQueryEmbedder({ OPENAI_API_KEY: KEY }, openAi(calls)), null);
	const baseline = await keywordOnly("vision meeting");
	const { value, lines } = await logged(() => searched(wikiQueryEmbedder({ OPENAI_API_KEY: KEY }), "vision meeting"));
	assert.deepEqual(value.value, baseline.value);
	assert.deepEqual(lines, []);
	assert.equal(calls.count, 0);
});

for (const [name, env, fetcher, reason] of FAILURES)
	test(`after ${name}, search returns exactly the keyword results and logs only the reason`, async () => {
		const baseline = await keywordOnly("vision meeting");
		const { value, lines } = await logged(() => searched(wikiQueryEmbedder(env, fetcher), "vision meeting"));
		assert.deepEqual(value.value, baseline.value);
		assert.deepEqual(
			lines.map((line) => JSON.parse(line)),
			[{ component: "wiki", outcome: "meaning-skipped", reason }],
		);
		assert.ok(!lines.join("").includes(KEY) && !lines.join("").includes("secret"));
	});

test("a release embedded with another profile never calls the provider", async () => {
	await admin.execute(sql`UPDATE reference_release SET embedding_profile='local-deterministic-v1' WHERE id=${release}`);
	try {
		const calls = counter();
		const baseline = await keywordOnly("vision meeting");
		const { value } = await searched(wikiQueryEmbedder(OPENAI, openAi(calls)), "vision meeting");
		assert.deepEqual(value, baseline.value);
		assert.equal(calls.count, 0);
	} finally {
		await admin.execute(
			sql`UPDATE reference_release SET embedding_profile='openai-text-embedding-3-small' WHERE id=${release}`,
		);
	}
});

test("once the day's query tokens pass $0.25, search stops calling the provider and returns keyword results", async () => {
	const before = await spent();
	const calls = counter();
	const embedder = wikiQueryEmbedder(OPENAI, openAi(calls, 12_500_000));
	const first = await searched(embedder, QUESTION);
	assert.equal(first.hits[0]?.articleId, A.vision.id);
	assert.equal(await spent(), before + 12_500_000);
	const baseline = await keywordOnly("vision meeting");
	const { value, lines } = await logged(() => searched(embedder, "vision meeting"));
	assert.deepEqual(value.value, baseline.value);
	assert.equal(calls.count, 1, "the second search makes no provider call");
	assert.deepEqual(
		lines.map((line) => JSON.parse(line)),
		[{ component: "wiki", outcome: "meaning-skipped", reason: "daily_limit" }],
	);
});
