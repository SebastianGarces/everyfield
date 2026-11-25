import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createWikiProducer } from "../../../packages/domain/src/wiki/index.ts";
import {
	DRAFT_LINE,
	FOREIGN_LINE,
	NETWORK_LINE,
	seedWiki,
	VISION_OPENING,
	VISION_TITLE,
	wikiIds,
} from "../adapters/wiki/corpus.mts";
import { ok, type Actor } from "../../support/fixture.mts";
import { caseWorld, propose, read, rowsOf, sql, type CaseWorld, type Reply } from "./case-world.mts";
import { seedFoundations } from "./foundations.mts";

let w: CaseWorld;
before(async () => {
	w = await caseWorld("familylibrary");
});
after(() => w?.close());
const wiki = createWikiProducer();

const RATIOS = ["0.81", "0.81", "0.81", "0.81", "0.81", "0.80"];
test("AC:EVRY-FAMILY-WIKI only the winning allowed version is quoted, credit is one reader's own past 80 percent, and a departed source's words go while the credit stays", async () => {
	const c = await w.church();
	const ids = wikiIds(randomUUID);
	await seedWiki((query) => w.admin.execute(query), c.P.id, ids);
	const g = await seedFoundations(w.admin);
	const copied = (from: string, to: string, articles: string[], body = sql`body`) =>
		w.admin
			.execute(sql`INSERT INTO article_revision(id,article_id,tenant_id,release_id,revision_number,title,slug,excerpt,body,content_type,phase,position,content_hash,published_at,meaningful,meaningful_sequence,section_id,related_slugs)
			SELECT gen_random_uuid(),article_id,tenant_id,${to},revision_number+1,title,slug,excerpt,${body},content_type,phase,position,md5(${to}||id::text),clock_timestamp(),true,revision_number+1,section_id,related_slugs
			FROM article_revision WHERE release_id=${from} AND article_id=ANY(${sql.param(articles)}::uuid[])`);
	const activate = (release: string) =>
		w.admin
			.execute(sql`INSERT INTO reference_activation(id,release_id,activation_number,activated_at,actor_tombstone,reason,expected_prior_number)
			SELECT gen_random_uuid(),${release},n+1,clock_timestamp(),'synthetic','again',n FROM (SELECT max(activation_number) AS n FROM reference_activation) prior`);
	const { release: other } = await w.one<{ release: string }>(
		sql`SELECT release_id AS release FROM reference_activation ORDER BY activation_number DESC LIMIT 1`,
	);
	await copied(other, ids.release, g);
	await activate(ids.release);
	const B = await w.seated(c.P, "admin");
	const authority = (who: Actor) => w.authorityOf(who);
	const progress = async (who: Actor, articleId: string, fraction: string) =>
		ok(
			await wiki.updateProgress(w.db, await authority(who), {
				requestKey: randomUUID(),
				input: { articleId, fraction },
			}),
		);
	const reading = () =>
		w.rows(
			sql`SELECT account_id,article_id,observed_fraction::text AS seen,completed_at IS NOT NULL AS done FROM reading ORDER BY 1,2`,
		);

	for (const [n, ratio] of RATIOS.entries()) await progress(c.A, g[n]!, ratio);
	await progress(B, g[5]!, "0.9");
	const credit = await reading();
	const stats = async (who: Actor) => {
		const { facts } = await w.look(who, "wiki.reading.stats", {});
		const own = ok<Reply>(await wiki.readingStats(w.db, await authority(who), {}));
		return [facts.discoveryRead, facts.discoveryTotal, facts.discoveryComplete, own.qualifyingReader];
	};
	assert.deepEqual(
		{ A: await stats(c.A), B: await stats(B) },
		{ A: [5, 6, false, false], B: [1, 6, false, false] },
		"exactly 80 percent is not read and two readers never pool",
	);
	const [criterion] = rowsOf(await w.look(c.A, "phases.readReadiness", { phase: 0 }), "criterion").filter(
		(r) => r.id === "foundations_complete",
	);
	assert.notEqual(criterion.fields.status, "met");
	await w.quiet(() =>
		w.ask(c.A, "Read the foundations", [() => g.map((articleId) => read("wiki.referenceExcerpt", { articleId }))]),
	);
	assert.deepEqual(await reading(), credit, "Evry's reading earns no credit");
	const resumed = rowsOf(await w.look(c.A, "wiki.reading.resume", {}));
	assert.equal(g.includes(resumed[0].fields.articleId), true);
	const recent = rowsOf(await w.look(c.A, "wiki.reading.recent", {}));
	assert.deepEqual(recent.map((r) => r.fields.articleId).sort(), [...g].sort());

	const find = async () => rowsOf(await w.look(c.A, "wiki.search", { query: "vision meeting" }));
	const V = ids.vision;
	const [shown] = await find();
	assert.deepEqual(
		[shown.id, shown.fields.articleId, shown.fields.source],
		[V.network, V.article, "network"],
		"one canonical article, the network's version wins",
	);
	assert.equal((await find()).length, 1);
	const excerpt = async () => rowsOf(await w.look(c.A, "wiki.referenceExcerpt", { articleId: V.article }));
	assert.match((await excerpt())[0].fields.excerpt, new RegExp(NETWORK_LINE));
	for (const line of [DRAFT_LINE, FOREIGN_LINE]) {
		const hidden = await w.look(c.A, "wiki.search", { query: line.slice(0, 40) });
		assert.equal(JSON.stringify(hidden).includes(line), false);
	}
	const drafted = rowsOf(await w.look(c.A, "wiki.referenceExcerpt", { articleId: ids.drafted.article }));
	assert.deepEqual([drafted[0].id, drafted[0].fields.source], [ids.drafted.global, "global"], "a draft never shows");
	const listed = rowsOf(await w.look(c.A, "wiki.articles.list", {}));
	assert.equal(listed.filter((r) => r.fields.articleId === V.article).length, 1);
	assert.equal(
		listed.some((r) => r.id === V.foreign || r.id === ids.drafted.draft),
		false,
	);
	const menu = rowsOf(await w.look(c.A, "wiki.navigation", {}));
	assert.equal(
		menu.reduce((n, r) => n + r.fields.articles, 0),
		listed.length,
	);
	const headings = rowsOf(await w.look(c.A, "wiki.tableOfContents", { articleId: V.article }));
	assert.deepEqual(
		headings.map((r) => r.label),
		[],
		"the network's version has no sections of the Wiki's",
	);
	const around = await w.look(c.A, "wiki.articleNeighbors", { articleId: ids.planted.article });
	assert.ok(rowsOf(around).some((r) => r.fields.articleId === ids.drafted.article || r.fields.articleId === V.article));
	const phase = rowsOf(await w.look(c.A, "wiki.recommendForPhase", {}));
	assert.ok(phase.length > 0 && phase.every((r) => listed.some((l) => l.id === r.id)));
	const guide = await w.look(c.A, "wiki.contextGuide", { route: "/meetings" });
	const native = ok<Reply>(await wiki.contextGuide(w.db, await authority(c.A), { route: "/meetings" }));
	assert.equal(rowsOf(guide).length === 1, native.found);
	const [pdf] = rowsOf(await w.look(c.A, "wiki.article.exportPdf", { articleId: V.article }));
	assert.deepEqual([pdf.id, pdf.fields.pdfHref], [V.network, `/api/wiki/pdf?article=${V.article}`]);
	const printed = ok<Reply>(await wiki.printArticle(w.db, await authority(c.A), { articleId: V.article }));
	assert.match(printed.html, new RegExp(NETWORK_LINE), "the print view and the PDF are the same shown version");

	const bookmark = await w.prepare(c.A, "wiki.bookmarks.set", { articleId: V.article });
	assert.deepEqual(rowsOf(await w.look(c.A, "wiki.bookmarks.list", {})), []);
	await w.approve(c.A, bookmark);
	assert.deepEqual(
		rowsOf(await w.look(c.A, "wiki.bookmarks.list", {})).map((r) => r.fields.articleId),
		[V.article],
	);
	await w.apply(c.A, "wiki.feedback.setMine", { articleId: V.article, vote: "helpful" });
	const mine = rowsOf(await w.look(c.A, "wiki.feedback.getMine", { articleId: V.article }));
	assert.deepEqual(
		mine.map((r) => [r.fields.articleId, r.fields.vote]),
		[[V.article, "helpful"]],
	);
	assert.deepEqual(rowsOf(await w.look(B, "wiki.feedback.getMine", {})), [], "each account's own vote");

	const N1 = { kind: "organization" as const, id: ids.network, organizationKind: "sending_network" as const };
	const director = await w.seated(N1, "admin");
	const bodyOf = (id: string) => w.one(sql`SELECT body,release_id FROM article_revision WHERE id=${id}`);
	const globalBefore = await bodyOf(ids.planted.global);
	const draftOf = async () =>
		ok<Reply>(
			await wiki.getOrganizationDraft(w.db, await authority(director), {
				articleId: ids.planted.article,
				organizationId: N1.id,
			}),
		);
	const seen = async () => rowsOf(await w.look(c.A, "wiki.referenceExcerpt", { articleId: ids.planted.article }))[0];
	await w.apply(director, "wiki.organizationArticles.add", {
		article: "Welcome Letters",
		text: "Network: sign each letter.",
	});
	assert.match(String((await draftOf()).body), /Network: sign each letter\./);
	assert.deepEqual(
		[(await seen()).fields.source, (await seen()).id],
		["global", ids.planted.global],
		"a draft changes nothing for the church",
	);
	await w.apply(director, "wiki.organizationArticles.edit", {
		article: "Welcome Letters",
		about: "sign each letter",
		text: "Network: sign each letter by hand.",
	});
	await w.apply(director, "wiki.organizationArticles.publish", { article: "Welcome Letters" });
	assert.equal((await seen()).fields.source, "network");
	const fork = (await seen()).id;
	const forkBody = await bodyOf(fork);
	await copied(ids.release, other, [ids.planted.article, V.article, ids.drafted.article], sql`'A newer global text.'`);
	await activate(other);
	assert.deepEqual([(await seen()).id, await bodyOf(fork)], [fork, forkBody], "the fork is not updated by the Wiki");
	assert.deepEqual(await bodyOf(ids.planted.global), globalBefore, "the global source is not overwritten");
	await activate(ids.release);
	const order = ok<Reply>(
		await wiki.setSourceOrder(w.db, await authority(c.A), {
			requestKey: randomUUID(),
			expectedRevision: "0",
			input: { churches: [], networks: [ids.network] },
		}),
	);
	assert.deepEqual([order.errorCode ?? null, order.networks], [null, [ids.network]], JSON.stringify(order));
	await w.apply(director, "wiki.organizationArticles.hide", { article: "Welcome Letters" });
	assert.equal(
		rowsOf(await w.look(c.A, "wiki.referenceExcerpt", { articleId: ids.planted.article })).some((r) =>
			/by hand/.test(JSON.stringify(r)),
		),
		false,
	);

	await progress(c.A, V.article, "0.9");
	const earned = (await reading()).find((r) => r.account_id === c.A.id && r.article_id === V.article);
	const cited = await w.ask(c.A, "What does it say?", [() => read("wiki.referenceExcerpt", { articleId: V.article })]);
	assert.match(JSON.stringify(cited.replies), new RegExp(NETWORK_LINE));
	const open = await w.prepare(c.A, "wiki.bookmarks.set", { articleId: ids.drafted.article });
	await c.foreignReview(open);
	await c.foreign(
		"What does our network say?",
		[
			() => [read("wiki.referenceExcerpt", { articleId: V.article }), read("wiki.search", { query: "vision meeting" })],
			() => read("wiki.bookmarks.list", {}),
			() => propose("wiki.organizationArticles.publish", { article: "Thank-You Notes" }),
		],
		{
			secrets: [NETWORK_LINE, DRAFT_LINE, FOREIGN_LINE],
			found: [VISION_TITLE, VISION_TITLE],
			shared: [V.article, V.global],
			on: { onError: "go_on" },
		},
	);
	await c.failedWrite(open, "reading");

	await w.admin.execute(sql`UPDATE affiliation SET ended_at=clock_timestamp() WHERE id=${ids.affiliation}`);
	const gone = await w.ask(c.A, "And now?", [() => read("wiki.referenceExcerpt", { articleId: V.article })], {
		conversation: cited.conversation,
	});
	assert.deepEqual(
		rowsOf(gone.replies[0]).map((r) => [r.id, r.fields.source]),
		[[V.global, "global"]],
	);
	assert.match(JSON.stringify(gone.replies), new RegExp(VISION_OPENING.slice(0, 40)));
	const { events } = await w.eventsOf(c.Aa, cited.conversation);
	for (const text of [JSON.stringify(gone.prompts), gone.saved, JSON.stringify(events)])
		assert.equal(text.includes(NETWORK_LINE), false, "the departed source's words are gone from history too");
	const [after] = rowsOf(await w.look(c.A, "wiki.article.exportPdf", { articleId: V.article }));
	assert.equal(after.id, V.global);
	assert.equal(
		ok<Reply>(await wiki.printArticle(w.db, await authority(c.A), { articleId: V.article })).html.includes(
			NETWORK_LINE,
		),
		false,
	);
	assert.deepEqual(
		(await reading()).find((r) => r.account_id === c.A.id && r.article_id === V.article),
		earned,
		"earned credit is kept",
	);
	assert.deepEqual(
		rowsOf(await w.look(c.A, "wiki.bookmarks.list", {}))
			.map((r) => r.fields.articleId)
			.sort(),
		[V.article, ids.drafted.article].sort(),
	);
});
