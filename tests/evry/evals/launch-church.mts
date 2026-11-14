// The Launch fixture (WP-075, WP-076), the acceptance fixture for the Launch evals, on Hope Fellowship (golden-church.mts,
// America/Chicago): Owner Nate Ellis, Admin Lena Park and Member Priya Shah. Every Launch change is made by the native
// Launch writer the Launch plan calls, as the Owner, and the dates are relative to the church-local date the Launch
// read returns today (`TODAY`): the Launch read counts from the server's clock, as the Launch plan does. The steps run
// in the order the eval's cases need them:
//
// - `scheduled`: Launch Sunday set to TODAY+35 a month ago, then moved to TODAY+28 three days ago ("The school asked us
//   to start a week earlier."), four milestones marked complete, so five stay open. "Send the press release to local
//   media", a prep task linked to "Promotion plan implemented", is two days overdue, and an ordinary task with similar
//   wording, "Send a press release to local media outlets", linked to no milestone, is three days overdue.
//   Launch team holds 14 people: the golden church's two (Mark and Jen Thompson) and 12 more prospects moved there.
// - `launched`: Launch Sunday set again to TODAY-2, before Launch Sunday's outcome is recorded through Evry.
// - `guests`: three first-time guests named on the Launch plan by typed name (each a new Person, as natively).
// - `milestones` (T-382): "Worship Center secured and rehearsed in", the venue milestone, reopened on the Launch plan,
//   with two more linked prep tasks so it has four, and its first two completed in Tasks: two of four stay open.
// - `needsReview` (T-382): the Admin completes the venue milestone on the Launch plan, and then the Owner reopens a task
//   that was complete then in Tasks, so the Launch plan shows "Needs review".
import { randomUUID } from "node:crypto";
import { sql } from "../../../packages/db/node_modules/drizzle-orm/index.js";
import type { Database } from "../../../packages/db/src/client.ts";
import { RequestActor } from "../../../packages/domain/src/access/session.ts";
import { reviewedOf } from "../../../packages/contracts/src/launch/index.ts";
import { createLaunchReader } from "../../../packages/domain/src/launch/reads.ts";
import { createLaunchWriter } from "../../../packages/domain/src/launch/writes.ts";
import { createTaskWriter, withTaskWrite } from "../../../packages/domain/src/tasks/index.ts";
import { ACTOR_SPECS, PLANT, type ActorName } from "./golden-church.mts";

export const ZONE = "America/Chicago";
/** The church-local date today, as the Launch read computes it from the server's clock. */
export const today = () =>
	new Intl.DateTimeFormat("en-CA", { timeZone: ZONE, year: "numeric", month: "2-digit", day: "2-digit" }).format(
		new Date(),
	);
/** The church-local date `n` days from today. */
export const day = (n: number) =>
	new Date(Date.parse(`${today()}T12:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const dayFormat = new Intl.DateTimeFormat("en-US", {
	weekday: "short",
	month: "short",
	day: "numeric",
	year: "numeric",
	timeZone: "UTC",
});
/** A church-local date as the Launch plan and the review cards say it: "Tue, Nov 10, 2026". */
export const said = (d: string) => dayFormat.format(new Date(`${d}T12:00:00Z`));

export type LaunchName = "owner" | "admin" | "member";
export const sessionOf = (who: LaunchName) => ACTOR_SPECS[who as ActorName].session;
export const authorityOf = (db: Database, who: LaunchName) =>
	RequestActor.resolve(db, sessionOf(who) as never) as Promise<RequestActor>;

export const reader = createLaunchReader();
export const writer = createLaunchWriter({ notices: async () => undefined });
export const MOVE_REASON = "The school asked us to start a week earlier.";
export const LINKED_TASK = "Send the press release to local media";
export const UNLINKED_TASK = "Send a press release to local media outlets";
/** The four milestones marked complete before the evals ask; the other five stay open. */
export const COMPLETED = [
	"operations.equipment_on_site",
	"operations.worship_center",
	"launch_team.prayer_and_fasting",
	"promotion.plan",
] as const;
export const GUESTS = ["Maya Brooks", "Owen Price", "Ruth Kim"] as const;
/** The venue milestone (T-382) and its four linked prep tasks: the Playbook's two and the two the fixture adds. */
export const VENUE = "operations.worship_center";
export const VENUE_TITLE = "Worship Center secured and rehearsed in";
export const VENUE_TASKS = [
	"Confirm the Worship Center booking",
	"Schedule three uses of the room before Launch Sunday",
	"Walk the room with the set-up team",
	"Rehearse the Launch Sunday service in the room",
] as const;

function ok<T>(reply: { status: string; value?: T; error?: unknown }): T {
	if (reply.status !== "ok") throw Error(`launch fixture refused: ${JSON.stringify(reply.error)}`);
	return reply.value as T;
}
export const planOf = async (db: Database, who: LaunchName = "owner") =>
	ok(await reader.readPlan(db, await authorityOf(db, who))).plan;

/**
 * Dates the newest Launch date row back by `days` from the server's clock, the one the Launch read counts from (the eval
 * database's own clock is pinned to the golden NOW), as if it was made then.
 */
async function backdate(admin: Database, days: number) {
	const at = new Date(Date.now() - days * 86_400_000).toISOString();
	await admin.execute(sql`UPDATE audit_event SET occurred_at=${at}::timestamptz,recorded_at=${at}::timestamptz
		WHERE id=(SELECT id FROM audit_event WHERE tenant_id=${PLANT} AND action='launch.changed'
			AND subject_type='launch' ORDER BY recorded_at DESC LIMIT 1)`);
}

export async function seedScheduled(admin: Database, db: Database) {
	const owner = await authorityOf(db, "owner");
	const first = await planOf(db);
	ok(
		await writer.schedule(db, owner, {
			requestKey: randomUUID(),
			expectedRevision: first.revision,
			input: { date: day(35), reason: null },
		}),
	);
	await backdate(admin, 30);
	const set = await planOf(db);
	ok(
		await writer.schedule(db, owner, {
			requestKey: randomUUID(),
			expectedRevision: set.launch!.revision,
			input: { date: day(28), reason: MOVE_REASON },
		}),
	);
	await backdate(admin, 3);
	for (const key of COMPLETED) {
		const m = (await planOf(db)).milestones.find((x) => x.templateKey === key)!;
		ok(
			await writer.completeMilestone(db, owner, {
				requestKey: randomUUID(),
				expectedRevision: m.revision,
				input: { milestoneId: m.id, reviewed: reviewedOf(m.tasks) },
			}),
		);
	}
	await admin.execute(sql`UPDATE task SET due_kind='date_only',due_date=${day(-2)}::date
		WHERE plant_id=${PLANT} AND title=${LINKED_TASK} AND launch_task_key IS NOT NULL`);
	await admin.execute(sql`INSERT INTO task(id,plant_id,title,category,priority,status,creator_id,created_at,due_kind,due_date)
		VALUES(${randomUUID()},${PLANT},${UNLINKED_TASK},'general','medium','not_started',${ACTOR_SPECS.owner.account},
			clock_timestamp()-interval '10 days','date_only',${day(-3)}::date)`);
	// Twelve more people in Launch team, beside Mark and Jen Thompson: 14 in all.
	await admin.execute(sql`UPDATE person SET stage='launch_team' WHERE id IN (SELECT id FROM person
		WHERE plant_id=${PLANT} AND state='live' AND stage='prospect' ORDER BY display_name,id LIMIT 12)`);
}

/** Launch Sunday set again to two days ago, so its outcome can be recorded. */
export async function seedLaunched(db: Database) {
	const plan = await planOf(db);
	ok(
		await writer.schedule(db, await authorityOf(db, "owner"), {
			requestKey: randomUUID(),
			expectedRevision: plan.launch!.revision,
			input: { date: day(-2), reason: "The new venue is ready." },
		}),
	);
}

/** Three first-time guests named on the Launch plan by typed name. */
export async function seedGuests(db: Database) {
	const owner = await authorityOf(db, "owner");
	for (const displayName of GUESTS)
		ok(await writer.addGuestAttendance(db, owner, { requestKey: randomUUID(), input: { displayName } }));
}

/** Launch Sunday recorded on the Launch plan, as the Owner records it there: for reads that need an outcome. */
export async function seedOutcome(db: Database, attendance: number) {
	const plan = await planOf(db);
	ok(
		await writer.recordOutcome(db, await authorityOf(db, "owner"), {
			requestKey: randomUUID(),
			expectedRevision: plan.launch!.revision,
			input: { actualDate: plan.launch!.targetDate!, attendance, decisions: null, note: null },
		}),
	);
}

export const venueOf = async (db: Database) => (await planOf(db)).milestones.find((m) => m.templateKey === VENUE)!;
const tasks = createTaskWriter({ reminders: async () => undefined });
/** A venue prep task completed or reopened in Tasks, as `who`, by its place (0 to 3). */
export async function setVenueTask(db: Database, who: LaunchName, n: number, op: "complete" | "reopen") {
	const t = (await venueOf(db)).tasks.find((x) => x.title === VENUE_TASKS[n])!;
	ok(
		await withTaskWrite(db, await authorityOf(db, who), (tx, ctx) =>
			tasks[op](tx, ctx, { requestKey: randomUUID(), expectedRevision: t.revision, input: { taskId: t.id } }),
		),
	);
}
/** The venue milestone completed or reopened on the Launch plan, as `who`. */
export async function setVenue(db: Database, who: LaunchName, op: "complete" | "reopen") {
	const m = await venueOf(db);
	const authority = await authorityOf(db, who);
	const q = { requestKey: randomUUID(), expectedRevision: m.revision };
	ok(
		op === "complete"
			? await writer.completeMilestone(db, authority, {
					...q,
					input: { milestoneId: m.id, reviewed: reviewedOf(m.tasks) },
				})
			: await writer.reopenMilestone(db, authority, { ...q, input: { milestoneId: m.id } }),
	);
}

/** The venue milestone open with four linked prep tasks, the first two complete. */
export async function seedMilestones(admin: Database, db: Database) {
	await setVenue(db, "owner", "reopen");
	await admin.execute(sql`INSERT INTO task(plant_id,title,description,category,priority,status,creator_id,created_at,due_kind,launch_task_key)
		SELECT ${PLANT}::uuid,r.title,'Launch readiness: part of the "Worship Center secured and rehearsed in" milestone on the Launch plan.',
			'launch_prep','medium','not_started',${ACTOR_SPECS.owner.account}::uuid,clock_timestamp(),'undated',r.key
		FROM (VALUES (${VENUE_TASKS[2]},${`${VENUE}/3`}),(${VENUE_TASKS[3]},${`${VENUE}/4`})) r(title,key)`);
	await setVenueTask(db, "owner", 0, "complete");
	await setVenueTask(db, "owner", 1, "complete");
}

/** The Admin completes the venue milestone on the Launch plan; the Owner then reopens a task that was complete then. */
export async function seedNeedsReview(db: Database) {
	await setVenue(db, "admin", "complete");
	await setVenueTask(db, "owner", 0, "reopen");
}
