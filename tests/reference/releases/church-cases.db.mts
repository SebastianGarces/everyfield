import assert from "node:assert/strict";
import { AsyncResource } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import test, { after, before } from "node:test";
import { isDeepStrictEqual } from "node:util";
import { sql } from "../../../packages/db/src/query.ts";
import { hash } from "../../../packages/reference/src/hash.ts";
import { RequestActor } from "../../../packages/domain/src/access/session.ts";
import {
	createAssessmentJob,
	createAssessments,
	runAssessmentBatch,
} from "../../../packages/domain/src/intelligence/index.ts";
import { createWikiProducer } from "../../../packages/domain/src/wiki/index.ts";
import { evryActor } from "../../../packages/evry/src/context/actor.ts";
import { liveRowKeys } from "../../../packages/evry/src/conversations/liveness.ts";
import { scriptedAssessmentDrafter } from "../../../packages/evry-scripted/src/scripted-assessment.ts";
import { church } from "../../integration/intelligence/assessment-church.mts";
import { ok, type Actor } from "../../support/fixture.mts";
import { recorded, untouched } from "../../support/recorded.mts";
import { fixture, revised } from "./fixtures.mts";
import { promotions } from "./promotions.mts";

const { cases } = JSON.parse(
	await readFile(new URL("../../../docs/acceptance/reference-release.json", import.meta.url), "utf8"),
);
const referenceCase = (id: string) => cases.find((row: { id: string }) => row.id === id);
const NOW = "2026-10-13T16:00:00Z";
const api = createWikiProducer();
const R1 = fixture("R1");
const articles = R1.bundle.entries.filter((e) => e.kind === "article");
const [forked, hidden, read, respelled] = articles as [
	(typeof articles)[number],
	(typeof articles)[number],
	(typeof articles)[number],
	(typeof articles)[number],
];
const content = (entry: { body: string }): string => JSON.parse(entry.body).content;
const mail = R1.bundle.entries.find((e) => e.kind === "mail_template")!;
const R2 = revised("R2", (e) => {
	if (e.id === forked.id || e.id === hidden.id || e.id === read.id)
		return { content: `${content(e)}\n\nA new paragraph for R2.` };
	if (e.id === respelled.id) return { content: content(e).replace(/[a-z]/, "x") };
	return e.id === mail.id ? { subject: "A new subject for R2" } : null;
});
const releases = new Map([
	["R1", R1],
	["R2", R2],
]);
async function released(prefix: string) {
	const c = await church(prefix, { clock: new Date(NOW) });
	const p = await promotions(c.database, (key) => releases.get(key)!);
	await p.seed();
	const promote = (key: string, expected: string, kind?: "rollback", reason?: string) =>
		p.service.promote(p.command(key, expected, kind, reason ? { reason } : {}), key);
	assert.equal((await promote("R1", "0")).number, "1");
	return { ...c, publisher: p.publisher, current: p.service.current, promote };
}
type Org = { id: string; editor: Actor };
type Released = Awaited<ReturnType<typeof released>>;
const open: Released[] = [];
after(async () => {
	for (const c of open) await c.database.close();
});
const cmd = <I,>(input: I, expectedRevision = "0") => ({
	requestKey: randomUUID(),
	expectedRevision,
	input,
});
const organization = (o: { id: string }) => ({
	kind: "organization" as const,
	organizationId: o.id,
});

let assessed: Released;
before(async () => {
	assessed = await released("refassess");
	open.push(assessed);
	await customized();
});

test("AC:REFREL-008 an assessment drafted under activation 1 cannot publish after activation 2, and the prior result stays current and unchanged", async () => {
	const { given, expected } = referenceCase("REFREL-008");
	const { admin, db, rows, promote, harvest } = assessed;
	const P = await harvest("P");
	const { run_reference_activation, current_reference_activation } = given["case-input"];
	const clock = { now: () => NOW as never };
	const job = createAssessmentJob({ clock });
	const assessments = createAssessments({ clock });
	const request = async () => ok(await assessments.requestRefresh(db, P.actor, { requestId: randomUUID() }));
	const runs = () =>
		rows<{
			id: string;
			outcome: string;
			reason: string | null;
			activation: number;
			row: unknown;
		}>(sql`SELECT id,outcome,reason,reference_activation::int AS activation,to_jsonb(r) AS row
			FROM assessment_run r WHERE plant_id=${P.id} ORDER BY captured_at,id`);
	await request();
	await runAssessmentBatch(job, db, scriptedAssessmentDrafter(), 1);
	const [prior] = await runs();
	assert.deepEqual([prior!.outcome, prior!.activation], ["published", run_reference_activation]);
	const named: Record<string, string> = { [prior!.id]: given["case-input"].prior_result };
	const insights = () =>
		rows(sql`SELECT to_jsonb(i) AS row FROM assessment_insight i WHERE plant_id=${P.id} ORDER BY run_id,ordinal`);
	const before = await insights();

	await request();
	let raced = false;
	const { added } = await recorded(admin, () =>
		runAssessmentBatch(
			job,
			db,
			scriptedAssessmentDrafter({
				during: AsyncResource.bind(async () => {
					if (raced) return;
					raced = true;
					const second = await promote("R2", String(run_reference_activation));
					assert.equal(Number(second.number), current_reference_activation);
				}),
			}),
			1,
		),
	);
	assert.deepEqual([raced, added.mail, added.notices], [true, 0, 0]);
	assert.deepEqual(added.audits, ["intelligence.assessed", "reference.activated"]);
	const after = await runs();
	const late = after.find((r) => r.id !== prior!.id)!;
	assert.deepEqual(
		[late.outcome, late.reason, late.activation],
		["superseded", "changed_reference", run_reference_activation],
	);
	assert.equal(after.length, 2);
	assert.equal(late.outcome === "published", expected.result.publication_allowed);
	const current = ok(await assessments.readAssessment(db, P.actor, {})).current!;
	assert.equal(named[current.runId], expected.result.current_result);
	assert.deepEqual(current.reference, { release: "R1", activation: run_reference_activation });
	assert.deepEqual(await insights(), before);
	assert.equal(
		!isDeepStrictEqual(
			after.find((r) => r.id === prior!.id),
			prior,
		),
		expected.result.historical_result_rewritten,
	);
});

let c: Released;
let S1: Org, N1: Org;
let A: Actor;
let endS1: () => Promise<unknown>;
async function customized() {
	c = await released("refchurch");
	open.push(c);
	const seated = async (kind: "sending_church" | "sending_network", name: string) => {
		const o = await c.database.organization(kind, { name, timezone: "America/Chicago" });
		return { ...o, editor: await c.database.actor(o, "admin") };
	};
	S1 = await seated("sending_church", "S1");
	N1 = await seated("sending_network", "N1");
	const P = await c.plant("P", { network: S1 });
	endS1 = () => c.admin.execute(sql`UPDATE affiliation SET ended_at=clock_timestamp() WHERE id=${P.affiliation}`);
	await c.admin.execute(sql`INSERT INTO affiliation(id,plant_id,organization_id,accepted_at,share_people,share_meetings,
		share_tasks,share_ministry_teams,share_wiki,share_activity,shared_findings)
		VALUES(${randomUUID()},${P.id},${N1.id},clock_timestamp()-interval '1 day',false,false,false,false,true,false,false)`);
	A = await c.database.actor(P, "admin");
}
const actor = async (who: Actor) => {
	const resolved = await RequestActor.resolve(c.db, who.session);
	assert.ok(resolved instanceof RequestActor);
	return resolved;
};
const view = async (articleId: string, source?: object) =>
	ok(await api.getArticle(c.db, await actor(A), { articleId, ...(source ? { source } : {}) }));
const shown = async (articleId: string, source?: object) => {
	const { article } = await view(articleId, source);
	assert.ok(article);
	return article;
};
async function publish(o: Org, articleId: string, body: string) {
	const value = ok(
		await api.publishOrganizationArticle(c.db, await actor(o.editor), cmd({ articleId, organizationId: o.id, body })),
	);
	assert.equal(value.errorCode, null);
}
const custom = async () => [
	await c.rows(
		sql`SELECT to_jsonb(r) AS row FROM article_revision r WHERE tenant_id IN (${S1.id},${N1.id}) ORDER BY id`,
	),
	await c.rows(sql`SELECT to_jsonb(e) AS row FROM article_editor_state e ORDER BY id`),
	await c.rows(sql`SELECT to_jsonb(r) AS row FROM reading r WHERE account_id=${A.id} ORDER BY article_id`),
];
const history = () =>
	c.rows<{
		n: number;
		release: string;
		row: unknown;
	}>(sql`SELECT a.activation_number::int AS n,r.release_key AS release,
		to_jsonb(a) AS row FROM reference_activation a JOIN reference_release r ON r.id=a.release_id ORDER BY 1`);

test("AC:REFREL-002 a second release keeps the church's fork, the network's hide and earned credit, and cues their editors in the app only", async () => {
	const { action, expected } = referenceCase("REFREL-002");
	const { org_fork, new_global_version, completed_read_version } = action.arguments;
	await publish(S1, forked.id, org_fork);
	await publish(N1, hidden.id, "N1 text");
	ok(
		await api.hideOrganizationArticle(
			c.db,
			await actor(N1.editor),
			cmd({ articleId: hidden.id, organizationId: N1.id }, "1"),
		),
	);
	for (const articleId of [read.id, forked.id])
		assert.equal(
			ok(
				await api.updateProgress(c.db, await actor(A), {
					requestKey: randomUUID(),
					input: { articleId, fraction: "0.9" },
				}),
			).completed,
			true,
		);
	const kept = await custom();
	assert.equal((await shown(read.id)).revisionNumber, completed_read_version);
	const { added } = await recorded(c.admin, () => c.promote("R2", "1"));
	assert.deepEqual(added, { audits: ["reference.activated"], jobs: [], notices: 0, mail: 0 });

	const next = (entry: { id: string }) => R2.bundle.entries.find((e) => e.id === entry.id)!;
	await untouched(c.admin, async () => {
		assert.deepEqual(await custom(), kept);
		const fork = await shown(forked.id);
		assert.deepEqual([fork.body, fork.sourceKind], [expected.result.org_fork, "church"]);
		const gone = await shown(hidden.id);
		assert.deepEqual([gone.body, gone.hidden], [null, expected.result.org_hide]);
		const now = await shown(read.id);
		assert.deepEqual(
			[now.sourceKind, now.revisionNumber, now.body, now.updatedLabel],
			["global", new_global_version, content(next(read)), true],
		);
		for (const article of [now, fork]) assert.equal(article.completed, expected.result.read_credit_retained);
		assert.equal((await shown(respelled.id)).body, content(next(respelled)));
		const [template] = await c.rows<{
			hash: string;
		}>(sql`SELECT v.content_hash AS hash FROM reference_version v
			JOIN reference_release r ON r.id=v.release_id WHERE r.release_key='R2' AND v.item_id=${mail.id}`);
		assert.equal(template?.hash, next(mail).contentHash);
		assert.notEqual(template?.hash, mail.contentHash);
	});
	for (const [o, articleId] of [
		[S1, forked.id],
		[N1, hidden.id],
	] as const) {
		const cue = await recorded(c.admin, async () =>
			ok(await api.emitUpstreamReview(c.db, await actor(o.editor), cmd({ articleId }))),
		);
		assert.deepEqual([cue.value.emailIntents, cue.value.autoAdoptions, cue.value.recipientIds], [0, 0, [o.editor.id]]);
		assert.deepEqual([cue.added.notices, cue.added.mail, cue.added.jobs], [1, 0, []]);
		assert.equal(cue.value.inAppCues === 1 ? "in_app" : null, expected.result.upstream_cue);
	}
	assert.deepEqual(await custom(), kept);
});

test("AC:REFREL-005 AC:REFREL-006 a reviewed rollback adds one activation, needs no organization adoption, and never returns a departed organization's text", async () => {
	const five = referenceCase("REFREL-005");
	const six = referenceCase("REFREL-006");
	const { article: slug, body } = six.given.cached;
	const own = randomUUID();
	const source = organization(S1);
	await c.admin.execute(
		sql`INSERT INTO reference_item(id,kind,canonical_key,tenant_id) VALUES(${own},'article',${slug},${S1.id})`,
	);
	await c.admin
		.execute(sql`INSERT INTO article_revision(id,article_id,tenant_id,revision_number,title,slug,excerpt,body,
		content_type,position,content_hash,meaningful,meaningful_sequence,section_id)
		SELECT gen_random_uuid(),${own},${S1.id},1,${slug},'s-add','','Draft.','safe_nodes',1,${hash("Draft.")},true,1,section_id
		FROM article_revision WHERE article_id=${read.id} LIMIT 1`);
	await publish(S1, own, body);
	ok(
		await api.updateProgress(c.db, await actor(A), {
			requestKey: randomUUID(),
			input: { articleId: own, fraction: "0.9" },
		}),
	);
	const cached = await shown(own, source);
	assert.equal(cached.body, body);
	const evry = [{ kind: "article", id: cached.revisionId }];
	const cited = async () => [...(await liveRowKeys(c.db, evryActor(await actor(A)), evry))];
	assert.equal((await cited()).length, 1);
	const printed = ok(await api.printArticle(c.db, await actor(A), { articleId: own, source }));
	assert.ok(printed.html?.includes(body));

	const listed = async () => {
		const reader = await actor(A);
		return JSON.stringify([
			ok(await api.readingRecent(c.db, reader, {})),
			ok(await api.search(c.db, reader, { query: "Former body" })),
		]);
	};
	assert.ok((await listed()).includes(own));

	const { activation, reason, worker_identity } = five.action.arguments;
	const kept = await custom();
	const before = await history();
	assert.deepEqual(
		before.map((a) => [a.n, a.release]),
		[
			[1, five.given.activation.previous],
			[activation, "R2"],
		],
	);
	const { value: rolled, added } = await recorded(c.admin, () =>
		c.promote(worker_identity.replace("fixture-state-", ""), String(activation), "rollback", reason),
	);
	assert.deepEqual(added, { audits: ["reference.activated"], jobs: [], notices: 0, mail: 0 });
	assert.equal(Number(rolled.number), five.expected.result.activation_sequence);
	assert.equal((await c.current())?.release_key, five.expected.result.active_generation);
	const now = await history();
	assert.deepEqual(
		now.slice(0, 2).map((a) => a.n),
		five.expected.result.history_entries_retained,
	);
	assert.deepEqual(now.slice(0, 2), before);
	const [appended] = await c.rows(
		sql`SELECT actor_id,reason,expected_prior_number::int AS prior FROM reference_activation WHERE activation_number=3`,
	);
	assert.deepEqual(appended, { actor_id: c.publisher.id, reason, prior: activation });
	assert.deepEqual(await custom(), kept, "no organization or reader row changes");
	const unchanged =
		(await shown(forked.id)).body === "S1-v1" && (await shown(hidden.id)).hidden && (await shown(own)).body === body;
	assert.equal(!unchanged, five.expected.result.org_adoption_required);
	const restored = await shown(read.id);
	assert.deepEqual([restored.body, restored.revisionNumber, restored.completed], [content(read), 1, true]);

	await endS1();
	await untouched(c.admin, async () => {
		const { error_code } = six.expected.result;
		for (const asked of [source, undefined, { kind: "global" as const }]) {
			const answer = await view(own, asked);
			assert.deepEqual(answer, { article: six.expected.result.body, errorCode: error_code });
		}
		const { cached_body } = six.expected.result;
		const reader = await actor(A);
		for (const ask of [api.exportPdf, api.printArticle]) {
			const copy = ok(await ask(c.db, reader, { articleId: own, source }));
			assert.deepEqual([copy.bytes, copy.html, copy.errorCode], [cached_body, cached_body, error_code]);
		}
		const excerpt = ok(await api.referenceExcerpt(c.db, reader, { articleId: own, source }));
		assert.deepEqual(excerpt, { excerpt: cached_body, errorCode: error_code });
		assert.deepEqual(await cited(), [], "Evry's earlier citation is withheld");
		const lists = await listed();
		for (const text of [body, "S1-v1", own]) assert.equal(lists.includes(text), false, text);
		const global = await shown(forked.id);
		assert.deepEqual([global.sourceKind, global.body], ["global", content(forked)]);
	});
	assert.equal((await history()).length, 3);
});
