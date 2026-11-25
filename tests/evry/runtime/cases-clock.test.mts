import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { RequestActor } from "../../../packages/domain/src/access/session.ts";
import { gatedTransaction } from "../../../packages/domain/src/operations/writes.ts";
import { meetingsReader, meetingsWriter, withMeetingsWrite } from "../../../packages/domain/src/meetings/index.ts";
import { createTaskWriter, taskReader, withTaskWrite } from "../../../packages/domain/src/tasks/index.ts";
import { nativePorts } from "../evals/settings-ports.mts";
import { ok, refused } from "../../support/fixture.mts";
import { withSettingsWrite } from "../../../packages/domain/src/settings/index.ts";
import {
	caseWorld,
	NOW,
	proposes,
	reads,
	rowsOf,
	sql,
	type CaseWorld,
	type Church,
	type Play,
	type Reply,
} from "./case-world.mts";

let w: CaseWorld;
before(async () => {
	w = await caseWorld("caseclock", { native: nativePorts() });
});
after(() => w?.close());

const authorityOf = async (c: Church) => {
	const authority = await RequestActor.resolve(w.db, c.A.session);
	assert.ok(authority instanceof RequestActor);
	return authority;
};
const schedule = async (c: Church, input: object): Promise<Reply> =>
	withMeetingsWrite(w.db, await authorityOf(c), (tx, ctx) =>
		meetingsWriter.schedule(tx, ctx, { requestKey: randomUUID(), input: { type: "orientation", ...input } }),
	);
const createTask = async (c: Church, local: string, offsetSeconds?: number): Promise<Reply> =>
	withTaskWrite(w.db, await authorityOf(c), (tx, ctx) =>
		createTaskWriter({ reminders: async () => undefined as never }).create(tx, ctx, {
			requestKey: randomUUID(),
			input: {
				title: "Call",
				due: { kind: "resolved_instant", local, ...(offsetSeconds !== undefined && { offsetSeconds }) },
			},
		}),
	);
const meetingOf = async (c: Church, meetingId: string): Promise<Reply> =>
	(ok(await meetingsReader.get(w.db, await authorityOf(c), { meetingId })) as Reply).meeting;
const appointments = () =>
	w.one(sql`SELECT (SELECT count(*)::int FROM meeting) AS meetings,(SELECT count(*)::int FROM task) AS tasks`);
const instant = (at: string) => new Date(at).toISOString().replace(".000", "");
const resolve = (date: string, time: string, offset?: string) =>
	reads("calendar.resolve", { date, time, ...(offset && { offset }) });
const fieldsOf = (reply: Reply) => rowsOf(reply)[0].fields;
const SPLIT = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})/;
const split = (local: string) => SPLIT.exec(local)!.slice(1, 3) as [string, string];

test("AC:B03-008 a time the clocks skip is refused by name in the native and the Evry meeting and task forms, with nothing saved", async () => {
	const c = await w.church();
	const before = await appointments();
	const [date, time] = split("2026-03-08T02:30:00");
	const native = [await schedule(c, { date, time }), await createTask(c, "2026-03-08T02:30:00")];
	for (const reply of native) refused(reply, "nonexistent_local_time");
	for (const step of [
		proposes("meetings.schedule", { type: "orientation", date, time }),
		proposes("tasks.create", { title: "Call", due: `${date}T${time}` }),
	]) {
		const asked = await w.ask(c.A, "Schedule it March 8 at 2:30am", [resolve(date, time), step], { onError: "go_on" });
		assert.equal(fieldsOf(asked.replies[0]).status, "nonexistent");
		const [card] = asked.proposals;
		if (card) {
			const { review, outcome } = card.review.refusal
				? { review: card, outcome: "refused" }
				: await w.approve(c.A, card);
			assert.equal(outcome, "refused");
			assert.match(
				JSON.stringify([review.review.refusal, review.receipt]),
				/nonexistent_local_time|That time does not exist on that day/,
			);
		} else assert.ok(asked.replies.at(-1).error, JSON.stringify(asked.replies));
	}
	assert.deepEqual(await appointments(), before);
});

test("AC:B03-009 a time that happens twice offers both instants, needs one chosen, and each chosen one round-trips", async () => {
	const c = await w.church();
	const [date, time] = split("2026-11-01T01:30:00");
	const expected = ["2026-11-01T06:30:00Z", "2026-11-01T07:30:00Z"];
	for (const reply of [await schedule(c, { date, time }), await createTask(c, "2026-11-01T01:30:00")])
		assert.deepEqual(
			refused(reply, "ambiguous_local_time").details.choices.map((x: Reply) => instant(x.instant)),
			expected,
		);
	const asked = await w.ask(c.A, "Nov 1 at 1:30am", [
		resolve(date, time),
		(r) =>
			["option1Offset", "option2Offset"].map((k) => ({
				tool: "calendar_read",
				input: { operation: "calendar.resolve", input: { date, time, offset: fieldsOf(r[0])[k] } },
			})),
	]);
	assert.deepEqual(
		[fieldsOf(asked.replies[0]).option1Offset, fieldsOf(asked.replies[0]).option2Offset],
		["-05:00", "-06:00"],
	);
	assert.deepEqual(
		asked.replies.slice(1).map((r) => instant(fieldsOf(r).instant)),
		expected,
	);
	for (const [n, offsetSeconds] of [-18_000, -21_600].entries()) {
		const { meeting } = ok(await schedule(c, { date, time, offsetSeconds })) as Reply;
		const { task } = ok(await createTask(c, "2026-11-01T01:30:00", offsetSeconds)) as Reply;
		const saved = await meetingOf(c, meeting.id);
		const held = (
			ok(
				await gatedTransaction(w.db, async (tx) => taskReader.get(tx, await authorityOf(c), { taskId: task.id })),
			) as Reply
		).task;
		assert.deepEqual(
			[instant(saved.startsAt), saved.localTime, instant(held.due.instant ?? held.due.at)],
			[expected[n], "01:30", expected[n]],
		);
	}
});

test("AC:B03-016 changing the church's zone keeps a one-time meeting's instant, natively and through Evry, and moving it is its own review", async () => {
	const said = "Change our time zone to Pacific/Auckland";
	for (const mode of ["native", "Evry"] as const) {
		const c = await w.church();
		const { meeting } = ok(await schedule(c, { date: "2026-10-20", time: "10:00" })) as Reply;
		assert.equal(instant(meeting.startsAt), "2026-10-20T15:00:00Z");
		const revision = async () => (await w.one(sql`SELECT revision::text AS r FROM meeting WHERE id=${meeting.id}`)).r;
		const held = await revision();
		if (mode === "native") {
			const authority = await authorityOf(c);
			const plant = { kind: "plant" as const, id: c.P.id };
			const context = { session: c.A.session, selected: plant } as never;
			const preview = ok(
				await withSettingsWrite(w.db, authority, context, (tx) =>
					w.ports!.settings.previewPlantTimezone(tx, context, { plant, timeZone: "Pacific/Auckland" } as never),
				),
			) as Reply;
			ok(
				await withSettingsWrite(w.db, authority, context, (tx) =>
					w.ports!.settings.setPlantTimezone(tx, context, {
						requestKey: randomUUID(),
						expectedRevision: preview.expectedRevision,
						input: { plant, timeZone: "Pacific/Auckland", previewId: preview.previewId },
					} as never),
				),
			);
		} else {
			const asked = await w.ask(c.A, said, [proposes("plant.setTimezone", { timeZone: "Pacific/Auckland" })]);
			assert.ok(asked.proposals[0], JSON.stringify(asked.replies));
			const done = await w.approve(c.A, asked.proposals[0]);
			assert.equal(done.review.outcome, "completed", JSON.stringify(done.review.receipt));
		}
		assert.equal((await w.one(sql`SELECT timezone FROM plant WHERE id=${c.P.id}`)).timezone, "Pacific/Auckland");
		const after = await meetingOf(c, meeting.id);
		assert.deepEqual(
			[instant(after.startsAt), await revision()],
			["2026-10-20T15:00:00Z", held],
			"no appointment edit",
		);
		const edit = await w.ask(c.A, "Move that meeting to 9am on October 21", [
			proposes("meetings.edit", { meetingId: meeting.id, date: "2026-10-21", time: "09:00" }),
		]);
		assert.equal(edit.proposals[0]!.status, "pending");
		assert.equal(instant((await meetingOf(c, meeting.id)).startsAt), "2026-10-20T15:00:00Z");
		await w.approve(c.A, edit.proposals[0]!);
		assert.equal(instant((await meetingOf(c, meeting.id)).startsAt), "2026-10-21T14:00:00Z");
	}
});

test("AC:B03-036 native and Evry resolve the same repeated time alike, a review of an older state is refused, and no private operation is offered", async () => {
	const c = await w.church();
	const [date, time] = split("2026-11-01T01:30:00");
	const { meeting } = ok(await schedule(c, { date, time, offsetSeconds: -21_600 })) as Reply;
	const asked = await w.ask(c.A, "Nov 1 at 1:30am, the second one", [resolve(date, time, "-06:00")]);
	assert.deepEqual(
		[instant(meeting.startsAt), instant(fieldsOf(asked.replies[0]).instant)],
		["2026-11-01T07:30:00Z", "2026-11-01T07:30:00Z"],
	);
	const review = await w.ask(c.A, "Rename it", [
		proposes("meetings.edit", { meetingId: meeting.id, title: "Renamed" }),
	]);
	assert.deepEqual(
		[review.proposals[0]!.status, (await meetingOf(c, meeting.id)).title ?? null],
		["pending", meeting.title ?? null],
	);
	await w.admin.execute(sql`UPDATE meeting SET revision=revision+1 WHERE id=${meeting.id}`);
	const stale = await w.approve(c.A, review.proposals[0]!);
	assert.deepEqual([stale.outcome, stale.review.status, stale.review.outcome], ["reviewing", "pending", null]);
	assert.notEqual(stale.review.digest, review.proposals[0]!.digest, "a new exact review replaces the stale one");
	const { task } = ok(await createTask(c, "2026-11-01T01:30:00", -21_600)) as Reply;
	const ticked = await w.ask(c.A, "Complete it", [proposes("tasks.complete", { taskId: task.id })]);
	await w.admin.execute(sql`UPDATE task SET revision=revision+1 WHERE id=${task.id}`);
	const old = await w.approve(c.A, ticked.proposals[0]!);
	assert.deepEqual([old.review.outcome, old.review.receipt?.code], ["refused", "revision_conflict"]);
	assert.equal((await w.one(sql`SELECT status FROM task WHERE id=${task.id}`)).status, "not_started");
	assert.equal((await meetingOf(c, meeting.id)).title ?? null, meeting.title ?? null);
	assert.deepEqual(
		asked.offered.filter((o) => /care|private|personalCalendar|weekly/i.test(o)),
		[],
	);
});

test("AC:GAP-EVR-424 the trusted clock and the church's zone give the date and the saved phase, and an organization context is not the church's", async () => {
	await w.at("2026-09-20T00:30:00Z");
	try {
		const c = await w.church({ timezone: "America/New_York", phase: 3 });
		const said = "Read current context and compare Today";
		const play: Play = [reads("calendar.getContext"), reads("wiki.reading.stats", {})];
		const asked = await w.quiet(() => w.ask(c.A, said, play));
		assert.deepEqual(
			[fieldsOf(asked.replies[0]).today, fieldsOf(asked.replies[0]).weekday, fieldsOf(asked.replies[0]).zone],
			["2026-09-19", "Saturday", "America/New_York"],
		);
		assert.match(asked.prompts.at(-1)!, /Current time \(trusted server clock\): 2026-09-20T00:30:/);
		assert.equal(asked.replies[1].facts.churchPhase, 3);
		assert.deepEqual([asked.replies[1].facts.discoveryTotal, asked.replies[1].facts.discoveryComplete], [0, false]);
		const org = await w.organization("sending_church", { name: "Grace Network" });
		const member = await w.seated(org, "owner");
		const theirs = await w.quiet(() => w.ask(member, said, play));
		assert.equal(theirs.offered.includes("calendar.getContext"), false);
		assert.deepEqual(theirs.cards, []);
		await c.foreign(said, [reads("calendar.getContext")], { found: ["Today in America/New_York"] });
		await c.outage(said, play, "plant");
	} finally {
		await w.at(NOW);
	}
});

test("AC:GAP-EVR-425 a skipped time asks for a valid one and a repeated time gives both choices, resolved only by the chosen one", async () => {
	const c = await w.church({ timezone: "America/New_York" });
	const said = "Resolve both user expressions and choose explicit second fold";
	const gap = split("2027-03-14T02:30:00");
	const fold = split("2026-11-01T01:30:00");
	const play: Play = [
		() =>
			[gap, fold].map(([date, time]) => ({
				tool: "calendar_read",
				input: { operation: "calendar.resolve", input: { date, time } },
			})),
		(r) =>
			["option1Offset", "option2Offset"].map((k) => ({
				tool: "calendar_read",
				input: { operation: "calendar.resolve", input: { date: fold[0], time: fold[1], offset: fieldsOf(r[1])[k] } },
			})),
	];
	const asked = await w.quiet(() => w.ask(c.A, said, play));
	const [skipped, twice, first, second] = asked.replies.map(fieldsOf);
	assert.deepEqual([skipped.status, skipped.instant, skipped.clocksSkipMinutes], ["nonexistent", undefined, "60"]);
	assert.deepEqual(
		[twice.status, twice.instant, twice.option1, twice.option2],
		["ambiguous", undefined, "Sun, Nov 1, 2026, 1:30 AM EDT", "Sun, Nov 1, 2026, 1:30 AM EST"],
	);
	assert.deepEqual([instant(first.instant), instant(second.instant)], ["2026-11-01T05:30:00Z", "2026-11-01T06:30:00Z"]);
	assert.match(
		asked.prompts.at(-1)!,
		/if it is ambiguous, ask which of the two times the user means, naming both; if it does not exist that day, say so and ask for another time/,
	);
	await c.foreign(said, play, {
		found: ["2027-03-14T02:30", "2026-11-01T01:30", "2026-11-01T01:30", "2026-11-01T01:30"],
	});
	await c.outage(said, play, "plant");
});

test("AC:INH-REGRESSION-DST-FOLD a 1:30am that happens twice is one clarification naming both instants, with none chosen and no meeting", async () => {
	const c = await w.church({ timezone: "America/New_York" });
	const said = "Schedule orientation November 1, 2026 at 1:30am.";
	const [date, time] = split("2026-11-01T01:30:00");
	const before = await appointments();
	const asked = await w.quiet(() => w.ask(c.A, said, [resolve(date, time)]));
	assert.equal(asked.cards.length, 1, "one clarification");
	const found = fieldsOf(asked.replies[0]);
	assert.deepEqual([found.status, found.instant ?? null], ["ambiguous", null]);
	const choices = await Promise.all(
		[found.option1Offset, found.option2Offset].map(async (offset) => instant(`${date}T${time}:00${offset}`)),
	);
	assert.deepEqual(choices, ["2026-11-01T05:30:00Z", "2026-11-01T06:30:00Z"]);
	const pushed = await w.ask(c.A, said, [proposes("meetings.schedule", { type: "orientation", date, time })]);
	const [card] = pushed.proposals;
	if (card) assert.ok(card.review.refusal, "an unresolved time is never an approvable review");
	else assert.ok(pushed.replies[0].error);
	assert.deepEqual(await appointments(), before);
	await c.foreign(said, [resolve(date, time)], { found: ["2026-11-01T01:30"] });
	await c.outage(said, [resolve(date, time)], "plant");
});

test("AC:INH-REGRESSION-DST-GAP a 2:30am the clocks skip is one clarification with no valid instant, and nothing is written until a real time is reviewed", async () => {
	const c = await w.church({ timezone: "America/New_York" });
	const said = "Schedule orientation March 14, 2027 at 2:30am.";
	const [date, time] = split("2027-03-14T02:30:00");
	const before = await appointments();
	const asked = await w.quiet(() => w.ask(c.A, said, [resolve(date, time)]));
	assert.equal(asked.cards.length, 1, "one clarification");
	const found = fieldsOf(asked.replies[0]);
	assert.deepEqual(
		[found.status, found.local, Object.keys(found).filter((k) => /instant|option/.test(k))],
		["nonexistent", "2027-03-14T02:30", []],
	);
	const pushed = await w.ask(c.A, said, [proposes("meetings.schedule", { type: "orientation", date, time })]);
	const [card] = pushed.proposals;
	if (card) assert.ok(card.review.refusal, "a skipped time is never an approvable review");
	else assert.ok(pushed.replies[0].error);
	assert.deepEqual(await appointments(), before);
	const real = await w.ask(c.A, "Then 3:30am", [
		proposes("meetings.schedule", { type: "orientation", date, time: "03:30" }),
	]);
	assert.deepEqual([real.proposals[0]!.status, await appointments()], ["pending", before], "a review first");
	await c.foreign(said, [resolve(date, time)], { found: ["2027-03-14T02:30"] });
	await c.outage(said, [resolve(date, time)], "plant");
});
