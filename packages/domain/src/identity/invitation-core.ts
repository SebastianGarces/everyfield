import { claimOperation, executeWrites } from "../operations/writes.ts";
import "server-only";
import { createHash, randomUUID } from "node:crypto";
import type { Transaction } from "@everyfield/db/client";
import { and, eq, sql } from "@everyfield/db/query";
import * as t from "@everyfield/db/tables";
import { z } from "zod";
import {
	accountId,
	owner,
	receipt,
	requestIdentity,
	sessionId,
	type Owner,
	type Receipt,
} from "@everyfield/contracts/common";
import { invitationError, seatError } from "@everyfield/contracts/identity";
import { currentActor, liveOwner } from "../access/session.ts";
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
export async function administer(tx: Transaction, session: string, selected: Owner) {
	const a = await currentActor(tx, sessionId.parse(session), selected);
	if (a.status !== "active" || a.context.kind !== "seat" || a.context.role === "member") refuse();
	return a;
}
export async function begin(
	tx: Transaction,
	selected: Owner,
	actor: string,
	name: typeof t.operation.$inferSelect.name,
	command: { requestKey: string; expectedRevision: string; input: unknown },
) {
	const request = requestIdentity.parse({
		owner: selected,
		actorId: actor,
		operation: name,
		requestKey: command.requestKey,
		digest: hash(canonical(command)),
		origin: { kind: "native" },
	});
	const claim = await claimOperation(tx, name, request);
	if (claim.kind === "conflict") refuse("idempotency_conflict");
	if (claim.kind === "replay") {
		const [prior] = await tx
			.select({ receipt: t.identity_operation_result.receipt, result: t.identity_operation_result.result })
			.from(t.operation)
			.innerJoin(t.identity_operation_result, eq(t.identity_operation_result.operation_id, t.operation.id))
			.where(and(eq(t.operation.tenant_id, selected.id), eq(t.operation.request_key, command.requestKey)));
		if (prior) {
			const saved = receipt.parse(prior.receipt);
			if (canonical(saved.request) !== canonical(request)) refuse("idempotency_conflict");
			return { kind: "replay" as const, result: prior.result };
		}

		refuse("invitation_unavailable");
	}
	return { kind: "new" as const, id: claim.id, request, writes: claim.writes, events: claim.events };
}
export type Command = Extract<Awaited<ReturnType<typeof begin>>, { kind: "new" }>;
export async function finish<T>(
	tx: Transaction,
	c: Command,
	output: (r: Receipt) => T,
	events: string[],
	effects: string[] = [],
	changed = true,
) {
	const r = receipt.parse({
		id: c.id,
		request: c.request,
		completedAt: new Date().toISOString(),
		outcome: changed ? "changed" : "noop",
		subjects: [{ kind: "operation", id: c.id, owner: c.request.owner }],
		eventIds: events,
		effectIds: effects,
	});
	const result = output(r);
	await executeWrites(tx, [
		...c.writes,
		...(c.events.length ? [tx.insert(t.event).values(c.events)] : []),
		tx
			.update(t.operation)
			.set({ state: "complete", outcome: changed ? "committed" : "no_effect", completed_at: new Date(r.completedAt) })
			.where(eq(t.operation.id, c.id)),
		tx.insert(t.identity_operation_result).values({ operation_id: c.id, receipt: r, result }),
	]);
	return result;
}
export function eventRow(
	c: Command,
	target: string,
	kind: typeof t.event.$inferInsert.kind,
	action: typeof t.event.$inferInsert.action,
	before: string,
	after: string,
) {
	const id = randomUUID();
	return {
		id,
		tenant_id: c.request.owner.id,
		target_record_id: target,
		operation_id: c.id,
		actor_id: c.request.actorId,
		kind,
		action,
		occurred_at: sql`clock_timestamp()`,
		recorded_at: sql`clock_timestamp()`,
		before_revision: before,
		after_revision: after,
		event_key: c.id + "/" + (action ?? kind) + "/" + target,
	};
}
export async function event(_tx: Transaction, ...args: Parameters<typeof eventRow>) {
	const row = eventRow(...args);
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
