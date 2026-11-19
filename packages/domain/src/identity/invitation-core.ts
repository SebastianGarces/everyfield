import { writeAction } from "../operations/actions.ts";
import { accountId, owner, requestIdentity, sessionId, type Owner } from "@everyfield/contracts/common";
import { invitationError, seatError } from "@everyfield/contracts/identity";
import { invitationMachine, permits, type InvitationSubject } from "@everyfield/contracts/machines";
import type { Database, Transaction } from "@everyfield/db/client";
import { eq, sql, type SQL } from "@everyfield/db/query";
import * as t from "@everyfield/db/tables";
import { createHash, randomUUID } from "node:crypto";
import "server-only";
import { z } from "zod";
import { currentActor, liveOwner, RequestActor, requestWrite, type WriteTx } from "../access/session.ts";
import { canonical } from "../operations/canonical.ts";
import { auditTransaction, finishAudit, prepareWrite } from "../operations/writes.ts";
import { rethrowWriteError } from "./budget.ts";
export { currentActor };
export const hash = (value: string) => createHash("sha256").update(value).digest("hex");
export class InvitationRefusal extends Error {
	readonly value: z.infer<typeof invitationError> | z.infer<typeof seatError>;
	constructor(value: z.infer<typeof invitationError> | z.infer<typeof seatError>) {
		super(value.code);
		this.value = value;
	}
}
export function refuse(code = "invitation_unavailable", retryAt?: string): never {
	throw new InvitationRefusal(
		z.union([invitationError, seatError]).parse({
			code,
			details: retryAt ? { retryAt } : {},
			correlationId: randomUUID(),
			retry:
				code === "invitation_rate_limited" ||
				code === "invitation_cooldown" ||
				code === "temporary" ||
				code === "required_write_failed"
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
export async function readAdministrator(tx: WriteTx, session: string, selected: Owner) {
	const actor = await currentActor(tx, sessionId.parse(session), selected, false);
	if (actor.status !== "active" || actor.context.kind !== "seat" || actor.context.role === "member") refuse();
	return actor;
}
export async function writeAsAdministrator<T>(
	db: Database | Transaction,
	authority: RequestActor,
	selected: Owner,
	body: (tx: WriteTx, bound: NonNullable<Awaited<ReturnType<RequestActor["bind"]>>>) => Promise<T>,
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
	tx: WriteTx,
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
export async function finish<T>(tx: WriteTx, c: Command, output: () => T) {
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
const invitationRow = z.object({
	id: z.uuid(),
	tenant_id: z.uuid(),
	purpose: z.enum(t.invitation.purpose.enumValues),
	recipient_email: z.string(),
	inviter_id: z.uuid().nullable(),
	role: z.enum(["admin", "member"]).nullable(),
	token_hash: z.string(),
	state: z.enum(t.invitation.state.enumValues),
	created_at: z.coerce.date(),
	resent_at: z.coerce.date().nullable(),
	acted_at: z.coerce.date().nullable(),
	accepted_account_id: z.uuid().nullable(),
	revision: z.string(),
	resident_person_id: z.uuid().nullable(),
	inviter_description: z.string(),
});
const lockedRow = invitationRow.extend({
	identity: identityRow.nullable(),
	tenant_kind: z.enum(t.tenant.kind.enumValues),
	organization_kind: z.string().nullable(),
	workspace_name: z.string().nullable(),
	root: z.boolean(),
	now: z.number(),
});
export async function lockInvitation(
	tx: Transaction,
	match: (row: SQL) => SQL,
	options: { session?: string; root?: boolean } = {},
) {
	const session = options.session === undefined ? undefined : z.uuid().parse(options.session);
	const root = (kind: "plant" | "organization") =>
		sql`(SELECT x.id FROM ${sql.raw(kind)} x WHERE x.id=(SELECT l.tenant_id FROM l WHERE l.tenant_kind=${kind}
 AND l.purpose IN ('seat','residency_link') AND ${match(sql`l`)}) FOR SHARE)`;
	const result = await tx.execute(sql`WITH ${
		session === undefined
			? sql``
			: sql`a AS MATERIALIZED (SELECT i.* FROM invitation_identity(${session}::uuid) i JOIN tenant t ON t.id=i.account_id AND t.kind='account'),`
	}
 src AS MATERIALIZED (SELECT i.id, i.tenant_id, i.purpose, i.resident_person_id FROM invitation i WHERE ${match(sql`i`)}${
		session === undefined ? sql`` : sql` AND EXISTS(SELECT FROM a WHERE a.verified)`
	}),
 src_organization AS MATERIALIZED (SELECT x.id FROM organization x WHERE x.id=(SELECT tenant_id FROM src
 WHERE purpose='residency_link' AND resident_person_id IS NOT NULL) FOR SHARE),
 src_person AS MATERIALIZED (SELECT p.id FROM person p WHERE p.id=(SELECT resident_person_id FROM src)
 AND p.tenant_id=(SELECT tenant_id FROM src) AND EXISTS(SELECT FROM src_organization) FOR UPDATE),
 l AS MATERIALIZED (SELECT i.id, i.tenant_id, i.purpose, i.recipient_email, i.inviter_id, i.role, i.token_hash, i.state,
 i.created_at, i.resent_at, i.acted_at, i.accepted_account_id, i.revision::text AS revision, i.resident_person_id,
 i.inviter_description, t.kind AS tenant_kind, o.kind AS organization_kind, coalesce(o.name, pl.name) AS workspace_name
 FROM invitation i JOIN tenant t ON t.id=i.tenant_id LEFT JOIN organization o ON o.id=t.id LEFT JOIN plant pl ON pl.id=t.id
 CROSS JOIN (SELECT count(*) FROM src_person) held WHERE i.id=(SELECT id FROM src) FOR UPDATE OF i)${
		options.root ? sql`, rp AS MATERIALIZED ${root("plant")}, ro AS MATERIALIZED ${root("organization")}` : sql``
	}
 SELECT ${session === undefined ? sql`NULL::jsonb` : sql`(SELECT to_jsonb(a) FROM a)`} AS identity, l.*,
 ${options.root ? sql`(EXISTS(SELECT FROM rp) OR EXISTS(SELECT FROM ro))` : sql`true`} AS root,
 (extract(epoch FROM clock_timestamp())*1000)::float8 AS now FROM l`);
	const [r] = lockedRow.array().parse(result.rows);
	if (!r || (r.purpose !== "seat" && r.purpose !== "residency_link")) refuse();
	if ((r.tenant_kind !== "plant" && r.tenant_kind !== "organization") || !r.root) refuse();
	const tenant = r.tenant_kind;
	const selected = owner.parse(
		tenant === "plant"
			? { kind: "plant", id: r.tenant_id }
			: { kind: "organization", id: r.tenant_id, organizationKind: r.organization_kind },
	);
	const invitation: Invitation = invitationRow.parse(r);
	return { identity: r.identity, invitation, selected, tenant, name: r.workspace_name, now: new Date(r.now) };
}
export async function workspace(tx: WriteTx, id: string) {
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
export const expires = (i: Pick<Invitation, "created_at">) => new Date(i.created_at.getTime() + 30 * 86400000);
export type InvitationEvent = (typeof invitationMachine.events)[number];
export type InvitationState = (typeof invitationMachine.states)[number];
export const subjectOf = (
	i: Pick<Invitation, "purpose" | "created_at">,
	tenant: InvitationSubject["tenant"],
	at: Date,
): InvitationSubject => ({ purpose: i.purpose, tenant, fresh: expires(i) > at });
export function current(
	i: Invitation,
	tenant: InvitationSubject["tenant"],
	at: Date,
	event: InvitationEvent,
	to: InvitationState,
	expected?: string,
) {
	const subject = subjectOf(i, tenant, at);
	if (!permits(invitationMachine, event, i.state, to, subject) || (expected !== undefined && i.revision !== expected))
		refuse();
	return subject;
}
export const bump = (r: string) => (BigInt(r) + 1n).toString();
