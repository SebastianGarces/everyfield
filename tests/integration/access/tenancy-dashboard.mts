// The Overview reads of INV-tenancy (tenancy.test.mts), and the internal pipeline count (PPL-023). Church A's owner
// dismisses a prompt, so its prompt state has something of its own to show.
import assert from "node:assert/strict";
import { dashboardReader, dashboardWriter } from "../../../packages/domain/src/dashboard/index.ts";
import { readPipelineMetrics } from "../../../packages/domain/src/people/index.ts";

export async function seedDashboard(t) {
	t.ok(await dashboardWriter.dismissPrompt(t.f.db, t.ownerA.actor, { prompt: "invite_team" }));
}

const plain = async (body) => ({ status: "ok", value: await body() });
const today = new Date().toISOString().slice(0, 10);

export function dashboardCases(t, who) {
	const db = t.f.db;
	const r = (name, run, expected) => [`dashboard:dashboardReader.${name}`, { run, expected }];
	return [
		// Each answers from the caller's own seat: church B's owner sees church B's empty dashboard.
		r("resolveHome", () => plain(() => dashboardReader.resolveHome(db, who.actor)), {
			check: (v) => assert.ok(v === "complete" || v === "incomplete"),
			control: (v) => assert.ok(v === "complete" || v === "incomplete"),
		}),
		r("readSetupGaps", () => dashboardReader.readSetupGaps(db, who.actor), {
			check: (v) => assert.ok(v.gaps.includes("add_people")),
			control: (v) => assert.ok(!v.gaps.includes("add_people")),
		}),
		r("readPromptState", () => dashboardReader.readPromptState(db, who.actor), {
			value: { dismissed: [] },
			control: (v) => assert.deepEqual(v, { dismissed: ["invite_team"] }),
		}),
		r("readAvailableActions", () => dashboardReader.readAvailableActions(db, who.actor), {
			check: (v) => assert.ok(v.setup.gaps.includes("add_people")),
			control: (v) => assert.ok(!v.setup.gaps.includes("add_people")),
		}),
		r("readMetrics", () => dashboardReader.readMetrics(db, who.actor), {
			check: (v) => assert.equal(v.recruited + v.myOverdueTasks + v.visionMeetings, 0),
			control: (v) => assert.ok(v.people > 0),
		}),
		// Church A's own owner sees church A's people in the feed: the default control.
		r("readActivity", () => dashboardReader.readActivity(db, who.actor), {
			check: (v) => assert.ok(v.entries.every((e) => e.change.kind !== "person_added")),
		}),
		[
			"people:readPipelineMetrics",
			{
				run: () =>
					readPipelineMetrics(db, who.actor, {
						asOf: new Date().toISOString(),
						from: "2026-01-01",
						through: today,
						transition: { from: "prospect", to: "attendee" },
					}),
				expected: {
					check: (v) =>
						assert.equal(
							Object.values(v.currentStageCounts).reduce((a, b) => a + b, 0),
							0,
						),
					control: (v) => assert.ok(Object.values(v.currentStageCounts).reduce((a, b) => a + b, 0) > 0),
				},
			},
		],
	];
}
