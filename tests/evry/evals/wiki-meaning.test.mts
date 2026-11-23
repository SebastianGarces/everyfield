import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { sql } from "../../../packages/db/node_modules/drizzle-orm/index.js";
import type { Database } from "../../../packages/db/src/client.ts";
import { readViewer } from "../../../packages/domain/src/access/session.ts";
import {
	createConversation,
	evryActor,
	invokeRead,
	readConversation,
	runTurn,
	selectQualifiedModel,
	submitTurn,
	type EvryActor,
} from "../../../packages/evry/src/index.ts";
import { search } from "../../../packages/evry/src/adapters/wiki/reads/index.ts";
import type { SourceResult } from "../../../packages/evry/src/catalog/types.ts";
import { transaction } from "../../../packages/domain/src/jobs/transaction.ts";
import { claimDue, finishClaim } from "../../../packages/domain/src/jobs/queue.ts";
import { RequestActor } from "../../../packages/domain/src/access/session.ts";
import { createWikiProducer } from "../../../packages/domain/src/wiki/index.ts";
import { runDueWikiEmbedding, wikiPassageEmbedder } from "../../../packages/domain/src/wiki/embedding.ts";
import { ACTOR_SPECS, evalDatabase, seedHope, WIKI } from "./golden-church.mts";
import { VISION_OPENING, VISION_SLUG, VISION_TITLE } from "../adapters/wiki/corpus.mts";

type Case = { id: string; criterion: number; given: string; ask: string; search: string[]; answer: string[] };
type NetworkVersion = { revision: string };
const { cases } = JSON.parse(readFileSync(new URL("./wiki-meaning.cases.json", import.meta.url), "utf8")) as {
	cases: Case[];
};

const DIMENSIONS = 1536;
const QUESTION = "getting people excited about our church's direction";
const axis = (index: number) => Array.from({ length: DIMENSIONS }, (_, at) => (at === index ? 1 : 0));
const near = Array.from({ length: DIMENSIONS }, (_, at) => (at === 0 ? 0.8 : at === 1 ? 0.6 : 0));
const NETWORK_QUESTION = "showing gratitude to first-time guests";
const NETWORK_TEXT = "Harvest planters mail a handwritten card within a week, signed by the whole team.";
const VECTORS: Record<string, number[]> = { [QUESTION]: near, [NETWORK_QUESTION]: axis(3), [NETWORK_TEXT]: axis(3) };
const SNIPPET = VISION_OPENING.split(/\s+/).slice(0, 20).join(" ");
const THANKS_SLUG = "core-group/follow-up/thank-you-notes";
const editorSession = randomUUID();
let networkVersion: NetworkVersion | null = null;

let close: () => Promise<void>;
let db: Database;
let admin: Database;
let owner: EvryActor;
const asked: string[] = [];
const model = selectQualifiedModel({ EVRY_SCRIPTED_MODEL: "1" });
const freshActor = async (session: string) => {
	const viewer = await readViewer(db, session as never);
	return viewer?.authority ? evryActor(viewer.authority) : null;
};
const realFetch = globalThis.fetch;
const env = { EVF_WIKI_EMBEDDINGS: process.env.EVF_WIKI_EMBEDDINGS, OPENAI_API_KEY: process.env.OPENAI_API_KEY };

before(async () => {
	const database = await evalDatabase({ prefix: "evrywikimeaning", max: 10 });
	close = database.close;
	db = database.pools.runtime;
	admin = database.admin;
	await seedHope(database.admin, { seatNames: true });
	await admin.execute(sql`UPDATE reference_release SET embedding_profile='openai-text-embedding-3-small',
		embedding_dimensions=${DIMENSIONS} WHERE id=${WIKI.release}`);
	const globals = [WIKI.vision.global, WIKI.planted.global, WIKI.drafted.global, ...WIKI.phaseTwo.map((a) => a.global)];
	for (const [index, revision] of globals.entries())
		await admin.execute(sql`INSERT INTO passage(release_id,revision_id,tenant_id,ordinal,content,content_hash,embedding,embedding_checksum)
			SELECT ${WIKI.release}, r.id, r.tenant_id, 0, r.body, md5(r.body), ${`[${axis(index * 2).join(",")}]`}::public.vector, md5(r.id::text)
			FROM article_revision r WHERE r.id=${revision}`);
	owner = (await freshActor(ACTOR_SPECS.owner.session))!;
	process.env.EVF_WIKI_EMBEDDINGS = "openai";
	process.env.OPENAI_API_KEY = "sk-test-wiki-meaning-eval";
	globalThis.fetch = async (url, init) => {
		assert.equal(String(url), "https://api.openai.com/v1/embeddings", "the only network call is the stubbed embedding");
		const { input } = JSON.parse(String(init?.body)) as { input: string[] };
		asked.push(...input);
		const vector = VECTORS[input[0] ?? ""];
		if (!vector) return new Response("unknown question", { status: 500 });
		return new Response(JSON.stringify({ data: [{ index: 0, embedding: vector }], usage: { total_tokens: 9 } }), {
			status: 200,
		});
	};
});
after(async () => {
	globalThis.fetch = realFetch;
	for (const [name, value] of Object.entries(env))
		if (value === undefined) delete process.env[name];
		else process.env[name] = value;
	await close?.();
});

async function ask(text: string) {
	const conversationId = (await createConversation(db, owner, { requestKey: randomUUID() })).id;
	await submitTurn(db, owner, conversationId, { requestKey: randomUUID(), text, references: [] });
	const [claim] = await claimDue(db, ["assistant_turn"], 1, 240);
	assert.ok(claim, "the turn is queued");
	const outcome = await runTurn(
		{ db, model, freshActor, native: null },
		{ turnId: claim.id, tenantId: claim.tenant_id, leaseOwner: claim.lease_owner, generation: claim.claim_generation },
		{ claimStart: new Date(), claimEnd: new Date() },
	);
	await transaction(db, (tx) => finishClaim(tx, claim, { state: outcome === "failed" ? "failed" : "succeeded" }));
	assert.equal(outcome, "succeeded", text);
	const read = await readConversation(db, owner, conversationId);
	const turn = read.events.slice(read.events.findLastIndex((e) => e.kind === "user_message") + 1);
	return {
		answer: turn
			.flatMap((e) => (e.kind === "assistant_text" && typeof e.body.text === "string" ? [e.body.text] : []))
			.join(""),
		searched: turn
			.flatMap((e) => (e.kind === "tool_result" ? [e.body.result as SourceResult] : []))
			.filter((r) => r.operation === "wiki.search"),
	};
}
async function publishNetworkVersion(): Promise<NetworkVersion> {
	const account = randomUUID();
	const user = randomUUID();
	await admin.execute(
		sql`INSERT INTO auth_user(id,email,email_verified,name) VALUES(${user},${account + "@example.test"},true,'Harvest Editor')`,
	);
	await admin.execute(
		sql`INSERT INTO account(id,auth_user_id,registration_state,registration_kind) VALUES(${account},${user},'active','network')`,
	);
	await admin.execute(sql`INSERT INTO auth_session(id,user_id,token,expires_at)
		VALUES(${editorSession},${user},${randomUUID()},clock_timestamp()+interval '1 day')`);
	await admin.execute(sql`INSERT INTO seat(account_id,organization_id,role,accepted_at)
		VALUES(${account},${WIKI.network},'admin',clock_timestamp()-interval '1 minute')`);
	const editor = await RequestActor.resolve(db, editorSession as never);
	assert.ok(editor instanceof RequestActor);
	const body = JSON.stringify({
		format: "everyfield-editor-v1",
		blocks: [{ type: "paragraph", children: [{ type: "text", text: NETWORK_TEXT, marks: [] }] }],
	});
	const reply = await createWikiProducer().publishOrganizationArticle(db, editor, {
		requestKey: randomUUID(),
		expectedRevision: "1",
		input: { articleId: WIKI.drafted.article, organizationId: WIKI.network, body },
	});
	assert.equal(reply.status, "ok");
	assert.equal(await runDueWikiEmbedding(db, wikiPassageEmbedder(process.env), 5, Date.now() + 30_000), 1);
	const row = (
		await admin.execute(sql`SELECT current_revision_id AS revision FROM article_editor_state
			WHERE organization_id=${WIKI.network} AND article_id=${WIKI.drafted.article} AND state='published'`)
	).rows[0] as NetworkVersion | undefined;
	assert.ok(row, "the network's version is published");
	return row;
}
const removeNetworkVersion = async () => {
	await admin.execute(
		sql`DELETE FROM article_editor_state WHERE organization_id=${WIKI.network} AND article_id=${WIKI.vision.article}`,
	);
	await admin.execute(
		sql`DELETE FROM article_revision WHERE tenant_id=${WIKI.network} AND article_id=${WIKI.vision.article}`,
	);
};

test("INV-evry-wiki-meaning: Evry's wiki.search finds the vision meeting article by meaning and answers from it, never from a global text the church's Wiki does not show", async () => {
	for (const c of cases) {
		if (c.given === "network_version_removed") await removeNetworkVersion();
		if (c.given === "network_version_published") networkVersion = await publishNetworkVersion();
		const turn = await ask(c.ask);
		assert.equal(turn.searched.length, 1, `${c.id} searches once`);
		assert.deepEqual(
			turn.searched[0]!.rows.map((r) => r.label),
			c.search,
			`${c.id} search rows`,
		);
		for (const text of c.answer)
			assert.ok(turn.answer.includes(text), `${c.id} answer ${JSON.stringify(turn.answer)} has ${text}`);
	}
	assert.deepEqual(
		asked,
		[QUESTION, QUESTION, NETWORK_TEXT, NETWORK_QUESTION],
		"each turn embeds the question once, and the publish job embeds the network's text once",
	);
});

test("INV-evry-wiki-meaning-adapter: wiki.search returns the vision meeting passage and link for a question with none of its words, with an unchanged input schema", async () => {
	assert.deepEqual(Object.keys((search.input as unknown as { shape: Record<string, unknown> }).shape), ["query"]);
	const result = await invokeRead(db, owner, search as never, { query: QUESTION });
	assert.deepEqual(result, {
		operation: "wiki.search",
		status: "available",
		rows: [
			{
				kind: "article",
				id: WIKI.vision.global,
				label: VISION_TITLE,
				fields: {
					articleId: WIKI.vision.article,
					href: `/wiki/${VISION_SLUG}`,
					source: "global",
					snippet: SNIPPET,
				},
			},
		],
		total: 1,
		page: 1,
		next: null,
		completeness: "complete",
		exclusions: ["article text beyond the snippet", "drafts", "hidden articles"],
	});
});

test("INV-evry-wiki-meaning-network-adapter: wiki.search returns a network's own published version by meaning, with its passage and link", async () => {
	assert.ok(networkVersion, "the eval published the network's version first");
	const result = await invokeRead(db, owner, search as never, { query: NETWORK_QUESTION });
	assert.deepEqual(result, {
		operation: "wiki.search",
		status: "available",
		rows: [
			{
				kind: "article",
				id: networkVersion.revision,
				label: "Thank-You Notes",
				fields: {
					articleId: WIKI.drafted.article,
					href: `/wiki/${THANKS_SLUG}`,
					source: "network",
					snippet: NETWORK_TEXT,
				},
			},
		],
		total: 1,
		page: 1,
		next: null,
		completeness: "complete",
		exclusions: ["article text beyond the snippet", "drafts", "hidden articles"],
	});
});
