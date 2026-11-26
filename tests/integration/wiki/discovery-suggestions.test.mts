import assert from "node:assert/strict";
import test, { after, before } from "node:test";
import foundations from "../../../docs/reference/discovery-foundations.json" with { type: "json" };
import { sql } from "../../../packages/db/src/query.ts";
import { ok, type Actor } from "../../support/fixture.mts";
import { wikiWorld } from "./case-world.mts";

let w: Awaited<ReturnType<typeof wikiWorld>>;
const six = foundations.articles.map((article) => article.id);
const phaseOne: string[] = [];
let phaseTwo: string[] = [];
before(async () => {
	w = await wikiWorld("wikidiscovery");
	for (const slug of ["a-phase-one", "b-phase-one"])
		phaseOne.push((await w.article({ slug, title: slug, phase: 1 })).id);
	phaseTwo = [(await w.article({ slug: "c-phase-two", title: "c-phase-two", phase: 2 })).id];
	for (const { id, slug, title } of foundations.articles) await w.article({ id, slug, title, phase: 1 });
});
after(() => w?.close());

async function planter() {
	const who = await w.f.actor(null);
	await w.admin.execute(sql`INSERT INTO discovery(account_id) VALUES(${who.id})`);
	return who;
}
const suggested = async (who: Actor) =>
	ok(await w.api.recommendForPhase(w.db, await w.actor(who), {})).articles.map((article) => article.articleId);
const finish = async (who: Actor, ids: readonly string[], ratio: number | string = 0.9) => {
	for (const id of ids) await w.progress(who, id, ratio);
};

test("a Discovery planter is suggested only the foundations not finished, in the foundations order", async () => {
	const none = await planter();
	assert.deepEqual(await suggested(none), six);
	const two = await planter();
	await finish(two, [six[0]!, six[2]!]);
	assert.deepEqual(await suggested(two), [six[1], six[3], six[4], six[5]]);
	const five = await planter();
	await finish(five, six.slice(0, 5));
	assert.deepEqual(await suggested(five), [six[5]]);
});

test("a foundation read at 0.80 or less stays suggested and one finished above 0.80 leaves the list", async () => {
	const who = await planter();
	await w.progress(who, six[0]!, "0.50");
	assert.deepEqual(await suggested(who), six);
	await w.progress(who, six[0]!, "0.80");
	assert.equal((await w.kept(who, six[0]!)).done, false);
	assert.deepEqual(await suggested(who), six);
	await w.admin
		.execute(sql`UPDATE reading SET completed_at=clock_timestamp(),completed_revision_id=last_revision_id,completed_fraction=0.80
		WHERE account_id=${who.id} AND article_id=${six[0]}`);
	assert.equal((await w.kept(who, six[0]!)).done, true, "a completion stored at 0.80 is not finished");
	assert.deepEqual(await suggested(who), six);
	await w.progress(who, six[0]!, "0.81");
	assert.deepEqual(await suggested(who), six.slice(1));
});

test("with all six finished a Discovery planter is suggested the Phase 1 articles not finished", async () => {
	const who = await planter();
	await finish(who, six);
	assert.deepEqual(await suggested(who), phaseOne);
	await finish(who, [phaseOne[0]!]);
	assert.deepEqual(await suggested(who), [phaseOne[1]]);
	await finish(who, [phaseOne[1]!]);
	assert.deepEqual(await suggested(who), phaseTwo, "unread articles remain, so the list is never empty");
});

test("church seats and seatless accounts without a Discovery profile keep the phase and catalog suggestions", async () => {
	const all = ok(await w.api.listArticles(w.db, await w.actor(await w.f.actor(null)), {})).articles;
	const seatless = await w.f.actor(null);
	await finish(seatless, [six[0]!]);
	assert.deepEqual(
		await suggested(seatless),
		all.map((article) => article.articleId),
	);
	const { P } = await w.church();
	for (const role of ["owner", "admin", "member"] as const) {
		const seat = await w.f.actor(P, role);
		const reply = ok(await w.api.recommendForPhase(w.db, await w.actor(seat), {}));
		assert.equal(reply.phase, 1);
		assert.deepEqual(
			reply.articles.map((article) => article.articleId),
			all.filter((article) => article.phase === 1).map((article) => article.articleId),
		);
	}
});

test("a foundation the planter cannot read is never suggested", async () => {
	const who = await planter();
	await w.admin.execute(sql`UPDATE article_revision SET published_at=NULL WHERE article_id=${six[1]}`);
	try {
		assert.deepEqual(await suggested(who), [six[0], ...six.slice(2)]);
		await finish(who, [six[0]!, ...six.slice(2)]);
		assert.deepEqual(await suggested(who), phaseOne);
	} finally {
		await w.admin.execute(sql`UPDATE article_revision SET published_at=clock_timestamp() WHERE article_id=${six[1]}`);
	}
});
