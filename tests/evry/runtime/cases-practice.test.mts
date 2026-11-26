import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { meetingsWriter, withMeetingsWrite } from "../../../packages/domain/src/meetings/index.ts";
import { approveProposal } from "../../../packages/evry/src/index.ts";
import { ok } from "../../support/fixture.mts";
import { caseWorld, sql, type CaseWorld } from "./case-world.mts";

type Case = {
	id: string;
	given: Record<string, Record<string, unknown>>;
	clock: { now: string };
	expected: { result: Record<string, unknown>; event: null };
};
const { cases } = JSON.parse(
	readFileSync(new URL("../../../docs/acceptance/launch.json", import.meta.url), "utf8"),
) as {
	cases: Case[];
};
const caseOf = (id: string) => cases.find((c) => c.id === id) ?? assert.fail(`no case ${id}`);

let w: CaseWorld;
before(async () => {
	w = await caseWorld("casepractice", { now: caseOf("B02-016").clock.now });
});
after(() => w?.close());

test("AC:B02-016 a reviewed practice is created, completed once through a repeated Approve, and a review of a practice that changed since is refused", async () => {
	const c = caseOf("B02-016");
	const input = c.given["launch-inputs"]!;
	assert.equal(input.reviewed_proposal_state, input.current_state);
	const ch = await w.church();
	const practices = () =>
		w.rows<{ id: string; status: string; held: string | null }>(
			sql`SELECT id,status,actual_occurrence_at::text held FROM meeting WHERE plant_id=${ch.P.id} AND type='prelaunch_practice'`,
		);
	const create = await w.prepare(ch.A, "meetings.schedule", {
		type: "prelaunch_practice",
		title: "Practice run",
		date: "2026-10-12",
		time: "10:00",
	});
	assert.deepEqual(await practices(), [], "nothing is created before Approve");
	assert.equal((await w.approve(ch.A, create)).review.outcome, "completed");
	const [practice] = await practices();
	assert.ok(practice);
	assert.equal(practice.status, "planning");

	const complete = await w.prepare(ch.A, "meetings.completePractice", { meetingId: practice.id });
	assert.equal(complete.review.refusal ?? null, null);
	await ch.foreignReview(complete);
	const runs = [];
	for (let n = 0; n < Number(input.repeat); n++) {
		const approved = await approveProposal(w.db, await w.actorOf(ch.A), complete.id, w.witness(complete), null);
		runs.push({ replayed: approved.replayed, outcome: await w.effect() });
	}
	assert.deepEqual(runs, [
		{ replayed: false, outcome: "completed" },
		{ replayed: true, outcome: null },
	]);
	const receipts = await w.count(
		sql`SELECT count(*)::int n FROM audit_event WHERE subject_id=${practice.id} AND kind='complete'`,
	);
	const completions = (await practices()).filter((p) => p.status === "completed" && p.held !== null).length;

	const correct = await w.prepare(ch.A, "meetings.correctPracticeOccurrence", {
		meetingId: practice.id,
		state: "not_completed",
		reason: "It was rained out",
	});
	const authority = await w.authorityOf(ch.A);
	const current = await w.one<{ r: string }>(sql`SELECT revision::text r FROM meeting WHERE id=${practice.id}`);
	ok(
		await withMeetingsWrite(w.db, authority, (tx, ctx) =>
			meetingsWriter.edit(tx, ctx, {
				requestKey: randomUUID(),
				expectedRevision: current.r,
				input: { meetingId: practice.id, patch: { notes: "Moved indoors" } },
			}),
		),
	);
	const stale = await w.approve(ch.A, correct);
	assert.equal(stale.review.outcome, "refused");
	assert.deepEqual(
		{ completion_rows: completions, receipts, stale_control_error: stale.review.receipt?.code },
		c.expected.result,
	);
	assert.deepEqual(
		(await practices()).map((p) => p.status),
		["completed"],
		"the refused correction changed nothing",
	);
	assert.equal(c.expected.event, null);
});
