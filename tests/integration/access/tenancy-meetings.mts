// The meetings reads of INV-tenancy (tenancy.test.mts): church A's meetings, written through the meetings writes as its
// owner, and one case per read. `t` is the shared context the test builds in its `before`.
import assert from "node:assert/strict";
import { sql } from "../../../packages/db/src/query.ts";
import {
	attendanceReader,
	createAttendanceWriter,
	guestsWriter,
	meetingsReader,
	meetingsWriter,
	previewMeetingsWrite,
	rosterReader,
	venuesReader,
	venuesWriter,
	withMeetingsWrite,
} from "../../../packages/domain/src/meetings/index.ts";

/** The reminder sync port (WP-031) as a local fake that plans nothing: no reminder is read back here. */
export const planNoReminders = async () => {};
const attendance = createAttendanceWriter({ reminders: planNoReminders });

/** A Vision night held a month ago with a venue, guests, an RSVP, a card, attendance and an evaluation. */
export async function seedMeetings(t) {
	const { a, MARK, key, ok, occurredOn } = t;
	const meet = (body) => withMeetingsWrite(t.f.db, t.ownerA.actor, body);
	const read = (op, input) => meetingsReader[op](t.f.db, t.ownerA.actor, input);
	a.venue = ok(
		await meet((tx, c) =>
			venuesWriter.create(tx, c, {
				requestKey: key(),
				input: { name: `${MARK} hall`, address: `1 ${MARK} Way`, notes: `${MARK} venue notes` },
			}),
		),
	).venue.id;
	const schedule = async (input) =>
		ok(await meet((tx, c) => meetingsWriter.schedule(tx, c, { requestKey: key(), input: { time: "18:00", ...input } })))
			.meeting;
	const dana = await t.personA("Dana");
	a.vision = (
		await schedule({
			type: "vision_meeting",
			title: `${MARK} vision night`,
			notes: `${MARK} meeting notes`,
			date: occurredOn,
			venue: { kind: "existing", venueId: a.venue },
			guests: [a.avery, a.blair],
		})
	).id;
	ok(
		await meet((tx, c) =>
			guestsWriter.inviteGuest(tx, c, {
				requestKey: key(),
				input: { meetingId: a.vision, personId: dana.id, inviterPersonId: a.avery },
			}),
		),
	);
	// Avery is linked to church A's owner, so the owner answers as Avery.
	ok(
		await meet((tx, c) =>
			guestsWriter.saveOwnRsvp(tx, c, { requestKey: key(), input: { meetingId: a.vision, rsvp: "confirmed" } }),
		),
	);
	const blair = ok(await read("listGuests", { meetingId: a.vision })).guests.find((g) => g.person.personId === a.blair);
	ok(
		await meet((tx, c) =>
			guestsWriter.recordCard(tx, c, {
				requestKey: key(),
				expectedRevision: blair.revision,
				input: { meetingId: a.vision, personId: a.blair, response: "interested", notes: `${MARK} card notes` },
			}),
		),
	);
	const { attendanceRevision } = ok(
		await attendanceReader.listAttendance(t.f.db, t.ownerA.actor, { meetingId: a.vision }),
	);
	// Blair is a first-time Vision guest, so finalizing generates Blair's follow-up obligation (the followups seed).
	ok(
		await meet((tx, c) =>
			attendance.finalizeAttendance(tx, c, {
				requestKey: key(),
				expectedRevision: attendanceRevision,
				input: { meetingId: a.vision, attendeeIds: [a.avery, a.blair] },
			}),
		),
	);
	const score = 4;
	ok(
		await meet((tx, c) =>
			attendance.recordEvaluation(tx, c, {
				requestKey: key(),
				input: {
					meetingId: a.vision,
					scores: Object.fromEntries(
						["attendance", "location", "logistics", "agenda", "vibe", "message", "close", "nextSteps"].map((f) => [
							`${f}Score`,
							score,
						]),
					),
					notes: `${MARK} evaluation notes`,
				},
			}),
		),
	);
	a.teamMeeting = (
		await schedule({ type: "team_meeting", teamId: a.team, title: `${MARK} team night`, date: occurredOn })
	).id;
	const practice = await schedule({ type: "prelaunch_practice", title: `${MARK} practice`, date: occurredOn });
	ok(
		await meet((tx, c) =>
			meetingsWriter.completePractice(tx, c, {
				requestKey: key(),
				expectedRevision: practice.revision,
				input: { meetingId: practice.id, occurredAt: new Date(Date.now() - 86_400_000).toISOString() },
			}),
		),
	);
}

/** The meetings cases for `who`: church B's owner for the tenancy check, church A's owner for the control. */
export function meetingsCases(t, who) {
	const { a, MARK, key } = t;
	const db = t.f.db;
	const m = (name, run, expected) => [`meetings:meetingsReader.${name}`, { run, expected }];
	const at = (name, run, expected) => [`meetings:attendanceReader.${name}`, { run, expected }];
	const v = (name, run, expected) => [`meetings:venuesReader.${name}`, { run, expected }];
	const meeting = { meetingId: a.vision };
	const unavailable = { refused: "unavailable" };
	// A reply may name the meeting the caller asked for; church A's control must show more of church A than that.
	const gone = { ...unavailable, echo: [a.vision] };
	const vision = { types: ["vision_meeting"], from: null, to: null };
	// The meeting church B's preview names, read before and after: a rolled-back write leaves it as it was.
	const visionRow = async () =>
		(
			await t.rows(
				sql`SELECT title, revision::text AS revision FROM meeting WHERE id = ${a.vision} AND plant_id = ${t.plantA.id}`,
			)
		)[0];
	return [
		m("list", () => meetingsReader.list(db, who.actor, {}), { value: { items: [], page: 1, total: 0, next: null } }),
		m("get", () => meetingsReader.get(db, who.actor, meeting), { value: { status: "unavailable" }, echo: [a.vision] }),
		m("hasHistory", () => meetingsReader.hasHistory(db, who.actor, {}), {
			value: { hasHistory: false, types: [] },
			// The answer is one flag: church A's own owner sees its meetings exist.
			control: (value) => assert.deepEqual(value, { hasHistory: true, types: [] }),
		}),
		m("readAgenda", () => meetingsReader.readAgenda(db, who.actor, meeting), {
			...gone,
			// The Vision agenda's sections, as scheduling gave church A's meeting.
			control: (value) => assert.equal(value.sections[0].title, "Welcome"),
		}),
		m("listKit", () => meetingsReader.listKit(db, who.actor, meeting), gone),
		m("listGuests", () => meetingsReader.listGuests(db, who.actor, meeting), gone),
		m("listCards", () => meetingsReader.listCards(db, who.actor, meeting), gone),
		m("cardBreakdown", () => meetingsReader.cardBreakdown(db, who.actor, meeting), {
			...gone,
			// Counts only: two attended, Blair with an interested card.
			control: (value) =>
				assert.partialDeepStrictEqual(value, { attended: { total: 2, withCard: 1, responses: { interested: 1 } } }),
		}),
		m("invitationAttribution", () => meetingsReader.invitationAttribution(db, who.actor, meeting), gone),
		m("communicationContext", () => meetingsReader.communicationContext(db, who.actor, meeting), gone),
		m("listCompletedPreLaunchPractices", () => meetingsReader.listCompletedPreLaunchPractices(db, who.actor), {
			value: { meetingIds: [], count: 0, criterion: "not_met" },
		}),
		m("getOwnRsvp", () => meetingsReader.getOwnRsvp(db, who.actor, meeting), gone),

		at("listAttendance", () => attendanceReader.listAttendance(db, who.actor, meeting), gone),
		at("attendanceSummary", () => attendanceReader.attendanceSummary(db, who.actor, meeting), {
			...gone,
			// Counts only: three guests, Avery (core group) and Blair (first time) attended.
			control: (value) =>
				assert.partialDeepStrictEqual(value, {
					guests: 3,
					attended: 2,
					classifications: { first_time: 1, core_group: 1 },
				}),
		}),
		at("getEvaluation", () => attendanceReader.getEvaluation(db, who.actor, meeting), gone),
		at("evaluationHistory", () => attendanceReader.evaluationHistory(db, who.actor, meeting), gone),
		at("compareEvaluation", () => attendanceReader.compareEvaluation(db, who.actor, meeting), {
			...gone,
			// Scores only: the evaluation church A recorded.
			control: (value) => assert.deepEqual(value.current, { status: "known", value: 4 }),
		}),
		at("linkedTaskProgress", () => attendanceReader.linkedTaskProgress(db, who.actor, meeting), gone),
		at("readAnalytics", () => attendanceReader.readAnalytics(db, who.actor, meeting), gone),
		at("evaluationTrend", () => attendanceReader.evaluationTrend(db, who.actor, {}), {
			value: { window: vision, points: [] },
		}),
		at("attendanceTrend", () => attendanceReader.attendanceTrend(db, who.actor, {}), {
			value: { window: vision, points: [] },
		}),
		at("summaryStats", () => attendanceReader.summaryStats(db, who.actor, {}), {
			value: {
				window: vision,
				held: 0,
				finalized: 0,
				attendances: 0,
				uniqueAttendees: 0,
				averageAttendance: { status: "unknown" },
				firstTime: 0,
				returning: 0,
				averageEvaluation: { status: "unknown" },
			},
			// Counts only: church A's own owner counts its finalized, evaluated Vision night (the communication cases'
			// meeting row is held too, but never finalized).
			control: (value) =>
				assert.partialDeepStrictEqual(value, {
					held: 2,
					finalized: 1,
					attendances: 2,
					firstTime: 1,
					averageEvaluation: { status: "known", value: 4 },
				}),
		}),

		[
			"meetings:rosterReader.previewRosterImport",
			{
				run: () => rosterReader.previewRosterImport(db, who.actor, { meetingId: a.teamMeeting }),
				expected: { ...unavailable, echo: [a.teamMeeting] },
			},
		],
		v("list", () => venuesReader.list(db, who.actor, {}), { value: { items: [], page: 1, total: 0, next: null } }),
		v("get", () => venuesReader.get(db, who.actor, { venueId: a.venue }), {
			value: { status: "unavailable" },
			echo: [a.venue],
		}),
		v("history", () => venuesReader.history(db, who.actor, { venueId: a.venue }), {
			value: { venueId: a.venue, items: [], page: 1, next: null },
			// The answer names the venue the caller asked for.
			echo: [a.venue],
		}),

		[
			"meetings:previewMeetingsWrite",
			{
				// A meetings write run once and rolled back (C73): church B's edit of church A's meeting, then the row unchanged.
				run: async () => {
					const before = await visionRow();
					const reply = await previewMeetingsWrite(db, who.actor, (tx, c) =>
						meetingsWriter.edit(tx, c, {
							requestKey: key(),
							expectedRevision: before.revision,
							input: { meetingId: a.vision, patch: { title: `${MARK} renamed` } },
						}),
					);
					assert.deepEqual(await visionRow(), before, "previewMeetingsWrite changed church A's meeting");
					return reply;
				},
				expected: gone,
			},
		],
	];
}
