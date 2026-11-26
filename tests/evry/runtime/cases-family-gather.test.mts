import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { createLaunchReader } from "../../../packages/domain/src/launch/reads.ts";
import { answerRsvpToken, describeRsvpToken } from "../../../packages/domain/src/meetings/index.ts";
import { issueRsvpToken } from "../../integration/meetings/rsvp-token.mts";
import { nativePorts } from "../evals/settings-ports.mts";
import { ok, refused } from "../../support/fixture.mts";
import { caseWorld, propose, read, rowsOf, sql, type CaseWorld, type Church, type Reply } from "./case-world.mts";

let w: CaseWorld;
before(async () => {
	w = await caseWorld("familygather", { native: { ...nativePorts(), launchNotices: async () => undefined } });
});
after(() => w?.close());

const fields = (reply: Reply, kind?: string) => rowsOf(reply, kind).map((r) => [r.label, r.fields]);
const meetings = (c: Church) =>
	w.rows<{ id: string; title: string | null; type: string; d: string }>(
		sql`SELECT id,title,type,local_date::text AS d FROM meeting WHERE plant_id=${c.P.id} ORDER BY local_date`,
	);
async function scheduled(c: Church, input: object): Promise<string> {
	const had = new Set((await meetings(c)).map((m) => m.id));
	await w.apply(c.A, "meetings.schedule", input);
	return (await meetings(c)).find((m) => !had.has(m.id))!.id;
}
const guest = (meeting: string, person: string) =>
	w.one(sql`SELECT rsvp,presence,card_response,card_notes,inviter_person_id,roster_member,removed_at IS NOT NULL AS removed
		FROM participation WHERE meeting_id=${meeting} AND person_id=${person}`);
const venueNamed = async (c: Church, name: string) =>
	String((await w.one(sql`SELECT id FROM venue WHERE plant_id=${c.P.id} AND name=${name}`)).id);

test("AC:EVRY-FAMILY-MEETINGS RSVP, card, headcount and attendance stay apart, one first-Vision follow-up, kept venue snapshot, a single-use token and a leader's own floor", async () => {
	const c = await w.church();
	const [alex, casey] = [c.rivera, c.casey];
	const jamie = await c.person("Jamie First");
	const L = await w.seated(c.P, "member", { user: { name: "Lena Leader" } });
	const lena = await c.person("Lena Leader", { stage: "leader" });
	await w.admin.execute(sql`UPDATE person SET linked_account_id=${L.id} WHERE id=${lena}`);
	for (const name of ["Hall", "Annex"]) await w.apply(c.A, "venues.create", { name, address: "1 Main St" });
	const [Hall, Annex] = [await venueNamed(c, "Hall"), await venueNamed(c, "Annex")];

	const earlier = await scheduled(c, { type: "vision_meeting", date: "2026-10-03", time: "10:00", guestIds: [casey] });
	await w.apply(c.A, "meetings.finalizeAttendance", { meetingId: earlier, attendeeIds: [casey] });
	const V = await scheduled(c, {
		type: "vision_meeting",
		date: "2026-10-10",
		time: "10:00",
		venueId: Annex,
		guestIds: [alex, casey],
	});
	const shown = async (operation: string, input: object = { meetingId: V }) =>
		fields(await w.look(c.A, operation, input));

	await w.apply(c.A, "venues.edit", { venueId: Annex, patch: { capacity: 40 } });
	await w.apply(c.A, "venues.correct", { venueId: Annex, patch: { name: "Annex East" }, reason: "Wrong name" });
	await w.apply(c.A, "venues.archive", { venueId: Annex, reason: "Closed" });
	const place = () => w.one(sql`SELECT venue_id,venue_name,venue_address FROM meeting WHERE id=${V}`);
	assert.deepEqual(
		await place(),
		{ venue_id: Annex, venue_name: "Annex", venue_address: "1 Main St" },
		"the meeting keeps the place as it was",
	);
	assert.deepEqual(
		(await shown("venues.list", {})).map(([label]) => label),
		["Hall"],
	);
	assert.deepEqual(
		(await shown("venues.get", { venueId: Annex })).map(([label, f]) => [label, f.active, f.capacity]),
		[["Annex East", false, "40"]],
	);
	assert.deepEqual((await shown("venues.history", { venueId: Annex })).length, 4);
	const archived = await w.ask(c.A, "Use the Annex", [
		() => propose("meetings.schedule", { type: "orientation", date: "2026-10-30", time: "18:00", venueId: Annex }),
	]);
	assert.equal(
		archived.proposals[0]?.review.refusal,
		"That venue is archived. Restore it or choose another venue.",
		JSON.stringify(archived.replies),
	);
	await assert.rejects(w.approve(c.A, archived.proposals[0]!), { code: "review_closed" });
	assert.equal((await meetings(c)).length, 2, "an archived venue takes no new meeting");
	await w.apply(c.A, "meetings.edit", { meetingId: V, notes: "Bring chairs", title: "Vision night" });
	assert.deepEqual((await place()).venue_name, "Annex", "another edit keeps the chosen place");
	await w.apply(c.A, "venues.restore", { venueId: Annex });
	assert.deepEqual((await shown("venues.list", {})).length, 2);
	await w.apply(c.A, "venues.archive", { venueId: Annex });
	assert.equal((await shown("meetings.get"))[0]![1].venue, "Annex");

	await w.apply(c.A, "meetings.replaceAgenda", {
		meetingId: V,
		sections: [
			{ title: "Welcome", minutes: 10 },
			{ title: "Vision", minutes: 30 },
		],
	});
	const agenda = rowsOf(await w.look(c.A, "meetings.readAgenda", { meetingId: V }), "item");
	assert.deepEqual(
		agenda.map((r) => [r.label, r.fields.minutes]),
		[
			["Welcome", "10"],
			["Vision", "30"],
		],
	);
	const kit = () => w.look(c.A, "meetings.listKit", { meetingId: V });
	const first = rowsOf(await kit())[0];
	await w.apply(c.A, "meetings.updateKitItem", {
		meetingId: V,
		itemId: first.id,
		checked: true,
		assigneePersonId: casey,
		notes: "In the van",
	});
	assert.deepEqual(rowsOf(await kit())[0].fields, {
		category: "essential",
		checked: true,
		assignee: "Casey Reed",
		notes: "In the van",
	});
	const bare = await scheduled(c, { type: "vision_meeting", date: "2026-11-20", time: "19:00" });
	await w.admin.execute(sql`DELETE FROM meeting_kit_item WHERE meeting_id=${bare}`);
	await w.admin.execute(sql`UPDATE meeting SET kit_version=NULL WHERE id=${bare}`);
	await w.apply(c.A, "meetings.populateKit", { meetingId: bare });
	assert.equal(await w.count(sql`SELECT count(*)::int AS n FROM meeting_kit_item WHERE meeting_id=${bare}`), 23);

	await w.apply(c.A, "meetings.inviteGuest", { meetingId: bare, personId: jamie, inviterPersonId: casey });
	assert.deepEqual(await guest(bare, jamie), {
		rsvp: "pending",
		presence: "absent",
		card_response: null,
		card_notes: null,
		inviter_person_id: casey,
		roster_member: false,
		removed: false,
	});
	await w.apply(c.A, "meetings.setInviter", { meetingId: bare, personId: jamie, inviterPersonId: alex });
	assert.deepEqual(
		(await shown("meetings.invitationAttribution", { meetingId: bare })).map(([, f]) => f.invitedBy),
		["Alex Rivera"],
	);
	await w.apply(c.A, "meetings.correctRsvp", { meetingId: bare, personId: jamie, rsvp: "no" });
	assert.equal((await guest(bare, jamie)).rsvp, "declined");
	await w.apply(c.A, "meetings.removeGuest", { meetingId: bare, personId: jamie });
	assert.equal((await guest(bare, jamie)).removed, true);
	const people = () => w.count(sql`SELECT count(*)::int AS n FROM person WHERE plant_id=${c.P.id}`);
	const before = await people();
	await w.apply(c.A, "meetings.createGuestContact", {
		meetingId: bare,
		displayName: "Gina Guest",
		email: "gina@example.test",
	});
	const gina = String(
		(await w.one(sql`SELECT id FROM person WHERE display_name='Gina Guest' AND plant_id=${c.P.id}`)).id,
	);
	assert.deepEqual(
		[await people(), (await guest(bare, gina)).presence],
		[before + 1, "absent"],
		"the person and the guest together",
	);
	const lost = await w.prepare(c.A, "meetings.createGuestContact", { meetingId: bare, displayName: "Nobody Saved" });
	await c.failedWrite(lost, "participation");
	assert.equal(await people(), before + 2, "one person, after the write could finish");
	await w.apply(c.A, "meetings.inviteGuest", { meetingId: bare, personId: lena });
	await w.apply(L, "meetings.saveOwnRsvp", { meetingId: bare, rsvp: "yes" });
	assert.equal((await guest(bare, lena)).rsvp, "confirmed");
	const own = await w.look(L, "meetings.getOwnRsvp", { meetingId: bare });
	assert.equal(rowsOf(own)[0].fields.rsvp, "yes");

	const token = await issueRsvpToken(w.admin, c.P.id, V, alex);
	assert.ok(token);
	const seen = () => describeRsvpToken(w.db, { token });
	assert.equal((await seen()).state, "pending");
	assert.equal((await answerRsvpToken(w.db, { token, rsvp: "confirmed" })).status, "ok");
	assert.equal((await seen()).state, "answered");
	refused(await answerRsvpToken(w.db, { token, rsvp: "declined" }), "token_closed");
	assert.deepEqual(
		[(await guest(V, alex)).rsvp, (await guest(V, alex)).presence],
		["confirmed", "absent"],
		"an RSVP is no attendance",
	);
	assert.deepEqual(
		(await shown("meetings.listGuests")).map(([label, f]) => [label, f.rsvp]),
		[
			["Alex Rivera", "yes"],
			["Casey Reed", "no answer"],
		],
	);

	await w.apply(c.A, "meetings.recordCard", { meetingId: V, personId: alex, response: "interested", notes: "Call me" });
	assert.deepEqual([(await guest(V, alex)).card_response, (await guest(V, alex)).presence], ["interested", "absent"]);
	await w.apply(c.A, "meetings.createWalkInContact", { meetingId: V, displayName: "Wanda Walkin" });
	const wanda = String((await w.one(sql`SELECT id FROM person WHERE display_name='Wanda Walkin'`)).id);
	assert.equal((await guest(V, wanda)).presence, "attended");
	await w.apply(c.A, "meetings.clearAttendance", { meetingId: V, personId: wanda });
	await w.apply(c.A, "meetings.checkIn", { meetingId: V, personId: jamie });
	await w.apply(c.A, "meetings.setAttendance", { meetingId: V, personId: alex, presence: "excused" });
	await w.apply(c.A, "meetings.captureAttendanceBatch", {
		meetingId: V,
		entries: [
			{ personId: alex, presence: "absent" },
			{ personId: casey, presence: "attended" },
		],
	});
	assert.deepEqual(await Promise.all([alex, casey, jamie, wanda].map(async (p) => (await guest(V, p)).presence)), [
		"absent",
		"attended",
		"attended",
		"absent",
	]);
	const owed = () =>
		w.rows(sql`SELECT b.id,b.meeting_id,b.person_id,t.id AS task FROM obligation b LEFT JOIN task t ON t.obligation_id=b.id AND t.deleted_at IS NULL
			WHERE b.plant_id=${c.P.id} AND b.kind='follow_up' AND b.superseded_at IS NULL ORDER BY b.id`);
	const prior = await owed();
	await w.apply(c.A, "meetings.finalizeAttendance", { meetingId: V, attendeeIds: [casey, jamie] });
	const mine = (await owed()).filter((o) => o.meeting_id === V);
	assert.deepEqual(
		mine.map((o) => o.person_id),
		[jamie],
		"V/Jamie only: not the RSVP, not the repeat",
	);
	assert.equal((await owed()).length, prior.length + 1, "Casey gets no second follow-up");
	await w.apply(c.A, "meetings.reconcileAttendance", {
		meetingId: V,
		attendeeIds: [casey, jamie, wanda],
		reason: "Wanda stayed",
	});
	const now = (await owed()).filter((o) => o.meeting_id === V);
	assert.deepEqual(
		now.find((o) => o.person_id === jamie),
		mine[0],
		"the same follow-up and task",
	);
	assert.equal(
		now.some((o) => o.person_id === alex),
		false,
	);
	assert.equal((await shown("meetings.listAttendance"))[0]![1].finalized, true);
	const summary = (await shown("meetings.attendanceSummary"))[0]![1];
	assert.deepEqual([summary.guests, summary.attended, summary.absent], ["4", "3", "1"]);
	const cards = await shown("meetings.cardBreakdown");
	assert.deepEqual(
		[cards[0]![1].attended, cards[0]![1].withCard, cards[1]![1].total],
		["3", "0", "1"],
		"cards count apart from attendance",
	);
	assert.deepEqual(
		(await shown("meetings.listCards")).map(([label]) => label),
		["Alex Rivera"],
	);
	await w.apply(c.A, "meetings.clearCard", { meetingId: V, personId: alex, reason: "Wrong person" });
	assert.equal((await guest(V, alex)).card_response, null);
	await w.apply(c.A, "meetings.addAttendeeNote", { meetingId: V, personId: jamie, text: "Loved the music" });
	assert.deepEqual(
		await w.rows(
			sql`SELECT n.body,n.person_id,g.meeting_id FROM person_note n JOIN participation g ON g.id=n.participation_id WHERE g.meeting_id=${V}`,
		),
		[{ body: "Loved the music", person_id: jamie, meeting_id: V }],
	);
	const progress = (await shown("meetings.linkedTaskProgress"))[0]![1];
	assert.deepEqual([progress.followUps, progress.open], [String(now.length), String(now.length)]);
	assert.equal(
		await w.count(
			sql`SELECT count(*)::int AS n FROM task t JOIN obligation b ON b.id=t.obligation_id WHERE b.meeting_id=${V} AND b.kind='follow_up'`,
		),
		now.length,
		"the counted tasks are real and linked",
	);

	const score = (n: number) =>
		Object.fromEntries(
			["attendance", "location", "logistics", "agenda", "vibe", "message", "close", "nextSteps"].map((k) => [
				`${k}Score`,
				n,
			]),
		);
	await w.apply(c.A, "meetings.recordEvaluation", { meetingId: earlier, scores: score(3) });
	await w.apply(c.A, "meetings.recordEvaluation", { meetingId: V, scores: score(4), notes: "Good night" });
	await w.apply(c.A, "meetings.correctEvaluation", { meetingId: V, changes: { vibeScore: 2 }, reason: "Too high" });
	const saved = (await w.one<{ s: Reply }>(sql`SELECT evaluation_scores AS s FROM meeting WHERE id=${V}`)).s;
	assert.equal(Object.keys(saved).length, 8);
	assert.equal(JSON.stringify(Object.values(saved).sort()), "[2,4,4,4,4,4,4,4]");
	assert.deepEqual(
		(await shown("meetings.evaluationHistory")).map(([label, f]) => [label, f.averageBefore, f.average, f.reason]),
		[
			["Recorded", null, "4", null],
			["Corrected", "4", "3.8", "Too high"],
		],
		"the first record stays",
	);
	const evaluation = (await shown("meetings.getEvaluation"))[0]![1];
	assert.deepEqual([evaluation.vibe, evaluation.message, evaluation.corrections], ["2", "4", "1"]);
	const compared = (await shown("meetings.compareEvaluation"))[0]![1];
	assert.deepEqual([compared.current, compared.baseline, compared.earlierCount], ["3.8", "3", "1"]);
	assert.equal((await shown("meetings.evaluationTrend", {})).length, 2);
	const trend = await shown("meetings.attendanceTrend", {});
	assert.deepEqual(
		trend.map(([, f]) => [f.date, f.attended]),
		[
			["2026-10-03", "1"],
			["2026-10-10", "3"],
		],
	);
	const stats = (await shown("meetings.summaryStats", {}))[0]![1];
	assert.deepEqual([stats.held, stats.finalized, stats.attendances, stats.uniqueAttendees], ["2", "2", "4", "3"]);
	const report = (await shown("meetings.readAnalytics"))[0]![1];
	assert.deepEqual([report.attended, report.followUpsOpen], ["3", String(now.length)]);
	assert.deepEqual((await shown("meetings.hasHistory", { types: ["vision_meeting"] }))[0]![1].hasHistory, true);
	assert.equal((await shown("meetings.communicationContext")).filter(([, f]) => f.hasEmail !== undefined).length, 4);

	await w.apply(c.A, "meetings.changeStatus", { meetingId: bare, to: "ready" });
	assert.equal((await w.one(sql`SELECT status FROM meeting WHERE id=${bare}`)).status, "ready");
	for (const to of ["ready", "in_progress", "completed"])
		await w.apply(c.A, "meetings.changeStatus", { meetingId: V, to });
	await w.apply(c.A, "meetings.correctOccurrence", { meetingId: V, voided: true, reason: "It was a rehearsal" });
	assert.equal((await w.one(sql`SELECT occurrence_voided_at IS NOT NULL AS v FROM meeting WHERE id=${V}`)).v, true);
	await w.apply(c.A, "meetings.correctOccurrence", { meetingId: V, voided: false, reason: "It counted" });
	assert.equal((await w.one(sql`SELECT occurrence_voided_at IS NOT NULL AS v FROM meeting WHERE id=${V}`)).v, false);
	assert.deepEqual(
		(await owed()).find((o) => o.person_id === jamie),
		mine[0],
		"identity survives the correction",
	);
	const practice = await scheduled(c, { type: "prelaunch_practice", date: "2026-10-12", time: "10:00" });
	await w.apply(c.A, "meetings.completePractice", { meetingId: practice });
	const held = async () => (await shown("meetings.listCompletedPreLaunchPractices", {}))[0]![1].held;
	assert.equal(await held(), "1");
	await w.apply(c.A, "meetings.correctPracticeOccurrence", {
		meetingId: practice,
		state: "not_completed",
		reason: "Rained off",
	});
	assert.equal(await held(), "0");
	await w.apply(c.A, "meetings.delete", { meetingId: practice, reason: "Not held" });
	assert.equal((await w.one(sql`SELECT retired_at IS NOT NULL AS gone FROM meeting WHERE id=${practice}`)).gone, true);

	await w.apply(c.A, "teams.create", { name: "Hospitality" });
	const team = String((await w.one(sql`SELECT id FROM team WHERE plant_id=${c.P.id} AND name='Hospitality'`)).id);
	await w.apply(c.A, "teams.appointLeader", { teamId: team, personId: lena });
	for (const [name, person] of [
		["Host", alex],
		["Greeter", casey],
	] as const) {
		await w.apply(c.A, "teams.createRole", { teamId: team, name });
		const role = String((await w.one(sql`SELECT id FROM team_role WHERE team_id=${team} AND name=${name}`)).id);
		await w.apply(c.A, "teams.assignRole", { roleId: role, personId: person });
	}
	const T = await scheduled(c, {
		type: "team_meeting",
		subtype: "training",
		date: "2026-10-11",
		time: "18:00",
		teamId: team,
	});
	await w.admin.execute(sql`DELETE FROM participation WHERE meeting_id=${T}`);
	const planned = await shown("meetings.previewRosterImport", { meetingId: T });
	assert.deepEqual(planned.map(([label]) => label).sort(), ["Alex Rivera", "Casey Reed"]);
	await w.apply(c.A, "meetings.copyTeamRoster", { meetingId: T });
	assert.deepEqual([(await guest(T, alex)).roster_member, (await guest(T, casey)).roster_member], [true, true]);

	const asLeader = (operation: string, input: object) =>
		w.quiet(() => w.ask(L, "As leader", [() => propose(operation, input)]));
	for (const [operation, input] of [
		["meetings.correctRsvp", { meetingId: T, personId: alex, rsvp: "yes" }],
		["meetings.recordCard", { meetingId: T, personId: alex, response: "interested" }],
		["meetings.delete", { meetingId: T, reason: "x" }],
		["meetings.recordEvaluation", { meetingId: V, scores: score(5) }],
		["meetings.inviteGuest", { meetingId: T, personId: jamie }],
	] as const) {
		const asked = await asLeader(operation, input);
		assert.deepEqual([asked.replies[0].error, asked.proposals], ["not_offered", []], operation);
	}
	await w.apply(L, "meetings.setAttendance", { meetingId: T, personId: alex, presence: "attended" });
	assert.equal((await guest(T, alex)).presence, "attended");
	const other = await w.ask(L, "Mark Jamie at the Vision meeting", [
		() => propose("meetings.setAttendance", { meetingId: bare, personId: gina, presence: "attended" }),
	]);
	assert.match(
		String(other.proposals[0]?.review.refusal ?? other.replies[0].error),
		/leader of this meeting|access_denied/,
	);
	assert.equal((await guest(bare, gina)).presence, "absent");
	assert.equal((await w.look(c.A, "meetings.list", { window: "all" })).total, 4);

	const card = await w.prepare(c.A, "meetings.correctRsvp", { meetingId: bare, personId: gina, rsvp: "yes" });
	await c.foreignReview(card);
	await c.foreign(
		"Correct the RSVP and the attendance",
		[
			() => [read("meetings.get", { meetingId: V }), read("meetings.listGuests", { meetingId: V })],
			() => [read("meetings.listAttendance", { meetingId: V }), read("venues.get", { venueId: Hall })],
			() => propose("meetings.setAttendance", { meetingId: V, personId: alex, presence: "attended" }),
			() => propose("meetings.correctRsvp", { meetingId: bare, personId: gina, rsvp: "yes" }),
		],
		{ secrets: ["Gina Guest", "Vision night", "Annex", "Loved the music"], on: { onError: "go_on" } },
	);
	await c.failedWrite(card, "participation");
	assert.equal((await guest(bare, gina)).rsvp, "confirmed");
});

async function clockTo(instant: string) {
	await w.at(instant);
	await w.admin.execute(sql`UPDATE auth_session SET expires_at=${instant}::timestamptz+interval '1 day'`);
}
const LAUNCHED = "2026-10-26T01:00:00Z";
const reader = createLaunchReader();
const DEBRIEF = {
	wentWell: "People came.",
	toChange: "Signs.",
	operations: "Good.",
	followUpPlan: "Calls.",
	supportNeeded: "None.",
};

test("AC:EVRY-FAMILY-LAUNCH the planned date, real milestone tasks, counts that make nobody, an independent debrief and a summary shared only when published", async () => {
	const c = await w.church();
	const org = await w.organization("sending_church", { name: "Grace Sending" });
	await w.admin
		.execute(sql`INSERT INTO affiliation(plant_id,organization_id,accepted_at,share_people,share_meetings,share_tasks,share_ministry_teams,share_wiki,share_activity,shared_findings)
		VALUES(${c.P.id},${org.id},clock_timestamp()-interval '1 day',true,true,true,true,false,false,true)`);
	const director = await w.seated(org, "admin");
	const launch = () =>
		w.one(
			sql`SELECT target_date::text AS target,actual_date::text AS actual,status,attendance,decisions FROM launch WHERE plant_id=${c.P.id}`,
		);
	const phase = async () => (await w.one(sql`SELECT phase FROM plant WHERE id=${c.P.id}`)).phase;
	const phases = {
		now: await phase(),
		moves: await w.count(sql`SELECT count(*)::int AS n FROM phase_transition WHERE plant_id=${c.P.id}`),
	};
	const counts = () =>
		w.one(sql`SELECT (SELECT count(*)::int FROM person WHERE plant_id=${c.P.id}) AS people,(SELECT count(*)::int FROM launch_guest WHERE plant_id=${c.P.id}) AS guests,
			(SELECT count(*)::int FROM commitment WHERE plant_id=${c.P.id}) AS commitments`);
	const journal = async () => rowsOf(await w.look(c.A, "launch.readJournal"));

	await w.apply(c.A, "launch.schedule", { date: "2026-10-18", reason: null });
	await w.apply(c.A, "launch.postpone", { reason: "The school asked us." });
	await w.apply(c.A, "launch.schedule", { date: "2026-10-25", reason: "New date" });
	const countdown = rowsOf(await w.look(c.A, "launch.readCountdown"))[0].fields;
	assert.deepEqual(
		[countdown.status, countdown.plannedDate, countdown.daysLeft],
		["Scheduled", "Sun, Oct 25, 2026", 12],
	);
	assert.deepEqual([(await launch()).target, (await launch()).status], ["2026-10-25", "scheduled"]);
	assert.deepEqual(
		(await journal()).map((e) => [e.label, e.fields.from, e.fields.to, e.fields.reason]),
		[
			["Launch Sunday set again", null, "Sun, Oct 25, 2026", "New date"],
			["Launch postponed", "Sun, Oct 18, 2026", null, "The school asked us."],
			["Launch Sunday set", null, "Sun, Oct 18, 2026", null],
		],
		"moves as recorded, with no rebuilt earlier state",
	);

	const workspace = (filter: string) => w.look(c.A, "launch.readWorkspace", { filter });
	const all = await workspace("all");
	const M = rowsOf(all, "milestone").find((r) => r.fields.total > 0);
	const linked = rowsOf(all, "item").filter((t) => t.fields.milestoneId === M.id);
	const [T, ...rest] = linked;
	for (const t of rest) await w.apply(c.A, "tasks.delete", { taskId: t.id });
	await w.apply(c.A, "tasks.bulkReschedule", { taskIds: [T.id], due: "2026-10-01" });
	await w.apply(c.A, "tasks.create", { title: T.label, due: "2026-10-01" });
	const U = String(
		(await w.one(sql`SELECT id FROM task WHERE plant_id=${c.P.id} AND title=${T.label} AND id<>${T.id}`)).id,
	);
	const links = async () =>
		rowsOf(await workspace("all"), "item")
			.filter((t) => t.fields.milestoneId === M.id)
			.map((t) => t.id);
	assert.deepEqual(await links(), [T.id], "M keeps its own task T; U, of the same name, is not linked");
	assert.equal(JSON.stringify(await workspace("all")).includes(U), false);
	assert.deepEqual(
		rowsOf(await workspace("blocked"), "milestone").map((m) => [m.id, m.fields.overdueTasks]),
		[[M.id, 1]],
	);
	await w.apply(c.A, "launch.completeMilestone", { milestoneId: M.id });
	const milestone = () =>
		w.one(sql`SELECT completed_at IS NOT NULL AS done,completed_by FROM launch_milestone WHERE id=${M.id}`);
	assert.deepEqual(await milestone(), { done: true, completed_by: c.A.id });
	assert.equal(
		(await w.one(sql`SELECT status FROM task WHERE id=${T.id}`)).status,
		"not_started",
		"its task stays open",
	);
	await w.apply(c.A, "launch.reopenMilestone", { milestoneId: M.id });
	assert.equal((await milestone()).done, false);
	const told = (await journal()).filter((e) => e.fields.change === "milestone");
	assert.deepEqual(
		told.map((e) => [e.fields.by, e.label.includes(M.label)]),
		[
			["Alex Admin", true],
			["Alex Admin", true],
		],
	);
	assert.deepEqual([/reopen/i.test(told[0].label), /complete/i.test(told[1].label)], [true, true], "newest first");

	await clockTo(LAUNCHED);
	const before = await counts();
	await w.apply(c.A, "launch.recordOutcome", { actualDate: "2026-10-25", attendance: 150, guestsNotNamed: 12 });
	assert.deepEqual(await launch(), {
		target: "2026-10-25",
		actual: "2026-10-25",
		status: "completed",
		attendance: 150,
		decisions: null,
	});
	assert.deepEqual(await counts(), before, "neither 150 people nor 12 unnamed guests make a Person, guest or decision");
	await w.apply(c.A, "launch.addGuestAttendance", { personId: c.rivera });
	const guests = () => w.rows(sql`SELECT person_id FROM launch_guest WHERE plant_id=${c.P.id}`);
	assert.deepEqual(
		[await guests(), (await counts()).people],
		[[{ person_id: c.rivera }], before.people],
		"one named guest",
	);
	const evidence = async () => ok(await reader.readPlan(w.db, await w.authorityOf(c.A))).plan.evidence;
	assert.equal((await evidence()).debriefDone.status, "unknown");
	await w.apply(c.A, "launch.saveDebriefDraft", { wentWell: "Half done" });
	assert.equal((await evidence()).debriefDone.status, "unknown", "a draft is no debrief");
	const debrief = await w.prepare(c.A, "launch.submitDebrief", DEBRIEF);
	assert.equal(debrief.review.refusal ?? null, null, "the missing names need no waiver");
	assert.equal((await w.approve(c.A, debrief)).outcome, "completed");
	assert.deepEqual(
		[(await evidence()).debriefDone.status, (await evidence()).guestNamesEntered],
		["met", { status: "not_met", remaining: 12 }],
	);
	const facts = async () => (await w.look(c.A, "launch.readDebrief")).facts;
	const read1 = await facts();
	assert.deepEqual(
		[
			read1.actualDate,
			read1.attendance,
			read1.decisions,
			read1.guestsNamed,
			read1.guestsNotNamed,
			read1.debriefSubmitted,
			read1.summaryPublished,
		],
		["Sun, Oct 25, 2026", 150, null, 1, 12, true, null],
	);

	const shared = async () => rowsOf(await w.look(director, "oversight.getPlant", { plantId: c.P.id }))[0].fields;
	await w.apply(c.A, "launch.saveDebriefSummaryDraft", { body: "DRAFT-CANARY words" });
	const unseen = await w.ask(director, "How did the launch go?", [
		() => read("oversight.getPlant", { plantId: c.P.id }),
	]);
	assert.equal(rowsOf(unseen.replies[0])[0].fields.publishedSummary, null);
	assert.doesNotMatch(JSON.stringify([unseen.prompts, unseen.saved]), /DRAFT-CANARY|People came/);
	const publish = await w.prepare(c.A, "launch.publishDebriefSummary", { body: "We launched with joy." });
	assert.equal((await shared()).publishedSummary, null, "its review shares nothing");
	assert.equal((await w.approve(c.A, publish)).outcome, "completed");
	assert.equal((await shared()).publishedSummary, "We launched with joy.");
	await w.admin.execute(sql`UPDATE affiliation SET shared_findings=false WHERE organization_id=${org.id}`);
	assert.doesNotMatch(JSON.stringify(await shared()), /launched with joy/);

	const material = async () =>
		Number((await w.one(sql`SELECT material_revision AS r FROM plant WHERE id=${c.P.id}`)).r);
	const dirty = await material();
	const story = await journal();
	await w.apply(c.A, "launch.correctOutcome", { attendance: 148, reason: "Recounted" });
	await w.apply(c.A, "launch.correctGuestAttendance", { personId: c.rivera, correctPersonId: c.chen });
	await w.apply(c.A, "launch.submitDebrief", { ...DEBRIEF, toChange: "More signs." });
	assert.deepEqual([(await launch()).attendance, await guests()], [148, [{ person_id: c.chen }]]);
	assert.deepEqual(
		await w.rows(
			sql`SELECT version,to_change FROM launch_debrief WHERE plant_id=${c.P.id} AND submitted_at IS NOT NULL ORDER BY version`,
		),
		[
			{ version: 1, to_change: "Signs." },
			{ version: 2, to_change: "More signs." },
		],
		"a corrected debrief keeps the first",
	);
	const longer = await journal();
	assert.deepEqual(longer.slice(-story.length), story, "corrections add to the story and rewrite none of it");
	assert.ok(longer.length >= story.length + 3);
	assert.ok(longer.some((e) => e.fields.reason === "Recounted"));
	assert.ok((await material()) > dirty, "a correction makes the affected evidence stale");
	assert.deepEqual(
		{
			now: await phase(),
			moves: await w.count(sql`SELECT count(*)::int AS n FROM phase_transition WHERE plant_id=${c.P.id}`),
		},
		phases,
		"no phase moves by itself",
	);

	const card = await w.prepare(c.A, "launch.correctOutcome", { attendance: 149, reason: "One more" });
	await c.foreignReview(card);
	await c.foreign(
		"Correct our launch outcome",
		[
			() => [read("launch.readDebrief"), read("launch.readJournal"), read("launch.readWorkspace", { filter: "all" })],
			() => propose("launch.correctOutcome", { attendance: 1, reason: "x" }),
			() => propose("launch.completeMilestone", { milestoneId: M.id }),
		],
		{ secrets: ["People came", "joy", "Recounted", "school asked"], on: { onError: "go_on" } },
	);
	await c.failedWrite(card, "launch");
	assert.equal((await launch()).attendance, 149);
});
