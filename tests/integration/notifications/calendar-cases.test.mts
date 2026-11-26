import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
	localDate,
	localDateTime,
	localDayBounds,
	resolveCalendar,
	timeZone,
} from "../../../packages/contracts/src/common/index.ts";
import { sql } from "../../../packages/db/src/query.ts";
import { claimDue } from "../../../packages/domain/src/jobs/queue.ts";
import { meetingsWriter } from "../../../packages/domain/src/meetings/index.ts";
import { ok, refused } from "../../support/fixture.mts";
import { recorded, untouched } from "../../support/recorded.mts";
import { caseOf, casesWorld, command, day, iso, type Case, type CasesWorld } from "./cases-world.mts";

let w: CasesWorld;
before(async () => {
	w = await casesWorld("calendar_cases", "2026-01-15T16:00:00Z");
});
after(() => w?.close());

const steps = (c: Case) => [c, ...(c.subcases ?? [])];

test("AC:B03-002 a spring and an autumn clock-change day end at the next church midnight, 23 and 25 hours after they start, and the stored date stays", async () => {
	for (const { clock, action, expected } of steps(caseOf("B03-002"))) {
		const { date, zone } = action.arguments;
		const bounds = localDayBounds(localDate.parse(date), timeZone.parse(zone));
		assert.deepEqual(
			{ day_hours: (Date.parse(bounds.end) - Date.parse(bounds.start)) / 3_600_000, next_midnight: bounds.end },
			{ ...expected.result, next_midnight: iso(expected.result.next_midnight) },
		);
		await w.at(clock.now);
		const t = await w.task(w.adminActor, { title: `Due ${date}`, due: day(date) });
		const midnight = Date.parse(expected.result.next_midnight);
		for (const [asOf, overdue] of [
			[midnight - 1, false],
			[midnight, true],
		] as const) {
			const read = async () => {
				const at = new Date(asOf).toISOString();
				const got = ok(await w.read(w.adminActor, "get", { taskId: t.id, asOf: at }));
				const listed = ok(await w.read(w.adminActor, "list", { asOf: at, limit: 100 })).items.find(
					(i) => i.id === t.id,
				);
				assert.ok(got.status === "available" && listed);
				assert.deepEqual(got.task.due, day(date));
				return [got.task.overdue, listed.overdue];
			};
			assert.deepEqual(await untouched(w.admin, read), [overdue, overdue], `${date} at ${asOf}`);
		}
		assert.deepEqual(await w.rows(sql`SELECT due_kind,due_date::text,due_at,timezone FROM task WHERE id=${t.id}`), [
			{ due_kind: "date_only", due_date: date, due_at: null, timezone: null },
		]);
	}
});

test("AC:B03-010 an automatic reminder at a skipped time moves forward by the gap and one at a repeated time takes the first, each once for its recipient however often it runs", async () => {
	for (const { given, action, expected } of steps(caseOf("B03-010"))) {
		const { local_datetime: local, zone } = action.arguments;
		const gap = local.startsWith("2026-03");
		const wall = localDateTime.parse(local);
		const resolved = resolveCalendar(wall, timeZone.parse(zone), "automatic");
		assert.ok(resolved.kind === "resolved");
		assert.deepEqual(
			[resolved.occurrence.instant, resolved.resolverVersion, resolved.adjustmentSeconds],
			[iso(expected.result.instant), 1, gap ? 3600 : 0],
		);

		await w.at(gap ? "2026-02-20T16:00:00Z" : "2026-10-13T16:00:00Z");
		const [date, time] = [gap ? "2026-03-15" : "2026-11-08", local.slice(11, 16)];
		const request = { requestKey: randomUUID(), input: { type: "orientation", date, time, guests: [] } };
		const m = ok(await w.meetings(meetingsWriter.schedule, request)).meeting;
		const replay = () => w.meetings(meetingsWriter.schedule, request);
		assert.deepEqual(ok(await untouched(w.admin, replay)).meeting, m);
		const weekBefore = () =>
			w.rows<{ at: string; state: string }>(
				sql`SELECT to_char(eligible_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"') AS at, state FROM job
					WHERE kind='notification' AND subject_record_id=${m.id} AND producer_key LIKE 'meeting/day_7/%'`,
			);
		assert.deepEqual(await weekBefore(), [{ at: expected.result.instant, state: "ready" }]);
		assert.equal((await weekBefore()).length, expected.result.logical_occurrences);

		const entered = { requestKey: randomUUID(), input: { type: "orientation", date: local.slice(0, 10), time } };
		const refusal = refused(
			await untouched(w.admin, () => w.meetings(meetingsWriter.schedule, entered)),
			gap ? "nonexistent_local_time" : "ambiguous_local_time",
		);
		assert.equal(refusal.details.choices?.length ?? 0, gap ? 0 : 2, "an entered time still needs a person's choice");

		const reminders = () =>
			w.rows(sql`SELECT n.recipient_id AS recipient, m.state FROM notice n LEFT JOIN mail m ON m.notice_id=n.id
				WHERE n.source_record_id=${m.id} AND n.purpose='meeting_reminder'`);
		await w.tick(new Date(Date.parse(expected.result.instant) - 1000).toISOString());
		assert.deepEqual(await reminders(), [], "nothing before the resolved instant");
		const repeats = 1 + (given.execution.repeat as number);
		for (let i = 0; i < repeats; i++) await w.tick(expected.result.instant);
		if (!gap) await w.tick("2026-11-01T07:30:00Z");
		const sent = w.outbox.filter((p) => p.to === w.adminActor.email);
		assert.deepEqual(await reminders(), [{ recipient: w.adminActor.id, state: "accepted" }]);
		assert.equal(sent.length, expected.result.logical_occurrences);
		w.outbox.length = 0;
		ok(await w.meetings(meetingsWriter.changeStatus, command({ meetingId: m.id, to: "cancelled" }, m.revision)));
	}
});

test("AC:B03-018 a church zone change moves a reminder that is waiting, never sends a delivered one again, and a repeated request or sweep adds nothing", async () => {
	const c = caseOf("B03-018");
	const { timezone } = c.action.arguments;
	assert.deepEqual(
		[c.given["zone-preview"].current_zone, c.given["zone-preview"].new_zone],
		["America/Chicago", timezone],
	);
	await w.at("2026-10-12T16:00:00Z");
	const assigneeIds = [w.adminActor.id];
	const t = await w.task(w.adminActor, { title: "T", assigneeIds, due: day("2026-10-13") });
	const later = await w.task(w.adminActor, { title: "Later", assigneeIds, due: day("2026-11-05") });
	const timed = await w.task(w.adminActor, {
		title: "Timed",
		assigneeIds,
		due: { kind: "resolved_instant", local: "2026-11-05T10:00:00" },
	});
	await w.tick("2026-10-13T14:00:00Z");
	const stored = (task: string) =>
		w.rows<{
			id: string;
			kind: string;
			at: string;
			state: string;
			job_state: string;
			cancelled: Date | null;
		}>(sql`SELECT n.id, split_part(n.logical_key,'/',2) AS kind, m.id AS mail, j.id AS job, m.state, j.state AS job_state,
			n.cancelled_at AS cancelled, n.schedule_date::text AS date, n.timezone AS zone, (j.eligible_at=n.eligible_at) AS together,
			to_char(n.eligible_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"') AS at
			FROM notice n JOIN mail m ON m.notice_id=n.id JOIN job j ON j.id=m.job_id WHERE n.source_record_id=${task} ORDER BY n.eligible_at`);
	const before = { t: await stored(t.id), later: await stored(later.id), timed: await stored(timed.id) };
	assert.deepEqual(
		before.t.map((n) => [n.kind, n.at, n.state, n.job_state]),
		[
			["task_due", "2026-10-13T14:00:00Z", "accepted", "succeeded"],
			["task_overdue", "2026-10-14T14:00:00Z", "pending", "ready"],
		],
		"one slot is delivered and one is pending",
	);

	await w.at(c.clock.now);
	const preview = await w.previewZone(timezone);
	const request = command(
		{ plant: w.plant, timeZone: timezone, previewId: preview.previewId },
		preview.expectedRevision,
	);
	const { value, added } = await recorded(w.admin, () => w.setZone(request));
	assert.equal(ok(value).status, "changed");
	assert.deepEqual(added, { audits: ["plant.profile_changed"], jobs: ["digest"], notices: 0, mail: 0 });
	const replayed = await untouched(w.admin, () => w.setZone(request));
	assert.deepEqual(replayed, value, "a request whose answer was lost changes nothing more");

	const [deliveredOne, pendingOne] = await stored(t.id);
	assert.deepEqual(deliveredOne, before.t[0], "the delivered slot is left as it was");
	assert.deepEqual(pendingOne, { ...before.t[1], at: "2026-10-13T20:00:00Z", zone: timezone });
	assert.deepEqual(await stored(later.id), [
		{ ...before.later[0], at: "2026-11-04T20:00:00Z", zone: timezone },
		{ ...before.later[1], at: "2026-11-05T20:00:00Z", zone: timezone },
	]);
	assert.deepEqual(await stored(timed.id), before.timed, "a timed deadline keeps its instant");
	const shown = preview.reminders.filter((r) => r.id === t.id || r.id === later.id);
	assert.equal(shown.length, 3);
	for (const slot of shown) {
		const now = [...(await stored(t.id)), ...(await stored(later.id))].map((n) => iso(n.at));
		assert.ok(now.includes(slot.after) && !now.includes(slot.before), "each reminder moved as the preview showed");
	}

	const subjects = () => w.outbox.map((p) => p.subject).filter((s) => /: T$/.test(s));
	assert.deepEqual(subjects(), ["Task due: T"]);
	await w.tick(c.clock.now);
	await w.tick("2026-10-13T19:59:59Z");
	assert.deepEqual(subjects(), ["Task due: T"]);
	for (const at of ["2026-10-13T20:00:00Z", "2026-10-13T20:00:00Z", "2026-10-14T14:00:00Z", "2026-10-15T14:00:00Z"])
		await w.tick(at);
	assert.deepEqual(subjects(), ["Task due: T", "Task overdue: T"]);
	const [delivered] = await stored(t.id);
	assert.deepEqual(
		{
			"pending-1": pendingOne!.id === before.t[1]!.id ? "replanned" : null,
			"delivered-1": delivered!.id === before.t[0]!.id ? "delivered" : null,
			delivered_resends: subjects().filter((s) => s === "Task due: T").length - 1,
		},
		c.expected.result,
	);
	await w.change(w.adminActor, "edit", later, { patch: { title: "Later, renamed" } });
	assert.deepEqual(
		(await stored(later.id)).filter((n) => !n.cancelled).map((n) => n.at),
		["2026-11-04T20:00:00Z", "2026-11-05T20:00:00Z"],
		"a later edit plans the same moved times",
	);
	const back = await w.previewZone("America/Chicago");
	ok(
		await w.setZone(
			command({ plant: w.plant, timeZone: "America/Chicago", previewId: back.previewId }, back.expectedRevision),
		),
	);
	await w.change(w.adminActor, "changeStatus", { ...later, revision: "2" }, { status: "no_longer_needed" });
	await w.change(w.adminActor, "changeStatus", timed, { status: "no_longer_needed" });
	await w.change(w.adminActor, "changeStatus", t, { status: "no_longer_needed" });
});

test("AC:CASE-NTF-005 a reassigned, rescheduled and then completed task sends none of its claimed old reminders, and its new ones keep 09:00 over the clock change", async () => {
	await w.at(caseOf("CASE-NTF-005").clock.now);
	w.outbox.length = 0;
	const due = day("2026-10-14");
	const t = await w.task(w.adminActor, { title: "Moved", assigneeIds: [w.adminActor.id], due });
	await w.at("2026-10-14T14:00:00Z");
	const old = await claimDue(w.db, ["mail"], 100);
	assert.equal(old.length, 1);
	const moved = await w.change(w.adminActor, "edit", t, {
		patch: { assigneeIds: [w.member.id], due: day("2026-11-01") },
	});
	for (const claim of old) await w.mail.dispatch(claim);
	assert.deepEqual(w.outbox, [], "the claimed old reminder is not sent");
	assert.deepEqual(await w.reminders(t.id), [
		[w.member.id, "task_due", "2026-11-01T15:00:00Z", "pending"],
		[w.member.id, "task_overdue", "2026-11-02T15:00:00Z", "pending"],
		[w.adminActor.id, "task_due", "2026-10-14T14:00:00Z", "cancelled (withdrawn)"],
		[w.adminActor.id, "task_overdue", "2026-10-15T14:00:00Z", "cancelled (withdrawn)"],
	]);
	await w.at("2026-11-01T14:59:59Z");
	assert.deepEqual(await claimDue(w.db, ["mail"], 100), []);
	await w.at("2026-11-01T15:00:00Z");
	const claims = await claimDue(w.db, ["mail"], 100);
	assert.equal(claims.length, 1);
	await w.change(w.member, "complete", moved);
	for (const claim of claims) await w.mail.dispatch(claim);
	for (const at of ["2026-11-01T15:00:00Z", "2026-11-02T15:00:00Z"]) await w.tick(at);
	assert.deepEqual(w.outbox, []);
	assert.equal(
		(await w.reminders(t.id)).every((n) => n[3] === "cancelled (withdrawn)"),
		true,
	);
});

async function digestChurch(cadence: "daily" | "weekly", start: string) {
	await w.at(start);
	const church = await w.newPlant({ name: `Harvest ${randomUUID().slice(0, 6)}`, digest_weekday: 0, digest_hour: 16 });
	const planter = await w.seated(church, "admin");
	const other = await w.seated(church, "owner");
	ok(
		await w.feed.setDigestCadence(
			w.db,
			planter.actor,
			command({ plantId: church.id, cadence }, await w.revisionOf(planter.id)),
		),
	);
	const titles = (title: string, who: { id: string }, due: string) =>
		w.task(planter, { title, assigneeIds: [who.id], due: day(due) });
	await titles("T1", planter, "2026-10-13");
	const t2 = await titles("T2", planter, "2026-10-10");
	await titles("T3", other, "2026-10-13");
	await w.change(planter, "complete", t2);
	const cursor = () =>
		w.rows<{ id: string; through: string }>(
			sql`SELECT id,covered_through::text AS through,cadence FROM digest_coverage WHERE recipient_id=${planter.id}`,
		);
	const digests = async () =>
		(
			await w.rows<{ title: string; body: string; state: string; key: string }>(
				sql`SELECT n.title,n.safe_body AS body,m.state,n.logical_key AS key FROM notice n JOIN mail m ON m.notice_id=n.id
					WHERE n.recipient_id=${planter.id} AND n.purpose='planter_digest' ORDER BY n.created_at`,
			)
		).map((d) => ({
			title: d.title,
			state: d.state,
			period: d.key.split("/").slice(3).join(" "),
			items: [...d.body.matchAll(/(?:due|on) \w{3} \d+, \d{4}: ([^.]+)\./g)].map((m) => m[1]),
		}));
	const mailed = () => w.outbox.filter((p) => p.to === planter.email && p.subject.startsWith("Church digest"));
	return { church, planter, other, cursor, digests, mailed };
}

test("AC:CASE-NTF-005 AC:NOTIFY47-006 after three missed daily slots one digest lists the open task once, with no message for a missed day, and a shared plant's dated activity reaches its organization once", async () => {
	for (const id of ["CASE-NTF-005", "NOTIFY47-006"]) {
		const c = caseOf(id);
		const cursor = c.given["digest-cursor"];
		const missed: string[] = c.given["behavior-inputs"]?.missed_periods ?? c.given.input.missed_dates;
		w.outbox.length = 0;
		const d = await digestChurch(cursor.cadence, "2026-10-09T16:00:00Z");
		await w.tick("2026-10-09T21:30:00Z");
		const [started] = await d.cursor();
		assert.equal(started!.through, cursor.last_period);
		const network = await w.organization("sending_network", `Network ${id}`);
		const overseer = await w.seated(network, "owner");
		const quiet = await w.newPlant({ name: "Unshared Church" });
		await w.affiliate(d.church.id, network.id, true);
		await w.affiliate(quiet.id, network.id, false);
		await w.tick("2026-10-10T12:30:00Z");
		for (const date of missed)
			for (const plant of [d.church.id, quiet.id])
				await w.admin
					.execute(sql`INSERT INTO audit_event(tenant_id,actor_token,action,kind,subject_type,subject_id,occurred_at)
					VALUES(${plant},'synthetic','people.updated','edit','record',${plant},${`${date}T17:00:00Z`}::timestamptz)`);
		await w.admin
			.execute(sql`INSERT INTO meeting(plant_id,type,title,local_date,local_time,timezone,starts_at,resolver_version,status,attendance_revision)
			VALUES(${d.church.id},'orientation','Cancelled night','2026-10-13','19:00','America/Chicago','2026-10-14T00:00:00Z','1','cancelled',1)`);
		w.outbox.length = 0;

		await w.tick(c.clock.now);
		const [digest, ...rest] = await d.digests();
		const { digest_count, catchup_messages, stale_day_messages, stale_daily_mail_count, open_items, open_tasks } =
			c.expected.result;
		assert.deepEqual(rest, []);
		assert.deepEqual(digest, {
			title: "Church digest: 1 open item, Oct 10, 2026 to Oct 12, 2026",
			state: "accepted",
			period: `${missed[0]} ${missed.at(-1)}`,
			items: open_items ?? open_tasks,
		});
		assert.equal(d.mailed().length, catchup_messages ?? digest_count);
		for (const word of ["T2", "T3", "Cancelled night"]) assert.equal(d.mailed()[0]!.text.includes(word), false, word);
		const stale = (await d.digests()).filter((x) => missed.some((date) => x.period === `${date} ${date}`));
		assert.equal(stale.length, stale_day_messages ?? stale_daily_mail_count);
		assert.deepEqual(await d.cursor(), [{ ...started, through: "2026-10-12" }]);
		const activity = await w.rows(
			sql`SELECT safe_body AS body FROM notice WHERE recipient_id=${overseer.id} AND purpose='oversight_digest'`,
		);
		const name = String((await w.one(sql`SELECT name FROM plant WHERE id=${d.church.id}`)).name);
		assert.equal(activity.length, 1);
		const lines = String(activity[0]!.body);
		assert.equal(lines.includes("Unshared Church"), false);
		for (const date of ["Oct 10, 2026", "Oct 11, 2026", "Oct 12, 2026"])
			assert.equal(lines.split(`${name}: 1 activity on ${date}.`).length, 2, lines);

		for (let i = 0; i < 2; i++) await w.tick();
		assert.deepEqual([(await d.digests()).length, d.mailed().length], [1, 1]);
		assert.deepEqual((await w.rows(sql`SELECT id FROM notice WHERE recipient_id=${overseer.id}`)).length, 1);
		await w.admin.execute(sql`UPDATE plant SET digest_cadence='off' WHERE id=${d.church.id}`);
	}
});

test("AC:CASE-NTF-007 a weekly Sunday 16:00 digest missed twice comes once with the planter's open task only, keeps its cursor, and stays at 16:00 church time over the clock change", async () => {
	const c = caseOf("CASE-NTF-007");
	const cursorIn = c.given["digest-cursor"];
	const { catchup_digests, included_tasks, other_assignee_tasks, stale_daily_digests, cursor_retained } =
		c.expected.result;
	for (const through of ["2026-09-27", cursorIn.last_period as string]) {
		w.outbox.length = 0;
		const d = await digestChurch(cursorIn.cadence, "2026-09-27T16:00:00Z");
		await w.tick("2026-09-27T21:00:00Z");
		const [started] = await d.cursor();
		assert.equal(started!.through, "2026-09-27");
		if (through !== started!.through)
			await w.admin.execute(sql`UPDATE digest_coverage SET covered_through=${through}::date WHERE id=${started!.id}`);
		w.outbox.length = 0;

		await w.tick(c.clock.now);
		const [digest, ...rest] = await d.digests();
		assert.deepEqual(rest, []);
		assert.equal(d.mailed().length, catchup_digests);
		assert.equal(digest!.state, "accepted");
		assert.deepEqual(digest!.items, included_tasks);
		const start = through === "2026-09-27" ? "2026-09-28" : "2026-10-10";
		assert.equal(digest!.period, `${start} 2026-10-11`);
		for (const date of c.given["case-input"].missed_dates)
			assert.equal((await d.digests()).filter((x) => x.period.startsWith(date)).length, stale_daily_digests, date);
		const others = ["T2", "T3"].filter((title) => d.mailed()[0]!.text.includes(`: ${title}.`));
		assert.deepEqual(others, other_assignee_tasks);
		const [kept, ...more] = await d.cursor();
		assert.deepEqual(more, []);
		assert.equal(kept!.id === started!.id, cursor_retained);
		assert.deepEqual(kept, { ...started, through: "2026-10-11" });
		await w.tick();
		assert.deepEqual(await d.cursor(), [kept]);
		assert.equal(d.mailed().length, catchup_digests);

		for (const [early, at, sent] of [
			["2026-10-18T20:59:59Z", "2026-10-18T21:00:00Z", 2],
			["2026-10-25T20:59:59Z", "2026-10-25T21:00:00Z", 3],
			["2026-11-01T21:59:59Z", "2026-11-01T22:00:00Z", 4],
		] as const) {
			await w.tick(early);
			assert.equal(d.mailed().length, sent - 1, early);
			await w.tick(at);
			assert.equal(d.mailed().length, sent, at);
		}
		assert.equal((await d.cursor())[0]!.through, "2026-11-01");
		await w.admin.execute(sql`UPDATE plant SET digest_cadence='off' WHERE id=${d.church.id}`);
	}
});
