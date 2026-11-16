import assert from "node:assert/strict";
import { test } from "node:test";
import { readCatalog } from "../../../packages/domain/src/phases/catalog.ts";
import { criteriaOf, lensesOf } from "../../../packages/domain/src/intelligence/views.ts";
import { draft, facts } from "./views-fixture.mjs";

test("AC:PI-CASE-019 eight tiles: measured where the snapshot counted, attested where only an answer stands, Unknown otherwise, and Unknown is never a pass", () => {
	const tiles = Object.fromEntries(lensesOf(facts, draft as never).map((l) => [l.key, l]));
	assert.equal(Object.keys(tiles).length, 8);
	assert.deepEqual(
		Object.values(tiles).map((l) => [l.key, l.quality, l.standing]),
		[
			["vision", "measured", "strength"],
			["ownership", "unknown", "insufficient"],
			["critical_mass", "measured", "attention"],
			["cohesion", "unknown", "insufficient"],
			["prayer", "attested", "not_raised"],
			["generosity", "unknown", "insufficient"],
			["leadership", "measured", "watch"],
			["training", "unknown", "insufficient"],
		],
	);
	assert.deepEqual(tiles.vision!.points, [3, 1], "strongest first: the strength, then the note");
	assert.deepEqual(
		tiles.prayer!.attestations.map((a) => [a.key, a.answered, a.asOf, a.needsRenewing]),
		[
			["prayer_rhythm_established", true, "2026-09-18", true],
			["prayer_in_gatherings", false, null, false],
		],
	);
	assert.deepEqual(tiles.leadership!.evidence, [
		{ key: "coverage.filled", label: "Ministry responsibilities filled", value: 2 },
		{ key: "coverage.people", label: "Distinct people across the responsibilities", value: 2 },
		{ key: "coverage.prayerLeader", label: "Prayer leaders", value: 0 },
	]);
});

test("a snapshot from another formula reads nothing measured, never a made-up result", () => {
	const tiles = lensesOf({ formulaVersion: "plant-facts/0" }, draft as never);
	assert.ok(tiles.every((l) => l.quality === "unknown" && l.evidence.length === 0));
});

test("AC:B01-005 the assessed phase's criteria as the snapshot measured them, with the facts behind each; Phase 6 has none", async () => {
	const catalog = await readCatalog();
	assert.deepEqual(
		criteriaOf(catalog, 2, facts).map((x) => [x.key, x.status, x.evidence.map((e) => `${e.key}=${e.value}`)]),
		[
			["all_team_leaders", "not_met", ["coverage.filled=2", "coverage.slots=8", "coverage.people=2"]],
			["launch_date_set", "met", ["launch.targetOn=2027-03-07"]],
		],
	);
	assert.deepEqual(
		criteriaOf(catalog, 1, facts).map((x) => [x.key, x.status]),
		[
			["committed_adults", "met"],
			["growth_trajectory", "met"],
			["financial_base", "unknown"],
			["worship_leader", "unknown"],
			["geographic_area", "unknown"],
		],
	);
	assert.deepEqual(criteriaOf(catalog, 6, facts), []);
});

test("Phase 5 shows First service held with the milestone it rests on; a snapshot stored before that fact reads Unknown", async () => {
	const catalog = await readCatalog();
	const reached = {
		...facts,
		formulaVersion: "plant-facts/2",
		firstService: { path: "milestone", status: "met", milestone: "Constituted as a church", heldOn: "2026-10-11" },
		criteria: { ...facts.criteria, first_service_complete: "met" },
	};
	const row = (snapshot: unknown) => criteriaOf(catalog, 5, snapshot).find((x) => x.key === "first_service_complete")!;
	assert.deepEqual(row(reached), {
		key: "first_service_complete",
		label: "First service held",
		status: "met",
		evidence: [
			{ key: "firstService.milestone", label: "Gathering milestone", value: "Constituted as a church" },
			{ key: "firstService.heldOn", label: "Milestone reached", value: "2026-10-11" },
		],
	});
	const held = {
		...reached,
		firstService: { path: "launch_sunday", status: "met", heldOn: "2026-10-04" },
	};
	assert.deepEqual(row(held).evidence, [
		{ key: "firstService.heldOn", label: "Launch Sunday held", value: "2026-10-04" },
	]);
	assert.equal(facts.formulaVersion, "plant-facts/1");
	assert.deepEqual(row(facts), {
		key: "first_service_complete",
		label: "First service held",
		status: "unknown",
		evidence: [],
	});
	assert.equal(criteriaOf(catalog, 2, facts).find((x) => x.key === "launch_date_set")!.status, "met");
});
