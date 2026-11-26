import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test, { after, before } from "node:test";
import foundations from "../../../docs/reference/discovery-foundations.json" with { type: "json" };
import { sql } from "../../../packages/db/src/query.ts";
import { createFacts } from "../../../packages/domain/src/intelligence/index.ts";
import { createOnboardingProducer } from "../../../packages/domain/src/onboarding/index.ts";
import { gatedTransaction } from "../../../packages/domain/src/operations/writes.ts";
import { accountId, tenantId } from "../../../packages/contracts/src/common/index.ts";
import { ok, type Actor } from "../../support/fixture.mts";
import { GLOBAL, knowledgeCase, present, wikiWorld } from "./case-world.mts";

let w: Awaited<ReturnType<typeof wikiWorld>>;
const six = foundations.articles.map((article) => article.id);
const onboarding = createOnboardingProducer({ relationships: async () => {}, enqueue: async () => {} });
const facts = createFacts();
before(async () => {
	w = await wikiWorld("wikireading");
	for (const { id, slug, title } of foundations.articles) await w.article({ id, slug, title, body: "Global " + title });
	for (const slug of ["discovery/mapping-your-target-area", "discovery/finding-demographic-data-for-your-area"])
		await w.article({ slug, title: foundations.articles[0]!.title });
});
after(() => w?.close());

const organization = (o: { id: string }) => ({ kind: "organization" as const, organizationId: o.id });
type Church = Awaited<ReturnType<typeof founded>>;
const context = (who: Actor, plant?: string) => ({
	session: who.session,
	selected: plant
		? { kind: "plant" as const, id: tenantId.parse(plant) }
		: { kind: "account" as const, id: accountId.parse(who.id) },
});
async function founded() {
	const owner = await w.f.actor(null, "owner", { account: { registration_kind: "planter" } });
	const made = ok(
		await gatedTransaction(w.db, (tx) =>
			onboarding.createPlant(tx, context(owner), w.cmd({ name: "P", confirmed: true }, "1")),
		),
	);
	return { owner, P: { kind: "plant" as const, id: made.plant.id as string } };
}
async function resume(c: Church) {
	const found = ok(await gatedTransaction(w.db, (tx) => onboarding.getResume(tx, context(c.owner, c.P.id), {})));
	assert.ok(found.status === "available");
	return found;
}
async function reader(c: Church, role: "admin" | "member" = "admin") {
	const who = await w.f.actor(c.P, role);
	const person = randomUUID();
	await w.admin
		.execute(sql`INSERT INTO person(id,tenant_id,plant_id,display_name,source,stage,adult_classification,commitment_state,pipeline_position,state,created_at,linked_account_id)
		VALUES(${person},${c.P.id},${c.P.id},'Reader','other','leader','unknown','unknown',2,'live',clock_timestamp(),${who.id})`);
	return { ...who, person };
}
async function leads(c: Church, person: string) {
	const { revision } = await resume(c);
	const assignment = {
		kind: "minimal_role",
		roleName: "Lead planter",
		container: { kind: "minimal", name: "Leadership" },
	};
	const saved = ok(
		await gatedTransaction(w.db, (tx) =>
			onboarding.answerLead(tx, context(c.owner, c.P.id), w.cmd({ answer: "yes", assignment }, revision)),
		),
	);
	assert.ok(saved.lead.answer === "yes");
	const { teamId, roleId } = saved.lead.assignment;
	await w.admin.execute(sql`UPDATE team_tenure SET person_id=${person} WHERE role_id=${roleId}`);
	await w.admin.execute(sql`UPDATE team SET leader_person_id=${person} WHERE id=${teamId}`);
}
const stats = async (who: Actor) => ok(await w.api.readingStats(w.db, await w.actor(who), {}));
const phase = (c: Church) =>
	w.one<{ phase: number }>(sql`SELECT phase FROM plant WHERE id=${c.P.id}`).then((r) => r.phase);
async function readsAll(who: Actor, ratios: readonly (number | string)[], articles = six) {
	const { added } = await w.recorded(async () => {
		for (const [n, ratio] of ratios.entries()) await w.progress(who, articles[n]!, ratio);
	});
	assert.deepEqual([added.notices, added.mail, added.jobs], [0, 0, []]);
}

test("AC:DISC-READER-001 one Admin lead's own six at 0.8001 complete Discovery for an Owner with none, in the same phase", async () => {
	const { action, expected } = knowledgeCase("DISC-READER-001");
	const { A_ratios, B_ratios, B_eligible } = action.arguments;
	const c = await founded();
	const B = await reader(c);
	const titled = await reader(c, "member");
	const names: Record<string, string> = { [c.owner.id]: "A", [B.id]: "B", [titled.id]: "titled" };
	await leads(c, titled.person);
	await w.admin.execute(sql`UPDATE seat SET ended_at=clock_timestamp() WHERE account_id=${titled.id}`);
	await w.admin.execute(
		sql`INSERT INTO seat(account_id,plant_id,role,accepted_at) VALUES(${titled.id},${(await w.f.plant()).id},'admin',clock_timestamp())`,
	);
	await readsAll(titled, B_ratios);
	assert.deepEqual((await resume(c)).reading, { status: "incomplete" }, "a title without a current seat never counts");
	for (const [n, ratio] of A_ratios.entries())
		assert.equal((await w.progress(c.owner, six[n]!, ratio)).completed, false);
	await readsAll(B, B_ratios);
	assert.deepEqual((await resume(c)).reading, { status: "incomplete" }, "an Admin without the lead title never counts");
	const role = await w.one<{ role_id: string; team_id: string }>(
		sql`SELECT tt.role_id,tm.id AS team_id FROM team_tenure tt JOIN team_role r ON r.id=tt.role_id JOIN team tm ON tm.id=r.team_id WHERE tt.person_id=${titled.person}`,
	);
	await w.admin.execute(sql`UPDATE team_tenure SET person_id=${B.person} WHERE role_id=${role.role_id}`);
	await w.admin.execute(sql`UPDATE team SET leader_person_id=${B.person} WHERE id=${role.team_id}`);
	const { reading, currentPhase } = await resume(c);
	assert.equal(reading.status === "complete", expected.result.complete);
	assert.ok(reading.status === "complete");
	assert.equal(names[reading.readerAccountId], expected.result.qualifying_reader);
	assert.equal(reading.eligibility.kind === "current_admin_lead", B_eligible);
	assert.deepEqual(
		reading.articles.map((a) => [a.articleId, a.scrollRatio]).toSorted(),
		six.map((id, n) => [id, B_ratios[n]]).toSorted(),
	);
	const mine = await stats(B);
	assert.deepEqual(
		[mine.discoveryComplete, mine.qualifyingReader, mine.articles.length, mine.completionAtRatio],
		[true, true, 6, { owner: false, caller: true }],
	);
	const owners = await stats(c.owner);
	assert.deepEqual([owners.discoveryComplete, owners.qualifyingReader], [false, false]);
	assert.deepEqual([currentPhase, await phase(c)], [1, 1]);
});

test("AC:DISC-READER-002 two readers' three and three never pool, and one article at exactly 0.80 leaves Discovery open in Phase 1", async () => {
	const { expected } = knowledgeCase("DISC-READER-002");
	const c = await founded();
	const other = await reader(c);
	await leads(c, other.person);
	await readsAll(c.owner, [0.9, 0.9, 0.9], six.slice(0, 3));
	await readsAll(other, [0.9, 0.9, 0.9], six.slice(3));
	const open = async () => {
		const { reading, currentPhase } = await resume(c);
		assert.equal(reading.status === "complete", expected.result.pooled_reading_credit);
		assert.deepEqual([currentPhase, await phase(c)], [expected.result.phase, expected.result.phase]);
		for (const who of [c.owner, other]) assert.equal((await stats(who)).discoveryComplete, false);
	};
	await open();
	await readsAll(c.owner, [0.9, 0.9, "0.80"], six.slice(3));
	await open();
	assert.deepEqual(
		(await stats(c.owner)).articles.filter((a) => !a.completed).map((a) => [a.articleId, a.ratio]),
		[[six[5], "0.80"]],
	);
	await w.progress(c.owner, six[5]!, "0.8001");
	const { reading } = await resume(c);
	assert.ok(reading.status === "complete");
	assert.equal(reading.readerAccountId, c.owner.id);
});

test("AC:DISC-READER-003 an entitled organization version and the global one earn the same credit, kept after an update and a departure that takes the text", async () => {
	const { action, expected } = knowledgeCase("DISC-READER-003");
	const { global_published, S1_active, read_completed } = action.arguments;
	assert.deepEqual([global_published, S1_active, read_completed], [true, false, true]);
	const { A, leave } = await w.church([w.S1]);
	const onGlobal = await w.church();
	const g1 = six[0]!;
	await w.publish(w.S1, g1, "S1 fork");
	const twin = await w.article({ title: foundations.articles[0]!.title });
	await w.progress(A, twin.id, "0.9");
	const credit = async (who: Actor) => (await stats(who)).articles.find((a) => a.articleId === g1)?.completed;
	assert.equal(await credit(A), false, "an unrelated article of the same title earns nothing");
	await w.progress(A, g1, "0.9");
	await w.progress(onGlobal.A, g1, "0.9");
	const fork = await w.kept(A, g1);
	const globally = await w.kept(onGlobal.A, g1);
	assert.deepEqual([fork.completed_source, globally.completed_source], [w.S1.id, GLOBAL]);
	assert.equal(await credit(onGlobal.A), expected.result.global_credit_allowed);
	await w.publish(w.S1, g1, "S1 fork, revised", "1");
	assert.deepEqual([await credit(A), (await w.view(A, g1)).article?.updatedLabel], [true, true]);
	await leave(w.S1);
	await w.untouched(async () => {
		assert.equal(await credit(A), expected.result.prior_credit_retained);
		assert.deepEqual(await w.view(A, g1, organization(w.S1)), {
			article: expected.result.S1_body,
			errorCode: "content_access_denied",
		});
		const now = present((await w.view(A, g1)).article, "global");
		assert.deepEqual([now.sourceKind, now.completed], ["global", true]);
		assert.deepEqual(await w.stored(A, g1), [fork]);
	});
});

test("AC:CONTENT50-002 a published global or church version read past 0.80 credits its canonical article for that reader only, and a draft credits nobody", async () => {
	const { action, expected } = knowledgeCase("CONTENT50-002");
	const { progress, draft_ratio, versions } = action.arguments;
	assert.deepEqual(versions, ["global-v1", "S1-v2"]);
	const c = await w.church([w.S1]);
	const B = await w.f.actor(c.P, "owner");
	const foundation = six[1]!;
	const names: Record<string, string> = { [foundation]: action.arguments.article };
	await w.publish(w.S1, foundation, "S1 one");
	await w.publish(w.S1, foundation, "S1 two", "1");
	const twin = await w.article({ title: foundations.articles[1]!.title });
	await w.progress(B, twin.id, "1");
	await w.progress(c.A, foundation, progress.A);
	await w.progress(B, foundation, progress.B);
	const credit = async (who: Actor, id: string) => {
		const row = (await stats(who)).articles.find((a) => a.articleId === id);
		const listed = await w.api.listCompletedArticles(w.db, await w.actor(who), [id]);
		assert.equal(listed.has(id), row?.completed);
		return row?.completed;
	};
	assert.equal(await credit(c.A, foundation), expected.result.A_credit);
	assert.equal(await credit(B, foundation), expected.result.B_credit);
	assert.equal((await w.kept(B, foundation)).done, expected.result.B_credit);
	const earned = await w.kept(c.A, foundation);
	assert.equal(names[earned.article_id], expected.result.canonical_id);
	assert.deepEqual(
		[earned.completed_source, earned.completed_version, Number(earned.completed)],
		[w.S1.id, 2, progress.A],
	);
	assert.equal(
		(await w.view(c.A, foundation, { kind: "global" })).article?.completed,
		true,
		"every version is not required",
	);

	const drafted = await w.article({ tenant: w.S1.id, title: foundations.articles[1]!.title });
	await w.admin
		.execute(sql`INSERT INTO article_editor_state(id,organization_id,article_id,state,draft_revision_id,revision)
		VALUES(gen_random_uuid(),${w.S1.id},${drafted.id},'draft',${drafted.revisionId},1)`);
	await w.untouched(async () => {
		const tried = await w.progress(c.A, drafted.id, draft_ratio);
		assert.deepEqual(
			[tried.completed, tried.written, tried.errorCode],
			[expected.result.draft_credit, false, "content_access_denied"],
		);
		assert.equal((await stats(c.A)).discoveryComplete, false);
	});
	ok(
		await w.api.addOrganizationArticle(
			w.db,
			await w.actor(w.S1.editor),
			w.cmd({ articleId: six[2]!, organizationId: w.S1.id, body: "S1 draft" }),
		),
	);
	assert.equal((await w.view(c.A, six[2]!)).article?.body, "Global " + foundations.articles[2]!.title);
	await w.progress(c.A, six[2]!, draft_ratio);
	assert.equal((await w.kept(c.A, six[2]!)).completed_source, GLOBAL);
});

test("AC:CONTENT50-003 a hidden or departed source keeps the earned credit, gives no text, and leaves the global text readable", async () => {
	const { action, expected } = knowledgeCase("CONTENT50-003");
	assert.deepEqual(action.arguments, {
		read_source: "S1-v1",
		completed: true,
		S1_active: false,
		global_published: true,
	});
	const { A, leave } = await w.church([w.S1]);
	const foundation = six[3]!;
	await w.publish(w.S1, foundation, "S1 text");
	await w.progress(A, foundation, "0.91");
	const credit = async () => (await stats(A)).articles.find((a) => a.articleId === foundation)?.completed;
	const before = await w.stored(A, foundation);
	ok(
		await w.api.hideOrganizationArticle(
			w.db,
			await w.actor(w.S1.editor),
			w.cmd({ articleId: foundation, organizationId: w.S1.id }, "1"),
		),
	);
	const global = async () => {
		const body = (await w.view(A, foundation, { kind: "global" })).article?.body;
		assert.equal(body === "Global " + foundations.articles[3]!.title, expected.result.global_body_available);
		assert.equal(await credit(), expected.result.credit_retained);
		assert.deepEqual(await w.stored(A, foundation), before);
	};
	await w.untouched(async () => {
		assert.equal((await w.view(A, foundation, organization(w.S1))).article?.body, expected.result.S1_body);
		assert.equal((await w.view(A, foundation)).article?.body, null);
		await global();
	});
	await leave(w.S1);
	await w.untouched(async () => {
		assert.equal((await w.view(A, foundation, organization(w.S1))).article, expected.result.S1_body);
		assert.equal((await w.view(A, foundation)).article?.sourceKind, "global");
		await global();
	});
});

test("AC:WIKI49-003 reading a new revision records its own progress beside the old credit, and a departed source gives no text", async () => {
	const { action, expected } = knowledgeCase("WIKI49-003");
	const { prior_read_version, ratio, new_version, read_again } = action.arguments;
	const { A, leave } = await w.church([w.S1]);
	const article = await w.article();
	await w.publish(w.S1, article.id, "S1 version 1");
	await w.progress(A, article.id, ratio);
	const first = await w.kept(A, article.id);
	assert.deepEqual([first.completed_version, first.last_version], [prior_read_version, prior_read_version]);
	await w.publish(w.S1, article.id, "S1 version 2", "1");
	const { added } = await w.recorded(() => w.progress(A, article.id, "0.2"));
	assert.deepEqual([added.notices, added.mail, added.jobs], [0, 0, []]);
	const second = await w.kept(A, article.id);
	assert.equal(
		second.last_version === new_version && second.last_source === w.S1.id,
		expected.result.new_progress_recorded,
	);
	assert.equal(read_again, true);
	assert.deepEqual(
		[second.completed_version, Number(second.completed), second.completed_at, Number(second.observed)],
		[prior_read_version, ratio, first.completed_at, ratio],
	);
	await leave(w.S1);
	await w.untouched(async () => {
		const former = await w.view(A, article.id, organization(w.S1));
		assert.deepEqual(former, { article: expected.result.former_body, errorCode: "content_access_denied" });
		const now = present((await w.view(A, article.id)).article, "global");
		assert.deepEqual([now.completed, now.sourceKind], [expected.result.prior_credit, "global"]);
		assert.deepEqual(await w.stored(A, article.id), [second]);
	});
});

test("AC:WIKI49-004 a meaningful update of all six leaves completed Discovery and training credit as they were", async () => {
	const { action, expected } = knowledgeCase("WIKI49-004");
	const { six_article_ratios, article_update, meaningful } = action.arguments;
	const c = await founded();
	await readsAll(c.owner, six_article_ratios);
	const trainee = await reader(c);
	const [program, credit] = [randomUUID(), randomUUID()];
	const names: Record<string, string> = { [credit]: action.arguments.training_credit };
	await w.admin.execute(
		sql`INSERT INTO training_program(id,plant_id,name,required) VALUES(${program},${c.P.id},'Launch team basics',true)`,
	);
	await w.admin.execute(sql`INSERT INTO training_assignment(plant_id,program_id,person_id,version,state,effective_on)
		VALUES(${c.P.id},${program},${trainee.person},1,'active','2026-10-01')`);
	await w.admin.execute(sql`INSERT INTO training_credit(id,plant_id,person_id,program_id,kind,version,earned_on)
		VALUES(${credit},${c.P.id},${trainee.person},${program},'earned',1,'2026-10-05')`);
	const evidence = async () => {
		const read = ok(await facts.readFacts(w.db, await w.actor(c.owner), {}));
		const { reading } = await resume(c);
		return {
			training: [read.training.complete, read.training.total, read.criteria.training_complete],
			credits: await w.rows<{ row: { id: string } }>(
				sql`SELECT to_jsonb(t) AS row FROM training_credit t WHERE plant_id=${c.P.id}`,
			),
			reading,
			stats: (await stats(c.owner)).discoveryComplete,
			readings: await w.rows<{ row: { completed_at: string | null } }>(
				sql`SELECT to_jsonb(r) AS row FROM reading r WHERE account_id=${c.owner.id} ORDER BY article_id`,
			),
		};
	};
	const before = await evidence();
	assert.deepEqual([before.training.slice(0, 2), before.reading.status, before.stats], [[1, 1], "complete", true]);
	for (const { id, slug, title } of foundations.articles)
		await w.revise(id, { slug, title, number: article_update, meaningful, sequence: 2, body: "Updated " + title });
	await w.untouched(async () => {
		for (const id of six) {
			const shown = present((await w.view(c.owner, id)).article, "article");
			assert.deepEqual([shown.updatedLabel, shown.completed, shown.revisionNumber], [true, true, 2]);
		}
		const after = await evidence();
		assert.deepEqual(after, before);
		assert.equal(after.reading.status === "complete" && after.stats, expected.result.Discovery_complete);
		assert.equal(names[after.credits[0]!.row.id], expected.result.training_credit);
		assert.equal(
			after.readings.some((r) => r.row.completed_at === null),
			expected.result.reading_reset,
		);
	});
});
