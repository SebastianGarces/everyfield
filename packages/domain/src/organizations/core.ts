import { writeAction } from "../operations/actions.ts";
import { RequestActor, requestWrite, type WriteTx } from "../access/session.ts";
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
import { and, eq, getTableColumns, sql, type SQL, type SQLWrapper, type SqlLiteral } from "@everyfield/db/query";
import * as tables from "@everyfield/db/tables";
import { currentActor } from "@everyfield/domain/access";
import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { canonical } from "../operations/canonical.ts";
import { finishAudit, prepareWrite } from "../operations/writes.ts";

export { currentActor, sameOwner };
export type Actor = Extract<Awaited<ReturnType<typeof currentActor>>, { status: "active" }>;
export const administrator = (a: Actor) => a.context.kind === "seat" && a.context.role !== "member";
export const unavailable = () => ({ status: "unavailable" }) as const;
export type OrganizationRefusalCode =
	| "unavailable"
	| "address_pending"
	| "already_active"
	| "invitation_limit"
	| "pending_invitation"
	| "reference_unavailable"
	| "region_unavailable"
	| "request_conflict"
	| "resend_cooldown"
	| "stale_revision";
export class OrganizationRefusal extends Error {
	readonly code: OrganizationRefusalCode;
	constructor(code: OrganizationRefusalCode) {
		super(code);
		this.code = code;
	}
}
export function refuse(code: OrganizationRefusalCode = "unavailable"): never {
	throw new OrganizationRefusal(code);
}
export function checkRevision(expected: string, actual: string) {
	if (expected !== actual) refuse("stale_revision");
}
export const hash = (value: string) => createHash("sha256").update(value).digest("hex");
export async function writeActor(tx: WriteTx, session: string, selected: Owner) {
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
	live: z.boolean(),
	active: z.boolean(),
});
export type Affiliation = z.infer<typeof affiliationSchema>;
const receivingOrganization = alias(tables.organization, "receiving_organization");
const sendingOrganization = alias(tables.organization, "sending_organization");
export type Reader = Pick<Transaction, "select" | "execute">;
const organizationFirst = sql<boolean>`EXISTS(SELECT FROM organization o WHERE o.id=${tables.affiliation.organization_id} FOR NO KEY UPDATE)`;
const linkLive = <AName extends string>(a: SqlLiteral<AName>) => {
	const c = <ColumnName extends string>(column: SqlLiteral<ColumnName>) => sql.raw(`${a}.${column}`);
	return sql<boolean>`(NOT EXISTS(SELECT FROM lifecycle_witness w WHERE w.state NOT IN ('active','cancelled') AND (w.affiliation_id=${c("id")} OR (w.opaque_subject_id IN (${c("organization_id")},${c("plant_id")},${c("account_id")},${c("sending_church_id")}) AND w.kind IN ('account','plant','organization')))) AND (${c("account_id")} IS NULL OR EXISTS(SELECT FROM discovery d WHERE d.account_id=${c("account_id")} AND d.converted_at IS NULL)))`;
};
export const linkActive = <AName extends string>(a: SqlLiteral<AName>) =>
	sql<boolean>`(${sql.raw(a)}.ended_at IS NULL AND ${sql.raw(a)}.accepted_at<=clock_timestamp() AND ${linkLive(a)})`;
export async function loadAffiliations(tx: Reader, predicate: SQL, write = false) {
	const live = linkLive("affiliation");
	const query = tx
		.select({
			...getTableColumns(tables.affiliation),
			organization_kind: receivingOrganization.kind,
			organization_name: receivingOrganization.name,
			subject_kind: sendingOrganization.kind,
			live,
			active: sql<boolean>`${tables.affiliation.ended_at} IS NULL AND ${tables.affiliation.accepted_at}<=clock_timestamp() AND ${live}`,
		})
		.from(tables.affiliation)
		.innerJoin(receivingOrganization, eq(receivingOrganization.id, tables.affiliation.organization_id))
		.leftJoin(sendingOrganization, eq(sendingOrganization.id, tables.affiliation.sending_church_id))
		.where(write ? and(predicate, organizationFirst) : predicate)
		.orderBy(tables.affiliation.id);
	const rows = await (write ? query.for("update", { of: tables.affiliation }) : query);
	return rows.map((row) => affiliationSchema.parse(row));
}
export const affiliationJson = affiliationSchema.extend({
	accepted_at: z.coerce.date(),
	ended_at: z.coerce.date().nullable(),
});
export const lockingAffiliations = (predicate: SQL) =>
	sql`SELECT l.id, l.plant_id, l.account_id, l.sending_church_id, l.organization_id, ro.name AS organization_name,
 ro.kind AS organization_kind, so.kind AS subject_kind, l.accepted_at, l.ended_at, l.invitation_id,
 l.revision::text AS revision, l.consent_revision::text AS consent_revision, l.share_people, l.share_meetings,
 l.share_tasks, l.share_ministry_teams, l.share_wiki, l.share_activity, l.shared_findings,
 ${linkLive("l")} AS live, ${linkActive("l")} AS active
 FROM affiliation l JOIN organization ro ON ro.id=l.organization_id LEFT JOIN organization so ON so.id=l.sending_church_id
 WHERE ${predicate} AND EXISTS(SELECT FROM organization o WHERE o.id=l.organization_id FOR NO KEY UPDATE)
 ORDER BY l.id FOR UPDATE OF l`;
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
export const active = (a: Affiliation) => a.active;
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
		writes: SQLWrapper[],
	): Promise<void>;
	invalidate(tx: Transaction, input: { owners: readonly Owner[]; sourceId: string; revision: string }): SQLWrapper;
}
export type RelationshipNotice = {
	eventId: string;
	actorId?: string;
	relationshipId: string;
	pair: RelationshipPair;
	kind: "relationship_approved" | "relationship_ended" | "sharing_changed";
	revision: string;
	operationId: string;
};
type Command = { requestKey: string; expectedRevision: string; input: unknown };
export async function beginCommand(tx: WriteTx, actor: Actor, selected: Owner, name: string, command: Command) {
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
export async function finishCommand<T>(tx: WriteTx, c: NewCommand, result: () => T): Promise<T> {
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
export function invalidate(
	tx: Transaction,
	effects: OrganizationEffects,
	c: NewCommand,
	pair: RelationshipPair,
	id: string,
	rev: string,
) {
	c.writes.push(
		tx
			.update(tables.organization)
			.set({ material_revision: sql<unknown>`(${tables.organization.material_revision} + 1)` })
			.where(eq(tables.organization.id, pair.organization.id)),
		effects.invalidate(tx, { owners: [pair.organization], sourceId: id, revision: rev }),
	);
}
export const witnessHides = (kind: "account" | "plant", id: SQL) =>
	sql<boolean>`EXISTS(SELECT FROM lifecycle_witness w WHERE w.kind=${kind} AND w.opaque_subject_id=${id} AND w.state NOT IN ('active','cancelled'))`;
export const discoveryOpen = (accountId: SQL) =>
	sql<boolean>`EXISTS(SELECT FROM discovery d WHERE d.account_id=${accountId} AND d.converted_at IS NULL)`;
export const seatless = (accountId: SQL) =>
	sql<boolean>`NOT EXISTS(SELECT FROM seat s WHERE s.account_id=${accountId} AND s.ended_at IS NULL)`;
const uuid = (value: string) => sql`${sql.param(value)}::uuid`;
function liveEndpoint(o: Owner): SQL<boolean> {
	if (o.kind === "global") return sql<boolean>`false`;
	if (o.kind === "organization")
		return sql<boolean>`EXISTS(SELECT FROM organization WHERE id=${uuid(o.id)} AND kind=${o.organizationKind})`;
	const root = o.kind === "plant" ? sql`plant` : sql`account`;
	return sql<boolean>`(EXISTS(SELECT FROM ${root} WHERE id=${uuid(o.id)}) AND NOT ${witnessHides(o.kind, uuid(o.id))})`;
}
export function pairLive(pair: RelationshipPair): SQL<boolean> {
	const live = sql<boolean>`(${liveEndpoint(subjectOwner(pair))} AND ${liveEndpoint(pair.organization)})`;
	return pair.kind === "discovery" ? sql<boolean>`(${live} AND ${discoveryOpen(uuid(pair.accountId))})` : live;
}
export const discoveryAuthority = (pair: RelationshipPair) =>
	pair.kind === "discovery"
		? sql<boolean>`(${discoveryOpen(uuid(pair.accountId))} AND ${seatless(uuid(pair.accountId))})`
		: sql<boolean>`true`;
type PairColumns = Record<"plant_id" | "account_id" | "sending_church_id" | "organization_id", SQLWrapper>;
export const pairMatch = (t: PairColumns, pair: RelationshipPair) => {
	const [plant, account, church, organization] = endpointValues(pair);
	const nullable = (v: string | null | undefined) => (v ? uuid(v) : sql`NULL::uuid`);
	return sql`${t.plant_id} IS NOT DISTINCT FROM ${nullable(plant)} AND ${t.account_id} IS NOT DISTINCT FROM ${nullable(account)} AND ${t.sending_church_id} IS NOT DISTINCT FROM ${nullable(church)} AND ${t.organization_id}=${uuid(organization!)}`;
};
