import { requestIdentity, sameOwner, type Owner, type sessionId } from "@everyfield/contracts/common";
import { teamsError, type TeamsError, type TeamsReply } from "@everyfield/contracts/teams";
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
	finishAudit,
	lockedWrite,
	nativeWrite,
	prepareWrite,
	WriteUnavailable,
	type AuditWrite,
} from "../operations/writes.ts";

export type Tx = Transaction;
export type Reader = Pick<Transaction, "execute">;
export type TeamsContext = { session: z.infer<typeof sessionId>; selected: Owner };

type Code = TeamsError["code"];
export class Refusal extends Error {
	readonly code: Code;
	readonly details: object;
	constructor(code: Code, details: object) {
		super(code);
		this.code = code;
		this.details = details;
	}
}
export function deny(code: Code = "unavailable", details: object = {}): never {
	throw new Refusal(code, details);
}
function refused(error: Refusal): TeamsReply<never> {
	return {
		status: "refused",
		error: teamsError.parse({
			code: error.code,
			details: error.details,
			correlationId: randomUUID(),
			retry: error.code === "conflict" ? "refresh" : error.code === "required_write_failed" ? "same_request" : "never",
		}),
	};
}
async function settle<T>(body: () => Promise<T>): Promise<TeamsReply<T>> {
	try {
		return { status: "ok", value: await body() };
	} catch (error) {
		if (error instanceof WriteUnavailable) return refused(new Refusal("unavailable", {}));
		if (error instanceof Refusal) return refused(error);
		throw error;
	}
}
const databaseError = z.object({ cause: z.object({ code: z.string().regex(/^[0-9A-Z]{5}$/) }) });
async function settleWrite<T>(body: () => Promise<T>): Promise<TeamsReply<T>> {
	try {
		return await settle(body);
	} catch (error) {
		if (databaseError.safeParse(error).success) return refused(new Refusal("required_write_failed", {}));
		throw error;
	}
}
export function parse<S extends z.ZodType>(schema: S, raw: unknown): z.output<S> {
	const found = schema.safeParse(raw);
	if (found.success) return found.data;
	deny("invalid_input", {
		issues: found.error.issues
			.slice(0, 50)
			.map((issue) => ({ path: issue.path.join(".").slice(0, 200), problem: issue.message.slice(0, 200) })),
	});
}
export async function reply<T>(tx: Tx, body: () => Promise<T>): Promise<TeamsReply<T>> {
	if (boundWrite(tx)) return { status: "ok", value: await body() };
	return settleWrite(() => auditSavepoint(tx, body));
}

/** One native write. Every teams command reads another row, so the path is established. */
export async function withTeamsWrite<T>(
	db: Database,
	authority: RequestActor,
	body: (tx: Tx, context: TeamsContext) => Promise<TeamsReply<T>>,
): Promise<TeamsReply<T>> {
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
export async function read<T>(authority: RequestActor, body: (viewer: Viewer) => Promise<T>): Promise<TeamsReply<T>> {
	return settle(() => {
		const actor = authority.actor;
		if (actor.context.kind !== "seat" || actor.context.owner.kind !== "plant") deny();
		return body({
			plantId: actor.context.owner.id,
			accountId: actor.accountId,
			access: {
				session: authority.session,
				owner: actor.context.owner,
				seatId: actor.context.seatId,
				role: actor.context.role,
			},
		});
	});
}
export type Viewer = { plantId: string; accountId: string; access: Parameters<typeof liveRead>[0] };
export async function one(db: Reader, viewer: Viewer, query: SQL) {
	const found = await db.execute(sql`SELECT a.access_live, q.* FROM (SELECT ${liveRead(viewer.access, false)}
		AS access_live) a
		LEFT JOIN LATERAL (SELECT true AS access_found, x.* FROM (${query}) x LIMIT 1) q ON a.access_live`);
	const row = found.rows[0] as Record<string, unknown>;
	if (row.access_live !== true) deny();
	return row.access_found === true ? row : undefined;
}

export type Writer = {
	accountId: string;
	admin: boolean;
	plant: NonNullable<NonNullable<ReturnType<typeof requestWrite>>["plant"]>;
};
export async function writer(tx: Tx, ctx: TeamsContext): Promise<Writer> {
	let bound = await lockedWrite(tx);
	if (!bound || bound.authority.session !== ctx.session || !sameOwner(bound.selected, ctx.selected))
		bound = (await RequestActor.claimWrite(tx, ctx.session, ctx.selected)) ?? undefined;
	if (!bound?.plant || bound.actor.context.kind !== "seat") deny();
	return { accountId: bound.actor.accountId, admin: bound.actor.context.role !== "member", plant: bound.plant };
}

type AuditInsert = typeof tables.audit_event.$inferInsert;
export type Change<T> = {
	value: T;
	subject: string;
	subjectType:
		| "team"
		| "team_role"
		| "team_tenure"
		| "participation"
		| "record"
		| "training_program"
		| "training_assignment"
		| "training_credit"
		| "meeting";
	action?:
		| "teams.changed"
		| "training.assigned"
		| "training.assignment_removed"
		| "training.completed"
		| "training.corrected"
		| "training.revoked"
		| "meetings.changed";
	kind: NonNullable<AuditInsert["kind"]>;
	outcome?: "changed" | "noop";
	before?: Record<string, unknown> | null;
	after?: Record<string, unknown> | null;
	revision?: { before: string | null; after: string };
	reason?: string | null;
};
export function delta(before: Record<string, unknown> | null, after: Record<string, unknown> | null) {
	const keys = [...new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})])].filter(
		(key) => JSON.stringify(before?.[key]) !== JSON.stringify(after?.[key]),
	);
	return {
		before: before ? Object.fromEntries(keys.map((key) => [key, before[key] ?? null])) : null,
		after: after ? Object.fromEntries(keys.map((key) => [key, after[key] ?? null])) : null,
	};
}
export type TeamWrite =
	| "teams.create"
	| "teams.edit"
	| "teams.archive"
	| "teams.restore"
	| "teams.correct"
	| "teams.createRole"
	| "teams.editRole"
	| "teams.retireRole"
	| "teams.assignRole"
	| "teams.endMembership"
	| "teams.reactivateMembership"
	| "teams.appointLeader"
	| "teams.initialize"
	| "meetings.copyTeamRoster"
	| "teams.createProgram"
	| "teams.correctProgram"
	| "teams.setRequiredTrainingParticipants"
	| "teams.attestCompletion"
	| "teams.revokeCompletion"
	| "teams.recompleteTraining"
	| "teams.scheduleMeeting"
	| "teams.recordAttendance";

/** A team id, or a lookup that runs only when the actor is not an admin. */
type LeaderGate = string | ((tx: Tx, w: Writer) => Promise<string | undefined>);
/** Admin, or the linked live leader of that team. A member who leads another team is refused. */
async function allow(tx: Tx, w: Writer, leaderOf?: LeaderGate) {
	if (w.admin) return;
	const teamId = typeof leaderOf === "function" ? await leaderOf(tx, w) : leaderOf;
	if (!teamId) deny("access_denied");
	const found = await tx.execute(sql`SELECT 1 AS ok FROM person p
		JOIN team t ON t.leader_person_id = p.id AND t.plant_id = p.tenant_id
		WHERE p.linked_account_id = ${w.accountId}::uuid AND p.state = 'live' AND p.tenant_id = ${w.plant.id}::uuid
			AND t.id = ${teamId}::uuid AND t.archived_at IS NULL`);
	if (!found.rows[0]) deny("access_denied");
}
export async function command<T>(
	tx: Tx,
	ctx: TeamsContext,
	operation: TeamWrite,
	input: { requestKey: string },
	body: (w: Writer, audit: AuditWrite) => Promise<Change<T>>,
	leaderOf?: LeaderGate,
): Promise<T> {
	const w = await writer(tx, ctx);
	await allow(tx, w, leaderOf);
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
		action: change.action ?? "teams.changed",
		kind: changed ? change.kind : "noop",
		before_revision: change.revision?.before ?? null,
		after_revision: change.revision?.after ?? null,
		before_value: values.before,
		after_value: values.after,
		reason: change.reason ?? null,
		metadata: {},
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
export const uuid = (value: string) => sql`${value}::uuid`;
