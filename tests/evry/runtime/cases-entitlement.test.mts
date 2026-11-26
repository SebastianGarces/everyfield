import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { randomBytes, randomUUID } from "node:crypto";
import { createWikiProducer } from "../../../packages/domain/src/wiki/index.ts";
import { observeRun } from "../../../packages/evry/src/index.ts";
import { ok } from "../../support/fixture.mts";
import { failingWrite, untouched } from "../../support/recorded.mts";
import { FOREIGN_LINE, GLOBAL, NETWORK_LINE, seedWiki, wikiIds } from "../adapters/wiki/corpus.mts";
import { caseWorld, reads, rowsOf, sql, type CaseWorld, type Play } from "./case-world.mts";

type Json = ReturnType<typeof JSON.parse>;
const CASE: Json = JSON.parse(
	readFileSync(new URL("../../../docs/acceptance/knowledge.json", import.meta.url), "utf8"),
).cases.find((c: Json) => c.id === "WIKI-ENTITLEMENT-001");
const wiki = createWikiProducer();
const ids = wikiIds(randomUUID);
const [S1, S2] = [ids.network, ids.foreignNetwork];
const articleId = ids.vision.article;

let w: CaseWorld;
before(async () => {
	w = await caseWorld("caseentitle", { now: CASE.clock.now });
});
after(() => w?.close());

test("AC:WIKI-ENTITLEMENT-001 an ended church's words leave history, cache, export, stream, citation and Evry, through a rollback, and the other church's stay", async () => {
	const c = await w.church();
	const run = w.admin.execute.bind(w.admin);
	await seedWiki((query) => run(query), c.P.id, ids);
	await run(sql`UPDATE organization SET kind='sending_church' WHERE id IN (${S1},${S2})`);
	await run(sql`INSERT INTO affiliation(id,plant_id,organization_id,accepted_at,share_people,share_meetings,share_tasks,share_ministry_teams,share_wiki,share_activity,shared_findings)
		VALUES(${randomUUID()},${c.P.id},${S2},clock_timestamp()-interval '1 hour',false,false,false,false,true,false,false)`);
	const who = () => w.authorityOf(c.A);
	const cmd = (input: object, expectedRevision = "0") => ({ requestKey: randomUUID(), expectedRevision, input });
	const order = ok(await wiki.setSourceOrder(w.db, await who(), cmd({ churches: [S1, S2], networks: [] })));
	assert.equal(order.errorCode, null);

	const source = { kind: "organization" as const, organizationId: S1 };
	const pdf = async (view?: typeof source) => {
		const made = ok(await wiki.exportPdf(w.db, await who(), { articleId, ...(view && { source: view }) }));
		return made.bytes
			? Buffer.from(made.bytes, "base64")
					.toString("latin1")
					.replaceAll(/\) Tj[^(]*\(/g, " ")
			: made;
	};
	const said = "Read the start of the vision meeting article and cite it";
	const play: Play = [reads("wiki.search", { query: "vision meeting" }), reads("wiki.referenceExcerpt", { articleId })];
	const cited = await w.ask(c.A, said, play);
	const mark = NETWORK_LINE.slice(0, 40);
	assert.ok(JSON.stringify(cited.replies[1]).includes(NETWORK_LINE), "the answer cites S1 while it is linked");
	assert.ok(cited.saved.includes(NETWORK_LINE));
	const stream = async () => {
		const actor = await w.actorOf(c.A);
		const seen: unknown[] = [];
		for await (const item of observeRun(w.db, actor, cited.conversation, 0, new AbortController().signal))
			seen.push(item);
		return seen;
	};

	const surfaces: Record<string, () => Promise<unknown[]>> = {
		history: async () => [
			await wiki.readingRecent(w.db, await who(), {}),
			await wiki.readingResume(w.db, await who(), {}),
			await wiki.bookmarksList(w.db, await who(), {}),
			await wiki.getArticle(w.db, await who(), { articleId, source }),
		],
		cache: async () => [
			await wiki.getArticle(w.db, await who(), { articleId }),
			await wiki.listArticles(w.db, await who(), {}),
			await wiki.search(w.db, await who(), { query: "network coach Dana Price" }),
			await wiki.navigation(w.db, await who(), { source }),
			await wiki.referenceExcerpt(w.db, await who(), { articleId, source }),
		],
		export: async () => [
			await pdf(source),
			await pdf(),
			await wiki.printArticle(w.db, await who(), { articleId, source }),
			await wiki.printArticle(w.db, await who(), { articleId }),
		],
		stream,
		citation: async () => [(await w.eventsOf(await w.actorOf(c.A), cited.conversation)).events],
		Evry: async () => {
			const asked = await w.ask(c.A, said, play, { conversation: cited.conversation });
			return [asked.replies, asked.prompts, asked.saved];
		},
	};
	assert.deepEqual(Object.keys(surfaces), CASE.given["case-input"].surfaces);
	ok(await wiki.recordView(w.db, await who(), { requestKey: randomUUID(), input: { articleId, plantId: c.P.id } }));
	ok(await wiki.setBookmark(w.db, await who(), cmd({ articleId, desired: true }, "1")));
	for (const [name, open] of Object.entries(surfaces))
		assert.ok(JSON.stringify(await open()).includes(mark), `${name} carries S1's words while it is linked`);

	await run(sql`UPDATE affiliation SET ended_at=clock_timestamp() WHERE id=${ids.affiliation}`);
	const hash = () => randomBytes(32).toString("hex");
	const second = randomUUID();
	await run(sql`INSERT INTO reference_release(id,release_key,artifact_locator,manifest_hash,state,complete_at,validated_at,approval_locator,approval_hash,chunker_version,embedding_profile,embedding_dimensions,tenant_id,expected_passages)
		VALUES(${second},${second},'memory://case',${hash()},'validated',clock_timestamp(),clock_timestamp(),'memory://approval',${hash()},'v','profile',1,${GLOBAL},0)`);
	for (const [number, release] of [
		[2, second],
		[3, ids.release],
	] as const)
		await run(sql`INSERT INTO reference_activation(id,release_id,activation_number,activated_at,actor_tombstone,reason,expected_prior_number)
			VALUES(${randomUUID()},${release},${number},clock_timestamp(),'synthetic','case',${number - 1})`);

	const bodies: (string | null)[] = [];
	const look = (open: () => Promise<unknown[]>) =>
		open().then((seen) => bodies.push(JSON.stringify(seen).includes(mark) ? NETWORK_LINE : null));
	await failingWrite(w.admin, { on: "audit_event", event: "INSERT" }, () =>
		untouched(w.admin, async () => {
			for (const name of ["history", "cache", "export", "stream", "citation"] as const) await look(surfaces[name]!);
		}),
	);
	await look(surfaces.Evry!);
	const expected = CASE.expected.result;
	assert.deepEqual(bodies, expected.S1_body_by_surface);

	const gone = ok(await wiki.getArticle(w.db, await who(), { articleId, source }));
	assert.deepEqual([gone.article, gone.errorCode], [null, "content_access_denied"]);
	const now = ok(await wiki.getArticle(w.db, await who(), { articleId }));
	assert.equal(now.article!.sourceId === S2 && now.article!.body!.includes(FOREIGN_LINE), expected.S2_resolves);
	const kept = ok(await wiki.listArticles(w.db, await who(), {}));
	assert.equal(JSON.stringify(kept.churches) !== JSON.stringify([S2]), expected.blanket_revoke);
	assert.ok(kept.articles.length > 1, "the global Wiki stays");
	const asked = await w.ask(c.A, said, play);
	assert.deepEqual(
		rowsOf(asked.replies[1]).map((r) => r.id),
		[ids.vision.foreign],
	);
	assert.ok(JSON.stringify(asked.replies[1]).includes(FOREIGN_LINE));
});
