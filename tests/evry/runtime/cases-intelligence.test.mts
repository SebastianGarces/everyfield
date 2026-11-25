import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { FOLLOW_UP, intelligenceChurch, type IntelligenceChurch } from "../evals/intelligence-church.mts";
import { caseWorld, propose, reads, rowsOf, sql, type CaseWorld, type Play } from "./case-world.mts";

let ch: IntelligenceChurch;
let w: CaseWorld;
before(async () => {
	ch = await intelligenceChurch("caseint");
	w = await caseWorld("caseint", { on: ch.database, now: "2026-10-13T15:00:00Z" });
});
after(() => (w ?? ch?.database)?.close());

test("AC:INH-INTELLIGENCE-06 an operational suggestion already covered by a task is not drafted again, a new one is a review, and a theological one makes no task", async () => {
	const c = await w.church({}, { plant: { kind: "plant", id: ch.cedar.id }, admin: ch.seats.admin as never });
	const said = "Turn the report's operational follow-up into draft tasks for me to review.";
	const look: Play = [reads("intelligence.readAssessment", {}), reads("tasks.list", { search: FOLLOW_UP })];
	const tasks = () =>
		w.rows(sql`SELECT id,title FROM task WHERE plant_id=${c.P.id} AND title=${FOLLOW_UP} AND deleted_at IS NULL`);
	const draft: Play = [
		...look,
		(r) => (rowsOf(r[1]).length ? "A task already covers it." : propose("tasks.create", { title: FOLLOW_UP })),
	];
	const first = await w.ask(c.A, said, draft);
	assert.match(JSON.stringify(first.replies[0]), new RegExp(FOLLOW_UP));
	assert.deepEqual(
		[first.proposals.map((p) => p.status), await tasks()],
		[["pending"], []],
		"a new task is only a review",
	);
	await w.approve(c.A, first.proposals[0]!);
	const [T1, ...more] = await tasks();
	assert.deepEqual([Boolean(T1), more], [true, []]);
	const again = await w.quiet(() => w.ask(c.A, said, draft));
	assert.deepEqual(
		rowsOf(again.replies[1]).map((t) => t.id),
		[T1!.id],
		"the existing task is found by the suggestion's words",
	);
	assert.deepEqual([again.proposals, await tasks()], [[], [T1]]);
	assert.match(JSON.stringify(again.replies[0]), /Set a regular prayer rhythm/);
	for (const rule of [
		/When an open task already covers it, name that task and propose nothing/,
		/When the suggestion is about prayer, theology or anyone's spiritual life, propose nothing and reply: I don't turn suggestions about prayer/,
	])
		assert.match(JSON.parse(again.prompts.at(-1)!)[0].content, rule);
	assert.equal(
		await w.count(sql`SELECT count(*)::int AS n FROM task WHERE plant_id=${c.P.id} AND title ILIKE '%pray%'`),
		0,
	);
	await c.foreign(said, [reads("tasks.list", { search: FOLLOW_UP }), reads("intelligence.readAssessment", {})]);
	await c.outage(said, look, "assessment_run");
});
