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
import { and, eq, getTableColumns, isNull, sql, type SQL, type SQLWrapper } from "@everyfield/db/query";
import * as tables from "@everyfield/db/tables";
import { currentActor, liveOwner } from "@everyfield/domain/access";
import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { canonical } from "../operations/canonical.ts";
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
export async function subjectAuthority(
	tx: Transaction,
	actor: Actor,
	pair: RelationshipPair,
	lock = true,
): Promise<boolean> {
	if (!sameOwner(actor.context.owner, subjectOwner(pair))) return false;
	if (pair.kind !== "discovery") return administrator(actor);
	const discovery = tx
		.select({ id: tables.discovery.id })
		.from(tables.discovery)
		.where(and(eq(tables.discovery.account_id, pair.accountId), isNull(tables.discovery.converted_at)));
	const seats = tx
		.select({ id: tables.seat.id })
		.from(tables.seat)
		.where(and(eq(tables.seat.account_id, pair.accountId), isNull(tables.seat.ended_at)));
	const d = await (lock ? discovery.for("share") : discovery);
	const s = await (lock ? seats.for("share") : seats);
	return d.length === 1 && s.length === 0;
}
/** Both endpoints exist and are not being deleted. A write locks them; a read observes. */
export async function validPair(tx: Transaction, pair: RelationshipPair, lock = true) {
	if (!(await liveOwner(tx, subjectOwner(pair), lock)) || !(await liveOwner(tx, pair.organization, lock))) return false;
	if (pair.kind === "discovery") {
		const discovery = tx
			.select({ id: tables.discovery.id })
			.from(tables.discovery)
			.where(and(eq(tables.discovery.account_id, pair.accountId), isNull(tables.discovery.converted_at)));
		return (await (lock ? discovery.for("share") : discovery)).length === 1;
	}
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
	/** Computed by loadAffiliations: no lifecycle witness on the link or any endpoint, and a Discovery subject still open. */
	live: z.boolean(),
	/** Computed by loadAffiliations: live, not ended and accepted. */
	active: z.boolean(),
});
export type Affiliation = z.infer<typeof affiliationSchema>;
const receivingOrganization = alias(tables.organization, "receiving_organization");
const sendingOrganization = alias(tables.organization, "sending_organization");
/** A pool or a transaction: a read needs no transaction. */
export type Reader = Pick<Transaction, "select" | "execute">;
/**
 * Lock order shared by every write on a link: the organization, then the link. An organization's write gate locks the
 * organization before its command body; a subject-side write updates the organization's material revision after the
 * link. This filter takes the organization lock before the row lock in the same statement, so both sides queue on
 * the organization instead of deadlocking.
 */
const organizationFirst = sql<boolean>`EXISTS(SELECT FROM organization o WHERE o.id=${tables.affiliation.organization_id} FOR NO KEY UPDATE)`;
/** Affiliations with their names and a computed `active` flag. A write locks the rows; a read takes no lock. */
export async function loadAffiliations(tx: Reader, predicate: SQL, write = false) {
	const live = sql<boolean>`(NOT EXISTS(SELECT FROM lifecycle_witness w WHERE w.state NOT IN ('active','cancelled') AND (w.affiliation_id=${tables.affiliation.id} OR (w.opaque_subject_id IN (${tables.affiliation.organization_id},${tables.affiliation.plant_id},${tables.affiliation.account_id},${tables.affiliation.sending_church_id}) AND w.kind IN ('account','plant','organization')))) AND (${tables.affiliation.account_id} IS NULL OR EXISTS(SELECT FROM discovery d WHERE d.account_id=${tables.affiliation.account_id} AND d.converted_at IS NULL)))`;
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
/** The live flag loadAffiliations computed in the same statement that read the row. */
export const active = (a: Affiliation) => a.active;
export interface OrganizationEffects {
	/** Queue the invitation mail into `writes`, the command's single write statement (D70). */
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
	/** One job row for the coarse notice. The command runs it inside its single write statement (D70). */
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
	): SQLWrapper;
	/** Stops queued work that read the old grant. Runs inside the command's single write statement (D70). */
	invalidate(tx: Transaction, input: { owners: readonly Owner[]; sourceId: string; revision: string }): SQLWrapper;
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
/** Queue the organization's material bump and the stale-work supersede into the command's write statement. */
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
/** SQL fragments for one-statement fact reads: the checks validPair and subjectAuthority make, as boolean columns. */
export const witnessHides = (kind: "account" | "plant", id: SQL) =>
	sql<boolean>`EXISTS(SELECT FROM lifecycle_witness w WHERE w.kind=${kind} AND w.opaque_subject_id=${id} AND w.state NOT IN ('active','cancelled'))`;
export const discoveryOpen = (accountId: SQL) =>
	sql<boolean>`EXISTS(SELECT FROM discovery d WHERE d.account_id=${accountId} AND d.converted_at IS NULL)`;
export const seatless = (accountId: SQL) =>
	sql<boolean>`NOT EXISTS(SELECT FROM seat s WHERE s.account_id=${accountId} AND s.ended_at IS NULL)`;
const uuid = (value: string) => sql`${sql.param(value)}::uuid`;
/** The endpoint root exists with that kind and no lifecycle witness hides it. Organizations carry no witness. */
export function liveEndpoint(o: Owner): SQL<boolean> {
	if (o.kind === "global") return sql<boolean>`false`;
	if (o.kind === "organization")
		return sql<boolean>`EXISTS(SELECT FROM organization WHERE id=${uuid(o.id)} AND kind=${o.organizationKind})`;
	const root = o.kind === "plant" ? sql`plant` : sql`account`;
	return sql<boolean>`(EXISTS(SELECT FROM ${root} WHERE id=${uuid(o.id)}) AND NOT ${witnessHides(o.kind, uuid(o.id))})`;
}
/** Both endpoints exist and are not being deleted, and a Discovery subject is still open: validPair in one column. */
export function pairLive(pair: RelationshipPair): SQL<boolean> {
	const live = sql<boolean>`(${liveEndpoint(subjectOwner(pair))} AND ${liveEndpoint(pair.organization)})`;
	return pair.kind === "discovery" ? sql<boolean>`(${live} AND ${discoveryOpen(uuid(pair.accountId))})` : live;
}
/** The subject may act for a discovery pair only while the profile is open and the account holds no live seat. */
export const discoveryAuthority = (pair: RelationshipPair) =>
	pair.kind === "discovery"
		? sql<boolean>`(${discoveryOpen(uuid(pair.accountId))} AND ${seatless(uuid(pair.accountId))})`
		: sql<boolean>`true`;
type PairColumns = Record<"plant_id" | "account_id" | "sending_church_id" | "organization_id", SQLWrapper>;
/** The rows of this exact pair in `affiliation` or `relationship_invitation`. */
export const pairMatch = (t: PairColumns, pair: RelationshipPair) => {
	const [plant, account, church, organization] = endpointValues(pair);
	const nullable = (v: string | null | undefined) => (v ? uuid(v) : sql`NULL::uuid`);
	return sql`${t.plant_id} IS NOT DISTINCT FROM ${nullable(plant)} AND ${t.account_id} IS NOT DISTINCT FROM ${nullable(account)} AND ${t.sending_church_id} IS NOT DISTINCT FROM ${nullable(church)} AND ${t.organization_id}=${uuid(organization!)}`;
};
