import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import "../../platform/setup.mts";
import { sql } from "../../../../packages/db/src/query.ts";
import { attendanceReader, meetingsReader } from "../../../../packages/domain/src/meetings/index.ts";
import { followUpReader } from "../../../../packages/domain/src/followups/index.ts";
import { taskReader } from "../../../../packages/domain/src/tasks/index.ts";
import { dashboardReader } from "../../../../packages/domain/src/dashboard/index.ts";
import { getPlant, requestIntelligenceRefresh } from "../../../../packages/domain/src/oversight/index.ts";
import { compileOversightDigest, compilePlanterDigest } from "../../../../packages/domain/src/notifications/index.ts";
import { timeZone } from "../../../../packages/contracts/src/common/index.ts";
import { ok } from "../../../support/fixture.mts";
import { key, sorted, world, type Feature, type World } from "./corrections-world.mts";

let w: World;
before(async () => {
	w = await world("corratt");
});
after(() => w?.database.close());

test("INV-corrections: correcting one wrong attendance mark moves every count, follow-up, task, digest, dashboard, Plant Intelligence, oversight and Evry read, keeps the old mark in history and rewrites nothing sent", async () => {
	const ann = await w.committed(w.p, "Ann Adult");
	const dana = await w.person(w.p, "Dana Doe", { adultClassification: "adult", email: "dana@example.test" });
	const eli = await w.person(w.p, "Eli Eager");
	const first = await w.held(10, [ann.id, dana.id]);
	const second = await w.held(3, [ann.id, dana.id, eli.id]);
	const published = await w.publish({ personIds: [dana.id] });
	const unchanged = await w.freeze([
		"mail",
		"mail_request",
		"job",
		"notice",
		"communication",
		"assessment_run",
		"network_intelligence_run",
		"network_intelligence_plant",
		"audit_event",
	]);
	const { actor } = w.boss;
	const report = { types: ["vision_meeting"], from: null, to: null, limit: 12 };
	const names = { [first]: "first", [second]: "second" };
	const mine = async () =>
		compilePlanterDigest(w.db, {
			plant: w.p.id,
			recipient: w.boss.id,
			asOf: new Date().toISOString(),
			through: w.day(1),
		});
	const features: Feature[] = [
		{
			name: "the attendance list",
			read: async () => {
				const list = ok(await attendanceReader.listAttendance(w.db, actor, { meetingId: first, page: 1, limit: 100 }));
				return list.items.map((i) => [i.person.displayName, i.presence, i.classification]);
			},
			before: [
				["Ann Adult", "attended", "core_group"],
				["Dana Doe", "attended", "first_time"],
			],
			after: [
				["Ann Adult", "attended", "core_group"],
				["Dana Doe", "absent", null],
			],
		},
		{
			name: "the later meeting's attendance list",
			read: async () => {
				const list = ok(await attendanceReader.listAttendance(w.db, actor, { meetingId: second, page: 1, limit: 100 }));
				return list.items.map((i) => [
					i.person.displayName,
					i.presence,
					i.classification,
					i.priorVisionId && names[i.priorVisionId],
				]);
			},
			before: [
				["Ann Adult", "attended", "core_group", "first"],
				["Dana Doe", "attended", "returning", "first"],
				["Eli Eager", "attended", "first_time", null],
			],
			after: [
				["Ann Adult", "attended", "core_group", "first"],
				["Dana Doe", "attended", "first_time", null],
				["Eli Eager", "attended", "first_time", null],
			],
		},
		{
			name: "the meeting's attendance summary",
			read: async () => {
				const s = ok(await attendanceReader.attendanceSummary(w.db, actor, { meetingId: first }));
				return [s.guests, s.attended, s.absent, s.classifications];
			},
			before: [2, 2, 0, { first_time: 1, returning: 0, core_group: 1 }],
			after: [2, 1, 1, { first_time: 0, returning: 0, core_group: 1 }],
		},
		{
			name: "the meeting reports",
			read: () =>
				Promise.all(
					[first, second].map(async (meetingId) => {
						const r = ok(await attendanceReader.readAnalytics(w.db, actor, { meetingId }));
						return [r.attended, r.classifications, r.growth, r.tasks.followUps];
					}),
				),
			before: [
				[
					{ status: "known", value: 2 },
					{ first_time: 1, returning: 0, core_group: 1 },
					{ status: "unknown" },
					{ total: 2, open: 2, complete: 0, closed: 0, needsOwner: 0 },
				],
				[
					{ status: "known", value: 3 },
					{ first_time: 1, returning: 1, core_group: 1 },
					{ status: "known", difference: 1, percent: 50 },
					{ total: 1, open: 1, complete: 0, closed: 0, needsOwner: 0 },
				],
			],
			after: [
				[
					{ status: "known", value: 1 },
					{ first_time: 0, returning: 0, core_group: 1 },
					{ status: "unknown" },
					{ total: 2, open: 1, complete: 0, closed: 1, needsOwner: 0 },
				],
				[
					{ status: "known", value: 3 },
					{ first_time: 2, returning: 0, core_group: 1 },
					{ status: "known", difference: 2, percent: 200 },
					{ total: 2, open: 2, complete: 0, closed: 0, needsOwner: 1 },
				],
			],
		},
		{
			name: "the cards of attended guests",
			read: async () => {
				const b = ok(await meetingsReader.cardBreakdown(w.db, actor, { meetingId: first }));
				return [b.attended.total, b.attended.unknown];
			},
			before: [2, 2],
			after: [1, 1],
		},
		{
			name: "the attendance trend",
			read: async () => {
				const t = ok(await attendanceReader.attendanceTrend(w.db, actor, report));
				return t.points.map((x) => [names[x.meetingId], x.attended, x.classifications, x.growth]);
			},
			before: [
				["first", 2, { first_time: 1, returning: 0, core_group: 1 }, { status: "unknown" }],
				["second", 3, { first_time: 1, returning: 1, core_group: 1 }, { status: "known", difference: 1, percent: 50 }],
			],
			after: [
				["first", 1, { first_time: 0, returning: 0, core_group: 1 }, { status: "unknown" }],
				["second", 3, { first_time: 2, returning: 0, core_group: 1 }, { status: "known", difference: 2, percent: 200 }],
			],
		},
		{
			name: "the meeting statistics",
			read: async () => {
				const s = ok(await attendanceReader.summaryStats(w.db, actor, report));
				return [s.held, s.attendances, s.uniqueAttendees, s.averageAttendance, s.firstTime, s.returning];
			},
			before: [2, 5, 3, { status: "known", value: 2.5 }, 2, 1],
			after: [2, 4, 3, { status: "known", value: 2 }, 2, 0],
		},
		{
			name: "the follow-ups",
			read: async () => {
				const r = ok(await w.read(followUpReader.readObligations, { page: 1, limit: 100 }));
				return r.items
					.filter((i) => i.kind === "first_vision_follow_up")
					.map((i) => [i.person?.label, names[i.meeting!.id], i.state, i.owners.map((o) => o.displayName)])
					.sort((a, b) => String(a).localeCompare(String(b)));
			},
			before: [
				["Ann Adult", "first", "open", ["Adam Admin"]],
				["Dana Doe", "first", "open", ["Adam Admin"]],
				["Eli Eager", "second", "open", ["Adam Admin"]],
			],
			after: [
				["Ann Adult", "first", "open", ["Adam Admin"]],
				["Dana Doe", "first", "no_longer_needed", ["Adam Admin"]],
				["Dana Doe", "second", "open", []],
				["Eli Eager", "second", "open", ["Adam Admin"]],
			],
		},
		{
			name: "the follow-up coverage",
			read: async () => {
				const r = ok(await w.read(followUpReader.followUpCoverage, { page: 1, limit: 100 }));
				return r.items.map((i) => [
					i.person.label,
					i.coverage,
					i.duties.map((d) => d.owners.map((o) => o.displayName)),
				]);
			},
			before: [
				["Ann Adult", "owned", [["Adam Admin"]]],
				["Dana Doe", "owned", [["Adam Admin"]]],
				["Eli Eager", "owned", [["Adam Admin"]]],
			],
			after: [
				["Dana Doe", "needs_owner", [[]]],
				["Ann Adult", "owned", [["Adam Admin"]]],
				["Eli Eager", "owned", [["Adam Admin"]]],
			],
		},
		{
			name: "the open tasks",
			read: async () => {
				const r = ok(await w.read(taskReader.count, {}));
				return r;
			},
			before: {
				topLevelTotal: 5,
				byStatus: [{ value: "not_started", count: 5 }],
				byPriority: [{ value: "medium", count: 5 }],
				byCategory: [
					{ value: "follow_up", count: 3 },
					{ value: "vision_meeting", count: 2 },
				],
				childTaskTotal: 0,
				childTaskComplete: 0,
				completeness: "complete",
			},
			after: {
				topLevelTotal: 6,
				byStatus: [
					{ value: "no_longer_needed", count: 1 },
					{ value: "not_started", count: 5 },
				],
				byPriority: [{ value: "medium", count: 6 }],
				byCategory: [
					{ value: "follow_up", count: 4 },
					{ value: "vision_meeting", count: 2 },
				],
				childTaskTotal: 0,
				childTaskComplete: 0,
				completeness: "complete",
			},
		},
		{
			name: "the church digest",
			read: async () => (await mine()).lines,
			before: [
				{ kind: "task", date: w.day(-8), title: "Follow up with Ann Adult" },
				{ kind: "task", date: w.day(-8), title: "Follow up with Dana Doe" },
				{ kind: "task", date: w.day(-1), title: "Follow up with Eli Eager" },
			],
			after: [
				{ kind: "task", date: w.day(-8), title: "Follow up with Ann Adult" },
				{ kind: "task", date: w.day(-1), title: "Follow up with Eli Eager" },
			],
		},
		{
			name: "the oversight digest's activity",
			read: async () =>
				(
					await compileOversightDigest(w.db, {
						organization: w.org.id,
						recipient: w.org.director.id,
						start: w.day(-1),
						end: w.day(1),
						zone: timeZone.parse("America/Chicago"),
					})
				).total,
			before: 17,
			after: 19,
		},
		{
			name: "the dashboard counts",
			read: async () => ok(await dashboardReader.readMetrics(w.db, actor)),
			before: { recruited: 1, people: 4, myOverdueTasks: 3, visionMeetings: 2 },
			after: { recruited: 1, people: 4, myOverdueTasks: 2, visionMeetings: 2 },
		},
		{
			name: "the dashboard activity",
			read: async () =>
				ok(await dashboardReader.readActivity(w.db, actor)).entries.flatMap((e) =>
					e.change.kind === "attendance_corrected" ? [[names[e.change.meetingId], e.actor?.displayName]] : [],
				),
			before: [],
			after: [["first", "Adam Admin"]],
		},
		{
			name: "the oversight meeting and task counts",
			read: async () => {
				const v = (await getPlant(w.db, w.director, w.p.id))!;
				return [v.sections.meetings, v.sections.tasks];
			},
			before: [
				{
					status: "shared",
					counts: {
						meetings: [
							{ date: w.day(-10), attended: 2 },
							{ date: w.day(-3), attended: 3 },
						],
						averageDaysBetween: 7,
						attendedTotal: 5,
					},
				},
				{ status: "shared", counts: { open: 5, overdue: 5 } },
			],
			after: [
				{
					status: "shared",
					counts: {
						meetings: [
							{ date: w.day(-10), attended: 1 },
							{ date: w.day(-3), attended: 3 },
						],
						averageDaysBetween: 7,
						attendedTotal: 4,
					},
				},
				{ status: "shared", counts: { open: 5, overdue: 5 } },
			],
		},
		{
			name: "Plant Intelligence facts",
			read: async () => {
				const f = await w.factsNow();
				return [f.vision.lastAttendance, f.followUps];
			},
			before: [
				[3, 2],
				{
					status: "measured",
					onTime: 0,
					measured: 3,
					noLongerNeeded: 0,
					pending: 0,
					unmeasured: 0,
					contacted: 0,
					total: 3,
				},
			],
			after: [
				[3, 1],
				{
					status: "measured",
					onTime: 0,
					measured: 3,
					noLongerNeeded: 1,
					pending: 0,
					unmeasured: 0,
					contacted: 0,
					total: 4,
				},
			],
		},
		{
			name: "Plant Intelligence freshness",
			read: async () => (await w.stale()) === published.run.runId,
			before: false,
			after: true,
		},
		{
			name: "Network Intelligence after its next run",
			read: async () => {
				const runId = key();
				ok(await requestIntelligenceRefresh(w.db, w.director, { runId }));
				return w.rows(
					sql`SELECT overdue_followups AS overdue,unowned_followups AS unowned FROM network_intelligence_plant WHERE run_id=${runId}`,
				);
			},
			before: [{ overdue: 3, unowned: 0 }],
			after: [{ overdue: 3, unowned: 1 }],
		},
		{
			name: "Evry: the meeting's attendance",
			read: () => w.shown("meetings.listAttendance", { meetingId: first }, ["presence", "visit"]),
			before: [
				["Attendance", null, null],
				["Ann Adult", "attended", "core group"],
				["Dana Doe", "attended", "first time"],
			],
			after: [
				["Attendance", null, null],
				["Ann Adult", "attended", "core group"],
				["Dana Doe", "absent", null],
			],
		},
		{
			name: "Evry: the meeting report and statistics",
			read: async () => [
				...(await w.shown("meetings.attendanceSummary", { meetingId: first }, ["attended", "absent", "firstTime"])),
				...(await w.shown("meetings.readAnalytics", { meetingId: second }, [
					"attended",
					"firstTime",
					"returning",
					"growth",
				])),
				...(await w.shown("meetings.attendanceTrend", {}, ["attended", "firstTime", "returning"])),
				...(await w.shown("meetings.summaryStats", {}, ["attendances", "averageAttendance", "returning"])),
				...(await w.shown("meetings.cardBreakdown", { meetingId: first }, ["attended", "noCard"])),
				...(await w.shown("meetings.linkedTaskProgress", { meetingId: first }, ["open"])),
			],
			before: [
				["Attendance summary", "2", "0", "1"],
				["Meeting report", "3", "1", "1", "1"],
				["Vision Meeting #1", "2", "1", "0"],
				["Vision Meeting #2", "3", "1", "1"],
				["Meetings summary", "5", "2.5", "1"],
				["Cards from attended guests", "2", "2"],
				["Cards from guests who did not attend", null, null],
				["Meeting tasks", "2"],
			],
			after: [
				["Attendance summary", "1", "1", "0"],
				["Meeting report", "3", "2", "0", "2"],
				["Vision Meeting #1", "1", "0", "0"],
				["Vision Meeting #2", "3", "2", "0"],
				["Meetings summary", "4", "2", "0"],
				["Cards from attended guests", "1", "1"],
				["Cards from guests who did not attend", null, null],
				["Meeting tasks", "1"],
			],
		},
		{
			name: "Evry: the follow-ups and tasks",
			read: async () => [
				...sorted(
					await w.shown("followups.readObligations", { personId: dana.id }, ["meetingDate", "state", "owners"]),
				),
				...sorted(await w.shown("tasks.followUpCoverage", {}, ["coverage", "owners"])),
				...sorted(await w.shown("tasks.list", {}, ["due", "owners"])),
				...sorted(await w.shown("tasks.count", {}, ["count"])),
			],
			before: [
				["Dana Doe", w.day(-10), "open", "you"],
				["Ann Adult", "owned", "you"],
				["Dana Doe", "owned", "you"],
				["Eli Eager", "owned", "you"],
				["Evaluate Vision Meeting #1", w.day(-8), null],
				["Evaluate Vision Meeting #2", w.day(-1), null],
				["Follow up with Ann Adult", w.day(-8), "you"],
				["Follow up with Dana Doe", w.day(-8), "you"],
				["Follow up with Eli Eager", w.day(-1), "you"],
				["checklist rows", 0],
				["not_started", 5],
			],
			after: [
				["Dana Doe", w.day(-10), "no_longer_needed", "you"],
				["Dana Doe", w.day(-3), "open", null],
				["Ann Adult", "owned", "you"],
				["Dana Doe", "needs_owner", null],
				["Eli Eager", "owned", "you"],
				["Evaluate Vision Meeting #1", w.day(-8), null],
				["Evaluate Vision Meeting #2", w.day(-1), null],
				["Follow up with Ann Adult", w.day(-8), "you"],
				["Follow up with Dana Doe", w.day(-1), null],
				["Follow up with Eli Eager", w.day(-1), "you"],
				["checklist rows", 0],
				["no_longer_needed", 1],
				["not_started", 5],
			],
		},
		{
			name: "Evry: the dashboard and oversight",
			read: async () => [
				...(await w.shown("dashboard.metrics", {}, ["count"])),
				...(await w.shown("oversight.getPlant", { plantId: w.p.id }, ["meetings", "tasks"], w.director)),
			],
			before: [
				["Recruited", 1],
				["People", 4],
				["My overdue tasks", 3],
				["Vision Meetings", 2],
				["Grace Harbor", "2 recent meetings, 5 attended", "5 open, 5 overdue"],
			],
			after: [
				["Recruited", 1],
				["People", 4],
				["My overdue tasks", 2],
				["Vision Meetings", 2],
				["Grace Harbor", "2 recent meetings, 4 attended", "5 open, 5 overdue"],
			],
		},
	];
	await w.check(features, "before");

	const correction = {
		requestKey: key(),
		expectedRevision: await w.revision("meeting", first, "attendance_revision"),
		input: {
			meetingId: first,
			attendeeIds: [ann.id],
			followUpAssigneeIds: [w.boss.id],
			reason: "Dana was not there",
		},
	};
	ok(await w.meeting(w.attendance.reconcileAttendance, correction));

	await w.check(features, "after");
	assert.deepEqual(await w.auditOf(sql`subject_id=${first} AND action='meetings.finalized' AND kind='reconcile'`), [
		{
			actor_id: w.boss.id,
			before: { attendeeIds: [ann.id, dana.id].sort() },
			after: { attendeeIds: [ann.id] },
			reason: "Dana was not there",
			recent: true,
		},
	]);
	await unchanged();
	assert.deepEqual(
		await w.rows(
			sql`SELECT overdue_followups AS overdue,unowned_followups AS unowned FROM network_intelligence_plant
				WHERE run_id=${published.networkRunId}`,
		),
		[{ overdue: 3, unowned: 0 }],
	);
});
