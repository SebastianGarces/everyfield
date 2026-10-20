import { writeAction } from "../operations/actions.ts";
import { RequestActor, requestWrite } from "../access/session.ts";
import { sessionId } from "@everyfield/contracts/common";
import {
	accountId,
	owner,
	recordId,
	requestIdentity,
	revision,
	sameOwner,
	tenantId,
	type Owner,
} from "@everyfield/contracts/common";
import {
	relationshipPair,
	relationshipProjection,
	sharingChoices,
	type RelationshipPair,
} from "@everyfield/contracts/organizations";
import type { Transaction } from "@everyfield/db/client";
import { alias } from "@everyfield/db/columns";
import { and, eq, getTableColumns, isNull, lte, sql, type SQL } from "@everyfield/db/query";
import * as tables from "@everyfield/db/tables";
import { currentActor, liveOwner } from "@everyfield/domain/access";
import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { finishAudit, prepareWrite } from "../operations/writes.ts";

export { currentActor, liveOwner, sameOwner };
export type Actor = Extract<Awaited<ReturnType<typeof currentActor>>, { status: "active" }>;
export const administrator = (a: Actor) => a.context.kind === "seat" && a.context.role !== "member";
export const unavailable = () => ({ status: "unavailable" }) as const;
export function refuse(code = "unavailable"): never {
	throw new Error(code);
}
export function checkRevision(expected: string, actual: string) {
	if (expected !== actual) refuse("stale_revision");
}
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
export async function writeActor(tx: Transaction, session: string, selected: Owner) {
	const bound = requestWrite(tx) ?? (await RequestActor.claimWrite(tx, sessionId.parse(session), selected));
	if (!bound || bound.authority.session !== session || !sameOwner(bound.selected, selected)) refuse();
	return bound.actor;
}
export const subjectOwner = (pair: RelationshipPair): Owner =>
	pair.kind === "discovery" ? owner.parse({ kind: "account", id: pair.accountId }) : pair.subject;
export const endpointValues = (pair: RelationshipPair) => [
	pair.kind === "plant" ? pair.subject.id : null,
	pair.kind === "discovery" ? pair.accountId : null,
	pair.kind === "sending_church" ? pair.subject.id : null,
	pair.organization.id,
];
export async function subjectAuthority(tx: Transaction, actor: Actor, pair: RelationshipPair): Promise<boolean> {
	if (!sameOwner(actor.context.owner, subjectOwner(pair))) return false;
	if (pair.kind !== "discovery") return administrator(actor);
	const d = await tx
		.select({ id: tables.discovery.id })
		.from(tables.discovery)
		.where(and(eq(tables.discovery.account_id, pair.accountId), isNull(tables.discovery.converted_at)))
		.for("share");
	const s = await tx
		.select({ id: tables.seat.id })
		.from(tables.seat)
		.where(and(eq(tables.seat.account_id, pair.accountId), isNull(tables.seat.ended_at)))
		.for("share");
	return d.length === 1 && s.length === 0;
}
export async function validPair(tx: Transaction, pair: RelationshipPair) {
	if (!(await liveOwner(tx, subjectOwner(pair))) || !(await liveOwner(tx, pair.organization))) return false;
	if (pair.kind === "discovery")
		return (
			(
				await tx
					.select({ id: tables.discovery.id })
					.from(tables.discovery)
					.where(and(eq(tables.discovery.account_id, pair.accountId), isNull(tables.discovery.converted_at)))
					.for("share")
			).length === 1
		);
	return true;
}
export const affiliationSchema = z.object({
	id: recordId,
	plant_id: tenantId.nullable(),
	account_id: accountId.nullable(),
	sending_church_id: tenantId.nullable(),
	organization_id: tenantId,
	organization_name: z.string(),
	organization_kind: z.enum(["sending_church", "sending_network"]),
	subject_kind: z.enum(["sending_church", "sending_network"]).nullable(),
	accepted_at: z.date(),
	ended_at: z.date().nullable(),
	invitation_id: recordId.nullable(),
	revision,
	consent_revision: revision,
	share_people: z.boolean(),
	share_meetings: z.boolean(),
	share_tasks: z.boolean(),
	share_ministry_teams: z.boolean(),
	share_wiki: z.boolean(),
	share_activity: z.boolean(),
	shared_findings: z.boolean(),
});
export type Affiliation = z.infer<typeof affiliationSchema>;
const receivingOrganization = alias(tables.organization, "receiving_organization");
const sendingOrganization = alias(tables.organization, "sending_organization");
/** A pool or a transaction: a read needs no transaction. */
export type Reader = Pick<Transaction, "select" | "execute">;
/** Affiliations with their names and a computed `active` flag. A write locks the rows; a read takes no lock. */
export async function loadAffiliations(tx: Reader, predicate: SQL, write = false) {
	const query = tx
		.select({
			...getTableColumns(tables.affiliation),
			organization_kind: receivingOrganization.kind,
			organization_name: receivingOrganization.name,
			subject_kind: sendingOrganization.kind,
			active: sql<boolean>`${tables.affiliation.ended_at} IS NULL AND ${tables.affiliation.accepted_at}<=clock_timestamp() AND NOT EXISTS(SELECT FROM lifecycle_witness w WHERE w.state NOT IN ('active','cancelled') AND (w.affiliation_id=${tables.affiliation.id} OR (w.opaque_subject_id IN (${tables.affiliation.organization_id},${tables.affiliation.plant_id},${tables.affiliation.account_id},${tables.affiliation.sending_church_id}) AND w.kind IN ('account','plant','organization')))) AND (${tables.affiliation.account_id} IS NULL OR EXISTS(SELECT FROM discovery d WHERE d.account_id=${tables.affiliation.account_id} AND d.converted_at IS NULL))`,
		})
		.from(tables.affiliation)
		.innerJoin(receivingOrganization, eq(receivingOrganization.id, tables.affiliation.organization_id))
		.leftJoin(sendingOrganization, eq(sendingOrganization.id, tables.affiliation.sending_church_id))
		.where(predicate)
		.orderBy(tables.affiliation.id);
	const rows = await (write ? query.for("update", { of: tables.affiliation }) : query);
	return rows.map((row) => ({ ...affiliationSchema.parse(row), active: row.active }));
}
export async function loadAffiliation(tx: Transaction, id: string, write = false): Promise<Affiliation | null> {
	return (await loadAffiliations(tx, eq(tables.affiliation.id, id), write))[0] ?? null;
}

export function pairOf(a: Affiliation): RelationshipPair {
	const organization = { kind: "organization", id: a.organization_id, organizationKind: a.organization_kind };
	return relationshipPair.parse(
		a.plant_id
			? { kind: "plant", subject: { kind: "plant", id: a.plant_id }, organization }
			: a.account_id
				? { kind: "discovery", accountId: a.account_id, organization }
				: {
						kind: "sending_church",
						subject: { kind: "organization", id: a.sending_church_id, organizationKind: a.subject_kind },
						organization,
					},
	);
}
export const projection = (a: Affiliation) =>
	relationshipProjection.parse({
		id: a.id,
		pair: pairOf(a),
		revision: a.revision,
		acceptedAt: a.accepted_at.toISOString(),
		endedAt: a.ended_at?.toISOString() ?? null,
	});
export const choices = (a: Affiliation) =>
	sharingChoices.parse({
		people: a.share_people,
		meetings: a.share_meetings,
		tasks: a.share_tasks,
		ministry_teams: a.share_ministry_teams,
		wiki: a.share_wiki,
		activity: a.share_activity,
		shared_findings: a.shared_findings,
	});
export async function active(tx: Transaction, a: Affiliation) {
	return (
		a.ended_at === null &&
		(
			await tx
				.select({ id: tables.affiliation.id })
				.from(tables.affiliation)
				.where(
					and(
						eq(tables.affiliation.id, a.id),
						lte(
							tables.affiliation.accepted_at,
							sql<Date>`clock_timestamp()`.mapWith((value: string) => new Date(value)),
						),
					),
				)
		).length === 1 &&
		(await validPair(tx, pairOf(a))) &&
		!(
			await tx
				.select({ id: tables.lifecycle_witness.id })
				.from(tables.lifecycle_witness)
				.where(
					and(
						eq(tables.lifecycle_witness.affiliation_id, a.id),
						sql<unknown>`(${tables.lifecycle_witness.state} != 'active')`,
					),
				)
				.for("share")
		).length
	);
}
export interface OrganizationEffects {
	invitation(
		tx: Transaction,
		input: {
			invitationId: string;
			owner: Owner;
			recipientEmail: string;
			proof: string;
			inviterDescription: string;
			expiresAt: string;
			operationId: string;
		},
	): Promise<void>;
	notice(
		tx: Transaction,
		input: {
			eventId: string;
			actorId?: string;
			relationshipId: string;
			pair: RelationshipPair;
			kind: "relationship_approved" | "relationship_ended" | "sharing_changed";
			revision: string;
			operationId: string;
		},
	): Promise<void>;
	invalidate(tx: Transaction, input: { owners: readonly Owner[]; sourceId: string; revision: string }): Promise<void>;
}
type Command = { requestKey: string; expectedRevision: string; input: unknown };
export async function beginCommand(tx: Transaction, actor: Actor, selected: Owner, name: string, command: Command) {
	const identity = requestIdentity.parse({
		owner: selected,
		actorId: actor.accountId,
		operation: name,
		requestKey: command.requestKey,
		digest: hash(canonical(command)),
	});
	const claim = await prepareWrite(tx, identity);
	if (claim.kind === "unavailable") refuse();
	if (claim.kind === "conflict") refuse("request_conflict");
	if (claim.kind === "replay") {
		return { kind: "replay" as const, result: claim.value };
	}
	return { kind: "new" as const, id: claim.id, identity, writes: claim.writes, events: claim.events };
}
export type NewCommand = Extract<Awaited<ReturnType<typeof beginCommand>>, { kind: "new" }>;
export async function finishCommand<T>(tx: Transaction, c: NewCommand, result: () => T): Promise<T> {
	const output = result();
	await finishAudit(tx, c, c.identity, output);
	return output;
}
export async function appendEvent(
	_tx: Transaction,
	c: NewCommand,
	target: string,
	kind: typeof tables.audit_event.$inferInsert.kind,
	action: typeof tables.audit_event.$inferInsert.action | null,
	before: string,
	after: string,
) {
	const id = c.events.length ? randomUUID() : c.id;
	c.events.push({
		id: id,
		tenant_id: c.identity.owner.id,
		subject_id: target,
		command_id: c.id,
		actor_id: c.identity.actorId,
		kind: kind,
		action: action ?? writeAction(c.identity.operation),
		occurred_at: sql<Date>`clock_timestamp()`.mapWith((value: string) => new Date(value)),
		recorded_at: sql<Date>`clock_timestamp()`.mapWith((value: string) => new Date(value)),
		before_revision: sql`${before}`,
		after_revision: sql`${after}`,
		event_key: sql<string>`((${sql.param(c.id)})::uuid)::text`,
	});
	return id;
}
export async function invalidate(
	tx: Transaction,
	effects: OrganizationEffects,
	pair: RelationshipPair,
	id: string,
	rev: string,
) {
	await tx
		.update(tables.organization)
		.set({ material_revision: sql<unknown>`(${tables.organization.material_revision} + 1)` })
		.where(eq(tables.organization.id, pair.organization.id));
	await effects.invalidate(tx, { owners: [pair.organization], sourceId: id, revision: rev });
}
