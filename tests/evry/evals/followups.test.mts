// The follow-up evals (WP-059): when the signed-in user asks who to follow up with, Evry never suggests the user's own
// row. Labelled requests (followups.cases.json) are scored against the real model's recorded streams
// (followups.recorded.json). The model gets Evry's real system prompt and read tools, and every read it calls runs the
// real adapter through invokeRead against a small church seeded on Postgres (small-church.mts). It runs in
// @everyfield/evry's test:db. The church has 5 live people: Daniel Reyes (the planter, an Owner linked to his account)
// and Lena Park (an Admin linked to hers) are the strongest follow-up candidates, with no next step, the oldest activity
// and no open task; Maria Lopez, Tom Baker and Priya Shah are the others. Inactivity and coverage are the real pipeline
// board's, derived from seeded activity and task rows, and the signed-in user's own row carries `you: true` from the
// real row path. One case signs in Lena on the same church. A recording is keyed by the exact call the provider
// receives, so a changed prompt, tool list, limit or read result has no recording and fails here until it is scored
// again on the real model (with the database variables of README.md in the shell):
//
//   EVRY_EVAL_RECORD=1 node --conditions=react-server --env-file=apps/web/.env.local --test tests/evry/evals/followups.test.mts
//
// Recording makes a few small paid calls inside the G-SPEND cap (D77). CI replays the file.
//   AC:EVRY-CONTEXT-BOUNDS tool selection: each request picks the operation of its case.
//   Answer correctness: a follow-up answer never names the signed-in user and names another candidate; the count
//   answer includes the user.
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { recorder } from "./golden-harness.mts";
import { converse, id, readAs, smallChurch } from "./small-church.mts";

type Case = {
	text: string;
	operation: string;
	alsoAccepted?: string[];
	actor?: "lena";
	expect: "followUp" | "count";
	rubric: Record<string, string>;
};
const CASES = new URL("followups.cases.json", import.meta.url);
const cases: Case[] = JSON.parse(readFileSync(CASES, "utf8"));
const recorded = recorder("followups");

const DANIEL = id(0xc1);
const LENA = id(0xc2);
const NOW = new Date("2026-11-02T14:00:00Z");
const church = await smallChurch({
	name: "Lakeshore Church",
	timezone: "America/New_York",
	people: [
		{
			id: DANIEL,
			name: "Daniel Reyes",
			city: "Lakewood",
			stage: "following_up",
			inactivity: "alert",
			linkedTo: "daniel",
		},
		{ id: LENA, name: "Lena Park", city: "Lakewood", stage: "attendee", inactivity: "alert", linkedTo: "lena" },
		{ id: id(0xc3), name: "Maria Lopez", city: "Parma", stage: "prospect", inactivity: "warning" },
		{ id: id(0xc4), name: "Tom Baker", city: "Euclid", stage: "attendee", inactivity: "none", covered: true },
		{ id: id(0xc5), name: "Priya Shah", city: "Lakewood", stage: "interviewed", inactivity: "warning", covered: true },
	],
	actors: { daniel: "owner", lena: "admin" },
});
after(church.close);
const { daniel, lena } = church.actors;

test("AC:EVRY-CONTEXT-BOUNDS the seeded church has 5 live people; Daniel and Lena have the highest inactivity and no open task, and each signed-in user's own row is marked you, read back through the real reads", async () => {
	assert.equal((await readAs(church.db, daniel, "people.listPeople", {})).total, 5);
	const levels = ["none", "warning", "alert"];
	for (const [who, self] of [
		[daniel, DANIEL],
		[lena, LENA],
	] as const) {
		const board = await readAs(church.db, who, "people.getPipelineData", {});
		assert.equal(board.total, 5);
		const top = Math.max(...board.rows.map((r) => levels.indexOf(String(r.fields.inactivity))));
		assert.deepEqual(
			board.rows
				.filter((r) => levels.indexOf(String(r.fields.inactivity)) === top)
				.map((r) => [r.label, r.fields.inactivity, r.fields.coverage])
				.sort(),
			[
				["Daniel Reyes", "alert", "uncovered"],
				["Lena Park", "alert", "uncovered"],
			],
		);
		assert.deepEqual(
			board.rows
				.filter((r) => r.fields.coverage === "covered")
				.map((r) => r.label)
				.sort(),
			["Priya Shah", "Tom Baker"],
		);
		assert.deepEqual(
			board.rows.filter((r) => r.fields.you === true).map((r) => r.id),
			[self],
		);
	}
});

test("AC:EVRY-CONTEXT-BOUNDS follow-up requests pick the right read, never suggest the signed-in user and still count them", async () => {
	assert.ok(cases.length >= 5);
	const model = recorded.model();
	const failures: string[] = [];
	for (const c of cases) {
		const who = c.actor === "lena" ? lena : daniel;
		const me = c.actor === "lena" ? "Lena" : "Daniel";
		const { calls, answer } = await converse(model, church.db, who, c.text, NOW);
		const ops = calls.map((x) => x.operation);
		if (!ops.some((op) => [c.operation, ...(c.alsoAccepted ?? [])].includes(op)))
			failures.push(`${c.text}: called ${ops.join(", ") || "nothing"}`);
		for (const call of calls.filter((x) => x.error))
			failures.push(`${c.text}: ${call.operation} ${JSON.stringify(call.input)} was refused (${call.error})`);
		if (c.expect === "followUp") {
			const points = {
				// Naming the user is fine only when Evry says the row is "you"; a line or sentence that names the user as a
				// candidate fails.
				notYou: !answer
					.split(/\n|(?<=[.!?])\s/)
					.some((part) => new RegExp(me, "i").test(part) && !/\b(you|your|yours)\b/i.test(part)),
				namesOther: ["Lena", "Daniel", "Maria", "Tom", "Priya"].some((n) => n !== me && answer.includes(n)),
			};
			for (const [point, ok] of Object.entries(points))
				if (!ok) failures.push(`${c.text} (${me}): rubric ${point} failed in "${answer}"`);
		} else if (!/\b(5|five)\b/i.test(answer)) failures.push(`${c.text}: rubric countsYou failed in "${answer}"`);
	}
	recorded.save();
	assert.deepEqual(failures, []);
});
