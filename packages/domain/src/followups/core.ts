import { instant } from "@everyfield/contracts/common";
import * as c from "@everyfield/contracts/followups";
import type { Database } from "@everyfield/db/client";
import { sql, type SQL } from "@everyfield/db/query";
import "server-only";
import { boundWrite, liveRead, type RequestActor } from "../access/session.ts";
import { auditSavepoint, declareWrite, nativeWrite } from "../operations/writes.ts";
import { TaskRefusal, type Reader, type TaskContext, type Tx } from "../tasks/core.ts";
import { defineRefusals, type Deny } from "../operations/refusals.ts";

export type FollowUpReply<T> = { status: "ok"; value: T } | { status: "refused"; error: c.FollowUpError };
const refusals = defineRefusals(c.followUpError, { writeUnavailable: "unavailable" });
export const refuse: Deny<typeof c.followUpError> = refusals.deny;
export async function readAnswer<T>(body: () => Promise<T>): Promise<FollowUpReply<T>> {
	try {
		return { status: "ok", value: await body() };
	} catch (error) {
		if (error instanceof TaskRefusal) return refusals.refused(error.code, error.details);
		return refusals.refusalOf(error);
	}
}
export async function answer<T>(tx: Tx, body: () => Promise<T>): Promise<FollowUpReply<T>> {
	if (boundWrite(tx)) return { status: "ok", value: await body() };
	return readAnswer(() => auditSavepoint(tx, body));
}
export async function withFollowUpWrite<T>(
	db: Database,
	authority: RequestActor,
	body: (tx: Tx, context: TaskContext) => Promise<FollowUpReply<T>>,
): Promise<FollowUpReply<T>> {
	const selected = authority.actor.context.owner;
	return readAnswer(() =>
		nativeWrite(db, authority, selected, async (tx) => {
			await declareWrite(tx, "established");
			const result = await body(tx, { session: authority.session, selected });
			if (result.status === "refused") throw new refusals.Refusal(result.error.code, result.error.details);
			return result.value;
		}),
	);
}

export async function gated(tx: Tx, viewer: Reader, query: SQL, admin = false) {
	const live = liveRead({ session: viewer.session, owner: viewer.owner, seatId: viewer.seatId }, admin);
	const r = await tx.execute(sql`SELECT g.live, q.* FROM (SELECT ${live} AS live) g
		LEFT JOIN LATERAL (${query}) q ON g.live ORDER BY q.ord`);
	if (r.rows[0]?.live !== true) refuse("unavailable");
	return r.rows.filter((row) => row.ord !== null);
}

export const followUpTask = (t: SQL) =>
	sql`${t}.category='follow_up' AND ${t}.person_id IS NOT NULL AND ${t}.parent_id IS NULL AND ${t}.deleted_at IS NULL`;
export const OPEN = sql`('not_started','in_progress','blocked')`;

export const now = () => instant.parse(new Date().toISOString());
