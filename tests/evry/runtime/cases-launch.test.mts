import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { runDueFeedbackPublication } from "../../../packages/domain/src/jobs/feedback-publication.ts";
import { createLaunchReader } from "../../../packages/domain/src/launch/reads.ts";
import { createLaunchWriter } from "../../../packages/domain/src/launch/writes.ts";
import { createPrivateCare } from "../../../packages/domain/src/intelligence/index.ts";
import { createTaskWriter, withTaskWrite } from "../../../packages/domain/src/tasks/index.ts";
import { createWikiProducer } from "../../../packages/domain/src/wiki/index.ts";
import { approveProposal } from "../../../packages/evry/src/index.ts";
import { nativePorts } from "../evals/settings-ports.mts";
import { ok, type Actor } from "../../support/fixture.mts";
import {
	caseWorld,
	proposes,
	reads,
	rowsOf,
	sql,
	type CaseWorld,
	type Church,
	type Play,
	type Reply,
} from "./case-world.mts";
import { seedFoundations } from "./foundations.mts";

let w: CaseWorld;
before(async () => {
	w = await caseWorld("caselaunch", { native: nativePorts() });
});
after(() => w?.close());

async function notice(
	account: string,
	plant: string,
	category: "task_due" | "meeting_reminder",
	title: string,
	minute: number,
) {
	const id = randomUUID();
	const source = randomUUID();
	await w.admin.execute(sql`INSERT INTO task(id,plant_id,title,category,priority,status,created_at,due_kind)
		VALUES(${source},${plant},${title},'general','medium','not_started',clock_timestamp(),'undated')`);
	await w.admin
		.execute(sql`INSERT INTO notice(id,tenant_id,recipient_id,category,purpose,logical_key,source_record_id,source_revision,title,eligible_at,created_at,timezone)
		VALUES(${id},${plant},${account},${category === "task_due" ? "task" : "meeting"},${category},${`${plant}/${category}/${id}`},${source},1,${title},
			${`2026-10-13T15:${String(minute).padStart(2, "0")}:00Z`},clock_timestamp(),'America/Chicago')`);
	return id;
}
const unread = async (account: string) =>
	(
		await w.rows<{ id: string }>(
			sql`SELECT id FROM notice WHERE recipient_id=${account} AND read_at IS NULL ORDER BY eligible_at`,
		)
	).map((r) => r.id);

test("AC:GAP-EVR-421 the feed and its count show one account's own notices, and neither reading nor preparing marks any read", async () => {
	const c = await w.church();
	const other = await w.seated(c.P, "member");
	const N = [];
	for (const [n, category] of (["task_due", "meeting_reminder", "task_due"] as const).entries())
		N.push(await notice(c.A.id, c.P.id, category, `Mine ${n}`, n));
	const N4 = await notice(c.A.id, c.P.id, "task_due", "Mine read", 5);
	await w.admin.execute(sql`UPDATE notice SET read_at=clock_timestamp() WHERE id=${N4}`);
	const theirs = [
		await notice(other.id, c.P.id, "task_due", "Theirs 1", 6),
		await notice(other.id, c.P.id, "task_due", "Theirs 2", 7),
	];
	const said = "Read/count unread feed then prepare selected marking";
	const play: Play = [
		reads("notifications.feed", { unread: true }),
		reads("notifications.feed", {}),
		reads("notifications.feed", { unread: true, category: "meeting_reminder" }),
	];
	const asked = await w.quiet(() => w.ask(c.A, said, play));
	const [mine, all, meetings] = asked.replies;
	const ids = (reply: Reply) => rowsOf(reply).map((r) => r.id);
	assert.deepEqual([ids(mine).sort(), mine.total], [[...N].sort(), 3]);
	assert.deepEqual(ids(all).sort(), [...N, N4].sort());
	assert.deepEqual(
		rowsOf(all)
			.filter((r) => r.fields.read)
			.map((r) => r.id),
		[N4],
	);
	assert.deepEqual(ids(meetings), [N[1]]);
	assert.equal(
		theirs.some((id) => JSON.stringify(asked.saved).includes(id)),
		false,
		"no other account's feed",
	);
	const prepared = await w.ask(c.A, said, [proposes("notifications.markSelectedRead", { noticeIds: N.slice(0, 2) })]);
	assert.deepEqual(
		prepared.proposals.map((p) => p.status),
		["pending"],
	);
	assert.deepEqual([await unread(c.A.id), await unread(other.id)], [N, theirs], "nothing is read yet");
	await c.foreign(said, play, { secrets: ["Mine 0", "Theirs 1"] });
	await c.outage(said, play, "notice");
});

test("AC:INH-NOTIFICATIONS-03 marking those three names each once, marks only them, and a second approval changes nothing", async () => {
	const c = await w.church();
	const [N1, N2, N3, N4] = [
		await notice(c.A.id, c.P.id, "task_due", "Notice one", 1),
		await notice(c.A.id, c.P.id, "task_due", "Notice two", 2),
		await notice(c.A.id, c.P.id, "task_due", "Notice three", 3),
		await notice(c.A.id, c.P.id, "task_due", "Notice four", 4),
	];
	const said = "Mark those three notifications as read.";
	const mark = proposes("notifications.markSelectedRead", { noticeIds: [N1, N2, N3] });
	const asked = await w.ask(c.A, said, [
		proposes("notifications.markSelectedRead", { noticeIds: [N1, N2, N3, N1, N2] }),
	]);
	const [card] = asked.proposals;
	assert.deepEqual(
		card!.review.changes.map((x) => [(x.before as { id: string }).id, x.after]).sort(),
		[N1, N2, N3].map((id) => [id, "read"]).sort(),
		"each of the three once",
	);
	assert.deepEqual(await unread(c.A.id), [N1, N2, N3, N4]);
	assert.equal((await w.approve(c.A, card!)).review.outcome, "completed");
	assert.deepEqual(await unread(c.A.id), [N4]);
	const marked = await w.rows(sql`SELECT id,read_at FROM notice WHERE recipient_id=${c.A.id} ORDER BY id`);
	const again = await w.quiet(() => approve(c, card!));
	assert.equal(again.replayed, true);
	assert.equal(await w.effect(), null);
	assert.deepEqual(await w.rows(sql`SELECT id,read_at FROM notice WHERE recipient_id=${c.A.id} ORDER BY id`), marked);
	await c.foreign(said, [mark], { secrets: ["Notice three"] });
	await c.outage(said, [reads("notifications.feed", { unread: true }), mark], "notice");
	assert.deepEqual(await unread(c.A.id), [N4]);
});
const approve = async (c: Church, p: Parameters<CaseWorld["witness"]>[0]) =>
	approveProposal(w.db, await w.actorOf(c.A), p.id, w.witness(p), null);

test("AC:INH-NOTIFICATIONS-04 feedback is stored privately after its exact review, and the public summary is the closed text with no words, token or private care", async () => {
	const c = await w.church();
	const care = createPrivateCare();
	const planter = await w.seated(c.P, "owner");
	await w.admin.execute(sql`UPDATE account SET personal_timezone='America/Chicago' WHERE id=${planter.id}`);
	const authority = await w.authorityOf(planter);
	const current = ok(await care.readCurrent(w.db, authority, {}));
	const answers = { spiritual: "struggling", family: "struggling", financial: "struggling", pace: "struggling" };
	ok(
		await care.save(w.db, authority, {
			requestKey: randomUUID(),
			expectedRevision: current.revision,
			input: { answers, note: "CARE-CANARY" },
		}),
	);
	const said = "Send product feedback that task filtering is confusing.";
	const words = "Task filtering is confusing";
	const submit = proposes("feedback.submit", { category: "suggestion", description: words });
	const started = await w.ask(planter, "My diagnostic log says Bearer TOKEN-CANARY-0123456789abcdef", []);
	assert.equal(JSON.stringify(started.prompts).includes("TOKEN-CANARY"), false, "a token never reaches the model");
	const asked = await w.ask(planter, said, [submit], { conversation: started.conversation });
	const [card] = asked.proposals;
	assert.ok(card, JSON.stringify(asked.replies));
	const shown = JSON.stringify(card.review);
	assert.deepEqual(card.review.changes.find((x) => x.field === "feedback")?.after, words);
	assert.doesNotMatch(shown, /CANARY/);
	assert.equal(await w.count(sql`SELECT count(*)::int AS n FROM feedback`), 0);
	await w.approve(planter, card);
	const saved = await w.one(sql`SELECT * FROM feedback WHERE account_id=${planter.id}`);
	assert.deepEqual([saved.category, saved.description, saved.publication_state], ["suggestion", words, "pending"]);
	assert.doesNotMatch(JSON.stringify(saved), /CANARY/);
	const published: unknown[] = [];
	await runDueFeedbackPublication(
		w.db,
		{
			repository: { id: "10", name: "everyfield-test/feedback" },
			issues: {
				search: async () => ({ kind: "found", issues: [] }),
				create: async (_repository, issue) => {
					published.push(issue);
					return { kind: "created", issue: { number: 1, url: "https://github.example.test/1" } };
				},
			},
			operatorMail: null,
		},
		10,
		Date.now() + 30_000,
	);
	const reference = (await w.one(sql`SELECT reference FROM feedback WHERE account_id=${planter.id}`)).reference;
	assert.equal(published.length, 1, JSON.stringify(published));
	assert.match(JSON.stringify(published[0]), /Suggestion — Application/);
	assert.ok(
		JSON.stringify(published[0]).includes(
			`A product suggestion was submitted for Application. Private details are retained for authorized triage. Reference: ${String(reference)}.`,
		),
	);
	assert.doesNotMatch(JSON.stringify(published), new RegExp(`CANARY|${words}|Alex|${planter.id}`));
	await c.foreign(said, [reads("feedback.listOwn", {})], { secrets: ["CANARY"] });
	await c.outage(said, [reads("feedback.listOwn", {}), submit], "feedback");
});

const planNow = async (c: Church) => {
	const reply = ok(await createLaunchReader().readPlan(w.db, await w.authorityOf(c.A)));
	return (reply as Reply).plan;
};
async function scheduled(c: Church, date: string, reason: string | null = null) {
	const plan = await planNow(c);
	ok(
		await createLaunchWriter({ notices: async () => undefined }).schedule(w.db, await w.authorityOf(c.A), {
			requestKey: randomUUID(),
			expectedRevision: plan.launch?.revision ?? plan.revision,
			input: { date, reason },
		}),
	);
}
const unloaded = (reply: Reply) =>
	reply.status === "not_found" && reply.facts.loaded === false && /couldn't be loaded/.test(reply.exclusions.join());

test("AC:INH-LAUNCH-02 a milestone is blocked only by its own linked overdue task and that task's unmet prerequisite, never by a similar title", async () => {
	const c = await w.church();
	await scheduled(c, "2026-12-20");
	const plan = await planNow(c);
	const M = plan.milestones.find((m: Reply) => m.tasks.length);
	const T = M.tasks[0].id;
	await w.admin.execute(sql`UPDATE task SET due_kind='date_only',due_date='2026-10-01' WHERE id=${T}`);
	const [U, P1] = [randomUUID(), randomUUID()];
	for (const [id, title] of [
		[U, M.tasks[0].title],
		[P1, "P1"],
	])
		await w.admin.execute(sql`INSERT INTO task(id,plant_id,title,category,priority,status,created_at,due_kind,due_date)
			VALUES(${id},${c.P.id},${title},'general','medium','not_started',clock_timestamp(),'date_only','2026-09-01')`);
	const actor = await w.authorityOf(c.A);
	const { r } = await w.one<{ r: string }>(sql`SELECT revision::text AS r FROM task WHERE id=${T}`);
	ok(
		await withTaskWrite(w.db, actor, (tx, ctx) =>
			createTaskWriter({ reminders: async () => undefined as never }).replacePrerequisites(tx, ctx, {
				requestKey: randomUUID(),
				expectedRevision: r,
				input: { taskId: T, prerequisiteIds: [P1] },
			}),
		),
	);
	const said = "Which launch milestones are blocked by overdue tasks?";
	const play: Play = [
		reads("launch.readWorkspace", { filter: "blocked" }),
		reads("tasks.listPrerequisites", { taskId: T }),
	];
	const asked = await w.quiet(() => w.ask(c.A, said, play));
	const [blocked, waits] = asked.replies;
	assert.deepEqual(
		rowsOf(blocked, "milestone").map((m) => [m.id, m.fields.overdueTasks]),
		[[M.id, 1]],
	);
	const blockers = [
		...rowsOf(blocked, "item")
			.filter((t) => t.fields.overdue)
			.map((t) => t.id),
		...rowsOf(waits)
			.filter((t) => t.fields.blocking)
			.map((t) => t.id),
	];
	assert.deepEqual(blockers, [T, P1]);
	assert.equal(asked.saved.includes(U), false, "a task of the same title is not linked");
	await c.foreign(said, [
		reads("tasks.listPrerequisites", { taskId: T }),
		reads("launch.readWorkspace", { filter: "blocked" }),
	]);
	await c.outage(said, [reads("launch.readWorkspace", { filter: "blocked" })], "launch_milestone", { told: unloaded });
});

test("AC:INH-LAUNCH-03 what changed is the recorded date move only, with no rebuilt earlier staffing, tasks or readiness", async () => {
	const c = await w.church();
	await scheduled(c, "2026-10-25");
	await scheduled(c, "2026-10-18", "The school asked us.");
	await w.admin.execute(sql`UPDATE task SET title=title||' edited' WHERE plant_id=${c.P.id}`);
	const said = "What changed in our launch readiness since last week?";
	const play: Play = [reads("launch.readJournal", { since: "2026-10-06" })];
	const asked = await w.quiet(() => w.ask(c.A, said, play));
	const [journal] = asked.replies;
	const moved = rowsOf(journal).filter((e) => e.label === "Launch Sunday moved");
	assert.deepEqual(
		moved.map((e) => [e.fields.from, e.fields.to]),
		[["Sun, Oct 25, 2026", "Sun, Oct 18, 2026"]],
	);
	assert.ok(
		rowsOf(journal).every((e) => e.fields.change === "date"),
		"only date entries",
	);
	assert.doesNotMatch(JSON.stringify(journal.rows), /staff|task|readiness|milestone/i);
	assert.deepEqual(journal.exclusions, ["how readiness stood at an earlier time, which history does not record"]);
	await c.foreign(said, [reads("launch.readWorkspace", { filter: "open" }), ...play], {
		secrets: ["The school asked us"],
	});
	await c.outage(said, play, "audit_event", { told: unloaded });
});

test("AC:INH-LAUNCH-04 an Owner or Admin gets the same review of October 18 with what stays, and the saved date moves only on approval", async () => {
	const c = await w.church();
	await scheduled(c, "2026-10-25");
	const owner = await w.seated(c.P, "owner");
	const member = await w.seated(c.P, "member");
	const said = "Move the launch date to October 18 and show me what else would move.";
	const move = proposes("launch.schedule", { date: "2026-10-18", reason: "Move it earlier" });
	const saved = async () => (await w.one(sql`SELECT target_date::text AS d FROM launch WHERE plant_id=${c.P.id}`)).d;
	const held = () =>
		w.rows(sql`SELECT id,due_date,status,revision::text AS r FROM task WHERE plant_id=${c.P.id} ORDER BY id`);
	const tasks = await held();
	const cards = [];
	for (const who of [c.A, owner]) {
		const asked = await w.ask(who, said, [reads("launch.readWorkspace", { filter: "open" }), move]);
		const [card] = asked.proposals;
		assert.deepEqual([card!.status, card!.review.refusal ?? null], ["pending", null]);
		assert.deepEqual(card!.review.changes[0], {
			field: "launchDate",
			before: "Sun, Oct 25, 2026",
			after: "Sun, Oct 18, 2026",
		});
		cards.push([card!.review.changes, card!.review.notes]);
	}
	assert.deepEqual(cards[0], cards[1]);
	assert.match(String(cards[0]![1]), /prep tasks?|due dates/i);
	assert.deepEqual([await saved(), await held()], ["2026-10-25", tasks]);
	const denied = await w.quiet(() => w.ask(member, said, [move]));
	assert.deepEqual([denied.replies[0].error, denied.proposals], ["not_offered", []]);
	const { proposals } = await w.ask(c.A, said, [move]);
	await w.approve(c.A, proposals[0]!);
	assert.deepEqual([await saved(), await held()], ["2026-10-18", tasks], "approval moves the date and no task");
	await c.foreign(said, [move], { secrets: ["Oct 25"] });
	await c.outage(said, [reads("launch.readWorkspace", { filter: "open" })], "launch", { told: unloaded });
});

test("AC:INH-LAUNCH-05 the form's headcount and 12 unnamed guests are saved as counts after review, with no Person, guest or decision from them, and the debrief still submits", async () => {
	const c = await w.church();
	await scheduled(c, "2026-10-20");
	await w.admin.execute(sql`UPDATE launch SET target_date='2026-10-11' WHERE plant_id=${c.P.id}`);
	const said = "Record the launch attendance and guest count from this form.";
	const record = proposes("launch.recordOutcome", { actualDate: "2026-10-11", attendance: 150, guestsNotNamed: 12 });
	const counts = () =>
		w.one(sql`SELECT (SELECT count(*)::int FROM person WHERE plant_id=${c.P.id}) AS people,(SELECT count(*)::int FROM launch_guest WHERE plant_id=${c.P.id}) AS guests,
			(SELECT count(*)::int FROM commitment WHERE plant_id=${c.P.id}) AS commitments`);
	const before = await counts();
	const asked = await w.ask(c.A, said, [record]);
	const [card] = asked.proposals;
	assert.ok(card, JSON.stringify(asked.replies));
	assert.deepEqual(card.review.refusal ?? null, null);
	assert.ok(card.review.changes.some((x) => x.field === "attendance" && x.after === 150));
	assert.match(JSON.stringify(card.review.changes.find((x) => x.field === "guestAnswer")), /12/);
	assert.match(String(card.review.notes), /No people are created from these numbers/);
	assert.deepEqual(await counts(), before, "nothing is written before approval");
	const done = await w.approve(c.A, card);
	assert.equal(done.review.outcome, "completed", JSON.stringify(done.review.receipt));
	const saved = await planNow(c);
	assert.deepEqual([saved.outcome.attendance, saved.outcome.decisions], [150, null]);
	assert.deepEqual([saved.debrief.draft.answers.missingNames, saved.debrief.draft.answers.missingCount], ["yes", 12]);
	const after = await counts();
	assert.deepEqual([after.people, after.guests, after.commitments], [before.people, 0, before.commitments]);
	const debrief = await w.ask(c.A, "Submit the debrief.", [
		proposes("launch.submitDebrief", {
			wentWell: "People came.",
			toChange: "Signs.",
			operations: "Good.",
			followUpPlan: "Calls.",
			supportNeeded: "None.",
		}),
	]);
	assert.equal(debrief.proposals[0]!.review.refusal ?? null, null, "missing names never block the debrief");
	assert.equal((await w.approve(c.A, debrief.proposals[0]!)).review.outcome, "completed");
	assert.ok((await planNow(c)).debrief.submitted);
	await c.foreign(said, [record, reads("launch.readDebrief", {})], { secrets: ["People came"] });
	await c.outage(said, [reads("launch.readDebrief", {})], "launch", { told: unloaded });
});

test("AC:EVRY-FOUNDATIONS-ONE-READER one eligible reader must read all six past 80 percent: readers never pool, exactly 80 does not count, Evry's reads earn nothing, and the church starts in Phase 1 either way", async () => {
	const articles = await seedFoundations(w.admin);
	const wiki = createWikiProducer();
	const readAs = async (who: Actor, some: string[], fraction: string) => {
		for (const articleId of some)
			ok(
				await wiki.updateProgress(w.db, await w.authorityOf(who), {
					requestKey: randomUUID(),
					input: { articleId, fraction },
				}),
			);
	};
	const C = await w.seated(null as never, "owner");
	const said =
		"Create new plant phase 1 before readings complete; inspect foundations metric before and after actual Reader-C completes sixth";
	const create = await w.ask(C, said, [proposes("onboarding.createPlant", { name: "Cedar Plant" })]);
	const [card] = create.proposals;
	assert.ok(card, JSON.stringify(create.replies));
	const made = await w.approve(C, card);
	assert.equal(made.outcome, "completed", JSON.stringify(made.review.receipt));
	const plant = await w.one<{ id: string; phase: number }>(
		sql`SELECT p.id,p.phase FROM plant p JOIN seat s ON s.plant_id=p.id WHERE s.account_id=${C.id}`,
	);
	assert.equal(plant.phase, 1, "a church is created in Phase 1 with no reading");
	const P = { kind: "plant" as const, id: plant.id };
	const [A, B, third] = [await w.seated(P, "admin"), await w.seated(P, "admin"), await w.seated(P, "admin")];
	const c = await w.church({}, { plant: P, admin: A });
	const metric = async (who: Actor) => {
		const asked = await w.quiet(() => w.ask(who, said, [reads("wiki.reading.stats", {})]));
		const { discoveryRead, discoveryTotal, discoveryComplete, churchPhase } = asked.replies[0].facts;
		const stats = ok(await wiki.readingStats(w.db, await w.authorityOf(who), {})) as Reply;
		return [discoveryRead, discoveryTotal, discoveryComplete, churchPhase, stats.qualifyingReader];
	};
	const criterion = async () => {
		const asked = await w.ask(C, said, [
			reads("phases.readReadiness", { phase: 0 }),
			reads("intelligence.readExitCriteria", { phase: 0 }),
		]);
		return asked.replies.map((r) => {
			const row = rowsOf(r, "criterion").find((x) => x.id === "foundations_complete");
			return row && [row.label, row.fields.status, row.fields.reading ?? null];
		});
	};
	const unknown = ["Foundational modules complete", "no data yet", null];
	assert.deepEqual(await criterion(), [unknown, unknown], "a measure with no record is unknown, never zero");
	assert.deepEqual(await metric(C), [0, 6, false, 1, false]);
	await readAs(A, articles.slice(0, 4), "0.9");
	await readAs(B, articles.slice(4), "0.9");
	await readAs(third, articles.slice(0, 1), "0.80");
	await readAs(C, articles.slice(0, 5), "0.81");
	assert.deepEqual(await metric(A), [4, 6, false, 1, false]);
	assert.deepEqual(await metric(B), [2, 6, false, 1, false], "two readers' six articles do not add up");
	assert.deepEqual(await metric(third), [0, 6, false, 1, false], "exactly 80 percent is not read");
	assert.deepEqual(await metric(C), [5, 6, false, 1, false]);
	const held = () =>
		w.rows(
			sql`SELECT account_id,article_id,observed_fraction::text AS f,completed_at IS NOT NULL AS done FROM reading ORDER BY 1,2`,
		);
	const before = await held();
	await w.quiet(() =>
		w.ask(C, said, [
			() =>
				articles.map((articleId) => ({
					tool: "wiki_read",
					input: { operation: "wiki.referenceExcerpt", input: { articleId } },
				})),
			reads("wiki.search", { query: "church planting calling" }),
		]),
	);
	assert.deepEqual(await held(), before, "a model's read is not a human reading");
	await readAs(C, articles.slice(5), "0.81");
	assert.deepEqual(await metric(C), [6, 6, true, 1, true]);
	assert.deepEqual(await metric(A), [4, 6, false, 1, false]);
	assert.deepEqual(await criterion(), [unknown, unknown], "reading does not stand in for the record");
	assert.equal((await w.one(sql`SELECT phase FROM plant WHERE id=${P.id}`)).phase, 1);
	await c.foreign(said, [reads("wiki.reading.stats", {}), reads("phases.readReadiness", {})], {
		secrets: ["Cedar Plant"],
		found: ["Phase 0 · Discovery"],
	});
	await c.outage(said, [reads("wiki.reading.stats", {})], "reading");
});
