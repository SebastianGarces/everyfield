import { requestIdentity, sameOwner, type Owner, type sessionId } from "@everyfield/contracts/common";
import { meetingsError, type MeetingsError, type MeetingsReply } from "@everyfield/contracts/meetings";
import type { Database, Transaction } from "@everyfield/db/client";
import { eq, sql } from "@everyfield/db/query";
import * as tables from "@everyfield/db/tables";
import { createHash, randomUUID } from "node:crypto";
import "server-only";
import { z } from "zod";
import { RequestActor, requestWrite } from "../access/session.ts";
import { canonical } from "../organizations/core.ts";
import {
	auditSavepoint,
	auditTransaction,
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
			retry: error.code === "conflict" ? "refresh" : "never",
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
	if (requestWrite(tx)) return { status: "ok", value: await body() };
	return settle(() => auditSavepoint(tx, body));
}
/** One native write: bind the request actor (one locking statement), run the command, roll back on refusal. */
export async function withMeetingsWrite<T>(
	db: Database,
	authority: RequestActor,
	body: (tx: Tx, context: MeetingsContext) => Promise<MeetingsReply<T>>,
): Promise<MeetingsReply<T>> {
	return settle(() =>
		auditTransaction(db, async (tx) => {
			const selected = authority.actor.context.owner;
			if (!(await authority.bind(tx, selected))) deny();
			const result = await body(tx, { session: authority.session, selected });
			if (result.status === "refused") throw new Refusal(result.error.code, result.error.details);
			return result.value;
		}),
	);
}
/** A read answers from the request's verified viewer; no statement re-resolves the session. */
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
			admin: actor.context.role !== "member",
		});
	});
}
export type Viewer = { plantId: string; accountId: string; admin: boolean };

export type Writer = {
	accountId: string;
	admin: boolean;
	plant: NonNullable<NonNullable<ReturnType<typeof requestWrite>>["plant"]>;
};
/** The locked request actor for this plant: bound by the native request, or claimed here by a direct caller. */
export async function writer(tx: Tx, ctx: MeetingsContext): Promise<Writer> {
	let bound = requestWrite(tx);
	if (!bound || bound.authority.session !== ctx.session || !sameOwner(bound.selected, ctx.selected))
		bound = (await RequestActor.claimWrite(tx, ctx.session, ctx.selected)) ?? undefined;
	if (!bound?.plant || bound.actor.context.kind !== "seat") deny();
	return { accountId: bound.actor.accountId, admin: bound.actor.context.role !== "member", plant: bound.plant };
}

export const hash = (value: unknown) => createHash("sha256").update(canonical(value)).digest("hex");
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

/**
 * The shared write (D70): the locked actor, the request-key claim, the command's own locked fact read, then one
 * statement with the change, the plant's material revision and one audit row. A replay returns the first answer.
 */
export async function command<T>(
	tx: Tx,
	ctx: MeetingsContext,
	operation: string,
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
