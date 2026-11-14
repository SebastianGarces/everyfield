import * as C from "@everyfield/contracts/organizations";
import type { Database, Transaction } from "@everyfield/db/client";
import { SQL, sql } from "@everyfield/db/query";
import { randomUUID } from "node:crypto";
import "server-only";
import { z } from "zod";
import { liveAccess, liveRead, type RequestActor } from "../access/session.ts";
import { hash } from "../operations/canonical.ts";
import { declareWrite, lockedWrite, nativeWrite, WriteUnavailable } from "../operations/writes.ts";

// What the organization pipeline and its development programs share: the viewer's seat with its live check (C13),
// refusals as replies, and one write in the gate's transaction (C88, established) with a body-free audit row.

export type Executor = Pick<Transaction, "execute">;

/** Any organization refusal: the pipeline's or a program's. Each module's replies name their own. */
type Refusal = C.PipelineRefusal | C.ProgramRefusal;

class Refused extends Error {
	readonly refusal: Refusal;
	constructor(refusal: Refusal) {
		super(refusal.code);
		this.refusal = refusal;
	}
}
export function refuse(refusal: Refusal = { code: "unavailable" }): never {
	throw new Refused(refusal);
}

/** The request actor's organization seat, or null for any other actor. */
export function seatOf(authority: RequestActor) {
	const context = authority.actor.context;
	if (context.kind !== "seat" || context.owner.kind !== "organization") return null;
	return {
		organization: context.owner.id,
		seatId: context.seatId,
		administrator: context.role !== "member",
		accountId: authority.actor.accountId,
		// The seat is still live with the same role: a role change after the request's lookup reads nothing (C13).
		live: liveRead({ ...liveAccess(authority), role: context.role }),
	};
}

type Reply<T, R> = { status: "ok"; value: T } | { status: "refused"; refusal: R };
/** Runs a read or write; a refusal thrown inside becomes the reply. `R` is the module's own refusal type. */
export async function answer<T, R extends Refusal = C.PipelineRefusal>(body: () => Promise<T>): Promise<Reply<T, R>> {
	try {
		return { status: "ok", value: await body() };
	} catch (error) {
		if (error instanceof Refused) return { status: "refused", refusal: error.refusal as R };
		if (error instanceof WriteUnavailable) return { status: "refused", refusal: { code: "unavailable" } as R };
		throw error;
	}
}
export function parse<S extends z.ZodType>(schema: S, raw: unknown): z.output<S> {
	const r = schema.safeParse(raw);
	if (!r.success) refuse({ code: "invalid_input", field: r.error.issues[0]?.path.join(".") });
	return r.data as z.output<S>;
}

export type Writer = {
	tx: Transaction;
	organization: string;
	seatId: string;
	administrator: boolean;
	actor: string;
	/** An audit row for this write: body-free, with IDs, actor, change kind and revisions only (REQ-MUL-002). */
	audit: (a: {
		id?: string;
		action: string;
		kind: string;
		subject: SQL;
		subjectType?: string;
		before?: SQL;
		after?: SQL;
		/** Body-free metadata; SQL when it holds a value the statement reads, such as a corrected day's old value. */
		metadata?: object | SQL;
	}) => SQL;
};

/**
 * One pipeline write in the gate's transaction (C88, established): the gate locks the actor's seat and the
 * organization, so the command's reads see every committed write before it, and the command runs as that seat.
 */
export async function write<T, R extends Refusal = C.PipelineRefusal>(
	db: Database,
	authority: RequestActor,
	administratorOnly: boolean,
	run: (w: Writer) => Promise<T>,
): Promise<Reply<T, R>> {
	const selected = authority.actor.context.owner;
	if (selected.kind !== "organization") return { status: "refused", refusal: { code: "unavailable" } as R };
	return answer<T, R>(() =>
		nativeWrite(db, authority, selected, async (tx) => {
			await declareWrite(tx, "established");
			const locked = await lockedWrite(tx);
			const context = locked?.actor.context;
			if (!locked || context?.kind !== "seat" || context.owner.id !== selected.id) refuse();
			const seat = context as Extract<NonNullable<typeof context>, { kind: "seat" }>;
			const administrator = seat.role !== "member";
			if (administratorOnly && !administrator) refuse();
			const organization = selected.id;
			const actor = locked!.actor.accountId;
			const token = hash([organization, actor]);
			return run({
				tx,
				organization,
				seatId: seat.seatId,
				administrator,
				actor,
				audit: (a) =>
					sql`INSERT INTO audit_event (id,tenant_id,actor_id,actor_token,action,kind,subject_type,subject_id,before_revision,
 after_revision,metadata) SELECT ${a.id ?? randomUUID()}::uuid,${organization}::uuid,${actor}::uuid,${token},${a.action},${a.kind},
 ${a.subjectType ?? "person"},${a.subject},${a.before ?? sql`NULL`}::bigint,${a.after ?? sql`NULL`}::bigint,
 ${a.metadata instanceof SQL ? a.metadata : sql`${JSON.stringify(a.metadata ?? {})}::jsonb`}`,
			});
		}),
	);
}

/** One row of a write statement's answer. */
export async function one<S extends z.ZodType>(w: Writer, schema: S, statement: SQL): Promise<z.output<S>> {
	return schema.parse((await w.tx.execute(statement)).rows[0]);
}

/**
 * Active residents (REQ-MUL-007): distinct live people of the organization with at least one active enrollment in a
 * residency-kind program. An apprenticeship enrollment or a pipeline stage labeled Resident alone does not count.
 */
export const activeResidents = (org: string) =>
	sql`(SELECT count(DISTINCT e.person_id) FROM development_enrollment e JOIN development_program p ON p.id=e.program_id
   AND p.organization_id=e.organization_id JOIN person x ON x.id=e.person_id AND x.tenant_id=e.organization_id
  WHERE e.organization_id=${org}::uuid AND e.status='active' AND p.kind='residency' AND x.state='live')`;
