import "../runs-in/react-server.mjs";
import assert from "node:assert/strict";
import { test } from "node:test";
import { readinessEntry, readinessRevision } from "../../../packages/contracts/src/intelligence/signals.ts";
import {
	actionLabel,
	draftOf,
	inputOf,
	intentOf,
	problemsOf,
	readinessRefusal,
	recorded,
	retracted,
	settleWrite,
	withReadiness,
} from "../../../apps/web/src/features/intelligence/readiness-model.ts";

const TODAY = "2026-11-26";
const AT = "2026-11-26T15:00:00.000Z";
const DANA = "6f1c1f43-6c3d-4a7b-9f5e-2b0f4f0c9a11";
const blank = (key) => ({
	key,
	state: "unanswered",
	asOf: null,
	named: null,
	personId: null,
	statement: null,
	reference: null,
	authorName: null,
	recordedAt: null,
	revision: "0",
});
const view = () => ({
	today: TODAY,
	attestations: ["relationship", "worship_agreement", "community"].map(blank),
	history: [],
	people: [{ id: DANA, displayName: "Dana Worship" }],
});
const relationship = {
	...blank("relationship"),
	state: "answered",
	asOf: "2026-11-01",
	named: "Hill Country Network",
	reference: "Pat Mentor",
	authorName: "Ana Admin",
	recordedAt: AT,
	revision: "1",
};
const error = (code) => ({ code, details: {}, correlationId: DANA, retry: "never" });
const saved = (attestation) => ({ status: "ok", value: { outcome: "saved", attestation } });
function harness(start = view()) {
	let current = start;
	const seen = [];
	return {
		apply: (change) => {
			current = change(current);
			seen.push(current);
		},
		get current() {
			return current;
		},
		seen,
	};
}

test("INV-readiness: each attestation's input carries its own named field and optional note, as the contract names them", () => {
	const draft = { named: "  Hill Country Network ", note: "Pat Mentor", asOf: "2026-11-01" };
	assert.deepEqual(inputOf("relationship", draft), {
		key: "relationship",
		organization: "Hill Country Network",
		mentor: "Pat Mentor",
		asOf: "2026-11-01",
	});
	assert.deepEqual(inputOf("worship_agreement", { named: DANA, note: "", asOf: TODAY }), {
		key: "worship_agreement",
		personId: DANA,
		statement: "",
		asOf: TODAY,
	});
	assert.deepEqual(inputOf("community", { named: "East Riverside", note: "", asOf: TODAY }), {
		key: "community",
		area: "East Riverside",
		plan: "",
		asOf: TODAY,
	});
});

test("INV-readiness: the form refuses a blank name, no person, a date after today, no date and text over 500 characters", () => {
	const ok = { named: "Grace", note: "", asOf: TODAY };
	assert.deepEqual(problemsOf("relationship", ok, TODAY), {});
	assert.deepEqual(problemsOf("relationship", { ...ok, named: "   " }, TODAY), { named: "Name the organization." });
	assert.deepEqual(problemsOf("community", { ...ok, named: "" }, TODAY), { named: "Name the community." });
	assert.deepEqual(problemsOf("worship_agreement", { ...ok, named: "" }, TODAY), {
		named: "Choose the person who agreed.",
	});
	assert.deepEqual(problemsOf("community", { ...ok, asOf: "2026-11-27" }, TODAY), {
		asOf: "A statement cannot be dated after today.",
	});
	assert.deepEqual(problemsOf("community", { ...ok, asOf: "" }, TODAY), { asOf: "Choose the date it is true as of." });
	const long = "x".repeat(501);
	assert.deepEqual(problemsOf("relationship", { ...ok, named: long, note: long }, TODAY), {
		named: "Keep it to 500 characters or fewer.",
		note: "Keep it to 500 characters or fewer.",
	});
	assert.deepEqual(problemsOf("relationship", { ...ok, named: "x".repeat(500), note: "x".repeat(500) }, TODAY), {});
});

test("INV-readiness: a correction opens filled with the current values, and an unchanged one is no write", () => {
	assert.deepEqual(draftOf(blank("community"), TODAY), { named: "", note: "", asOf: TODAY });
	const draft = draftOf(relationship, TODAY);
	assert.deepEqual(draft, { named: "Hill Country Network", note: "Pat Mentor", asOf: "2026-11-01" });
	assert.equal(intentOf(relationship, draft), "none");
	assert.equal(intentOf(relationship, { ...draft, note: " Pat Mentor " }), "none", "trimmed text is the same");
	assert.equal(intentOf(relationship, { ...draft, asOf: "2026-11-02" }), "correct");
	assert.equal(intentOf(relationship, { ...draft, note: "" }), "correct");
	assert.equal(intentOf(blank("relationship"), draft), "attest");
	assert.equal(intentOf({ ...relationship, state: "retracted" }, draft), "attest");
	const worship = { ...blank("worship_agreement"), state: "answered", asOf: TODAY, personId: DANA, named: "Dana" };
	assert.deepEqual(draftOf(worship, TODAY), { named: DANA, note: "", asOf: TODAY });
	assert.deepEqual(
		["unanswered", "answered", "retracted"].map((state) => actionLabel({ ...relationship, state })),
		["Record", "Correct", "Record again"],
	);
});

test("INV-readiness: a save shows at once, then the saved attestation and a recorded history line replace it", async () => {
	const h = harness();
	const entry = blank("worship_agreement");
	const draft = { named: DANA, note: "Agreed at lunch", asOf: "2026-11-20" };
	const optimistic = recorded(entry, draft, view().people, "Ana Admin", AT);
	assert.equal(readinessEntry.parse(optimistic).named, "Dana Worship");
	const server = { ...optimistic, recordedAt: "2026-11-26T15:00:01.000Z" };
	let sent = 0;
	const failure = await settleWrite(entry, "answered", optimistic, async () => (sent++, saved(server)), h.apply);
	assert.equal(failure, null);
	assert.equal(sent, 1);
	assert.deepEqual(h.seen[0].attestations[1], optimistic, "the optimistic state shows first");
	assert.deepEqual(h.current.attestations[1], server);
	assert.equal(h.current.history.length, 1);
	const line = readinessRevision.parse(h.current.history[0]);
	assert.deepEqual(
		[line.kind, line.asOf, line.named, line.personId, line.statement, line.authorName, line.revision],
		["answered", "2026-11-20", "Dana Worship", DANA, "Agreed at lunch", "Ana Admin", 1],
	);
});

test("INV-readiness: a correction and a retraction add their history lines, and the retraction keeps the old value", async () => {
	const h = harness(withReadiness(view(), relationship));
	const corrected = recorded(
		relationship,
		{ named: "Hill Country Network", note: "", asOf: "2026-11-05" },
		[],
		"Ana Admin",
		AT,
	);
	assert.equal(await settleWrite(relationship, "corrected", corrected, async () => saved(corrected), h.apply), null);
	assert.deepEqual([corrected.revision, corrected.reference, corrected.asOf], ["2", null, "2026-11-05"]);
	const gone = retracted(corrected, TODAY, "Owen Owner", AT);
	assert.deepEqual([gone.state, gone.named, gone.asOf, gone.revision], ["retracted", null, TODAY, "3"]);
	assert.equal(await settleWrite(corrected, "retracted", gone, async () => saved(gone), h.apply), null);
	assert.deepEqual(
		h.current.history.map((l) => [l.kind, l.named, l.asOf, l.authorName]),
		[
			["retracted", "Hill Country Network", TODAY, "Owen Owner"],
			["corrected", "Hill Country Network", "2026-11-05", "Ana Admin"],
		],
	);
	assert.equal(h.current.attestations[0].state, "retracted");
});

test("INV-readiness: a refused or lost write rolls the section back to what it was and says why in plain words", async () => {
	const start = withReadiness(view(), relationship);
	for (const [result, text, stale] of [
		[
			{ status: "refused", error: error("revision_conflict") },
			"Another Owner or Admin changed this first. Load the latest to see it, then try again. What you typed is still here.",
			true,
		],
		[
			{ status: "refused", error: error("access_denied") },
			"Your seat no longer allows this. Only an Owner or Admin of a church plant can record these.",
			false,
		],
		[
			{ status: "lost" },
			"Everyfield could not be reached, so this may not have saved. What you typed is still here. Save again.",
			false,
		],
	]) {
		const h = harness(start);
		const gone = retracted(relationship, TODAY, "Ana Admin", AT);
		const failure = await settleWrite(relationship, "retracted", gone, async () => result, h.apply);
		assert.deepEqual(failure, { text, stale });
		assert.equal(h.seen[0].attestations[0].state, "retracted", "it showed the change at once");
		assert.deepEqual(h.current, start, "then rolled back");
	}
	const h = harness(start);
	const thrown = await settleWrite(relationship, "retracted", relationship, () => Promise.reject(Error("x")), h.apply);
	assert.equal(thrown?.stale, false);
	assert.deepEqual(h.current, start);
	assert.equal(readinessRefusal(error("no_change")), "That is what it already says. Change a value or the date to correct it.");
});
