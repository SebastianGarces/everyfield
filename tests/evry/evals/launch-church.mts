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
import { randomUUID } from "node:crypto";
import { sql } from "../../../packages/db/node_modules/drizzle-orm/index.js";
import type { Database } from "../../../packages/db/src/client.ts";
import { RequestActor } from "../../../packages/domain/src/access/session.ts";
import { reviewedOf } from "../../../packages/contracts/src/launch/index.ts";
import { createLaunchReader } from "../../../packages/domain/src/launch/reads.ts";
import { createLaunchWriter } from "../../../packages/domain/src/launch/writes.ts";
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
