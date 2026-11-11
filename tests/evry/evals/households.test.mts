// The household evals: labelled requests (households.cases.json) scored against the real model's recorded streams
// (households.recorded.json). The model gets Evry's real system prompt and read tools, and every read it calls runs the
// real adapter through invokeRead against a small church seeded on Postgres (small-church.mts): one household, "Okafor
// household" in North Ridgeville, OH, with James Okafor as Head and Ruth Allen as Spouse, read by a plant Owner. It runs
// in @everyfield/evry's test:db. A recording is keyed by the exact call the provider receives, so a changed prompt,
// tool list, limit or read result has no recording and fails here until it is scored again on the real model (with the
// database variables of README.md in the shell):
//
//   EVRY_EVAL_RECORD=1 node --conditions=react-server --env-file=apps/web/.env.local --test tests/evry/evals/households.test.mts
//
// Recording makes a few small paid calls (G-SPEND, approved by Sebastian on Oct 31 4:02 PM ET). CI replays the file.
//   AC:EVRY-CONTEXT-BOUNDS tool selection: each request picks the household operation of its case, with sensible input.
//   Answer correctness: the answer to "what households do we have?" names the household, says there is 1 and does not
//   say a row was withheld or is unavailable. The rubric scores each point.
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { recorder } from "./golden-harness.mts";
import { converse, id, readAs, smallChurch } from "./small-church.mts";

type Case = {
	text: string;
	operation: string;
	alsoAccepted?: string[];
	noSearch?: boolean;
	rubric?: Record<string, string>;
};
const CASES = new URL("households.cases.json", import.meta.url);
const cases: Case[] = JSON.parse(readFileSync(CASES, "utf8"));
const recorded = recorder("households");

const HOUSEHOLD = id(0xa1);
const JAMES = id(0xb1);
const RUTH = id(0xb2);
const NOW = new Date("2026-10-31T20:00:00Z");
const church = await smallChurch({
	name: "Lorain County Church",
	timezone: "America/New_York",
	households: [{ id: HOUSEHOLD, name: "Okafor household", city: "North Ridgeville", state: "OH" }],
	people: [
		{
			id: JAMES,
			name: "James Okafor",
			city: "North Ridgeville",
			stage: "attendee",
			household: { id: HOUSEHOLD, role: "head" },
		},
		{
			id: RUTH,
			name: "Ruth Allen",
			city: "North Ridgeville",
			stage: "attendee",
			household: { id: HOUSEHOLD, role: "spouse" },
		},
	],
	actors: { owner: "owner" },
});
after(church.close);
const actor = church.actors.owner;
const read = (operation: string, input: unknown) => readAs(church.db, actor, operation, input);

test("AC:EVRY-CONTEXT-BOUNDS the seeded church has exactly 1 household, the Okafor household with James Okafor as Head and Ruth Allen as Spouse, read back through the real reads", async () => {
	const homes = await read("people.listHouseholds", {});
	assert.equal(homes.total, 1);
	assert.deepEqual(
		homes.rows.map((r) => [r.kind, r.id, r.label, r.fields.city, r.fields.memberCount]),
		[["household", HOUSEHOLD, "Okafor household", "North Ridgeville", "2"]],
	);
	for (const input of [{ householdId: HOUSEHOLD }, { personId: JAMES }]) {
		const members = (await read("people.getHousehold", input)).rows.filter((r) => r.kind === "person");
		assert.deepEqual(
			members.map((r) => [r.id, r.label, r.fields.role]),
			[
				[JAMES, "James Okafor", "head"],
				[RUTH, "Ruth Allen", "spouse"],
			],
			JSON.stringify(input),
		);
	}
});

test("AC:EVRY-CONTEXT-BOUNDS household requests pick the household operation with sensible input, and the answer is correct", async () => {
	assert.ok(cases.length >= 4);
	const model = recorded.model();
	const failures: string[] = [];
	let answered = 0;
	for (const c of cases) {
		const { calls, answer } = await converse(model, church.db, actor, c.text, NOW);
		const ops = calls.map((x) => x.operation);
		const accepted = [c.operation, ...(c.alsoAccepted ?? [])];
		if (!ops.some((op) => accepted.includes(op))) failures.push(`${c.text}: called ${ops.join(", ") || "nothing"}`);
		for (const call of calls.filter((x) => x.error))
			failures.push(`${c.text}: ${call.operation} ${JSON.stringify(call.input)} was refused (${call.error})`);
		for (const call of calls.filter((x) => accepted.includes(x.operation))) {
			if (c.noSearch && call.input?.search)
				failures.push(`${c.text}: searched for ${JSON.stringify(call.input.search)}`);
			if (/get(Household|HouseholdMembers)$/.test(call.operation)) {
				const target = call.input?.householdId ?? call.input?.personId;
				if (![HOUSEHOLD, JAMES, RUTH].includes(target))
					failures.push(`${c.text}: ${call.operation} with ${JSON.stringify(call.input)}`);
			}
		}
		if (c.rubric) {
			answered++;
			// The scored points of the answer to "what households do we have?".
			const points = {
				namesHousehold: /Okafor/.test(answer),
				saysCount:
					/\b(1|one|single)\b[^.\n]{0,20}\bhousehold\b|\bhousehold\b[^.\n]{0,20}\b(1|one)\b|\bonly one\b/i.test(answer),
				notWithheld: !/withheld|unavailable|no longer available|not available|couldn't|could not|missing/i.test(answer),
			};
			for (const [point, ok] of Object.entries(points))
				if (!ok) failures.push(`${c.text}: rubric ${point} failed in "${answer}"`);
		}
	}
	recorded.save();
	assert.ok(answered >= 1, "the answer rubric is scored");
	assert.deepEqual(failures, []);
});
