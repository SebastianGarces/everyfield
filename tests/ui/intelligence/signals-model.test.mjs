// Attestations screen rules (WP-039 slice 2) that a silent break would turn into a wrong age, a false "no" or a lost
// answer. They run in node against the modules the screen uses; no browser.
import assert from "node:assert/strict";
import { test } from "node:test";
import { countsOf, renewalOf, SIGNAL_DEFINITIONS } from "../../../packages/contracts/src/intelligence/signals.ts";
import {
	actionLabel,
	answerLabel,
	draftReasons,
	intent,
	refusalText,
	renewalLabel,
	reaffirmed,
	retracted,
	signalInput,
	stated,
	statedAsOf,
	withSignal,
} from "../../../apps/web/src/features/intelligence/signals-model.ts";
import { MANUAL_SIGNALS } from "../../../docs/reference/manual-signals.ts";

const TODAY = "2026-10-13";
const blank = (key) => ({
	key,
	state: "unanswered",
	value: null,
	asOf: null,
	detail: null,
	reference: null,
	authorName: null,
	recordedAt: null,
	revision: "0",
	ageDays: null,
	renewal: { status: "unknown" },
});
const page = () => {
	const signals = SIGNAL_DEFINITIONS.map((d) => blank(d.key));
	return { today: TODAY, signals, counts: countsOf(signals), candidates: [], people: [], history: [] };
};

test("the contract's seven definitions match docs/reference/manual-signals.ts in order", () => {
	assert.deepEqual(
		SIGNAL_DEFINITIONS.map((d) => [d.key, d.label, d.description, d.reaffirms]),
		MANUAL_SIGNALS.map((d) => [d.key, d.label, d.description, d.reaffirms]),
	);
});

test("renewal: three signals go stale after 30 days and keep their value; the others never expire", () => {
	assert.deepEqual(renewalOf("prayer_rhythm_established", "answered", 30), { status: "current", daysLeft: 0 });
	assert.deepEqual(renewalOf("prayer_rhythm_established", "answered", 31), { status: "needs_renewing" });
	assert.deepEqual(renewalOf("financial_base_established", "answered", 100), { status: "does_not_expire" });
	assert.deepEqual(renewalOf("core_group_giving", "retracted", null), { status: "unknown" });
	assert.equal(renewalLabel({ status: "current", daysLeft: 18 }), "Current for 18 more days");
});

test("an answer shows at once, counts follow, and a refusal puts the row back", () => {
	const before = page();
	const entry = before.signals.find((s) => s.key === "prayer_in_gatherings");
	const optimistic = withSignal(
		before,
		stated(entry, { value: "yes", asOf: "2026-10-01", detail: " Weekly ", reference: "" }, TODAY, "Daniel"),
	);
	const shown = optimistic.signals.find((s) => s.key === entry.key);
	assert.deepEqual(
		[shown.state, shown.value, shown.detail, shown.ageDays, shown.revision],
		["answered", "yes", "Weekly", 12, "1"],
	);
	assert.deepEqual(optimistic.counts, { current: 1, needsRenewing: 0, notAnswered: 6 });
	assert.deepEqual(withSignal(optimistic, entry).counts, before.counts);
});

test("a retraction reads Retracted and Unknown, never no; Still true moves only the age", () => {
	const answered = stated(
		blank("core_group_giving"),
		{ value: "not_yet", asOf: "2026-08-01", detail: "", reference: "" },
		TODAY,
		"Daniel",
	);
	assert.equal(answered.renewal.status, "needs_renewing");
	assert.equal(reaffirmed(answered, TODAY, "Daniel").ageDays, 0);
	assert.equal(reaffirmed(answered, TODAY, "Daniel").value, "not_yet");
	const gone = retracted(answered, "Daniel");
	assert.deepEqual(
		[answerLabel(gone), gone.value, gone.renewal.status, actionLabel(gone)],
		["Retracted", null, "unknown", "Answer"],
	);
	assert.equal(answerLabel(blank("core_group_giving")), "Not answered");
	assert.equal(actionLabel(answered), "Renew");
});

test("saving needs a choice; the same value is not a correction; candidate reasons name what is missing", () => {
	const answered = stated(
		blank("systems_tested"),
		{ value: "yes", asOf: TODAY, detail: "", reference: "" },
		TODAY,
		"D",
	);
	assert.equal(intent(blank("systems_tested"), { value: null }), "none");
	assert.equal(intent(blank("systems_tested"), { value: "yes" }), "attest");
	assert.equal(intent(answered, { value: "yes" }), "none");
	assert.equal(intent(answered, { value: "not_yet" }), "correct");
	assert.deepEqual(draftReasons({ start: "2026-08-15", end: "2026-10-13", attended: true, volunteered: true }), []);
	assert.deepEqual(draftReasons({ start: "2026-08-16", end: "2026-10-13", attended: false, volunteered: true }), [
		"attendance_not_attested",
		"period_too_short",
	]);
	assert.match(refusalText({ code: "revision_conflict" }), /another window or by another admin/);
	assert.match(refusalText(null), /still here/);
});

test("a cleared True as of date is left out of the request and the answer reads as of today (com-16)", () => {
	const draft = { value: "yes", asOf: "", detail: " Thursdays ", reference: "" };
	const input = signalInput("prayer_rhythm_established", "yes", draft);
	assert.equal("asOf" in input && input.asOf !== undefined, false);
	assert.equal(JSON.parse(JSON.stringify(input)).asOf, undefined);
	assert.equal(statedAsOf(draft, TODAY), TODAY);
	const shown = stated(blank("prayer_rhythm_established"), { ...draft, asOf: statedAsOf(draft, TODAY) }, TODAY, "Daniel Reyes");
	assert.deepEqual([shown.asOf, shown.ageDays, shown.detail], [TODAY, 0, "Thursdays"]);
	const dated = { ...draft, asOf: "2026-10-01" };
	assert.equal(signalInput("prayer_rhythm_established", "yes", dated).asOf, "2026-10-01");
	assert.equal(statedAsOf(dated, TODAY), "2026-10-01");
});
