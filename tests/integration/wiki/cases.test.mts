import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test, { after, before } from "node:test";
import { sql } from "../../../packages/db/src/query.ts";
import { readViewer } from "../../../packages/domain/src/access/session.ts";
import { sessionId } from "../../../packages/contracts/src/common/values.ts";
import { documentsWriter } from "../../../packages/domain/src/documents/index.ts";
import { createWikiProducer, type WikiConfig } from "../../../packages/domain/src/wiki/index.ts";
import { wikiBlocks, type WikiArticle } from "../../../packages/contracts/src/wiki/index.ts";
import { referenceService } from "../../../packages/reference/src/starter/verify/service.ts";
import { WikiRefusal } from "../../../packages/reference/src/starter/verify/snapshot.ts";
import { ok, raced, refused, type Actor } from "../../support/fixture.mts";
import { NOTHING } from "../../support/recorded.mts";
import { nativeFromText } from "../../../packages/contracts/src/documents/native.ts";
import { GLOBAL, knowledgeCase, pdfText, present, wikiWorld } from "./case-world.mts";

let w: Awaited<ReturnType<typeof wikiWorld>>;
before(async () => {
	w = await wikiWorld("wikicases");
});
after(() => w?.close());

const organization = (o: { id: string }) => ({
	kind: "organization" as const,
	organizationId: o.id,
});
const denied = { article: null, errorCode: "content_access_denied" };
async function listed(who: Actor) {
	const found: WikiArticle[] = [];
	for (let page: number | null = 1; page !== null;) {
		const value: Extract<Awaited<ReturnType<typeof w.api.listArticles>>, { status: "ok" }>["value"] = ok(
			await w.api.listArticles(w.db, await w.actor(who), { page }),
		);
		found.push(...value.articles);
		page = value.nextCursor === null ? null : Number(value.nextCursor);
	}
	return found;
}
const pgCode = (error: unknown): unknown => {
	const { code, cause } = error as { code?: unknown; cause?: unknown };
	return code ?? (cause && pgCode(cause));
};
const caller = (who: Actor) => ({ actorId: who.id, userId: who.user, sessionId: who.session });

test("AC:CASE-WIKI-001 the church edit wins the list over the network edit and global, same-slug additions stay separate, and organization code is text", async () => {
	const { given, action, expected } = knowledgeCase("CASE-WIKI-001");
	const { S1_override, N1_override, global } = action.arguments;
	const { A } = await w.church([w.S1, w.N1]);
	const q = await w.church();
	const g1 = await w.article({ title: given.G1.title, body: global });
	await w.publish(w.S1, g1.id, S1_override);
	await w.publish(w.N1, g1.id, N1_override);
	const additions: { id: string; body: string }[] = [];
	for (const o of [w.S1, w.N1]) {
		const own = await w.article({
			tenant: o.id,
			slug: g1.slug,
			title: "Our own",
			body: o.id + " addition",
		});
		await w.admin
			.execute(sql`INSERT INTO article_editor_state(id,organization_id,article_id,state,current_revision_id,revision)
			VALUES(gen_random_uuid(),${o.id},${own.id},'published',${own.revisionId},1)`);
		additions.push({ ...own, body: o.id + " addition" });
	}
	const unsafe = await w.article({ title: "Unsafe" });
	const code = "import x from 'x'\n\nS1 text {6 * 7} <script>alert(1)</script>";
	await w.publish(w.S1, unsafe.id, code);

	await w.untouched(async () => {
		const mine = await listed(A);
		const shown = mine.filter((a) => a.articleId === g1.id);
		assert.deepEqual(
			shown.map((a) => [a.body, a.sourceKind, a.sourceId, a.title]),
			[[expected.result.default_body, "church", w.S1.id, "Preparing leaders"]],
		);
		assert.deepEqual(
			shown[0]!.alternates.map((a) => a.sourceId),
			[w.N1.id, GLOBAL],
		);
		for (const [source, body] of [
			[organization(w.N1), "N1 text"],
			[{ kind: "global" as const }, "Global text"],
		] as const)
			assert.equal((await w.view(A, g1.id, source)).article?.body, body);
		for (const own of additions)
			assert.deepEqual(
				mine.filter((a) => a.articleId === own.id).map((a) => [a.slug, a.body]),
				[[g1.slug, own.body]],
			);
		const theirs = await listed(q.A);
		assert.equal(theirs.find((a) => a.articleId === g1.id)?.body, "Global text");
		for (const own of additions)
			assert.equal(
				theirs.some((a) => a.articleId === own.id),
				false,
			);
		assert.deepEqual(await w.view(q.A, g1.id, organization(w.S1)), denied);

		const stored = present((await w.view(A, unsafe.id)).article, "unsafe article");
		assert.deepEqual([stored.contentType, stored.body], ["safe_nodes", code]);
		assert.deepEqual(
			wikiBlocks(stored.contentType, code)
				.flatMap((block) => (block.kind === "paragraph" ? block.paragraphs : []))
				.join("\n"),
			"import x from 'x'\nS1 text {6 * 7} alert(1)",
		);
		const html = present(
			ok(await w.api.printArticle(w.db, await w.actor(A), { articleId: unsafe.id })).html,
			"print html",
		);
		assert.equal(/<script/i.test(html), expected.result.executable_MDX_allowed);
		assert.ok(html.includes("import x from 'x'") && html.includes("{6 * 7}"), html);
	});
});

test("AC:CASE-WIKI-002 one slug encoding, a related list without missing, repeated or other-church articles, and headings in order", async () => {
	const { action, expected } = knowledgeCase("CASE-WIKI-002");
	const { slug, foreign_related } = action.arguments;
	const { A } = await w.church([w.S1]);
	const q = await w.church([w.S2]);
	const sibling = await w.article({ slug: "case-two/sibling", title: "Sibling" });
	const own = await w.article({
		tenant: w.S2.id,
		slug: foreign_related,
		title: "Q article",
		body: "Q only",
	});
	await w.admin
		.execute(sql`INSERT INTO article_editor_state(id,organization_id,article_id,state,current_revision_id,revision)
		VALUES(gen_random_uuid(),${w.S2.id},${own.id},'published',${own.revisionId},1)`);
	const g1 = await w.article({
		slug,
		body: "Prepare a leadership conversation.\n## First step\nText\n### Detail\nText\n## Second step\nText",
		related: [foreign_related, sibling.slug, "no/such-article", sibling.slug],
		parent: sibling.id,
	});
	const unicode = await w.article({ slug: "líderes/día uno", title: "Unicode" });
	await w.untouched(async () => {
		const nav = ok(await w.api.navigation(w.db, await w.actor(A), {}));
		const entries = nav.groups.flatMap((group) => group.articles);
		assert.equal(entries.find((a) => a.articleId === g1.id)?.encodedSlug, expected.result.encoded_slug);
		assert.equal(entries.find((a) => a.articleId === unicode.id)?.encodedSlug, "l%C3%ADderes%2Fd%C3%ADa%20uno");
		assert.equal(
			entries.some((a) => a.articleId === own.id),
			expected.result.foreign_related_visible,
		);
		const around = ok(await w.api.articleNeighbors(w.db, await w.actor(A), { articleId: g1.id }));
		assert.deepEqual(
			around.related.map((a) => a.articleId),
			[sibling.id],
		);
		assert.deepEqual((await w.view(A, g1.id)).article?.relatedIds, [sibling.id]);
		assert.deepEqual((await w.view(q.A, g1.id)).article?.relatedIds, [own.id, sibling.id]);
		assert.equal((await w.view(A, g1.id)).article?.sectionKey, "section-1");
		const toc = ok(await w.api.tableOfContents(w.db, await w.actor(A), { articleId: g1.id }));
		assert.deepEqual(toc.headings, [
			{ level: 2, text: "First step" },
			{ level: 3, text: "Detail" },
			{ level: 2, text: "Second step" },
		]);
	});
});

test("AC:CASE-WIKI-003 search pages 20 of a phase, leaves hidden and foreign text out, and a database timeout is unavailable and never an empty result", async () => {
	const { action, expected } = knowledgeCase("CASE-WIKI-003");
	const { query, limit, phase } = action.arguments;
	const { A } = await w.church([w.S1]);
	const q = await w.church([w.S2]);
	const wanted = new Set<string>();
	for (let n = 0; n <= limit; n++)
		wanted.add(
			(
				await w.article({
					phase,
					title: n % 2 ? `Quillwork ${n}` : "Other",
					body: "Quillwork for leaders",
				})
			).id,
		);
	const other = await w.article({ phase: 2, title: "Quillwork for leaders" });
	const hidden = await w.article({ phase, title: "Quillwork for leaders hidden" });
	await w.publish(w.S1, hidden.id, "Quillwork leaders S1");
	ok(
		await w.api.hideOrganizationArticle(
			w.db,
			await w.actor(w.S1.editor),
			w.cmd({ articleId: hidden.id, organizationId: w.S1.id }, "1"),
		),
	);
	await w.untouched(async () => {
		const search = async (page: number) =>
			ok(await w.api.search(w.db, await w.actor(A), { query: `quillwork ${query}`, phase, page }, null));
		const first = await search(1);
		assert.ok(first.status === "results");
		assert.equal(first.results.length, limit);
		assert.equal(first.nextCursor, "2");
		const second = await search(2);
		assert.ok(second.status === "results");
		assert.equal(second.nextCursor, null);
		const found = [...first.results, ...second.results].map((a) => a.articleId);
		assert.deepEqual(found.toSorted(), [...wanted].toSorted());
		for (const out of [other, hidden]) assert.equal(found.includes(out.id), false);
		const inGlobal = ok(
			await w.api.search(w.db, await w.actor(A), { query: "quillwork hidden", source: { kind: "global" } }, null),
		);
		assert.deepEqual(
			inGlobal.results?.map((a) => a.articleId),
			[hidden.id],
		);
		const foreign = ok(
			await w.api.search(w.db, await w.actor(q.A), { query: "quillwork", source: organization(w.S1) }, null),
		);
		assert.deepEqual(foreign, { status: "empty", results: [], nextCursor: null });
		await w.admin.transaction(async (tx) => {
			await tx.execute(sql`LOCK TABLE article_revision IN ACCESS EXCLUSIVE MODE`);
			const blocked = ok(await w.api.search(w.db, await w.actor(A), { query, phase }, null));
			assert.deepEqual(blocked, {
				status: expected.result.status,
				results: expected.result.results,
			});
			assert.equal((blocked.status as string) === "empty", expected.result.empty_result_claimed);
		});
	});
});

test("AC:CASE-WIKI-004 0.80 is in progress, 0.8001 completes once, a meaningful update is labeled, a typo adds no notice and a departed source gives no text", async () => {
	const { action, expected } = knowledgeCase("CASE-WIKI-004");
	const { result } = expected;
	const { A, leave } = await w.church([w.S1]);
	const g1 = await w.article();
	await w.publish(w.S1, g1.id, "S1 text");
	const completed = [];
	for (const ratio of action.arguments.ratios) {
		const { value, added } = await w.recorded(() => w.progress(A, g1.id, ratio));
		assert.deepEqual([added.notices, added.mail, added.jobs], [0, 0, []]);
		completed.push(value.completed);
	}
	assert.deepEqual(completed, result.completed);
	const earned = await w.stored(A, g1.id);
	assert.deepEqual(
		earned.map((r) => [r.observed, r.completed, r.completed_source, r.completed_version]),
		[["0.8001", "0.8001", w.S1.id, 1]],
	);
	const restored = await w.open(A, g1.id);
	assert.equal(restored.completed, true);
	const again = await w.stored(A, g1.id);
	assert.equal(again.length - earned.length, result.passive_restore_new_completions);
	assert.deepEqual(again, earned);

	await w.publish(w.S1, g1.id, "S1 text, revised", "1");
	const updated = present((await w.view(A, g1.id)).article, "updated");
	assert.deepEqual(
		[updated.updatedLabel, updated.completed, updated.body],
		[result.meaningful_update_label, true, "S1 text, revised"],
	);
	await w.open(A, g1.id);
	const sequence = updated.meaningfulSequence;
	const typo = await w.revise(g1.id, {
		tenant: w.S1.id,
		number: 3,
		meaningful: false,
		sequence,
		body: "S1 text, respelled",
	});
	await w.admin.execute(
		sql`UPDATE article_editor_state SET current_revision_id=${typo},revision=revision+1 WHERE organization_id=${w.S1.id} AND article_id=${g1.id}`,
	);
	const quiet = present((await w.view(A, g1.id)).article, "typo");
	assert.deepEqual(
		[quiet.updatedLabel, quiet.body, quiet.completed],
		[result.typo_new_notice, "S1 text, respelled", true],
	);

	await leave(w.S1);
	await w.untouched(async () => {
		const former = await w.view(A, g1.id, organization(w.S1));
		assert.deepEqual(former, denied);
		assert.equal(former.article, result.former_source_body);
		const now = present((await w.view(A, g1.id)).article, "global");
		assert.deepEqual(
			[now.sourceKind, now.body, now.completed],
			["global", "Prepare a leadership conversation.", result.earned_credit_retained],
		);
		const recent = ok(await w.api.readingRecent(w.db, await w.actor(A), {}));
		assert.equal(JSON.stringify(recent).includes("S1 text"), false);
		const guess = ok(
			await w.api.referenceExcerpt(w.db, await w.actor(A), {
				articleId: g1.id,
				source: organization(w.S1),
			}),
		);
		assert.deepEqual(guess, { excerpt: null, errorCode: "content_access_denied" });
		const credit = await w.kept(A, g1.id);
		assert.deepEqual([credit.completed, credit.completed_source], ["0.8001", w.S1.id]);
	});
});

test("AC:CASE-WIKI-005 racing and replayed bookmark requests leave one row per wanted state, and a departed or hidden article leaves the list", async () => {
	const { action, expected } = knowledgeCase("CASE-WIKI-005");
	const { desired_states, request_key, repeat } = action.arguments;
	const { A, leave } = await w.church([w.S1]);
	const g1 = await w.article();
	const authority = await w.actor(A);
	const put = (requestKey: string, desired: boolean, revision: string) =>
		w.api.setBookmark(w.db, authority, {
			requestKey,
			expectedRevision: revision,
			input: { articleId: g1.id, desired },
		});
	const marks = async () =>
		(
			await w.one(
				sql`SELECT count(*) FILTER (WHERE bookmarked)::int AS n FROM reading WHERE account_id=${A.id} AND article_id=${g1.id}`,
			)
		).n;
	const { value: pair, added } = await w.recorded(() =>
		raced(w.admin, w.db, sql`SELECT FROM account WHERE id=${A.id} FOR UPDATE`, [
			() => put(request_key, desired_states[0], "0"),
			() => put(request_key, desired_states[1], "0"),
		]),
	);
	assert.deepEqual([added.notices, added.mail, added.jobs, added.audits.length], [0, 0, [], 1]);
	const [left, right] = pair.map((reply) => ok(reply));
	assert.deepEqual(left, right);
	const counts = [await marks()];
	const replay = await w.untouched(async () => ok(await put(request_key, desired_states[1], "0")));
	assert.deepEqual(replay, left);
	counts.push(await marks());
	for (let n = 0; n < repeat; n++) {
		assert.equal(ok(await put("CASE-WIKI-005-request-2", desired_states[2 + n], left!.revision)).bookmarked, false);
		counts.push(await marks());
	}
	assert.deepEqual(counts, expected.result.bookmark_counts);
	assert.equal(await w.one(sql`SELECT count(*)::int AS n FROM reading WHERE account_id=${A.id}`).then((r) => r.n), 1);

	const gone = await w.article({ tenant: w.S1.id, body: "S1 only" });
	await w.admin
		.execute(sql`INSERT INTO article_editor_state(id,organization_id,article_id,state,current_revision_id,revision)
		VALUES(gen_random_uuid(),${w.S1.id},${gone.id},'published',${gone.revisionId},1)`);
	const hidden = await w.article();
	for (const articleId of [gone.id, hidden.id])
		ok(await w.api.setBookmark(w.db, await w.actor(A), w.cmd({ articleId, desired: true })));
	const list = async () => ok(await w.api.bookmarksList(w.db, await w.actor(A), {}));
	assert.deepEqual((await list()).articles.map((a) => a.articleId).toSorted(), [gone.id, hidden.id].toSorted());
	await w.publish(w.S1, hidden.id, "S1 text");
	ok(
		await w.api.hideOrganizationArticle(
			w.db,
			await w.actor(w.S1.editor),
			w.cmd({ articleId: hidden.id, organizationId: w.S1.id }, "1"),
		),
	);
	assert.deepEqual(
		(await list()).articles.map((a) => a.articleId),
		[gone.id],
	);
	await leave(w.S1);
	const left_ = await list();
	assert.deepEqual(
		left_.articles.filter((a) => a.articleId === gone.id),
		expected.result.visible_departed_articles,
	);
	assert.deepEqual([left_.total, JSON.stringify(left_).includes("S1")], [1, false]);
});

test("AC:CASE-WIKI-006 a reader's later vote replaces the earlier in view and keeps both in their own history, for their church only", async () => {
	const { action, expected } = knowledgeCase("CASE-WIKI-006");
	const { A } = await w.church();
	const q = await w.church();
	const g1 = await w.article();
	const plants = () => w.one(sql`SELECT count(*)::int AS n FROM plant`).then((r) => r.n);
	const before = await plants();
	const authority = await w.actor(A);
	for (const vote of action.arguments.votes) {
		const { added } = await w.recorded(async () =>
			ok(await w.api.setMine(w.db, authority, w.cmd({ articleId: g1.id, vote }))),
		);
		assert.deepEqual([added.audits.length, added.notices, added.mail, added.jobs], [1, 0, 0, []]);
	}
	const churchless = await w.f.actor(null);
	await w.untouched(async () => {
		const mine = ok(await w.api.getMine(w.db, authority, { articleId: g1.id }));
		assert.deepEqual(mine, {
			articleId: g1.id,
			currentVote: expected.result.current_vote,
			ownHistoryVotes: expected.result.own_history_votes,
			phantomPlants: expected.result.phantom_plants,
			foreignVoteBody: expected.result.foreign_vote_body,
		});
		for (const who of [q.A, churchless]) {
			const theirs = ok(await w.api.getMine(w.db, await w.actor(who), { articleId: g1.id }));
			assert.deepEqual(
				[theirs.currentVote, theirs.ownHistoryVotes, theirs.foreignVoteBody],
				[null, [], expected.result.foreign_vote_body],
			);
		}
		refused(
			await w.api.setMine(w.db, await w.actor(churchless), w.cmd({ articleId: g1.id, vote: "helpful" })),
			"access_denied",
		);
	});
	assert.equal((await plants()) - before, expected.result.phantom_plants);
	assert.equal((await w.one(sql`SELECT count(*)::int AS n FROM audit_event WHERE actor_id=${churchless.id}`)).n, 0);
});

test("AC:CASE-WIKI-007 a departed source exports nothing, a font failure offers the print copy, and the printed and PDF copies carry the exact article and footer", async () => {
	const kase = knowledgeCase("CASE-WIKI-007");
	const [fontFailure, print, pdf] = kase.subcases;
	const { title, body, footer } = print.given["rendered-article"];
	const { A, leave } = await w.church([w.S1]);
	const g1 = await w.article({ slug: "preparing-leaders", title, body });
	await w.admin
		.execute(sql`INSERT INTO reference_version(id,item_id,release_id,version_number,artifact_path,content_hash,source_credit)
		SELECT gen_random_uuid(),${g1.id},release_id,1,'wiki/preparing-leaders',content_hash,${footer} FROM article_revision WHERE id=${g1.revisionId}`);
	await w.publish(w.S1, g1.id, "S1 private guidance");
	const drawn: string[] = [];
	const fontless: WikiConfig = {
		renderPdf(name) {
			drawn.push(name);
			throw Error("font load failed");
		},
	};
	const failing = createWikiProducer(fontless);
	assert.equal(
		present(
			ok(
				await w.api.printArticle(w.db, await w.actor(A), {
					articleId: g1.id,
					source: organization(w.S1),
				}),
			).html,
			"own source",
		).includes("S1 private guidance"),
		true,
	);
	await leave(w.S1);
	await w.untouched(async () => {
		for (const ask of [failing.exportPdf, failing.printArticle]) {
			const refusedCopy = ok(await ask(w.db, await w.actor(A), { articleId: g1.id, source: organization(w.S1) }));
			assert.deepEqual(refusedCopy, {
				bytes: kase.expected.result.export_bytes,
				html: null,
				errorCode: kase.expected.result.error_code,
				fontFailureOffersPrintFallback: kase.expected.result.font_failure_offers_print_fallback,
			});
		}
		assert.deepEqual(drawn, []);

		const source = { kind: "global" as const };
		const failed = ok(await failing.exportPdf(w.db, await w.actor(A), { articleId: g1.id, source }));
		assert.deepEqual(drawn, [title]);
		assert.equal(failed.bytes === null ? "unavailable" : "available", fontFailure.expected.result.export_status);
		assert.equal(failed.fontFailureOffersPrintFallback, fontFailure.expected.result.print_fallback_available);

		const printed = ok(await w.api.printArticle(w.db, await w.actor(A), { articleId: g1.id, source }));
		const page = present(printed.html, "print html");
		assert.equal(failed.html, page);
		assert.deepEqual(
			[...page.matchAll(/<(h1|p|footer)>([^<]*)<\/\1>/g)].map((m) => [m[1], m[2]]),
			[
				["p", pdf.expected.result.filename],
				["h1", print.expected.result.title],
				["p", print.expected.result.body],
				["footer", print.expected.result.footer],
			],
		);
		assert.equal(/<link|@import|url\(|https?:/.test(page), false);

		const exported = ok(await w.api.exportPdf(w.db, await w.actor(A), { articleId: g1.id, source }));
		assert.equal(exported.html, null);
		assert.equal(exported.bytes === null ? "unavailable" : "available", pdf.expected.result.export_status);
		const file = pdfText(Buffer.from(present(exported.bytes, "pdf bytes"), "base64"));
		assert.deepEqual(file, {
			title: pdf.expected.result.filename,
			pages: [
				[
					pdf.expected.result.filename,
					pdf.expected.result.title,
					pdf.expected.result.body,
					pdf.expected.result.footer + "  1/1",
				],
			],
		});
		assert.equal((await w.view(A, g1.id, source)).article?.sourceKind, pdf.expected.result.source);
		assert.equal(JSON.stringify([page, file]).includes("S1"), false);
	});
	assert.equal(
		(await w.one(sql`SELECT count(*)::int AS n FROM generated_document`)).n,
		kase.expected.result.generated_document_history_added,
	);
});

test("AC:CASE-WIKI-007 tables, callouts and lists of the authorized article reach the printed and PDF copies", async () => {
	const { A } = await w.church();
	const g1 = await w.article({
		slug: "structured",
		title: "Structured",
		body: '## Steps\n- Pray\n- Plan\n\n| Who | When |\n|---|---|\n| Alex | Monday |\n\n<Callout type="tip">\nKeep it short.\n</Callout>',
	});
	await w.untouched(async () => {
		const file = pdfText(
			Buffer.from(
				present(ok(await w.api.exportPdf(w.db, await w.actor(A), { articleId: g1.id })).bytes, "pdf bytes"),
				"base64",
			),
		);
		assert.deepEqual(file.pages, [
			[
				"structured.pdf",
				"Structured",
				"Steps",
				"\x95 Pray",
				"\x95 Plan",
				"Who | When",
				"Alex | Monday",
				"Keep it short.",
				"1/1",
			],
		]);
		const html = present(ok(await w.api.printArticle(w.db, await w.actor(A), { articleId: g1.id })).html, "print html");
		assert.ok(
			html.includes(
				"<h2>Steps</h2><ul><li>Pray</li><li>Plan</li></ul><table><tr><td>Who</td><td>When</td></tr><tr><td>Alex</td><td>Monday</td></tr></table><aside><p>Keep it short.</p></aside>",
			),
			html,
		);
	});
});

test("AC:CASE-WIKI-008 the guide cites the global article and its instruction stays text; missing, ended, gone and unavailable differ and nothing is written", async () => {
	const { given, action, expected } = knowledgeCase("CASE-WIKI-008");
	const { route, source_text } = action.arguments;
	const { A } = await w.church([w.S1]);
	const ending = await w.f.actor((await w.church()).P, "member");
	const g1 = await w.article({
		slug: "core-group/follow-up/database-management",
		title: given.G1.title,
		body: `${given.G1.body}\n## What to Track\n${source_text}\n## Next`,
	});
	const ended = await w.actor(ending);
	await w.admin.execute(sql`UPDATE seat SET ended_at=clock_timestamp() WHERE account_id=${ending.id}`);
	const authority = await w.actor(A);
	await w.untouched(async () => {
		const guide = ok(await w.api.contextGuide(w.db, authority, { route }));
		const names: Record<string, string> = { [g1.id]: "g1" };
		assert.equal(`${guide.sourceKind}:${names[guide.articleId ?? ""]}`, expected.result.source_citation);
		assert.deepEqual(guide, {
			found: true,
			missing: false,
			citation: "What to Track",
			articleId: g1.id,
			revisionId: g1.revisionId,
			sourceKind: "global",
			title: given.G1.title,
			slug: "core-group/follow-up/database-management",
			body: `## What to Track\n${source_text}`,
		});
		const missing = ok(await w.api.contextGuide(w.db, authority, { route: "/meetings" }));
		assert.deepEqual([missing.found, missing.missing, missing.articleId, missing.body], [false, true, null, null]);
		refused(await w.api.contextGuide(w.db, ended, { route }), "access_denied");
		await w.admin.transaction(async (locked) => {
			await locked.execute(sql`LOCK TABLE article_revision IN ACCESS EXCLUSIVE MODE`);
			await assert.rejects(
				w.db.transaction(async (tx) => {
					await tx.execute(sql`SELECT set_config('lock_timeout','20ms',true)`);
					return w.api.contextGuide(tx, authority, { route });
				}),
				(error: unknown) => pgCode(error) === "55P03",
			);
		});
	});
	await w.publish(w.S1, g1.id, "S1 text");
	ok(
		await w.api.hideOrganizationArticle(
			w.db,
			await w.actor(w.S1.editor),
			w.cmd({ articleId: g1.id, organizationId: w.S1.id }, "1"),
		),
	);
	const gone = ok(await w.api.contextGuide(w.db, authority, { route }));
	assert.deepEqual([gone.found, gone.articleId, gone.body], [false, null, null]);
	const unread = await w.one(sql`SELECT count(*)::int AS n FROM reading WHERE account_id=${A.id}`);
	assert.equal(unread.n, expected.result.new_read_progress);
	assert.equal(
		(await w.one(sql`SELECT count(*)::int AS n FROM audit_event WHERE actor_id=${A.id}`)).n,
		expected.result.tool_effects,
	);
});

test("AC:CASE-WIKI-009 another organization's, the global and a plant's publication and the cache refresh refuse, and a stale own publish or hide changes nothing", async () => {
	const { action, expected } = knowledgeCase("CASE-WIKI-009");
	assert.deepEqual([action.arguments.actor_org, action.arguments.target_org], ["S1", "S2"]);
	const { result } = expected;
	const q = await w.church();
	const g1 = await w.article();
	await w.publish(w.S2, g1.id, "S2 guidance.");
	await w.publish(w.S1, g1.id, "S1 guidance.");
	const input = { articleId: g1.id, body: "Changed.", cachePath: "wiki/缓存/路径" };
	const writers = [w.api.publishOrganizationArticle, w.api.editOrganizationArticle, w.api.hideOrganizationArticle];
	const service = referenceService(w.admin);
	await w.untouched(async () => {
		for (const write of writers)
			for (const [who, organizationId] of [
				[w.S1.editor, w.S2.id],
				[w.S1.editor, "global"],
				[q.A, w.S2.id],
			] as const) {
				const reply = ok(await write(w.db, await w.actor(who), w.cmd({ ...input, organizationId }, "1")));
				assert.deepEqual(
					[reply.errorCode, reply.publicationsAdded, reply.invalidationCalls, reply.additionalHistoryEntries],
					[result.error_code, result.publications_added, result.invalidation_calls, 0],
				);
			}
		for (const write of writers)
			refused(
				await write(w.db, await w.actor(w.S1.editor), w.cmd({ ...input, organizationId: w.S1.id }, "7")),
				"conflict",
			);
		for (const who of [w.S1.editor, q.A])
			await assert.rejects(
				service.invalidateWikiCache(caller(who), { requestKey: randomUUID() }),
				(error: unknown) => error instanceof WikiRefusal && error.code === "access_denied",
			);
	});
	await w.admin.execute(
		sql`INSERT INTO platform_grant(account_id,capability,revoked_at) VALUES(${w.S1.editor.id},'reference_publish',clock_timestamp())`,
	);
	await w.untouched(() =>
		assert.rejects(
			service.invalidateWikiCache(caller(w.S1.editor), { requestKey: randomUUID() }),
			(error: unknown) => error instanceof WikiRefusal && error.code === "access_denied",
		),
	);
	const own = ok(
		await w.api.publishOrganizationArticle(
			w.db,
			await w.actor(w.S1.editor),
			w.cmd({ ...input, organizationId: w.S1.id }, "1"),
		),
	);
	assert.deepEqual([own.errorCode, own.publishedRevision], [null, 2]);
});

test("AC:CASE-WIKI-011 only /wiki paths preview, for fetchers and spoofed agents alike, with no private text, no session and no fetcher treatment for people", async () => {
	const { action, expected } = knowledgeCase("CASE-WIKI-011");
	const { user_agent, requested_paths } = action.arguments;
	const g1 = await w.article({ slug: "public/with space", body: "Global body text" });
	await w.publish(w.S1, g1.id, "S1 private body");
	const own = await w.article({
		tenant: w.S1.id,
		slug: "private/only",
		title: "S1 private title",
		body: "S1 private body",
	});
	await w.admin
		.execute(sql`INSERT INTO article_editor_state(id,organization_id,article_id,state,current_revision_id,revision)
		VALUES(gen_random_uuid(),${w.S1.id},${own.id},'published',${own.revisionId},1)`);
	const sessions = () => w.one(sql`SELECT count(*)::int AS n FROM auth_session`);
	const held = await sessions();
	await w.untouched(async () => {
		assert.equal(await readViewer(w.db, sessionId.parse(randomUUID())), null, "a forged session cookie opens nothing");
		const ask = async (path: string, userAgent: string) => [
			ok(await w.api.publicPreviewMetadata(w.db, { path, userAgent })),
			ok(await w.api.renderGlobalPreview(w.db, { path, userAgent })),
		];
		for (const agent of [user_agent, "facebookexternalhit/1.1", "Twitterbot/1.0"]) {
			const replies = await Promise.all(requested_paths.map((path: string) => ask(path, agent)));
			for (const at of [0, 1])
				assert.deepEqual(
					replies.map((reply) => reply[at]!.publicPreviewAllowed),
					expected.result.public_preview_allowed,
				);
			assert.deepEqual(
				replies.flat().map((reply) => reply.title),
				["Wiki", "Wiki", null, null, null, null],
			);
		}
		const [, card] = await ask("/wiki/public/with%20space", user_agent);
		assert.deepEqual(card, {
			publicPreviewAllowed: true,
			crawler: true,
			title: "Preparing leaders",
			excerpt: "Preparing leaders",
		});
		const [, hidden] = await ask("/wiki/private/only", user_agent);
		assert.deepEqual(hidden, {
			publicPreviewAllowed: true,
			crawler: true,
			title: null,
			excerpt: null,
		});
		assert.equal(
			"body" in present(card, "card") || "privateBody" in present(card, "card"),
			expected.result.private_body !== null,
		);
		for (const person of [
			"Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 WhatsApp/2.24",
			"Mozilla/5.0 unknown agent",
		])
			for (const reply of await ask("/wiki/public/with%20space", person)) assert.equal(reply.crawler, false);
		for (const forged of ["/dashboard?next=/wiki", "//wiki", "/WIKI", "/people/wiki", "/wikileaks/wiki"])
			for (const reply of await ask(forged, user_agent))
				assert.deepEqual([reply.publicPreviewAllowed, reply.title, reply.excerpt], [false, null, null]);
	});
	assert.equal((await sessions()).n > held.n, expected.result.crawler_header_creates_session);
});

test("AC:WIKI49-001 a finished reader keeps the 0.91 credit of version 1 when version 2 is published, and reads the new text as updated", async () => {
	const { action, expected } = knowledgeCase("WIKI49-001");
	const { A } = await w.church();
	const g1 = await w.article({ body: "Version 1" });
	await w.progress(A, g1.id, action.arguments.ratio);
	const before = await w.stored(A, g1.id);
	await w.revise(g1.id, {
		number: action.arguments.new_version,
		meaningful: true,
		sequence: 2,
		body: "Version 2",
	});
	const publisher = await w.f.actor(null);
	await w.admin.execute(
		sql`INSERT INTO platform_grant(account_id,capability) VALUES(${publisher.id},'reference_publish')`,
	);
	const { added } = await w.recorded(() =>
		referenceService(w.admin).invalidateWikiCache(caller(publisher), { requestKey: randomUUID() }),
	);
	assert.deepEqual(added, { ...NOTHING, audits: ["reference.activated"] });
	await w.untouched(async () => {
		const article = present((await w.view(A, g1.id)).article, "article");
		assert.deepEqual(
			[article.completed, Number(article.observedFraction), article.updatedLabel, article.body],
			[expected.result.completed, expected.result.ratio, true, "Version 2"],
		);
		assert.equal(expected.result.label, "Updated since you read it");
		const after = await w.stored(A, g1.id);
		assert.deepEqual(after, before);
		assert.deepEqual(
			[after[0]?.completed_version, Number(after[0]?.completed)],
			[expected.result.credited_version, expected.result.ratio],
		);
	});
});

const updates = knowledgeCase("WIKI49-002");
for (const row of [{ name: "typo", ...updates }, ...updates.subcases])
	test(`AC:WIKI49-002 ${row.name}: only a publisher-marked meaningful revision labels a finished article`, async () => {
		const { A } = await w.church();
		const read = { ...updates.given, ...row.given }["read-A"];
		const { g1 } = row.given;
		const article = await w.article({ body: "Original spelling.", meaningful: false, sequence: 0 });
		for (const version of g1.meaningful_versions.filter((v: number) => v !== g1.revision_number))
			await w.revise(article.id, { number: version, meaningful: true, sequence: 1, body: g1.body });
		await w.revise(article.id, {
			number: g1.current_version,
			meaningful: g1.meaningful ?? false,
			sequence: g1.meaningful_sequence,
			body: g1.body,
		});
		await w.admin
			.execute(sql`INSERT INTO reading(id,account_id,article_id,last_revision_id,observed_fraction,last_viewed_at,completed_at,completed_revision_id,completed_fraction,policy_version,last_read_meaningful_sequence,bookmarked,revision)
			VALUES(gen_random_uuid(),${A.id},${article.id},${article.revisionId},${read.completed_fraction},${read.completed_at},${read.completed_at},${article.revisionId},${read.completed_fraction},'wiki-reading-v1',${read.last_read_meaningful_sequence},false,1)`);
		const before = await w.stored(A, article.id);
		await w.untouched(async () => {
			const shown = present((await w.view(A, article.id)).article, "article");
			assert.deepEqual(
				[shown.updatedLabel, shown.completed, shown.body, shown.revisionNumber],
				[row.expected.result.updated_label, row.expected.result.completed, g1.body, g1.current_version],
			);
			assert.deepEqual(await w.stored(A, article.id), before);
		});
		const { value, added } = await w.recorded(() => w.open(A, article.id));
		assert.deepEqual([value.completed, value.meaningfulUpdateLabel], [true, false]);
		assert.deepEqual([added.notices, added.mail, added.jobs], [0, 0, []]);
		assert.equal((await w.view(A, article.id)).article?.updatedLabel, false);
		const after = await w.kept(A, article.id);
		assert.deepEqual(
			[after.completed, after.completed_at, after.completed_version],
			[before[0]?.completed, before[0]?.completed_at, 1],
		);
	});

test("AC:WIKI52-001 an organization's own text stays through a typo and a meaningful global change, and its editors get one notice for each", async () => {
	const { action, expected } = knowledgeCase("WIKI52-001");
	const { S1_fork, global_updates } = action.arguments;
	const { A } = await w.church([w.S1]);
	const inheriting = await w.church([w.S2]);
	const g1 = await w.article({ body: "Global guidance." });
	await w.publish(w.S1, g1.id, S1_fork);
	for (const { version, meaningful } of global_updates)
		await w.revise(g1.id, {
			number: version,
			meaningful,
			sequence: meaningful ? 2 : 1,
			body: `Global version ${version}`,
		});
	const { value, added } = await w.recorded(async () =>
		ok(await w.api.emitUpstreamReview(w.db, await w.actor(w.S1.editor), w.cmd({ articleId: g1.id }))),
	);
	assert.deepEqual(value, {
		inAppCues: expected.result.upstream_notices,
		emailIntents: 0,
		autoAdoptions: 0,
		recipientIds: [w.S1.editor.id],
	});
	assert.deepEqual([added.notices, added.mail, added.jobs], [expected.result.upstream_notices, 0, []]);
	await w.untouched(async () => {
		const own = present((await w.view(A, g1.id)).article, "S1 article");
		assert.deepEqual([own.body, own.sourceId], [expected.result.S1_body, w.S1.id]);
		const inherited = present((await w.view(inheriting.A, g1.id, organization(w.S2))).article, "inherited");
		assert.deepEqual(
			[inherited.revisionNumber, inherited.body, inherited.state],
			[expected.result.inherited_current_version, "Global version 3", "inherited"],
		);
	});
});

test("AC:WIKI52-002 the upstream cue reaches only a current editor of the customized article, in the app, whatever the email choices", async () => {
	const { given, expected } = knowledgeCase("WIKI52-002");
	const g1 = await w.article({ body: "Global guidance." });
	await w.publish(w.S1, g1.id, given["org-article"].body);
	await w.revise(g1.id, {
		number: given.g1.revision,
		meaningful: given.g1.meaningful,
		sequence: 1,
		body: "Global typo fix.",
	});
	const revoked = await w.f.actor({ kind: "organization", id: w.S1.id, organizationKind: "sending_church" }, "admin");
	const former = await w.actor(revoked);
	await w.admin.execute(sql`UPDATE seat SET ended_at=clock_timestamp() WHERE account_id=${revoked.id}`);
	await w.admin
		.execute(sql`INSERT INTO notification_preference(account_id,category,channel,enabled,unsubscribe_revision)
		VALUES(${w.S1.editor.id},'phase_milestone','email',true,1),(${w.S1.editor.id},'wiki_upstream_review','in_app',true,1)`);
	await assert.rejects(
		w.admin.execute(sql`INSERT INTO notification_preference(account_id,category,channel,enabled,unsubscribe_revision)
			VALUES(${w.S1.editor.id},'wiki_upstream_review','email',${given.input.email_preference},1)`),
	);
	const { value, added } = await w.recorded(async () =>
		ok(await w.api.emitUpstreamReview(w.db, await w.actor(w.S1.editor), w.cmd({ articleId: g1.id }))),
	);
	assert.deepEqual([value.recipientIds, value.inAppCues], [[w.S1.editor.id], 1]);
	assert.equal(value.emailIntents, expected.result.email_intents);
	assert.deepEqual([added.notices, added.mail, added.jobs], [1, expected.result.email_intents, []]);
	const cue = await w.one<Record<string, string>>(
		sql`SELECT tenant_id,recipient_id,category,title FROM notice WHERE tenant_id=${w.S1.id} AND logical_key LIKE ${`%/wiki_upstream_review/${(await w.view(w.S1.editor, g1.id, { kind: "global" })).article?.revisionId}/%`}`,
	);
	assert.deepEqual(cue, {
		tenant_id: w.S1.id,
		recipient_id: w.S1.editor.id,
		category: "reference_update",
		title: "Preparing leaders",
	});
	await w.untouched(async () => {
		refused(await w.api.getArticle(w.db, former, { articleId: g1.id, source: organization(w.S1) }), "access_denied");
		const now = await w.view(revoked, g1.id, organization(w.S1));
		assert.deepEqual(now, denied);
		assert.equal(now.article, expected.result.B_body);
		assert.equal((await w.view(w.S1.editor, g1.id)).article?.body, given["org-article"].body);
	});
});

test("AC:WIKI52-003 a church writes and archives its own document while its Wiki reading stays and every plant Wiki edit refuses", async () => {
	const { action, expected } = knowledgeCase("WIKI52-003");
	const { church_document, plant_wiki_version, requested_wiki_edit } = action.arguments;
	assert.equal(requested_wiki_edit, true);
	const { P, A } = await w.church([w.S1]);
	const article = await w.article();
	await w.publish(w.S1, article.id, plant_wiki_version);
	const entitled = async () => {
		const shown = present((await w.view(A, article.id)).article, "article");
		assert.equal(shown.body === plant_wiki_version && shown.sourceId === w.S1.id, expected.result.entitled_P1_read);
	};
	await entitled();
	const authority = await w.actor(A);
	const saved = ok(
		await documentsWriter.saveNative(w.db, authority, {
			title: church_document,
			body: nativeFromText("We serve our community."),
			expectedRevision: "0",
		}),
	);
	const read = ok(await documentsWriter.getAuthorized(w.db, authority, { documentId: saved.id }));
	assert.deepEqual([read.title, read.body], [church_document, nativeFromText("We serve our community.")]);
	assert.equal(
		(await w.one<{ tenant_id: string }>(sql`SELECT tenant_id FROM document WHERE id=${saved.id}`)).tenant_id === P.id,
		expected.result.church_document_write,
	);
	const { value, added } = await w.recorded(async () =>
		ok(await documentsWriter.archive(w.db, authority, { documentId: saved.id, expectedRevision: saved.revision })),
	);
	assert.equal(value.archived, true);
	assert.deepEqual(added, { ...NOTHING, audits: ["documents.archived"] });
	await w.untouched(async () => {
		await entitled();
		for (const write of [
			w.api.addOrganizationArticle,
			w.api.editOrganizationArticle,
			w.api.publishOrganizationArticle,
			w.api.hideOrganizationArticle,
		])
			for (const organizationId of [P.id, w.S1.id]) {
				const reply = ok(
					await write(w.db, authority, w.cmd({ articleId: article.id, organizationId, body: "Plant text" }, "1")),
				);
				assert.equal(reply.errorCode === null, expected.result.plant_wiki_edit);
				assert.equal(reply.errorCode, "editorial_access_denied");
			}
	});
});
