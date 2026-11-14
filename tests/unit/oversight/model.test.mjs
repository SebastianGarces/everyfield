// The organization oversight pages' words (apps/web/src/features/oversight/model.ts): what a directory row and a plant
// page say for each provenance, lead and launch state, and the sending church's own heading.
import test from "node:test";
import assert from "node:assert/strict";
import {
	HOME_HEADING,
	launchLabel,
	leadLabel,
	linkedLabel,
	locality,
	phaseLabel,
	provenanceLabel,
	sharedCount,
} from "../../../apps/web/src/features/oversight/model.ts";

test("AC:ORG55-004 a plant with no lead planter says so and never falls back to another name", () => {
	assert.equal(leadLabel({ leadPlanter: "Marcus Hill" }), "Marcus Hill");
	assert.equal(leadLabel({ leadPlanter: null }), "No lead planter named");
});

test("AC:TARGET-IDN-023 how a plant is linked, its locality, phase and Launch Sunday", () => {
	assert.equal(provenanceLabel({ provenance: { kind: "direct" } }), "Directly");
	const through = { provenance: { kind: "through", sendingChurches: ["Grace Austin"] } };
	assert.equal(provenanceLabel(through), "Through Grace Austin");
	assert.equal(linkedLabel(through), "Linked through Grace Austin");
	assert.equal(linkedLabel({ provenance: { kind: "direct" } }), "Linked directly");
	assert.equal(
		provenanceLabel({ provenance: { kind: "through", sendingChurches: ["A", "B", "C"] } }),
		"Through A, B and C",
	);
	assert.equal(locality({ city: "Round Rock", stateProvince: "TX", country: "US" }), "Round Rock, TX");
	assert.equal(locality({ city: null, stateProvince: null, country: "US" }), "US");
	assert.equal(phaseLabel(3), "3 · Training");
	assert.equal(launchLabel(null), "Not set");
	// A plant-local date shows as that date in every time zone, never the day before.
	assert.equal(launchLabel("2027-03-14"), "Mar 14, 2027");
});

test("AC:TARGET-IDN-024 a sending church's home heading never says network", () => {
	assert.equal(HOME_HEADING.sending_church, "Your plants");
	assert.doesNotMatch(HOME_HEADING.sending_church, /network/i);
});

test("AC:TARGET-IDN-023 a plant shares what it shares, empty included; not shared and unavailable never count", () => {
	const s = (status) => ({ status });
	assert.equal(
		sharedCount({
			people: s("shared"),
			meetings: s("empty"),
			tasks: s("shared"),
			ministryTeams: s("withheld"),
			wiki: s("unavailable"),
		}),
		3,
	);
});

// WP-047b: the near-launch rule (network rubric NIR-03) and the home's health value, as every screen reads them.
import {
	followUpResult,
	growthResult,
	healthOf,
	nearLaunch,
	nearLaunchSentence,
	NEAR_LAUNCH_RULE,
	trainingResult,
} from "../../../packages/contracts/src/oversight/index.ts";
import { gapText, resultLabels } from "../../../apps/web/src/features/oversight/model.ts";

const prep = (p) => ({ launched: false, daysToLaunch: 20, unfilledRoles: 0, outstandingTraining: 0, ...p });

test("a near Launch Sunday alone is no concern; a recorded role or training gap inside 30 days is", () => {
	assert.equal(nearLaunch(prep({ daysToLaunch: 10 })), "clear");
	assert.equal(nearLaunch(prep({ daysToLaunch: 30, unfilledRoles: 1 })), "gap");
	assert.equal(nearLaunch(prep({ daysToLaunch: 0, outstandingTraining: 2 })), "gap");
	assert.equal(nearLaunch(prep({ daysToLaunch: 31, unfilledRoles: 1 })), "clear");
	assert.equal(nearLaunch(prep({ daysToLaunch: -1, unfilledRoles: 1 })), "clear");
	assert.equal(nearLaunch(prep({ launched: true, daysToLaunch: null, unfilledRoles: 3 })), "clear");
	// Missing evidence is Unknown, never a zero.
	assert.equal(nearLaunch(prep({ daysToLaunch: null })), "unknown");
	assert.equal(nearLaunch(prep({ unfilledRoles: null })), "unknown");
	assert.equal(nearLaunch(prep({ unfilledRoles: null, outstandingTraining: 1 })), "gap");
});

test("not sharing findings is Limited visibility, and silence is never On track", () => {
	assert.equal(healthOf(false, prep({ unfilledRoles: 1 })), "limited_visibility");
	assert.equal(healthOf(true, prep({ unfilledRoles: 1 })), "launch_readiness");
	assert.equal(healthOf(true, prep({})), "not_assessed");
	assert.equal(healthOf(true, prep({ daysToLaunch: null })), "not_assessed");
});

test("the pattern uses the rubric's NIR-03 wording, and a Not shared row says nothing else", () => {
	assert.equal(
		nearLaunchSentence(2),
		"2 plants within 30 calendar days of an uncompleted launch have a recorded assignment or required-training gap.",
	);
	assert.match(NEAR_LAUNCH_RULE.nextStep, /^Coordinate a bounded preparation support conversation/);
	assert.deepEqual(resultLabels({ status: "not_shared", plantId: "x", name: "Mueller" }), [
		{ label: "Not shared", status: "unknown" },
	]);
	const results = { "NIR-03": "unknown", "NIR-04": "clear", "NIR-05": "stalled", "NIR-06": "gap" };
	assert.deepEqual(
		resultLabels({ status: "shared", plantId: "x", name: "A", results }).map((l) => l.label),
		["Launch unknown", "No overdue follow-ups", "Growth stalled", "Training outstanding"],
	);
	assert.equal(
		gapText(prep({ unfilledRoles: 1, outstandingTraining: 2 })),
		"1 required role unfilled and 2 required trainings not done",
	);
	assert.equal(gapText(prep({})), null);
});

// T-372: NIR-04 to NIR-06 per plant. Zero is observed; missing evidence and nothing assigned are Unknown.
const counts = (c) => ({
	overdueFollowUps: null,
	unownedFollowUps: null,
	growthDays: null,
	requiredTraining: null,
	outstandingTraining: null,
	...c,
});
test("follow-up, growth and training results keep zero, the 21 and 28 day lines and Unknown apart", () => {
	assert.equal(followUpResult(counts({ overdueFollowUps: 0, unownedFollowUps: 0 })), "clear");
	assert.equal(followUpResult(counts({ overdueFollowUps: 2, unownedFollowUps: 1 })), "gap");
	assert.equal(followUpResult(counts({})), "unknown");
	assert.deepEqual(
		[20, 21, 27, 28, 35, null].map((growthDays) => growthResult(counts({ growthDays }))),
		["clear", "slowed", "slowed", "stalled", "stalled", "unknown"],
	);
	assert.equal(trainingResult(counts({ requiredTraining: 3, outstandingTraining: 2 })), "gap");
	assert.equal(trainingResult(counts({ requiredTraining: 3, outstandingTraining: 0 })), "clear");
	assert.equal(trainingResult(counts({ outstandingTraining: 0 })), "unknown");
});
