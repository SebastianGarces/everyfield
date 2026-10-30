import { correlationId, instant } from "@everyfield/contracts/common";
import * as c from "@everyfield/contracts/followups";
import type { Database } from "@everyfield/db/client";
import { sql, type SQL } from "@everyfield/db/query";
import { randomUUID } from "node:crypto";
import "server-only";
import { boundWrite, liveRead, type RequestActor } from "../access/session.ts";
import { auditSavepoint, declareWrite, nativeWrite, WriteUnavailable } from "../operations/writes.ts";
import { TaskRefusal, type Reader, type TaskContext, type Tx } from "../tasks/core.ts";

export type FollowUpReply<T> = { status: "ok"; value: T } | { status: "refused"; error: c.FollowUpError };
type Code = c.FollowUpError["code"];

/** The follow-up refusals that task refusals do not have. Task helpers keep throwing their own. */
export class FollowUpRefusal extends Error {
	readonly code: Code;
	readonly details: Record<string, unknown>;
	constructor(code: Code, details: Record<string, unknown> = {}) {
		super(code);
		this.code = code;
		this.details = details;
	}
}
export function refuse(code: Code): never {
	throw new FollowUpRefusal(code);
}
const retryOf = new Map(c.followUpError.options.map((o) => [o.shape.code.value, o.shape.retry.value]));
function refused(code: Code, details: Record<string, unknown> = {}): FollowUpReply<never> {
	return {
		status: "refused",
		error: c.followUpError.parse({
			code,
			details,
			correlationId: correlationId.parse(randomUUID()),
			retry: retryOf.get(code),
		}),
	};
}
export async function readAnswer<T>(body: () => Promise<T>): Promise<FollowUpReply<T>> {
	try {
		return { status: "ok", value: await body() };
	} catch (error) {
		if (error instanceof WriteUnavailable) return refused("unavailable");
		if (error instanceof TaskRefusal || error instanceof FollowUpRefusal) return refused(error.code, error.details);
		throw error;
	}
}
/** A tool or test caller without a bound native request gets its own savepoint, so a refusal rolls back alone. */
export async function answer<T>(tx: Tx, body: () => Promise<T>): Promise<FollowUpReply<T>> {
	if (boundWrite(tx)) return { status: "ok", value: await body() };
	return readAnswer(() => auditSavepoint(tx, body));
}
/** The native request owns rollback: bind the verified actor once, then run the command in the same transaction. */
export async function withFollowUpWrite<T>(
	db: Database,
	authority: RequestActor,
	body: (tx: Tx, context: TaskContext) => Promise<FollowUpReply<T>>,
): Promise<FollowUpReply<T>> {
	const selected = authority.actor.context.owner;
	return readAnswer(() =>
		nativeWrite(db, authority, selected, async (tx) => {
			// Every write of this module reads other rows, counts or the church's settings (C88).
			await declareWrite(tx, "established");
			const result = await body(tx, { session: authority.session, selected });
			if (result.status === "refused") throw new FollowUpRefusal(result.error.code, result.error.details);
			return result.value;
		}),
	);
}

/**
 * One read statement: the reader's live authority (C13) and the rows of `query`, numbered in `ord`. A reader whose
 * session, seat, role or lifecycle changed since the viewer lookup reads nothing.
 */
export async function gated(tx: Tx, viewer: Reader, query: SQL, admin = false) {
	const live = liveRead({ session: viewer.session, owner: viewer.owner, seatId: viewer.seatId }, admin);
	const r = await tx.execute(sql`SELECT g.live, q.* FROM (SELECT ${live} AS live) g
		LEFT JOIN LATERAL (${query}) q ON g.live ORDER BY q.ord`);
	if (r.rows[0]?.live !== true) refuse("unavailable");
	return r.rows.filter((row) => row.ord !== null);
}

export { COMMITTED, eligibleOwner, ownerView } from "../tasks/owner.ts";
/** A live top-level person follow-up task: what assignment, coverage and handoff act on. */
export const followUpTask = (t: SQL) =>
	sql`${t}.category='follow_up' AND ${t}.person_id IS NOT NULL AND ${t}.parent_id IS NULL AND ${t}.deleted_at IS NULL`;
export { originJson, originOf } from "../tasks/origin.ts";
export const OPEN = sql`('not_started','in_progress','blocked')`;

export const now = () => instant.parse(new Date().toISOString());
