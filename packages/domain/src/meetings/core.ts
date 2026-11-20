import { requestIdentity, sameOwner, type Owner, type sessionId } from "@everyfield/contracts/common";
import { meetingsError, type MeetingsReply } from "@everyfield/contracts/meetings";
import type { Database, Transaction } from "@everyfield/db/client";
import { eq, sql, type SQL } from "@everyfield/db/query";
import * as tables from "@everyfield/db/tables";
import { hash } from "../operations/canonical.ts";
import "server-only";
import { z } from "zod";
import { boundWrite, liveRead, RequestActor, type requestWrite, type WriteTx } from "../access/session.ts";
import {
	auditSavepoint,
	declareWrite,
	lockedWrite,
	nativeWrite,
	finishAudit,
	prepareWrite,
	WriteUnavailable,
	type AuditWrite,
	gatedTransaction,
} from "../operations/writes.ts";
import { defineRefusals, type Deny } from "../operations/refusals.ts";

export type Tx = WriteTx;
export type Reader = Pick<Transaction, "execute">;
export type MeetingsContext = { session: z.infer<typeof sessionId>; selected: Owner };

const refusals = defineRefusals(meetingsError, { writeUnavailable: "unavailable" });
export const { Refusal, refused } = refusals;
const { settle } = refusals;
export const deny: Deny<typeof meetingsError> = refusals.deny;
const databaseError = z.object({ cause: z.object({ code: z.string().regex(/^[0-9A-Z]{5}$/) }) });
async function settleWrite<T>(body: () => Promise<T>): Promise<MeetingsReply<T>> {
	try {
		return await settle(body);
	} catch (error) {
		if (databaseError.safeParse(error).success) return refusals.refused("required_write_failed");
		throw error;
	}
}
export function parse<S extends z.ZodType>(schema: S, raw: unknown): z.output<S> {
	const r = schema.safeParse(raw);
	if (r.success) return r.data;
	deny("invalid_input", {
		issues: r.error.issues
			.slice(0, 50)
			.map((i) => ({ path: i.path.join(".").slice(0, 200), problem: i.message.slice(0, 200) })),
	});
}

export async function reply<T>(tx: Tx, body: () => Promise<T>): Promise<MeetingsReply<T>> {
	if (boundWrite(tx)) return { status: "ok", value: await body() };
	return settleWrite(() => auditSavepoint(tx, body));
}
export async function withMeetingsWrite<T>(
	db: Database,
	authority: RequestActor,
	body: (tx: Tx, context: MeetingsContext) => Promise<MeetingsReply<T>>,
): Promise<MeetingsReply<T>> {
	const selected = authority.actor.context.owner;
	return settleWrite(() =>
		nativeWrite(db, authority, selected, async (tx) => {
			await declareWrite(tx, "established");
			const result = await body(tx, { session: authority.session, selected });
			if (result.status === "refused") throw new Refusal(result.error.code, result.error.details);
			return result.value;
		}),
	);
}
class Preview extends Error {
	readonly value: unknown;
	constructor(value: unknown) {
		super("preview");
		this.value = value;
	}
}
export async function previewMeetingsWrite<T>(
	db: Database,
	authority: RequestActor,
	body: (tx: Tx, context: MeetingsContext) => Promise<MeetingsReply<T>>,
): Promise<MeetingsReply<T>> {
	const selected = authority.actor.context.owner;
	return settleWrite(() =>
		gatedTransaction(db, async (tx) => {
			if (!(await authority.bind(tx, selected))) throw new WriteUnavailable();
			const result = await body(tx, { session: authority.session, selected });
			if (result.status === "refused") throw new Refusal(result.error.code, result.error.details);
			throw new Preview(result.value);
		}).catch((error: unknown) => {
			if (error instanceof Preview) return error.value as T;
			throw error;
		}),
	);
}
export async function read<T>(
	authority: RequestActor,
	body: (viewer: Viewer) => Promise<T>,
): Promise<MeetingsReply<T>> {
	return settle(() => {
		const actor = authority.actor;
		if (actor.context.kind !== "seat" || actor.context.owner.kind !== "plant") deny("unavailable");
		return body({
			plantId: actor.context.owner.id,
			accountId: actor.accountId,
			access: { session: authority.session, owner: actor.context.owner, seatId: actor.context.seatId },
		});
	});
}
export type Viewer = { plantId: string; accountId: string; access: Parameters<typeof liveRead>[0] };
export const plantVisible = (plant: SQL) =>
	sql`NOT EXISTS (SELECT FROM lifecycle_witness w WHERE w.kind = 'plant' AND w.opaque_subject_id = ${plant}
		AND w.state NOT IN ('active', 'cancelled'))`;
export async function one(db: Reader, v: Viewer, query: SQL, admin = false) {
	const r = await db.execute(sql`SELECT a.access_live, a.access_admin, q.* FROM (SELECT ${liveRead(v.access, admin)}
		AS access_live, ${liveRead(v.access, true)} AS access_admin) a
		LEFT JOIN LATERAL (SELECT true AS access_found, x.* FROM (${query}) x LIMIT 1) q ON a.access_live`);
	const row = r.rows[0] as Record<string, unknown>;
	if (row.access_live !== true) deny("unavailable");
	return { row: row.access_found === true ? row : undefined, admin: row.access_admin === true };
}

export type Writer = {
	accountId: string;
	admin: boolean;
	plant: NonNullable<NonNullable<ReturnType<typeof requestWrite>>["plant"]>;
};
async function writer(tx: Tx, ctx: MeetingsContext): Promise<Writer> {
	let bound = await lockedWrite(tx);
	if (!bound || bound.authority.session !== ctx.session || !sameOwner(bound.selected, ctx.selected))
		bound = (await RequestActor.claimWrite(tx, ctx.session, ctx.selected)) ?? undefined;
	if (!bound?.plant || bound.actor.context.kind !== "seat") deny("unavailable");
	return { accountId: bound.actor.accountId, admin: bound.actor.context.role !== "member", plant: bound.plant };
}

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
	revision?: { before: string | null; after: string };
	reason?: string | null;
	meetingId?: string;
	metadata?: Record<string, unknown>;
};
export function delta(before: Record<string, unknown> | null, after: Record<string, unknown> | null) {
	const keys = [...new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})])].filter(
		(k) => JSON.stringify(before?.[k]) !== JSON.stringify(after?.[k]),
	);
	return {
		before: before ? Object.fromEntries(keys.map((k) => [k, before[k] ?? null])) : null,
		after: after ? Object.fromEntries(keys.map((k) => [k, after[k] ?? null])) : null,
	};
}

export type MeetingWrite =
	| "meetings.addAttendeeNote"
	| "meetings.addGuests"
	| "meetings.captureAttendanceBatch"
	| "meetings.changeStatus"
	| "meetings.checkIn"
	| "meetings.clearAttendance"
	| "meetings.clearCard"
	| "meetings.completePractice"
	| "meetings.copyTeamRoster"
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
export async function command<T>(
	tx: Tx,
	ctx: MeetingsContext,
	operation: MeetingWrite,
	input: { requestKey: string },
	body: (w: Writer, audit: AuditWrite) => Promise<Change<T>>,
	options: { member?: boolean } = {},
): Promise<T> {
	const w = await writer(tx, ctx);
	if (!w.admin && !options.member) deny("unavailable");
	const identity = requestIdentity.parse({
		owner: ctx.selected,
		actorId: w.accountId,
		operation,
		requestKey: input.requestKey,
		digest: hash({ operation, input }),
	});
	const claim = await prepareWrite(tx, identity);
	if (claim.kind === "conflict") deny("conflict");
	if (claim.kind === "unavailable") deny("unavailable");
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
export const next = (revision: string) => String(BigInt(revision) + 1n);
