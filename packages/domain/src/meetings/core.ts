import { requestIdentity, sameOwner, type Owner, type sessionId } from "@everyfield/contracts/common";
import { meetingsError, type MeetingsError, type MeetingsReply } from "@everyfield/contracts/meetings";
import type { Database, Transaction } from "@everyfield/db/client";
import { eq, sql, type SQL } from "@everyfield/db/query";
import * as tables from "@everyfield/db/tables";
import { randomUUID } from "node:crypto";
import { hash } from "../operations/canonical.ts";
import "server-only";
import { z } from "zod";
import { boundWrite, liveRead, RequestActor, type requestWrite } from "../access/session.ts";
import {
	auditSavepoint,
	declareWrite,
	lockedWrite,
	nativeWrite,
	finishAudit,
	prepareWrite,
	WriteUnavailable,
	type AuditWrite,
} from "../operations/writes.ts";

export type Tx = Transaction;
/** A pool or a transaction: every read is one statement. */
export type Reader = Pick<Transaction, "execute">;
export type MeetingsContext = { session: z.infer<typeof sessionId>; selected: Owner };

type Code = MeetingsError["code"];
export class Refusal extends Error {
	readonly code: Code;
	readonly details: object;
	constructor(code: Code, details: object) {
		super(code);
		this.code = code;
		this.details = details;
	}
}
/** Refuse the operation. The reply parses the code and details against the contract's closed error union. */
export function deny(code: Code = "unavailable", details: object = {}): never {
	throw new Refusal(code, details);
}
function refused(error: Refusal): MeetingsReply<never> {
	return {
		status: "refused",
		error: meetingsError.parse({
			code: error.code,
			details: error.details,
			correlationId: randomUUID(),
			retry: error.code === "conflict" ? "refresh" : error.code === "required_write_failed" ? "same_request" : "never",
		}),
	};
}
async function settle<T>(body: () => Promise<T>): Promise<MeetingsReply<T>> {
	try {
		return { status: "ok", value: await body() };
	} catch (error) {
		if (error instanceof WriteUnavailable) return refused(new Refusal("unavailable", {}));
		if (error instanceof Refusal) return refused(error);
		throw error;
	}
}
/** A PostgreSQL error (SQLSTATE) under a write's rolled-back transaction or savepoint. */
const databaseError = z.object({ cause: z.object({ code: z.string().regex(/^[0-9A-Z]{5}$/) }) });
/**
 * A write's reply: as settle, and a database failure of a required write (an insert, an update or its audit row) is
 * required_write_failed after its transaction or savepoint rolled back, so nothing of the command remains.
 */
async function settleWrite<T>(body: () => Promise<T>): Promise<MeetingsReply<T>> {
	try {
		return await settle(body);
	} catch (error) {
		if (databaseError.safeParse(error).success) return refused(new Refusal("required_write_failed", {}));
		throw error;
	}
}
/** Parse a request at the boundary; every problem is named in the refusal. */
export function parse<S extends z.ZodType>(schema: S, raw: unknown): z.output<S> {
	const r = schema.safeParse(raw);
	if (r.success) return r.data;
	deny("invalid_input", {
		issues: r.error.issues
			.slice(0, 50)
			.map((i) => ({ path: i.path.join(".").slice(0, 200), problem: i.message.slice(0, 200) })),
	});
}

/** Inside a native request the request transaction owns rollback; a direct caller gets a savepoint per command. */
export async function reply<T>(tx: Tx, body: () => Promise<T>): Promise<MeetingsReply<T>> {
	if (boundWrite(tx)) return { status: "ok", value: await body() };
	return settleWrite(() => auditSavepoint(tx, body));
}
/** One native write: bind the request actor (one locking statement), run the command, roll back on refusal. */
export async function withMeetingsWrite<T>(
	db: Database,
	authority: RequestActor,
	body: (tx: Tx, context: MeetingsContext) => Promise<MeetingsReply<T>>,
): Promise<MeetingsReply<T>> {
	const selected = authority.actor.context.owner;
	return settleWrite(() =>
		nativeWrite(db, authority, selected, async (tx) => {
			// Every write of this module reads other rows, counts or the church's settings (C88).
			await declareWrite(tx, "established");
			const result = await body(tx, { session: authority.session, selected });
			if (result.status === "refused") throw new Refusal(result.error.code, result.error.details);
			return result.value;
		}),
	);
}
/** Carries a previewed write's answer out of its transaction, so the transaction rolls back. */
class Preview extends Error {
	constructor(readonly value: unknown) {
		super("preview");
	}
}
/**
 * One meetings write run once and rolled back: the answer the same command gives now, with nothing saved (C73). The
 * request actor binds in one transaction as in withMeetingsWrite's established run; no first attempt runs it again.
 */
export async function previewMeetingsWrite<T>(
	db: Database,
	authority: RequestActor,
	body: (tx: Tx, context: MeetingsContext) => Promise<MeetingsReply<T>>,
): Promise<MeetingsReply<T>> {
	const selected = authority.actor.context.owner;
	return settleWrite(() =>
		db
			.transaction(async (tx) => {
				if (!(await authority.bind(tx, selected))) throw new WriteUnavailable();
				const result = await body(tx, { session: authority.session, selected });
				if (result.status === "refused") throw new Refusal(result.error.code, result.error.details);
				throw new Preview(result.value);
			})
			.catch((error: unknown) => {
				if (error instanceof Preview) return error.value as T;
				throw error;
			}),
	);
}
/**
 * A read names its actor from the request's verified viewer; no statement re-resolves the session. That lookup proves
 * nothing about access when a later statement runs, so each statement goes through `one` (C13).
 */
export async function read<T>(
	authority: RequestActor,
	body: (viewer: Viewer) => Promise<T>,
): Promise<MeetingsReply<T>> {
	return settle(() => {
		const actor = authority.actor;
		if (actor.context.kind !== "seat" || actor.context.owner.kind !== "plant") deny();
		return body({
			plantId: actor.context.owner.id,
			accountId: actor.accountId,
			access: { session: authority.session, owner: actor.context.owner, seatId: actor.context.seatId },
		});
	});
}
export type Viewer = { plantId: string; accountId: string; access: Parameters<typeof liveRead>[0] };
/**
 * One statement of a tenant read: the first row of `query`, returned only while the reader's session, seat, role
 * (Owner or Admin when `admin`) and lifecycle are live in that same statement (C13, C27). A reader who lost access
 * reads nothing. `admin` is the live role, which decides what a privileged field shows; `row` is undefined when the
 * query finds nothing.
 */
export async function one(db: Reader, v: Viewer, query: SQL, admin = false) {
	const r = await db.execute(sql`SELECT a.access_live, a.access_admin, q.* FROM (SELECT ${liveRead(v.access, admin)}
		AS access_live, ${liveRead(v.access, true)} AS access_admin) a
		LEFT JOIN LATERAL (SELECT true AS access_found, x.* FROM (${query}) x LIMIT 1) q ON a.access_live`);
	const row = r.rows[0] as Record<string, unknown>;
	if (row.access_live !== true) deny();
	return { row: row.access_found === true ? row : undefined, admin: row.access_admin === true };
}

export type Writer = {
	accountId: string;
	admin: boolean;
	plant: NonNullable<NonNullable<ReturnType<typeof requestWrite>>["plant"]>;
};
/** The locked request actor for this plant: bound by the native request, or claimed here by a direct caller. */
export async function writer(tx: Tx, ctx: MeetingsContext): Promise<Writer> {
	let bound = await lockedWrite(tx);
	if (!bound || bound.authority.session !== ctx.session || !sameOwner(bound.selected, ctx.selected))
		bound = (await RequestActor.claimWrite(tx, ctx.session, ctx.selected)) ?? undefined;
	if (!bound?.plant || bound.actor.context.kind !== "seat") deny();
	return { accountId: bound.actor.accountId, admin: bound.actor.context.role !== "member", plant: bound.plant };
}

export { hash };
type AuditInsert = typeof tables.audit_event.$inferInsert;
export type Change<T> = {
	value: T;
	subject: string;
	subjectType: "meeting" | "venue" | "participation" | "person";
	action: NonNullable<AuditInsert["action"]>;
	kind: NonNullable<AuditInsert["kind"]>;
	outcome?: "changed" | "noop";
	before?: Record<string, unknown> | null;
	after?: Record<string, unknown> | null;
	/** The subject's revisions, when a reader orders its history by them: a Person's history needs both. */
	revision?: { before: string | null; after: string };
	reason?: string | null;
	meetingId?: string;
	metadata?: Record<string, unknown>;
};
/** The fields that differ, with their before and after values. */
export function delta(before: Record<string, unknown> | null, after: Record<string, unknown> | null) {
	const keys = [...new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})])].filter(
		(k) => JSON.stringify(before?.[k]) !== JSON.stringify(after?.[k]),
	);
	return {
		before: before ? Object.fromEntries(keys.map((k) => [k, before[k] ?? null])) : null,
		after: after ? Object.fromEntries(keys.map((k) => [k, after[k] ?? null])) : null,
	};
}

/** Every meeting and venue write name. The wrapper declares each write established (C88), so one declaration decides the path. */
export type MeetingWrite =
	| "meetings.addAttendeeNote"
	| "meetings.captureAttendanceBatch"
	| "meetings.changeStatus"
	| "meetings.checkIn"
	| "meetings.clearAttendance"
	| "meetings.clearCard"
	| "meetings.completePractice"
	| "meetings.correctEvaluation"
	| "meetings.correctOccurrence"
	| "meetings.correctPracticeOccurrence"
	| "meetings.correctRsvp"
	| "meetings.createGuestContact"
	| "meetings.createWalkInContact"
	| "meetings.delete"
	| "meetings.edit"
	| "meetings.finalizeAttendance"
	| "meetings.inviteGuest"
	| "meetings.populateKit"
	| "meetings.reconcileAttendance"
	| "meetings.recordCard"
	| "meetings.recordEvaluation"
	| "meetings.removeGuest"
	| "meetings.replaceAgenda"
	| "meetings.saveOwnRsvp"
	| "meetings.schedule"
	| "meetings.setAttendance"
	| "meetings.setInviter"
	| "meetings.updateKitItem"
	| "venues.archive"
	| "venues.correct"
	| "venues.create"
	| "venues.edit"
	| "venues.restore";
/**
 * The shared write (D70): the locked actor, the request-key claim, the command's own locked fact read, then one
 * statement with the change, the plant's material revision and one audit row. A replay returns the first answer.
 */
export async function command<T>(
	tx: Tx,
	ctx: MeetingsContext,
	operation: MeetingWrite,
	input: { requestKey: string },
	body: (w: Writer, audit: AuditWrite) => Promise<Change<T>>,
	options: { member?: boolean } = {},
): Promise<T> {
	const w = await writer(tx, ctx);
	if (!w.admin && !options.member) deny();
	const identity = requestIdentity.parse({
		owner: ctx.selected,
		actorId: w.accountId,
		operation,
		requestKey: input.requestKey,
		digest: hash({ operation, input }),
	});
	const claim = await prepareWrite(tx, identity);
	if (claim.kind === "conflict") deny("conflict");
	if (claim.kind === "unavailable") deny();
	if (claim.kind === "replay") return claim.value as T;
	const change = await body(w, claim);
	const changed = (change.outcome ?? "changed") === "changed";
	const values = delta(change.before ?? null, change.after ?? null);
	claim.events.push({
		id: claim.id,
		tenant_id: w.plant.id,
		actor_id: w.accountId,
		subject_type: change.subjectType,
		subject_id: change.subject,
		action: change.action,
		kind: changed ? change.kind : "noop",
		before_revision: change.revision?.before ?? null,
		after_revision: change.revision?.after ?? null,
		before_value: values.before,
		after_value: values.after,
		reason: change.reason ?? null,
		metadata: { ...(change.meetingId ? { meetingId: change.meetingId } : {}), ...change.metadata },
	});
	if (changed)
		claim.writes.push(
			tx
				.update(tables.plant)
				.set({ material_revision: sql`${tables.plant.material_revision}+1` })
				.where(eq(tables.plant.id, w.plant.id)),
		);
	await finishAudit(tx, claim, identity, change.value);
	return change.value;
}
/** Revisions cross the boundary as decimal strings. */
export const next = (revision: string) => String(BigInt(revision) + 1n);
export const uuid = (value: string) => sql`${sql.param(value)}::uuid`;
