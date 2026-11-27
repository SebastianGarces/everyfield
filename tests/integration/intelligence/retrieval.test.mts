import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { sql } from "../../../packages/db/src/query.ts";
import {
	createAssessmentJob,
	createAssessments,
	runAssessmentBatch,
} from "../../../packages/domain/src/intelligence/index.ts";
import type { Passage } from "../../../packages/contracts/src/intelligence/index.ts";
import { scriptedAssessmentDrafter } from "../../../packages/evry-scripted/src/scripted-assessment.ts";
import {
	DAILY_QUERY_CAP_USD,
	EmbeddingRefusal,
	tokensFor,
	type WikiQueryEmbedder,
} from "../../../packages/reference/src/starter/verify/query.ts";
import { ok } from "../../support/fixture.mts";
import { church, GLOBAL, type Church, type ChurchPlant, type StoredRun } from "./assessment-church.mts";
import { axis, DIMENSIONS, FAKE_PROFILE, fakeEmbedder, near, vectorText } from "./fake-embedder.mts";

let c: Church;
let T: ChurchPlant;
let O: ChurchPlant;
let N: Awaited<ReturnType<Church["network"]>>;
let P: ChurchPlant;
let r1: Awaited<ReturnType<Church["release"]>>;
const assessments = createAssessments();
const hash = () => randomBytes(32).toString("hex");
const section = randomUUID();

const DENSE_ONLY = {
	phaseOne: [
		"prayer-walks",
		1,
		"Prayer walks.\n## Walking the neighborhood\nWalk the streets of the city and pray for its people.",
	],
	phaseThree: [
		"launch-team-huddle",
		3,
		"Plan the week.\n## Weekly huddle\nGather the launch team each week to pray and plan.",
	],
	general: [
		"planter-sabbath",
		null,
		"Rest well.\n## Keeping a sabbath\nTake one day each week to rest with your family.",
	],
} as const;

async function passage(release: string | null, tenant: string, revision: string, vector: number[]) {
	await c.admin.execute(sql`INSERT INTO passage(release_id,revision_id,tenant_id,ordinal,content,content_hash,embedding,
		embedding_checksum) VALUES(${release},${revision},${tenant},0,'passage',${hash()},${vectorText(vector)}::public.vector,${hash()})`);
}
async function globalArticle(
	release: string,
	[slug, phase, body]: readonly [string, number | null, string],
	vector: number[],
) {
	const article = randomUUID();
	const revision = randomUUID();
	await c.admin.execute(
		sql`INSERT INTO reference_item(id,kind,canonical_key,tenant_id) VALUES(${article},'article',${slug + "-" + release},${GLOBAL})`,
	);
	await c.admin.execute(sql`INSERT INTO article_revision(id,article_id,tenant_id,release_id,revision_number,title,slug,
		excerpt,body,content_type,phase,position,content_hash,published_at,meaningful,meaningful_sequence,section_id)
		VALUES(${revision},${article},${GLOBAL},${release},1,${slug},${slug},${slug},${body},'safe_mdx',${phase},1,${hash()},
		clock_timestamp(),true,1,${section})`);
	await passage(release, GLOBAL, revision, vector);
	return revision;
}
async function embeddable(release: string) {
	await c.admin.execute(sql`UPDATE reference_release SET embedding_profile=${FAKE_PROFILE},
		embedding_dimensions=${DIMENSIONS} WHERE id=${release}`);
}

before(async () => {
	c = await church("t707r");
	await c.admin.execute(
		sql`INSERT INTO reference_item(id,kind,canonical_key,tenant_id) VALUES(${section},'section','framework/dense',${GLOBAL})`,
	);
	T = await c.phaseThree();
	O = await c.phaseThree("Elm Street Church");
	N = await c.network();
	P = await c.plant("Hill Plant", { network: N });
	r1 = await c.release("methodology-r1");
	await embeddable(r1.id);
	await globalArticle(r1.id, DENSE_ONLY.phaseOne, axis(0));
	await globalArticle(r1.id, DENSE_ONLY.phaseThree, near(0, 1, 0.9));
	await globalArticle(r1.id, DENSE_ONLY.general, near(0, 2, 0.8));
	await passage(r1.id, GLOBAL, r1.revisions["training-and-preparation"]!, near(0, 3, 0.85));
});
after(() => c?.database.close());

async function run(p: ChurchPlant, embedder: WikiQueryEmbedder | null) {
	const requestId = randomUUID();
	ok(await assessments.requestRefresh(c.db, p.actor, { requestId }));
	await runAssessmentBatch(createAssessmentJob({ embedder }), c.db, scriptedAssessmentDrafter(), 20);
	const row = await c.one<StoredRun>(
		sql`SELECT * FROM assessment_run WHERE plant_id=${p.id} AND demand_key=${"manual/" + requestId}`,
	);
	assert.equal(row.grounding, "grounded", JSON.stringify([row.outcome, row.reason]));
	return row.model_input!.passages;
}
const slugs = (passages: Passage[]) => passages.map((x) => x.slug);
const spent = async () =>
	Number(
		(
			await c.one<{ usage: string | null }>(sql`SELECT (SELECT usage FROM embedding_spend
				WHERE day=(clock_timestamp() AT TIME ZONE 'UTC')::date AND purpose='query')::text AS usage`)
		).usage ?? 0,
	);
const skips = (calls: { arguments: unknown[] }[]) =>
	calls
		.map((call) => String(call.arguments[0]))
		.filter((line) => line.includes("dense-skipped"))
		.map((line) => (JSON.parse(line) as { reason: string }).reason);

test("the dense leg keeps Phase 3 and general passages near the query and drops a nearer Phase 1 passage for a Phase 3 plant", async () => {
	const embedder = fakeEmbedder();
	const found = slugs(await run(T, embedder));
	assert.ok(found.includes("launch-team-huddle"), "the Phase 3 dense match is kept");
	assert.ok(found.includes("planter-sabbath"), "the general dense match is kept");
	assert.ok(!found.includes("prayer-walks"), "the nearest dense match is Phase 1 and is dropped");
	assert.equal(embedder.texts.length, 7, "one query per methodology topic");
});

test("reference.embedQuery embeds the same fixed topic text for every plant, with none of a plant's data", async () => {
	const first = fakeEmbedder();
	const second = fakeEmbedder();
	await run(T, first);
	await run(O, second);
	assert.deepEqual(first.texts, second.texts);
	for (const text of first.texts) {
		assert.doesNotMatch(text, /Oak Cliff|Elm Street|Adult \d|canary/i);
		assert.ok(!text.includes(T.id) && !text.includes(O.id));
	}
});

test("a passage found by both legs appears once, with its article, revision, source, section, text hash and version", async () => {
	const passages = await run(T, fakeEmbedder());
	const training = passages.filter((x) => x.slug === "training-and-preparation");
	assert.equal(training.length, 1);
	const revision = await c.one<{ article_id: string; revision_number: number }>(
		sql`SELECT article_id,revision_number FROM article_revision WHERE id=${r1.revisions["training-and-preparation"]!}`,
	);
	const text = "In Training and Preparation every team member finishes the required training for their ministry.";
	const { key, ...rest } = training[0]!;
	assert.match(key, /^passage:\d+$/);
	assert.deepEqual(rest, {
		articleId: revision.article_id,
		revisionId: r1.revisions["training-and-preparation"],
		sourceKind: "global",
		sourceId: GLOBAL,
		title: "training and preparation",
		slug: "training-and-preparation",
		section: "Required training",
		phase: 3,
		text,
		textHash: createHash("sha256").update(text).digest("hex"),
		version: { release: "methodology-r1", activation: 1, revision: revision.revision_number },
	});
	assert.equal(new Set(passages.map((x) => `${x.revisionId}#${x.section}`)).size, passages.length);
});

test("each query embedding records its tokens under the daily query spend", async () => {
	const before = await spent();
	await run(T, fakeEmbedder({ tokens: 5 }));
	assert.equal(await spent(), before + 35);
});

test("a refused embedding records its tokens, makes no further call and the run stays grounded on the sparse leg", async (t) => {
	const log = t.mock.method(console, "error", () => {});
	const before = await spent();
	const embedder = fakeEmbedder({ fail: () => new EmbeddingRefusal("openai_refused", 3) });
	const found = slugs(await run(T, embedder));
	assert.equal(embedder.texts.length, 1);
	assert.equal(await spent(), before + 3);
	assert.ok(found.includes("training-and-preparation"), "sparse candidates still ground the run");
	assert.ok(!found.includes("launch-team-huddle") && !found.includes("planter-sabbath"));
	assert.deepEqual(skips(log.mock.calls), ["openai_refused"]);
});

test("at the daily query cap no provider call is made and the run uses the sparse leg alone", async (t) => {
	const log = t.mock.method(console, "error", () => {});
	const before = await spent();
	const cap = tokensFor(DAILY_QUERY_CAP_USD);
	await c.admin.execute(sql`INSERT INTO embedding_spend(day,purpose,usage)
		VALUES((clock_timestamp() AT TIME ZONE 'UTC')::date,'query',${cap}::bigint)
		ON CONFLICT (day,purpose) DO UPDATE SET usage=EXCLUDED.usage`);
	try {
		const embedder = fakeEmbedder();
		const found = slugs(await run(T, embedder));
		assert.equal(embedder.texts.length, 0);
		assert.equal(await spent(), cap);
		assert.ok(found.includes("training-and-preparation"));
		assert.ok(!found.includes("launch-team-huddle"));
		assert.deepEqual(skips(log.mock.calls), ["daily_limit"]);
	} finally {
		await c.admin.execute(sql`UPDATE embedding_spend SET usage=${before}::bigint
			WHERE day=(clock_timestamp() AT TIME ZONE 'UTC')::date AND purpose='query'`);
	}
});

for (const [name, embedder, reason, calls] of [
	["no embedder is configured", null, "no_embedder", 0],
	[
		"the embedder's profile differs from the activated release",
		fakeEmbedder({ profile: "other/2" }),
		"profile_mismatch",
		0,
	],
	[
		"the embedder's dimensions differ from the activated release",
		fakeEmbedder({ dimensions: 768 }),
		"profile_mismatch",
		0,
	],
	["the provider fails", fakeEmbedder({ fail: () => new Error("network down") }), "embedding_failed", 1],
] as const)
	test(`when ${name} the dense leg is skipped, logged, and the run stays grounded on sparse candidates`, async (t) => {
		const log = t.mock.method(console, "error", () => {});
		const before = await spent();
		const found = slugs(await run(T, embedder));
		assert.ok(found.includes("training-and-preparation"));
		assert.ok(!found.includes("launch-team-huddle") && !found.includes("planter-sabbath"));
		assert.equal(embedder?.texts.length ?? 0, calls);
		assert.equal(await spent(), before);
		assert.deepEqual(skips(log.mock.calls), [reason]);
	});

test("the dense leg returns a network's passage only while the plant's affiliation is active and shares its Wiki", async () => {
	const article = randomUUID();
	const revision = randomUUID();
	await c.admin.execute(
		sql`INSERT INTO reference_item(id,kind,canonical_key,tenant_id) VALUES(${article},'article','network/prayer-chain',${N.id})`,
	);
	await c.admin
		.execute(sql`INSERT INTO article_revision(id,article_id,tenant_id,revision_number,title,slug,excerpt,body,
		content_type,phase,position,content_hash,published_at,meaningful,meaningful_sequence,section_id)
		VALUES(${revision},${article},${N.id},1,'Our prayer chain','network/prayer-chain','Prayer chain',
		${"How this network prays.\n## The prayer chain\nEach planter phones two others every Monday to pray together."},
		'safe_nodes',null,1,${hash()},clock_timestamp(),true,1,${section})`);
	await c.admin
		.execute(sql`INSERT INTO article_editor_state(id,organization_id,article_id,state,current_revision_id,revision)
		VALUES(${randomUUID()},${N.id},${article},'published',${revision},1)`);
	await passage(null, N.id, revision, axis(0));

	const shared = await run(P, fakeEmbedder());
	const chain = shared.find((x) => x.slug === "network/prayer-chain");
	assert.deepEqual([chain?.sourceKind, chain?.sourceId], ["network", N.id], "the network's dense match is returned");

	await c.admin.execute(sql`UPDATE affiliation SET share_wiki=false WHERE id=${P.affiliation}`);
	assert.ok(!(await run(P, fakeEmbedder())).some((x) => x.sourceKind === "network"), "not while the Wiki is unshared");
	await c.admin.execute(
		sql`UPDATE affiliation SET share_wiki=true,ended_at=clock_timestamp() WHERE id=${P.affiliation}`,
	);
	const ended = await run(P, fakeEmbedder());
	assert.ok(!ended.some((x) => x.sourceKind === "network"), "an ended organization's passage is never returned");
	assert.doesNotMatch(JSON.stringify(ended), /prayer chain|phones two others/i);
});

test("both legs read global articles only from the latest activated release", async () => {
	const r2 = await c.release("methodology-r2");
	await embeddable(r2.id);
	const fresh = await globalArticle(
		r2.id,
		["release-two-rest", null, "Rest.\n## Resting\nRest each week."],
		near(0, 4, 0.9),
	);
	await passage(r2.id, GLOBAL, r2.revisions["training-and-preparation"]!, near(0, 3, 0.85));

	const second = await run(T, fakeEmbedder());
	assert.ok(slugs(second).includes("release-two-rest"));
	assert.ok(!slugs(second).includes("launch-team-huddle"), "an earlier release's dense passage is not returned");
	const r2Revisions = new Set([...Object.values(r2.revisions), fresh]);
	assert.ok(second.every((x) => x.version.release === "methodology-r2" && r2Revisions.has(x.revisionId)));

	await c.admin.execute(sql`UPDATE reference_release SET expected_passages=(SELECT count(*) FROM passage
		WHERE release_id=${r1.id}) WHERE id=${r1.id}`);
	await c.activate(r1.id);
	const rolledBack = await run(T, fakeEmbedder());
	assert.ok(slugs(rolledBack).includes("launch-team-huddle"));
	assert.ok(!slugs(rolledBack).includes("release-two-rest"), "a release that is no longer activated is not returned");
	const r1Revisions = new Set(Object.values(r1.revisions));
	assert.ok(
		rolledBack.every((x) => x.version.release === "methodology-r1" && x.version.activation === 3),
		JSON.stringify(rolledBack.map((x) => x.version)),
	);
	assert.ok(
		rolledBack.filter((x) => x.slug === "training-and-preparation").every((x) => r1Revisions.has(x.revisionId)),
	);
});
