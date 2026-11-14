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
