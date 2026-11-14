// Plant Intelligence's words (WP-044): the cold start never shows a result, the newest run's line keeps the previous
// result, and next steps come only from gaps the measured facts show.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
	coldStartTitle,
	factText,
	newestText,
	nextSteps,
	trendText,
} from "../../../apps/web/src/features/intelligence/assessment-model.ts";
import { facts } from "./views-fixture.mjs";

test("AC:PI-CASE-025 cold start says not prepared, on its way or couldn't be prepared, never a result", () => {
	assert.equal(coldStartTitle(null).title, "Your first assessment hasn't been prepared yet");
	assert.equal(
		coldStartTitle({ state: "preparing", retryAt: null, grounding: null }).title,
		"Your first assessment is on its way",
	);
	assert.equal(
		coldStartTitle({ state: "deferred", retryAt: "2026-11-02T18:00:00.000Z", grounding: "grounded" }).title,
		"Your first assessment is on its way",
	);
	assert.equal(
		coldStartTitle({ state: "failed", retryAt: null, grounding: "grounded" }).title,
		"Your first assessment couldn't be prepared yet",
	);
});

test("AC:ASMT-005 a newer run that is pending or failed is its own line, and the complete result stays", () => {
	assert.equal(newestText(null, true), null);
	assert.match(
		newestText({ state: "preparing", retryAt: null, grounding: null }, true),
		/being prepared\. The assessment below is still the latest complete one\./,
	);
	assert.match(newestText({ state: "failed", retryAt: null, grounding: "grounded" }, true), /couldn't be finished/);
	assert.match(newestText({ state: "needs_review", retryAt: null, grounding: "grounded" }, true), /Everyfield team/);
});

test("next steps name only gaps the measured facts show", () => {
	assert.deepEqual(
		nextSteps(facts).map((s) => s.href),
		["/follow-ups", "/ministries", "/intelligence/attestations"],
	);
	assert.match(nextSteps(facts)[1].detail, /^2 of 8 have someone assigned\.$/);
	assert.match(nextSteps(facts)[2].title, /^Answer 6 attestations$/);
});

test("fact values and trend cells read as words, Unknown and Not measured never as zero", () => {
	assert.equal(factText(null), "Unknown");
	assert.equal(factText(0), "0");
	assert.equal(factText("2026-11-02"), "Nov 2, 2026");
	assert.equal(factText("not_met"), "Not met");
	assert.equal(factText([18, 16]), "18, 16");
	assert.equal(trendText({ state: "not_measured" }), "Not measured");
	assert.equal(trendText({ state: "unknown" }), "Unknown");
	assert.equal(trendText({ state: "measured", value: 0 }), "0");
});
