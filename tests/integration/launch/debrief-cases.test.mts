import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { sql } from "../../../packages/db/src/query.ts";
import { GUEST_QUESTION, WRITTEN_AREAS } from "../../../packages/contracts/src/launch/index.ts";
import { captureFacts, createSignals, criteriaOf } from "../../../packages/domain/src/intelligence/index.ts";
import { readCatalog } from "../../../packages/domain/src/phases/catalog.ts";
import { ok, refused } from "../../support/fixture.mts";
import { launchWorld, NOW, type LaunchWorld, type Who } from "./debrief-world.mts";

let w: LaunchWorld;
before(async () => {
	w = await launchWorld("lchdebrief");
});
after(() => w?.database.close());

const without = <T extends object>(row: T, ...keys: string[]) =>
	Object.fromEntries(Object.entries(row).filter(([k]) => !keys.includes(k)));
const debriefEntries = async (who: Who) =>
	(await w.journal(who)).filter((e) => e.change.kind === "debrief").map((e) => [e.actor?.displayName, e.change]);
const piCriteria = async (plant: { id: string }, phase: number) => {
	const facts = await captureFacts(w.db, plant.id, NOW);
	assert.ok(facts, "the plant's facts are captured");
	return Object.fromEntries(criteriaOf(await readCatalog(), phase, facts).map((x) => [x.key, x.status]));
};
const derivedOnly = async (who: Who) => {
	for (const milestoneId of ["guest_data_entered", "debrief_done"]) {
		refused(
			await w.writer.completeMilestone(w.db, who.actor, {
				requestKey: w.key(),
				expectedRevision: "1",
				input: { milestoneId, reviewed: "" },
			}),
			"derived_evidence_only",
		);
		refused(
			await w.writer.reopenMilestone(w.db, who.actor, {
				requestKey: w.key(),
				expectedRevision: "1",
				input: { milestoneId },
			}),
			"derived_evidence_only",
		);
	}
};

test("AC:B02-019 the debrief reads the actual date 2026-10-11, headcount 40 and the note beside its questionnaire, which is not an attestation; counts and answers are edited separately", async () => {
	const c = await w.plantOf();
	let p = await w.plan(c.owner);
	p = ok(await w.record(c.owner, { actualDate: "2026-10-11", attendance: 40, note: "Service held" }, p.revision)).plan;
	const before = await w.footprint(c.p);
	p = ok(await w.debrief(c.owner, p, { missingNames: "no" }, true)).plan;
	const read = await w.plan(c.owner);
	assert.deepEqual(read, p, "the debrief read is the committed plan");
	assert.deepEqual(
		[read.outcome!.actualDate, read.outcome!.attendance, read.outcome!.note],
		["2026-10-11", 40, "Service held"],
	);
	assert.deepEqual(read.debrief!.submitted!.answers, {
		wentWell: null,
		toChange: null,
		operations: null,
		followUpPlan: null,
		supportNeeded: null,
		missingNames: "no",
		missingCount: null,
	});
	const after = await w.footprint(c.p);
	assert.deepEqual(
		[after.attestations, after.attestation_revisions],
		[before.attestations, before.attestation_revisions],
		"raw debrief answers are no attestation",
	);
	assert.deepEqual(
		await w.rows(sql`SELECT action FROM audit_event WHERE tenant_id=${c.p.id} AND action LIKE 'attestation.%'`),
		[],
	);
	const signals = ok(await createSignals().readAttestations(w.db, c.owner.actor, {}));
	assert.deepEqual([signals.history, signals.candidates], [[], []], "no signal is answered by the debrief");
	assert.deepEqual(await w.footprint(c.p), after, "reading writes nothing");

	const counted = ok(
		await w.correct(
			c.owner,
			{ actualDate: "2026-10-11", attendance: 41, decisions: null, note: "Service held twice", reason: "Recount" },
			read.revision,
		),
	).plan;
	assert.deepEqual([counted.outcome!.attendance, counted.outcome!.note], [41, "Service held twice"]);
	assert.deepEqual(counted.debrief, read.debrief, "a count correction leaves the questionnaire");
	const answered = ok(await w.debrief(c.owner, counted, { missingNames: "yes", missingCount: 1 }, true)).plan;
	assert.deepEqual(answered.outcome, counted.outcome, "an answer correction leaves the counts and note");
	assert.equal(answered.debrief!.submitted!.version, 2);
});

test("AC:B02-020 a draft alone is unknown; submitted No is met and Yes 3 is not met, each with Debrief done met", async () => {
	const c = await w.launched();
	let p = await w.plan(c.owner);
	p = ok(await w.debrief(c.owner, p, { wentWell: "Draft words" })).plan;
	assert.equal(p.debrief!.draft!.answers.missingNames, null);
	assert.deepEqual(
		[p.evidence.guestNamesEntered.status, p.evidence.debriefDone.status],
		["unknown", "unknown"],
		"draft criterion",
	);
	p = ok(await w.debrief(c.owner, p, { wentWell: "Draft words", missingNames: "no" }, true)).plan;
	const first = p.evidence;
	p = ok(await w.debrief(c.owner, p, { missingNames: "yes", missingCount: 3 }, true)).plan;
	const second = p.evidence;
	assert.deepEqual(
		[first.guestNamesEntered.status, second.guestNamesEntered.status],
		["met", "not_met"],
		"guest criterion",
	);
	assert.deepEqual([first.debriefDone.status, second.debriefDone.status], ["met", "met"], "debrief criterion");
	assert.deepEqual(second.guestNamesEntered, { status: "not_met", remaining: 3 });
	assert.deepEqual(
		(await w.versions(c.p)).map((v) => [v.version, v.missing_names, v.missing_count, v.submitted]),
		[
			[1, "no", null, true],
			[2, "yes", 3, true],
		],
	);
});

test("AC:B02-021 correcting Yes 3 to No meets the guest criterion, keeps Phase 5 and both versions, and makes no task", async () => {
	const c = await w.launched({}, { phase: 5 });
	let p = ok(await w.debrief(c.owner, await w.plan(c.owner), { missingNames: "yes", missingCount: 3 }, true)).plan;
	const old = p.debrief!.submitted!;
	const before = await w.footprint(c.p);
	p = ok(await w.debrief(c.owner, p, { missingNames: "no" }, true)).plan;
	assert.equal(p.evidence.guestNamesEntered.status, "met");
	const after = await w.footprint(c.p);
	assert.deepEqual([after.phase, after.tasks, after.audits], [5, before.tasks, before.audits + 1]);
	assert.deepEqual(
		(await w.versions(c.p)).map((v) => [v.version, v.missing_names, v.missing_count]),
		[
			[1, "yes", 3],
			[2, "no", null],
		],
		"history versions",
	);
	assert.deepEqual(await debriefEntries(c.owner), [
		["Olivia Owner", { kind: "debrief", event: "corrected", version: 2 }],
		["Olivia Owner", { kind: "debrief", event: "submitted", version: 1 }],
	]);
	assert.equal(old.version, 1);
});

test("AC:CASE-LCH-007 a submitted No corrected to Yes 2 and a later incomplete draft keep the evidence at Yes 2 and the headcount at 50; correcting the outcome demotes nothing", async () => {
	const c = await w.launched({ attendance: 50 }, { phase: 5 });
	const alex = await w.person(c.p, "Alex");
	let p = ok(await w.debrief(c.owner, await w.plan(c.owner), { missingNames: "no" }, true)).plan;
	p = ok(await w.debrief(c.owner, p, { missingNames: "yes", missingCount: 2 }, true)).plan;
	p = ok(await w.debrief(c.owner, p, { wentWell: "Half written" })).plan;
	ok(await w.guest(c.owner, { personId: alex }));
	p = await w.plan(c.owner);
	assert.deepEqual(p.evidence.guestNamesEntered, { status: "not_met", remaining: 2 }, "the evidence is Yes 2");
	assert.equal(p.debrief!.draft!.submittedAt, null);
	const reviewed = p.revision;
	const fixed = ok(
		await w.correct(
			c.owner,
			{ actualDate: "2026-10-11", attendance: 50, decisions: 7, note: null, reason: "Counted decision cards" },
			reviewed,
		),
	).plan;
	assert.deepEqual([fixed.outcome!.attendance, fixed.outcome!.decisions], [50, 7]);
	assert.deepEqual(fixed.evidence, p.evidence);
	refused(
		await w.correct(
			c.owner,
			{ actualDate: "2026-10-11", attendance: 50, decisions: 8, note: null, reason: "Other tab" },
			reviewed,
		),
		"conflict",
	);
	const q = await w.plantOf({ name: "Quarry Church", planned: null });
	await w.admin.execute(sql`UPDATE plant SET timezone='America/New_York' WHERE id=${q.p.id}`);
	const held = await w.footprint(c.p);
	refused(
		await w.correct(
			q.admin,
			{ actualDate: "2026-10-11", attendance: 1, decisions: null, note: null, reason: "Elsewhere" },
			reviewed,
		),
		"not_ready",
	);
	assert.deepEqual(await w.footprint(c.p), held, "another church's Admin reaches nothing here");
	assert.deepEqual(
		[held.phase, (await w.one(sql`SELECT stage FROM person WHERE id=${alex}`)).stage],
		[5, "prospect"],
		"no phase is demoted and no stage moves",
	);
	assert.deepEqual(
		(await w.versions(c.p)).map((v) => [v.version, v.missing_names, v.missing_count, v.submitted]),
		[
			[1, "no", null, true],
			[2, "yes", 2, true],
			[3, null, null, false],
		],
		"prior submissions retained",
	);
});

test("AC:LAUNCH46-006 the debrief has one guest question whose Yes carries a count, and there is no finish or attestation control for guest entry", async () => {
	const c = await w.launched();
	assert.equal(
		GUEST_QUESTION,
		"Was there anyone that visited as a guest and has not been entered by name into our People CRM?",
	);
	const p = ok(await w.debrief(c.owner, await w.plan(c.owner), { missingNames: "yes", missingCount: 3 }, true)).plan;
	const answers = Object.keys(p.debrief!.submitted!.answers);
	assert.deepEqual(
		answers.filter((k) => !(WRITTEN_AREAS as readonly string[]).includes(k)),
		["missingNames", "missingCount"],
		"one question and its count field",
	);
	assert.equal(p.debrief!.submitted!.answers.missingCount, 3, "the count field holds the Yes count");
	const no = ok(await w.debrief(c.owner, p, { missingNames: "no", missingCount: 3 }, true)).plan;
	assert.equal(no.debrief!.submitted!.answers.missingCount, null, "No carries no count");
	assert.deepEqual(
		Object.keys(w.writer).filter((k) => /finish|attest|confirm/i.test(k)),
		[],
		"no finish guest entry operation",
	);
	const before = await w.footprint(c.p);
	await derivedOnly(c.owner);
	assert.deepEqual(await w.footprint(c.p), before);
});

test("AC:LAUNCH46-007 a submitted No is met from the dated questionnaire by its author, whether the headcount is 0, unknown or 40 and with no named guests", async () => {
	for (const attendance of [0, null, 40]) {
		const c = await w.launched({ attendance });
		const p = ok(await w.debrief(c.admin, await w.plan(c.owner), { missingNames: "no" }, true)).plan;
		const s = p.debrief!.submitted!;
		assert.deepEqual(p.evidence.guestNamesEntered, { status: "met", remaining: null }, `headcount ${attendance}`);
		assert.deepEqual([p.outcome!.attendance, p.guests.count], [attendance, 0]);
		assert.ok(s.submittedAt);
		assert.equal(p.evidence.submittedAt, s.submittedAt, "provenance: the submitted debrief");
		assert.deepEqual(s.submittedBy, { accountId: c.admin.id, displayName: "Adam Admin" });
		assert.deepEqual(await debriefEntries(c.owner), [
			["Adam Admin", { kind: "debrief", event: "submitted", version: 1 }],
		]);
	}
});

test("AC:LAUNCH46-008 Yes 3 stays not met with 3 remaining while the roster holds 20 named guests and then 2 more, until the answer is corrected", async () => {
	const c = await w.launched({ attendance: 100 });
	for (let i = 1; i <= 20; i++) ok(await w.guest(c.owner, { displayName: `Guest ${i}` }));
	let p = ok(await w.debrief(c.owner, await w.plan(c.owner), { missingNames: "yes", missingCount: 3 }, true)).plan;
	assert.deepEqual([p.guests.count, p.evidence.guestNamesEntered], [20, { status: "not_met", remaining: 3 }]);
	ok(await w.guest(c.owner, { displayName: "June" }));
	ok(await w.guest(c.owner, { displayName: "Theo" }));
	p = await w.plan(c.owner);
	assert.deepEqual([p.guests.count, p.evidence.guestNamesEntered], [22, { status: "not_met", remaining: 3 }]);
	assert.equal(p.debrief!.submitted!.version, 1, "no answer was corrected for the roster");
});

test("AC:LAUNCH46-009 after a valid No, an unanswered draft leaves the current criterion met and is itself unknown", async () => {
	const c = await w.launched();
	let p = ok(await w.debrief(c.owner, await w.plan(c.owner), { missingNames: "no" }, true)).plan;
	p = ok(await w.debrief(c.owner, p, { wentWell: "Next draft", missingNames: null })).plan;
	assert.deepEqual(p.evidence.guestNamesEntered, { status: "met", remaining: null }, "current criterion");
	assert.equal(p.debrief!.draft!.answers.missingNames, null, "the draft answers nothing");
	assert.equal(
		refused(await w.debrief(c.owner, p, { wentWell: "Next draft" }, true), "invalid_debrief").details.problem,
		"guest_answer_needed",
		"the draft cannot count: its criterion is unknown",
	);
	assert.deepEqual((await w.plan(c.owner)).evidence, p.evidence);
	assert.deepEqual(
		(await w.versions(c.p)).map((v) => [v.version, v.missing_names, v.submitted]),
		[
			[1, "no", true],
			[2, null, false],
		],
	);
});

test("AC:LAUNCH46-010 a valid six-area submission with Yes 3 makes Debrief done met and Guest data entered not met", async () => {
	const c = await w.launched();
	const areas = {
		wentWell: "Worship",
		toChange: "Parking",
		operations: "Kids check-in",
		followUpPlan: "Texts Monday",
		supportNeeded: "Prayer",
	};
	const p = ok(
		await w.debrief(c.owner, await w.plan(c.owner), { ...areas, missingNames: "yes", missingCount: 3 }, true),
	).plan;
	assert.deepEqual(p.evidence.debriefDone, { status: "met" });
	assert.deepEqual(p.evidence.guestNamesEntered, { status: "not_met", remaining: 3 });
	assert.deepEqual(p.debrief!.submitted!.answers, { ...areas, missingNames: "yes", missingCount: 3 });
	assert.deepEqual([p.outcome!.actualDate, p.outcome!.attendance], ["2026-10-11", 40], "the sixth area");
});

test("AC:LAUNCH46-011 a partial six-area form saves as a draft with Debrief done unknown, then submits with empty optional prose and is corrected", async () => {
	const c = await w.launched();
	let p = await w.plan(c.owner);
	assert.equal(WRITTEN_AREAS.length + (p.outcome ? 1 : 0), 6, "five written areas and the actual date and attendance");
	p = ok(await w.debrief(c.owner, p, { wentWell: "Worship", toChange: "Parking" })).plan;
	assert.deepEqual(
		[p.debrief!.draft!.submittedAt, p.debrief!.submitted, p.evidence.debriefDone.status],
		[null, null, "unknown"],
		"status draft",
	);
	assert.deepEqual(
		WRITTEN_AREAS.map((k) => p.debrief!.draft!.answers[k]),
		["Worship", "Parking", null, null, null],
	);
	p = ok(
		await w.debrief(
			c.owner,
			p,
			{ wentWell: " ", toChange: "", operations: null, followUpPlan: null, supportNeeded: null, missingNames: "no" },
			true,
		),
	).plan;
	assert.deepEqual([p.debrief!.draft, p.debrief!.submitted!.version, p.evidence.debriefDone.status], [null, 1, "met"]);
	assert.deepEqual(
		WRITTEN_AREAS.map((k) => p.debrief!.submitted!.answers[k]),
		[null, null, null, null, null],
		"empty optional prose is stored as nothing",
	);
	p = ok(await w.debrief(c.owner, p, { wentWell: "Worship", missingNames: "no" }, true)).plan;
	assert.deepEqual([p.debrief!.submitted!.version, p.debrief!.submitted!.answers.wentWell], [2, "Worship"]);
});

test("AC:LAUNCH46-012 a narrative claiming the first service sets no actual date and leaves the planned Oct 10 and First service held unknown", async () => {
	const c = await w.plantOf({ planned: "2026-10-10" });
	const narrative = "Our first service happened yesterday";
	const before = await w.footprint(c.p);
	const draft = refused(await w.debrief(c.owner, await w.plan(c.owner), { wentWell: narrative }), "not_ready");
	assert.deepEqual(draft.details, { needs: "outcome" });
	assert.deepEqual(await w.footprint(c.p), before);
	let p = await w.plan(c.owner);
	assert.deepEqual([p.outcome, p.launch!.targetDate], [null, "2026-10-10"]);
	const facts = await captureFacts(w.db, c.p.id, NOW);
	assert.deepEqual(
		[facts?.firstService?.status, facts?.firstService?.heldOn, facts?.criteria?.first_service_complete],
		["unknown", null, "unknown"],
	);
	assert.equal((await piCriteria(c.p, 5)).first_service_complete, "unknown");

	p = ok(await w.record(c.owner, { actualDate: "2026-10-11", attendance: 40 }, p.revision)).plan;
	p = ok(await w.debrief(c.owner, p, { wentWell: narrative, missingNames: "no" }, true)).plan;
	p = ok(
		await w.correct(
			c.owner,
			{ actualDate: "2026-10-11", attendance: 45, decisions: null, note: null, reason: "Recount" },
			p.revision,
		),
	).plan;
	assert.deepEqual(
		[p.launch!.targetDate, p.outcome!.actualDate, p.outcome!.attendance],
		["2026-10-10", "2026-10-11", 45],
		"the canonical correction writer changes the count, never the planned target",
	);
	assert.deepEqual(
		(await w.journal(c.owner))
			.filter((e) => e.change.kind === "outcome")
			.map((e) => (e.change as { event: string }).event),
		["corrected", "recorded"],
	);
});

test("AC:LAUNCH46-013 correcting Yes 3 to No is met with two versions, keeps Phase 5 and the first reading, and a replay, a repeat or a stale review adds no history", async () => {
	const c = await w.launched({}, { phase: 5 });
	let p = ok(await w.debrief(c.owner, await w.plan(c.owner), { missingNames: "yes", missingCount: 3 }, true)).plan;
	const first = await w.versions(c.p);
	const facts = await captureFacts(w.db, c.p.id, NOW);
	const reviewed = p;
	ok(await w.debrief(c.admin, p, { wentWell: "Admin draft" }));
	refused(await w.debrief(c.owner, reviewed, { missingNames: "no" }, true), "conflict");
	p = await w.plan(c.owner);
	assert.deepEqual(p.evidence.guestNamesEntered, { status: "not_met", remaining: 3 }, "a stale review changes nothing");
	const replayKey = randomUUID();
	const fixed = ok(await w.debrief(c.owner, p, { wentWell: "Admin draft", missingNames: "no" }, true, replayKey));
	assert.equal(fixed.outcome, "changed");
	assert.deepEqual(fixed.plan.evidence.guestNamesEntered, { status: "met", remaining: null });
	const settled = await w.footprint(c.p);
	for (let i = 0; i < 2; i++) {
		const again = ok(await w.debrief(c.owner, p, { wentWell: "Admin draft", missingNames: "no" }, true, replayKey));
		assert.deepEqual([again.outcome, again.plan], ["changed", fixed.plan], "a replay answers as the first did");
	}
	assert.equal(
		ok(await w.debrief(c.owner, fixed.plan, { wentWell: "Admin draft", missingNames: "no" }, true)).outcome,
		"noop",
	);
	assert.deepEqual(await w.footprint(c.p), settled, "no additional history");
	assert.deepEqual(
		(await w.versions(c.p)).map((v) => [v.version, v.missing_names, v.missing_count, v.submitted]),
		[
			[1, "yes", 3, true],
			[2, "no", null, true],
		],
	);
	assert.deepEqual((await w.versions(c.p))[0], first[0], "the earlier reading is kept as it was");
	assert.deepEqual(
		without((await captureFacts(w.db, c.p.id, NOW))!, "sourceRevision"),
		without(facts!, "sourceRevision"),
		"the Plant Intelligence snapshot reads the same",
	);
	assert.equal(settled.phase, 5, "the advanced phase stays");
	assert.deepEqual(
		(await debriefEntries(c.owner)).map(([, change]) => change),
		[
			{ kind: "debrief", event: "corrected", version: 2 },
			{ kind: "debrief", event: "submitted", version: 1 },
		],
	);
});

test("AC:LAUNCH46-021 headcount 40 and a recorded outcome with no submitted questionnaire leave Guest data entered and Debrief done unknown, and no manual signal sets them", async () => {
	const c = await w.launched({ attendance: 40 });
	const unknown = { guest_data_entered: "unknown", debrief_done: "unknown" };
	const both = async () => {
		const p = await w.plan(c.owner);
		const pi = await piCriteria(c.p, 5);
		return {
			launch: { guest_data_entered: p.evidence.guestNamesEntered.status, debrief_done: p.evidence.debriefDone.status },
			pi: { guest_data_entered: pi.guest_data_entered, debrief_done: pi.debrief_done },
		};
	};
	const p = await w.plan(c.owner);
	assert.deepEqual([p.outcome!.attendance, p.launch!.status], [40, "completed"]);
	assert.deepEqual(await both(), { launch: unknown, pi: unknown });
	const before = await w.footprint(c.p);
	await derivedOnly(c.owner);
	for (const key of ["guest_data_entered", "debrief_done"])
		refused(
			await createSignals().attest(w.db, c.owner.actor, {
				requestKey: w.key(),
				expectedRevision: "0",
				input: { key, value: "yes", asOf: "2026-10-12" },
			}),
			"invalid_input",
		);
	assert.deepEqual(await w.footprint(c.p), before, "nothing was written");
	ok(await w.debrief(c.owner, p, { missingNames: "no", wentWell: "Draft only" }));
	assert.deepEqual(await both(), { launch: unknown, pi: unknown }, "a draft is no submission");
});
