import { writeAction } from "../operations/actions.ts";
import { accountId, owner, requestIdentity, sessionId, type Owner } from "@everyfield/contracts/common";
import { invitationError, seatError } from "@everyfield/contracts/identity";
import type { Database, Transaction } from "@everyfield/db/client";
import { eq, sql } from "@everyfield/db/query";
import * as t from "@everyfield/db/tables";
import { createHash, randomUUID } from "node:crypto";
import "server-only";
import { z } from "zod";
import { currentActor, liveOwner, RequestActor, requestWrite } from "../access/session.ts";
import { auditTransaction, finishAudit, prepareWrite } from "../operations/writes.ts";
import { rethrowWriteError } from "./budget.ts";
export { currentActor, liveOwner };
export const hash = (value: string) => createHash("sha256").update(value).digest("hex");
export function canonical(value: unknown): string {
	if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
	if (value !== null && typeof value === "object")
		return (
			"{" +
			Object.entries(value)
				.sort(([a], [b]) => a.localeCompare(b))
				.map(([k, v]) => JSON.stringify(k) + ":" + canonical(v))
				.join(",") +
			"}"
		);
	return JSON.stringify(value);
}
export class InvitationRefusal extends Error {
	constructor(readonly value: z.infer<typeof invitationError> | z.infer<typeof seatError>) {
		super(value.code);
	}
}
export function refuse(code = "invitation_unavailable", retryAt?: string): never {
	throw new InvitationRefusal(
		z.union([invitationError, seatError]).parse({
			code,
			details: retryAt ? { retryAt } : {},
			correlationId: randomUUID(),
			retry:
				code === "invitation_rate_limited" || code === "invitation_cooldown" || code === "temporary"
					? "same_request"
					: code === "conflict"
						? "refresh"
						: "never",
		}),
	);
}
export async function lock(tx: Transaction, key: string) {
	await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${key},8008))`);
}
const identityRow = z.object({
	account_id: accountId,
	email: z.email(),
	display_name: z.string(),
	verified: z.boolean(),
	registration_state: z.enum(["pending_domain", "active"]),
});
export async function identity(tx: Transaction, session: string) {
	const r = await tx.execute(sql`SELECT * FROM invitation_identity(${z.uuid().parse(session)}::uuid)`);
	if (!r.rows[0]) refuse();
	const a = identityRow.parse(r.rows[0]);
	if (!(await liveOwner(tx, owner.parse({ kind: "account", id: a.account_id })))) refuse();
	return a;
}
export async function readAdministrator(tx: Transaction, session: string, selected: Owner) {
	const actor = await currentActor(tx, sessionId.parse(session), selected);
	if (actor.status !== "active" || actor.context.kind !== "seat" || actor.context.role === "member") refuse();
	return actor;
}
export async function writeAsAdministrator<T>(
	db: Database,
	authority: RequestActor,
	selected: Owner,
	body: (tx: Transaction, bound: NonNullable<Awaited<ReturnType<RequestActor["bind"]>>>) => Promise<T>,
): Promise<T> {
	try {
		return await auditTransaction(db, async (tx) => {
			const bound = await authority.bind(tx, selected);
			if (!bound || bound.actor.context.kind !== "seat" || bound.actor.context.role === "member") refuse();
			return body(tx, bound);
		});
	} catch (error) {
		rethrowWriteError(error);
	}
}

export async function begin(
	tx: Transaction,
	selected: Owner,
	actor: string,
	name: string,
	command: { requestKey: string; expectedRevision: string; input: unknown },
) {
	const request = requestIdentity.parse({
		owner: selected,
		actorId: actor,
		operation: name,
		requestKey: command.requestKey,
		digest: hash(canonical(command)),
	});
	const claim = await prepareWrite(tx, request);
	if (claim.kind === "unavailable") refuse();
	if (claim.kind === "conflict") refuse("idempotency_conflict");
	if (claim.kind === "replay") {
		return { kind: "replay" as const, result: claim.value };
	}
	return { kind: "new" as const, id: claim.id, request, writes: claim.writes, events: claim.events };
}
export type Command = Extract<Awaited<ReturnType<typeof begin>>, { kind: "new" }>;
export async function finish<T>(tx: Transaction, c: Command, output: () => T) {
	const result = output();
	await finishAudit(tx, c, c.request, result);
	return result;
}
export function eventRow(
	c: Command,
	target: string,
	kind: typeof t.audit_event.$inferInsert.kind,
	action: typeof t.audit_event.$inferInsert.action | null,
	before: string,
	after: string,
) {
	const id = randomUUID();
	return {
		id,
		tenant_id: c.request.owner.id,
		subject_id: target,
		command_id: c.id,
		actor_id: c.request.actorId,
		kind,
		action: action ?? writeAction(c.request.operation),
		occurred_at: sql`clock_timestamp()`,
		recorded_at: sql`clock_timestamp()`,
		before_revision: before,
		after_revision: after,
		event_key: c.id + "/" + (action ?? kind) + "/" + target,
	};
}
export async function event(_tx: Transaction, ...args: Parameters<typeof eventRow>) {
	const row = eventRow(...args);
	if (!args[0].events.some((e) => e.id === args[0].id)) row.id = args[0].id;
	args[0].events.push(row);
	return row.id;
}
export type Invitation = typeof t.invitation.$inferSelect;
export async function load(tx: Transaction, id: string) {
	const [i] = await tx.select().from(t.invitation).where(eq(t.invitation.id, id)).for("update");
	if (!i || (i.purpose !== "seat" && i.purpose !== "residency_link")) refuse();
	return i;
}
export async function workspace(tx: Transaction, id: string) {
	const bound = requestWrite(tx);
	if (bound?.selected.id === id && bound.selected.kind !== "account")
		return { selected: bound.selected, name: bound.plant?.name ?? bound.organization?.name ?? null };
	const [r] = await tx
		.select({
			kind: t.tenant.kind,
			organizationKind: t.organization.kind,
			organizationName: t.organization.name,
			plantName: t.plant.name,
		})
		.from(t.tenant)
		.leftJoin(t.organization, eq(t.organization.id, t.tenant.id))
		.leftJoin(t.plant, eq(t.plant.id, t.tenant.id))
		.where(eq(t.tenant.id, id));
	if (!r || (r.kind !== "plant" && r.kind !== "organization")) refuse();
	const selected = owner.parse(
		r.kind === "plant" ? { kind: "plant", id } : { kind: "organization", id, organizationKind: r.organizationKind },
	);
	if (!(await liveOwner(tx, selected))) refuse();
	return { selected, name: r.organizationName ?? r.plantName };
}
export async function now(tx: Transaction) {
	const [v] = await tx
		.select({ now: sql<Date>`clock_timestamp()`.mapWith((value: string) => new Date(value)) })
		.from(t.tenant)
		.limit(1);
	if (!v) throw Error("clock_unavailable");
	return v.now;
}
export const expires = (i: Invitation) => new Date(i.created_at.getTime() + 30 * 86400000);
export async function pending(tx: Transaction, i: Invitation, expected?: string) {
	if (i.state !== "pending" || expires(i) <= (await now(tx)) || (expected !== undefined && i.revision !== expected))
		refuse();
}
export const bump = (r: string) => (BigInt(r) + 1n).toString();
