// WP-040 counting rules of Plant Intelligence's measured facts, through the pure builder the read uses, at fixed dates.
// A silent break here would show a planter a wrong count, a false "stalled" or a guess where the records cannot answer.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { buildFacts, factInputs, type FactInputs } from "../../../packages/domain/src/intelligence/facts.ts";

const TODAY = "2026-11-14";
const AS_OF = "2026-11-14T17:00:00.000Z";
const day = (offset: number) =>
	new Date(Date.parse(TODAY + "T00:00:00Z") + offset * 86_400_000).toISOString().slice(0, 10);
const hours = (h: number) => new Date(Date.parse(AS_OF) + h * 3_600_000).toISOString();

type Person = FactInputs["people"][number];
let n = 0;
function person(over: Partial<Person> & { signed?: number[]; kind?: "core_group" | "launch_team" } = {}): Person {
	const { signed = [-60], kind = "core_group", ...rest } = over;
	return {
		id: randomUUID(),
		name: `Person ${String(++n).padStart(3, "0")}`,
		birth: null,
		manual: "adult",
		cards: signed.map((d) => ({ id: randomUUID(), kind, on: day(d) })),
		changes: [],
		...rest,
	};
}
const empty = (): FactInputs => ({
	zone: "America/New_York",
	people: [],
	vision: [],
	nextVision: null,
	anyAttendance: false,
	attendance: [],
	followUps: [],
	roles: [],
	training: [],
	attestations: [],
	interviews: { count: 0, latestOn: null },
	fourCs: { count: 0, latestOn: null },
	launch: null,
});
const facts = (over: Partial<FactInputs>, today = TODAY, asOf = AS_OF) =>
	buildFacts(factInputs.parse({ ...empty(), ...over }), asOf as never, today);
const adults = (count: number, over: Partial<Person> = {}) => Array.from({ length: count }, () => person(over));

test("AC:CA001 AC:CA003 30 adults across core group and launch team count once each; children and withdrawn people do not count", () => {
	const both = adults(10).map((p) => ({
		...p,
		cards: [...p.cards, { id: randomUUID(), kind: "launch_team" as const, on: day(-30) }],
	}));
	const resigned = adults(5, { signed: [-80, -40, -20] });
	const byBirth = adults(3, { birth: "1990-01-01", manual: "child" });
	const children = [person({ birth: "2015-05-01", manual: null }), person({ manual: "child" })];
	const withdrawn = person({ changes: [{ id: randomUUID(), kind: "withdrawn", on: day(-2), at: 1 }] });
	const f = facts({ people: [...both, ...resigned, ...byBirth, ...adults(12), ...children, withdrawn] });
	assert.equal(f.committedAdults.status, "met");
	assert.equal(f.committedAdults.known, 30);
	assert.equal(f.committedAdults.exact, 30);
	assert.equal(f.committedAdults.children, 2);
	assert.deepEqual(f.committedAdults.needsClassifying, []);
	assert.equal(new Set(f.committedAdults.evidence.map((e) => e.person.id)).size, 30);
	assert.equal(f.committedAdults.evidence.length, 30);
	const two = f.committedAdults.evidence.find((e) => e.person.id === both[0]!.id)!;
	assert.deepEqual(two.kinds, ["core_group", "launch_team"]);
	assert.equal(two.committedSince, day(-60));
	assert.equal(f.committedAdults.evidence.find((e) => e.person.id === byBirth[0]!.id)!.adultFrom, "birth_date");
	assert.equal(f.criteria.committed_adults, "met");
});

test("AC:CA004 AC:CA005 29 known adults and one unclassified person read Unknown with at least 29; 28 and one is Not met", () => {
	const unknown = person({ manual: null, name: "Sam Unclassified" });
	const f = facts({ people: [...adults(29), unknown] });
	assert.equal(f.committedAdults.status, "unknown");
	assert.equal(f.committedAdults.known, 29);
	assert.equal(f.committedAdults.exact, null);
	assert.deepEqual(f.committedAdults.needsClassifying, [{ id: unknown.id, name: "Sam Unclassified" }]);
	assert.equal(f.criteria.committed_adults, "unknown");
	// The recorded "unknown" classification is the same as none.
	assert.equal(facts({ people: [...adults(29), person({ manual: "unknown" })] }).committedAdults.status, "unknown");
	// At most 29 cannot reach 30, so the criterion is Not met without claiming an exact total.
	const short = facts({ people: [...adults(28), person({ manual: null })] }).committedAdults;
	assert.deepEqual([short.status, short.known, short.exact], ["not_met", 28, null]);
	// Thirty established adults meet the criterion even with someone unresolved.
	assert.equal(facts({ people: [...adults(30), person({ manual: null })] }).committedAdults.status, "met");
});

test("AC:CA017 growth is on track at 20 days, slowed from 21 to 27 days and stalled only at 28, on plant-local dates", () => {
	const expected: Record<number, string> = { 20: "on_track", 21: "slowed", 24: "slowed", 27: "slowed", 28: "stalled" };
	for (const [ago, status] of Object.entries(expected)) {
		const f = facts({ people: [...adults(5, { signed: [-90] }), person({ signed: [-Number(ago)] })] });
		assert.equal(f.growth.status, status, `${ago} days`);
		assert.equal(f.growth.daysSince, Number(ago));
		assert.equal(f.growth.lastAcquiredOn, day(-Number(ago)));
		assert.equal(f.criteria.growth_trajectory, status === "stalled" ? "not_met" : "met");
	}
	// The windows are exactly 28 inclusive dates each: [today−27, today] and [today−55, today−28].
	const f = facts({
		people: [
			person({ signed: [-27] }),
			person({ signed: [-28] }),
			person({ signed: [-55] }),
			person({ signed: [-56] }),
		],
	});
	assert.deepEqual(
		[f.growth.current, f.growth.prior, f.growth.windowStart, f.growth.priorStart],
		[1, 2, day(-27), day(-55)],
	);
	// A repeat signature is not a new adult: the clock runs from the first one.
	assert.equal(facts({ people: [person({ signed: [-40, -3] })] }).growth.daysSince, 40);
	// No established date is Unknown, never stalled.
	assert.deepEqual([facts({}).growth.status, facts({}).growth.reason], ["unknown", "no_acquisition"]);
});

test("AC:CA017 an old known date cannot prove stalled while an unclassified person signed after it", () => {
	const f = facts({ people: [person({ signed: [-40] }), person({ signed: [-5], manual: null })] });
	assert.deepEqual([f.growth.status, f.growth.reason], ["unknown", "unclassified_newer"]);
	// A recent known adult still proves growth on track.
	assert.equal(
		facts({ people: [person({ signed: [-3] }), person({ signed: [-1], manual: null })] }).growth.status,
		"on_track",
	);
});

test("AC:CA008 a withdrawn adult lowers the current count and still counts as a new adult in the growth clock", () => {
	const left = person({ signed: [-10], changes: [{ id: randomUUID(), kind: "withdrawn", on: day(-3), at: 1 }] });
	const f = facts({ people: [...adults(4, { signed: [-50] }), left] });
	assert.equal(f.committedAdults.known, 4);
	assert.ok(!f.committedAdults.evidence.some((e) => e.person.id === left.id));
	assert.deepEqual([f.growth.daysSince, f.growth.current, f.growth.currentWithdrawn, f.growth.prior], [10, 1, 1, 4]);
	assert.equal(f.growth.status, "on_track");
});

test("AC:PI-CASE-003 Vision rhythm is past the 21-day mark at 22 days; a scheduled meeting does not count; no attendance is Unknown", () => {
	const f = facts({
		anyAttendance: true,
		vision: [
			{ on: day(-22), attended: 18 },
			{ on: day(-36), attended: 21 },
		],
		nextVision: day(3),
	});
	assert.deepEqual(
		[f.vision.status, f.vision.daysSince, f.vision.lastHeldOn, f.vision.nextScheduledOn],
		["watch", 22, day(-22), day(3)],
	);
	assert.deepEqual(f.vision.lastAttendance, [18, 21]);
	for (const [ago, status] of [
		[14, "on_target"],
		[15, "over_target"],
		[20, "over_target"],
		[21, "watch"],
		[28, "direct"],
	] as const)
		assert.equal(facts({ anyAttendance: true, vision: [{ on: day(-ago), attended: 3 }] }).vision.status, status);
	const none = facts({ nextVision: day(3) });
	assert.deepEqual(
		[none.vision.status, none.vision.reason, none.cohesion.status],
		["unknown", "no_attendance", "unknown"],
	);
	assert.equal(facts({ anyAttendance: true }).vision.reason, "no_vision_meeting");
});

test("AC:PI-CASE-005 cohesion flags three or more committed people, at least 20%, who attended before and not in the last 28 days", () => {
	const people = adults(10);
	const attendance = people.map((p, i) => ({ personId: p.id, on: i < 3 ? [day(-40)] : [day(-40), day(-5)] }));
	const f = facts({ people, attendance, anyAttendance: true });
	assert.equal(f.cohesion.status, "flagged");
	assert.deepEqual(
		f.cohesion.disengaged.map((p) => p.id).sort(),
		people
			.slice(0, 3)
			.map((p) => p.id)
			.sort(),
	);
	assert.equal(f.cohesion.committed, 10);
	const two = facts({
		people,
		attendance: attendance.map((a, i) => (i === 2 ? { ...a, on: [day(-1)] } : a)),
		anyAttendance: true,
	});
	assert.equal(two.cohesion.status, "steady");
});

test("AC:PI-TASK-CONTACT-001 four follow-ups read 2 of 3 on time with No longer needed left out; only recorded contact is contact", () => {
	const origin = hours(-72);
	const f = facts({
		followUps: [
			{ originAt: origin as never, state: "complete", completion: hours(-60) as never, contacted: true, owned: true },
			// Ticked through an administrative completion: on time, but not contact.
			{ originAt: origin as never, state: "complete", completion: hours(-30) as never, contacted: false, owned: true },
			{ originAt: origin as never, state: "no_longer_needed", completion: null, contacted: false, owned: true },
			{ originAt: origin as never, state: "open", completion: null, contacted: false, owned: true },
		],
	});
	assert.deepEqual(
		[f.followUps.onTime, f.followUps.measured, f.followUps.noLongerNeeded, f.followUps.contacted, f.followUps.total],
		[2, 3, 1, 1, 4],
	);
	// A follow-up younger than 48 hours is not yet measured; a completion after 48 hours is a miss.
	const g = facts({
		followUps: [
			{ originAt: hours(-10) as never, state: "open", completion: null, contacted: false, owned: true },
			{
				originAt: hours(-100) as never,
				state: "complete",
				completion: hours(-40) as never,
				contacted: false,
				owned: true,
			},
		],
	});
	assert.deepEqual([g.followUps.onTime, g.followUps.measured, g.followUps.pending], [0, 1, 1]);
	assert.equal(facts({}).followUps.status, "unknown");
});

test("AC:B01-002 six of eight responsibilities filled by four people, with Prayer Leader listed separately", () => {
	const [a, b, c, d, e] = adults(5);
	const hold = (key: string, p: Person) => ({ key, id: p.id, name: p.name });
	const f = facts({
		roles: [
			hold("worship", a!),
			hold("children", b!),
			hold("assimilation", c!),
			hold("small_groups", d!),
			hold("facilities", a!),
			hold("promotion", b!),
			hold("promotion", b!),
			hold("prayer", e!),
		],
	});
	assert.deepEqual([f.coverage.filled, f.coverage.slots, f.coverage.people, f.coverage.status], [6, 8, 4, "not_met"]);
	assert.deepEqual(f.coverage.prayerLeader, [{ id: e!.id, name: e!.name }]);
	assert.deepEqual(
		f.coverage.responsibilities.filter((r) => !r.people.length).map((r) => r.key),
		["administration_finance", "technology"],
	);
	assert.equal(f.criteria.all_team_leaders, "not_met");
	assert.equal(f.criteria.worship_leader, "met");
});

test("AC:B01-020 training 9 of 10 is not complete, and rounding never clears the last person", () => {
	const program = (complete: number, total: number) => ({
		id: randomUUID(),
		name: "Launch team basics",
		people: Array.from({ length: total }, (_, i) => ({ personId: randomUUID(), complete: i < complete })),
	});
	const f = facts({ training: [program(9, 10)] });
	assert.deepEqual([f.training.complete, f.training.total, f.training.status], [9, 10, "not_met"]);
	assert.equal(facts({ training: [program(999, 1000)] }).training.status, "not_met");
	assert.equal(facts({ training: [program(10, 10)] }).training.status, "met");
	// Nothing required and assigned is Unknown, not complete.
	assert.equal(facts({ training: [program(0, 0)] }).training.status, "unknown");
});

test("AC:B01-026 a prayer rhythm answer from 35 days ago needs renewing and keeps its value and date", () => {
	const f = facts({
		attestations: [
			{ key: "prayer_rhythm_established", kind: "answered", answer: true, asOf: day(-35) },
			{ key: "financial_base_established", kind: "answered", answer: false, asOf: day(-90) },
			{ key: "systems_tested", kind: "retracted", answer: null, asOf: day(-4) },
		],
	});
	const prayer = f.attestations.find((a) => a.key === "prayer_rhythm_established")!;
	assert.deepEqual(
		[prayer.value, prayer.asOf, prayer.ageDays, prayer.renewal.status],
		["yes", day(-35), 35, "needs_renewing"],
	);
	assert.equal(f.attestations.find((a) => a.key === "core_group_giving")!.state, "unanswered");
	assert.equal(f.criteria.financial_base, "not_met");
	assert.equal(f.criteria.systems_tested, "unknown");
	assert.equal(f.attestations.length, 7);
});

test("AC:PI-CASE-001 the same inputs give the same revision and any changed input gives a new one", () => {
	const inputs = { people: adults(3), anyAttendance: true };
	assert.equal(facts(inputs).sourceRevision, facts(inputs).sourceRevision);
	assert.equal(facts(inputs).sourceRevision, facts(inputs, day(5), hours(120)).sourceRevision);
	assert.notEqual(facts(inputs).sourceRevision, facts({ ...inputs, anyAttendance: false }).sourceRevision);
});

test("AC:PI-PURPOSE-001 the fact inputs hold no private care and only a count and date of interviews and 4 C's", () => {
	assert.deepEqual(Object.keys(factInputs.shape).sort(), [
		"anyAttendance",
		"attendance",
		"attestations",
		"followUps",
		"fourCs",
		"interviews",
		"launch",
		"nextVision",
		"people",
		"roles",
		"training",
		"vision",
		"zone",
	]);
	assert.deepEqual(Object.keys(factInputs.shape.interviews.shape).sort(), ["count", "latestOn"]);
	assert.deepEqual(Object.keys(factInputs.shape.fourCs.shape).sort(), ["count", "latestOn"]);
	assert.throws(() =>
		factInputs.parse({ ...empty(), interviews: { count: 1, latestOn: day(-1), result: "qualified" } }),
	);
});

const sunday = {
	target: null,
	actual: null,
	status: "planning",
	path: "launch_sunday",
	reachedOn: null,
	reachedName: null,
} as const;
const CONSTITUTED = "Constituted as a church";
/** A milestone-path launch, reached on `reachedOn` when given. */
const milestone = (reachedOn: string | null) => ({
	...sunday,
	path: "milestone" as const,
	reachedOn,
	reachedName: reachedOn ? CONSTITUTED : null,
});

test("the launch countdown is the plant-local days to a scheduled launch that has not happened", () => {
	const on = (target: string | null, status: "planning" | "scheduled" | "postponed" | "completed", actual = null) =>
		facts({ launch: { ...sunday, target, actual, status } }).launch;
	assert.deepEqual(facts({}).launch, { targetOn: null, daysToLaunch: null });
	assert.deepEqual(on("2026-12-14", "scheduled"), { targetOn: "2026-12-14", daysToLaunch: 30 });
	assert.deepEqual(on(TODAY, "scheduled"), { targetOn: TODAY, daysToLaunch: 0 });
	assert.deepEqual(on("2026-12-14", "planning"), { targetOn: null, daysToLaunch: null });
	assert.deepEqual(on(null, "postponed"), { targetOn: null, daysToLaunch: null });
});

test("a reached milestone is First service held on the milestone path; unreached or cleared is Unknown, never Not met", () => {
	const reached = facts({ launch: milestone("2026-10-11") }, "2026-10-12");
	assert.equal(reached.criteria.first_service_complete, "met");
	assert.deepEqual(reached.firstService, {
		path: "milestone",
		status: "met",
		milestone: CONSTITUTED,
		heldOn: "2026-10-11",
	});
	// A milestone reached today counts today.
	assert.equal(facts({ launch: milestone("2026-10-12") }, "2026-10-12").criteria.first_service_complete, "met");
	// Chosen but not recorded, and recorded then cleared, read the same: Unknown with nothing behind it.
	const open = facts({ launch: milestone(null) }, "2026-10-12");
	assert.equal(open.criteria.first_service_complete, "unknown");
	assert.deepEqual(open.firstService, { path: "milestone", status: "unknown", milestone: null, heldOn: null });
	// The other Phase 5 criteria stay as they were: the facts do not measure guest data or the debrief.
	assert.equal(reached.criteria.guest_data_entered, undefined);
	assert.equal(reached.criteria.debrief_done, undefined);
});

test("a corrected date moves the evidence", () => {
	const corrected = facts({ launch: milestone("2026-10-04") }, "2026-10-12");
	assert.deepEqual(
		[corrected.criteria.first_service_complete, corrected.firstService],
		["met", { path: "milestone", status: "met", milestone: CONSTITUTED, heldOn: "2026-10-04" }],
	);
});

test("a reached or held day after the facts' plant-local date never counts", () => {
	const read = (launch: FactInputs["launch"], today: string) =>
		facts({ launch }, today).criteria.first_service_complete;
	assert.equal(read(milestone("2026-10-11"), "2026-10-10"), "unknown");
	assert.equal(read(milestone("2026-10-11"), "2026-10-11"), "met");
	const held = { ...sunday, status: "completed", actual: "2026-10-11" } as const;
	assert.equal(read(held, "2026-10-10"), "unknown");
	assert.equal(read(held, "2026-10-11"), "met");
	assert.deepEqual(facts({ launch: milestone("2026-10-11") }, "2026-10-10").firstService, {
		path: "milestone",
		status: "unknown",
		milestone: null,
		heldOn: null,
	});
});

test("a Launch Sunday plant counts only an actual Launch Sunday; its launch-date criteria do not change", () => {
	const at = (launch: FactInputs["launch"]) => facts({ launch }, TODAY);
	const held = at({ ...sunday, status: "completed", target: null, actual: day(-7) });
	assert.deepEqual(
		[held.criteria.first_service_complete, held.firstService],
		["met", { path: "launch_sunday", status: "met", heldOn: day(-7) }],
	);
	assert.equal(held.criteria.launch_date_set, undefined);
	assert.equal(held.criteria.launch_window, undefined);
	const states = {
		none: null,
		planning: { ...sunday },
		scheduled: { ...sunday, status: "scheduled", target: day(20) },
		postponed: { ...sunday, status: "postponed" },
	} as const;
	for (const [state, launch] of Object.entries(states)) {
		const f = at(launch);
		assert.equal(f.criteria.first_service_complete, "unknown", state);
		assert.deepEqual(f.firstService, { path: "launch_sunday", status: "unknown", heldOn: null }, state);
	}
	const scheduled = at(states.scheduled);
	assert.deepEqual(
		[scheduled.criteria.launch_date_set, scheduled.criteria.launch_window],
		["met", "met"],
		"a scheduled launch still sets the date and window",
	);
});
