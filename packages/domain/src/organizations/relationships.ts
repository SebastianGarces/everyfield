import { requestWrite } from "../access/session.ts";
import { writeActor } from "./core.ts";
import { eq, sql } from "@everyfield/db/query";
import * as tables from "@everyfield/db/tables";
import { auditSavepoint, setAuditDetails } from "../operations/writes.ts";

import { accountId, recordId, revision, tenantId, type Owner, type sessionId } from "@everyfield/contracts/common";
import type { OrganizationAdapter, RelationshipPair } from "@everyfield/contracts/organizations";
import * as Q from "@everyfield/contracts/organizations";
import type { Transaction } from "@everyfield/db/client";
import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import {
	administrator,
	affiliationSchema,
	appendEvent,
	beginCommand,
	checkRevision,
	currentActor,
	discoveryAuthority,
	discoveryOpen,
	endpointValues,
	finishCommand,
	hash,
	invalidate,
	loadAffiliation,
	loadAffiliations,
	pairLive,
	pairMatch,
	pairOf,
	projection,
	refuse,
	sameOwner,
	seatless,
	subjectOwner,
	witnessHides,
	type Actor,
	type Affiliation,
	type OrganizationEffects,
} from "./core.ts";

const DAY = 86400000;
const invitationFacts = z.object({
	id: recordId,
	recipient_email: z.string(),
	token_hash: z.string(),
	state: z.string(),
	created_at: z.coerce.date(),
	resent_at: z.coerce.date().nullable(),
	revision,
	plant_id: tenantId.nullable(),
	account_id: accountId.nullable(),
	sending_church_id: tenantId.nullable(),
	organization_id: tenantId,
	organization_kind: z.enum(["sending_church", "sending_network"]),
	subject_kind: z.enum(["sending_church", "sending_network"]).nullable(),
	inviter_description: z.string(),
	now: z.coerce.date(),
	/** The session's verified address is the invitation's recipient. */
	addressed: z.boolean(),
	/** Both endpoints exist and are not being deleted; a Discovery subject is still open. */
	pair_live: z.boolean(),
	/** A Discovery subject still acts for itself: open profile, no live seat. True for every other subject. */
	subject_authority: z.boolean(),
	/** The inviter still holds the authority the invitation came from. */
	inviter_live: z.boolean(),
});
type Invite = z.infer<typeof invitationFacts>;
const pairFor = (i: Invite) =>
	Q.relationshipPair.parse({
		kind: i.plant_id ? "plant" : i.account_id ? "discovery" : "sending_church",
		...(i.account_id
			? { accountId: i.account_id }
			: {
					subject: i.plant_id
						? { kind: "plant", id: i.plant_id }
						: { kind: "organization", id: i.sending_church_id, organizationKind: i.subject_kind },
				}),
		organization: { kind: "organization", id: i.organization_id, organizationKind: i.organization_kind },
	});
/**
 * One statement: the relationship invitation with its organizations and every fact an answer or a command checks.
 * A command locks the invitation row; the respond page reads without a lock.
 */
async function loadInvitation(tx: Transaction, id: string, session: z.infer<typeof sessionId>, lock: boolean) {
	const account = sql`r.account_id`;
	const subjectLive = sql`CASE WHEN r.plant_id IS NOT NULL THEN EXISTS(SELECT FROM plant p WHERE p.id=r.plant_id) AND NOT ${witnessHides("plant", sql`r.plant_id`)}
		WHEN r.account_id IS NOT NULL THEN EXISTS(SELECT FROM account a WHERE a.id=r.account_id) AND NOT ${witnessHides("account", account)} AND ${discoveryOpen(account)}
		ELSE s.id IS NOT NULL END`;
	const inviterLive = sql`i.inviter_id IS NOT NULL AND EXISTS(SELECT FROM account a WHERE a.id=i.inviter_id) AND NOT ${witnessHides("account", sql`i.inviter_id`)}
		AND CASE WHEN r.account_id IS NOT NULL THEN i.inviter_id=r.account_id AND ${discoveryOpen(account)} AND ${seatless(account)}
		ELSE EXISTS(SELECT FROM seat s2 WHERE s2.account_id=i.inviter_id AND coalesce(s2.plant_id,s2.organization_id)=coalesce(r.plant_id,r.sending_church_id)
			AND s2.role IN ('owner','admin') AND s2.ended_at IS NULL AND NOT EXISTS(SELECT FROM lifecycle_witness w WHERE w.seat_id=s2.id AND w.state<>'active')) END`;
	const rows = await tx.execute(
		sql`SELECT i.id,i.recipient_email,i.token_hash,i.state,i.created_at,i.resent_at,i.revision,
		r.plant_id,r.account_id,r.sending_church_id,r.organization_id,r.inviter_description,o.kind AS organization_kind,s.kind AS subject_kind,
		clock_timestamp() AS now,coalesce(relationship_recipient(${session})=i.recipient_email,false) AS addressed,
		(${subjectLive}) AS pair_live,
		(r.account_id IS NULL OR (${discoveryOpen(account)} AND ${seatless(account)})) AS subject_authority,
		(${inviterLive}) AS inviter_live
		FROM invitation i JOIN relationship_invitation r ON r.invitation_id=i.id JOIN organization o ON o.id=r.organization_id
		LEFT JOIN organization s ON s.id=r.sending_church_id WHERE i.id=${id}${lock ? sql` FOR UPDATE OF i` : sql``}`,
	);
	return rows.rows[0] ? invitationFacts.parse(rows.rows[0]) : null;
}
function proofMatches(proof: string, digest: string) {
	const a = Buffer.from(hash(proof)),
		b = Buffer.from(digest);
	return a.length === b.length && timingSafeEqual(a, b);
}
/** The receiving organization's Owner or Admin, at the address the invitation went to. */
const authorizedReceiver = (actor: Actor, i: Invite, pair: RelationshipPair) =>
	sameOwner(actor.context.owner, pair.organization) && administrator(actor) && i.addressed;
/** The subject side: its Owner or Admin, or the Discovery account itself while it may still act. */
const actsForSubject = (actor: Actor, pair: RelationshipPair, discovery: boolean) =>
	sameOwner(actor.context.owner, subjectOwner(pair)) && (pair.kind === "discovery" ? discovery : administrator(actor));
const expired = (i: Invite) => i.now.getTime() >= i.created_at.getTime() + 30 * DAY;
const bump = (column: typeof tables.invitation.revision | typeof tables.affiliation.revision) => sql`${column}+1`;
const inviteFacts = z.object({
	now: z.coerce.date(),
	recent: z.number().int(),
	pending: z.boolean(),
	/** This subject already has a pending request out to this address (unique per tenant and address). */
	address_pending: z.boolean(),
	active_pair: z.boolean(),
	pair_live: z.boolean(),
	subject_authority: z.boolean(),
	inviter_name: z.string().nullable(),
});
export function relationshipCommands(
	effects: OrganizationEffects,
): Pick<
	OrganizationAdapter<Transaction>,
	| "associations.invite"
	| "associations.acceptInvitation"
	| "associations.respondInvitation"
	| "associations.declineInvitation"
	| "associations.resendInvitation"
	| "associations.revokeInvitation"
	| "associations.end"
> {
	async function invite(tx: Transaction, session: z.infer<typeof sessionId>, selected: Owner, raw: unknown) {
		return auditSavepoint(tx, async () => {
			const q = Q.inviteRelationshipRequest.parse(raw),
				pair = q.input.pair,
				subject = subjectOwner(pair);
			const actor = await writeActor(tx, session, selected);
			if (
				actor.status !== "active" ||
				!sameOwner(actor.context.owner, subject) ||
				(pair.kind !== "discovery" && !administrator(actor))
			)
				refuse();
			// The write gate locked and read the subject root, the selected owner: its revision and name cost no statement.
			const bound = requestWrite(tx),
				root = subject.kind === "plant" ? bound?.plant : subject.kind === "organization" ? bound?.organization : null,
				rootRevision = subject.kind === "account" ? bound?.account.revision : root?.revision;
			if (rootRevision === undefined) refuse();
			// A real address-budget row serializes cross-workspace invitation admission before the count below.
			const addressKey = hash("relationship-address/" + q.input.recipientEmail),
				addressId =
					addressKey.slice(0, 8) +
					"-" +
					addressKey.slice(8, 12) +
					"-" +
					addressKey.slice(12, 16) +
					"-" +
					addressKey.slice(16, 20) +
					"-" +
					addressKey.slice(20, 32);
			await tx.execute(
				sql`INSERT INTO admission_attempt(id,kind,identifier_hash,workspace_key,reserved_at,state,expires_at) VALUES(${addressId}::uuid,'relationship_invite',${addressKey},'relationship-address',clock_timestamp(),'counted',clock_timestamp()+interval '720 hours') ON CONFLICT(id) DO UPDATE SET expires_at=greatest(admission_attempt.expires_at,excluded.expires_at)`,
			);
			// One statement: the pair's existing link (locked), the address budget, a pending request and both endpoints.
			const facts = inviteFacts.parse(
				(
					await tx.execute(
						sql`WITH a AS (SELECT ended_at FROM affiliation WHERE ${pairMatch(tables.affiliation, pair)} FOR UPDATE)
		SELECT clock_timestamp() AS now,
		(SELECT count(*)::int FROM invitation WHERE recipient_email=${q.input.recipientEmail} AND created_at>clock_timestamp()-interval '30 days') AS recent,
		EXISTS(SELECT FROM invitation i JOIN relationship_invitation ON relationship_invitation.invitation_id=i.id
			WHERE ${pairMatch(tables.relationship_invitation, pair)} AND i.state='pending' AND i.created_at>clock_timestamp()-interval '30 days') AS pending,
		EXISTS(SELECT FROM invitation WHERE tenant_id=${subject.id} AND recipient_email=${q.input.recipientEmail} AND state='pending') AS address_pending,
		coalesce((SELECT bool_or(ended_at IS NULL) FROM a),false) AS active_pair,
		${pairLive(pair)} AS pair_live,${discoveryAuthority(pair)} AS subject_authority,
		${subject.kind === "account" ? sql`relationship_inviter_name(${session})` : sql`NULL`} AS inviter_name`,
					)
				).rows[0],
			);
			if (!facts.pair_live || !facts.subject_authority) refuse();
			const c = await beginCommand(tx, actor, selected, "associations.invite", q);
			if (c.kind === "replay") return Q.invitationResult.parse(c.result);
			checkRevision(q.expectedRevision, revision.parse(rootRevision));
			if (facts.active_pair) refuse("already_active");
			if (facts.recent >= 3) refuse("invitation_limit");
			if (facts.pending) refuse("pending_invitation");
			// One pending request per subject and address (invitation_uq_1): refuse instead of failing the insert.
			if (facts.address_pending) refuse("address_pending");
			const id = randomUUID(),
				expiry = new Date(facts.now.getTime() + 30 * DAY).toISOString(),
				proof = randomBytes(32).toString("base64url");
			const purposes: Record<RelationshipPair["kind"], typeof tables.invitation.$inferInsert.purpose> = {
				plant: pair.organization.organizationKind === "sending_church" ? "plant_church" : "plant_network",
				sending_church: "church_network",
				discovery: pair.organization.organizationKind === "sending_church" ? "discovery_church" : "discovery_network",
			};
			const description =
				subject.kind === "account" ? z.string().trim().min(1).max(500).parse(facts.inviter_name) : root!.name;
			const [plant, account, church] = endpointValues(pair);
			c.writes.push(
				tx.insert(tables.invitation).values({
					id,
					tenant_id: subject.id,
					purpose: purposes[pair.kind],
					recipient_email: q.input.recipientEmail,
					inviter_id: actor.accountId,
					token_hash: hash(proof),
					state: "pending",
					created_at: facts.now,
				}),
				tx.insert(tables.relationship_invitation).values({
					invitation_id: id,
					plant_id: plant,
					account_id: account,
					sending_church_id: church,
					organization_id: pair.organization.id,
					inviter_description: description,
					subject_revision: q.expectedRevision,
				}),
			);
			await appendEvent(tx, c, id, "create", null, "0", "1");
			await effects.invitation(
				tx,
				{
					invitationId: id,
					owner: subject,
					recipientEmail: q.input.recipientEmail,
					proof,
					inviterDescription: description,
					expiresAt: expiry,
					operationId: c.id,
				},
				c.writes,
			);
			return finishCommand(tx, c, () =>
				Q.invitationResult.parse({
					status: "pending",
					invitationId: id,
					pair,
					revision: "1",
					expiresAt: expiry,
					inviterDescription: description,
				}),
			);
		});
	}
	async function decide(
		tx: Transaction,
		session: z.infer<typeof sessionId>,
		selected: Owner,
		raw: unknown,
		name: "associations.acceptInvitation" | "associations.respondInvitation" | "associations.declineInvitation",
	) {
		return auditSavepoint(tx, async () => {
			const q =
				name === "associations.declineInvitation"
					? Q.declineInvitationRequest.parse(raw)
					: name === "associations.acceptInvitation"
						? Q.acceptInvitationRequest.parse(raw)
						: Q.respondInvitationRequest.parse(raw);
			const actor = await writeActor(tx, session, selected);
			const i = await loadInvitation(tx, q.input.invitationId, session, true);
			if (!i) refuse();
			const pair = pairFor(i);
			if (actor.status !== "active" || !i.pair_live || !authorizedReceiver(actor, i, pair)) refuse();
			const c = await beginCommand(tx, actor, selected, name, q);
			if (c.kind === "replay") {
				if (i.state === "accepted") {
					const [a] = await loadAffiliations(tx, pairMatch(tables.affiliation, pair));
					if (!a || a.ended_at !== null) refuse();
				}
				return Q.invitationDecisionResult.parse(c.result);
			}
			checkRevision(q.expectedRevision, i.revision);
			if (i.state !== "pending" || expired(i) || !i.inviter_live) refuse();
			if ("proof" in q.input && !proofMatches(q.input.proof, i.token_hash)) refuse();
			const accept = q.input.decision === "accept",
				next = String(BigInt(i.revision) + 1n);
			c.writes.push(
				tx
					.update(tables.invitation)
					.set({
						state: accept ? "accepted" : "declined",
						acted_at: i.now,
						accepted_account_id: actor.accountId,
						revision: bump(tables.invitation.revision),
					})
					.where(eq(tables.invitation.id, i.id)),
			);
			if (!accept) {
				await appendEvent(tx, c, i.id, "remove", null, i.revision, next);
				return finishCommand(tx, c, () => Q.invitationDecisionResult.parse({ status: "declined", invitationId: i.id }));
			}
			const [prior] = await loadAffiliations(tx, pairMatch(tables.affiliation, pair), true);
			if (prior?.ended_at === null) refuse("already_active");
			const [plant, account, church] = endpointValues(pair);
			// The row as it reads after this write: a rejoin revives the pair's own row, a first approval creates it.
			const a: Affiliation = prior
				? {
						...prior,
						accepted_at: i.now,
						ended_at: null,
						invitation_id: i.id,
						revision: revision.parse(String(BigInt(prior.revision) + 1n)),
						active: true,
					}
				: affiliationSchema.parse({
						id: randomUUID(),
						plant_id: plant,
						account_id: account,
						sending_church_id: church,
						organization_id: pair.organization.id,
						organization_name: "",
						organization_kind: pair.organization.organizationKind,
						subject_kind: pair.kind === "sending_church" ? pair.subject.organizationKind : null,
						accepted_at: i.now,
						ended_at: null,
						invitation_id: i.id,
						revision: "1",
						consent_revision: "1",
						share_people: pair.kind === "plant",
						share_meetings: pair.kind === "plant",
						share_tasks: pair.kind === "plant",
						share_ministry_teams: pair.kind === "plant",
						share_wiki: pair.kind === "plant",
						share_activity: pair.kind === "plant",
						shared_findings: pair.kind === "plant",
						live: true,
						active: true,
					});
			c.writes.push(
				prior
					? tx
							.update(tables.affiliation)
							.set({
								accepted_at: i.now,
								ended_at: null,
								invitation_id: i.id,
								revision: bump(tables.affiliation.revision),
							})
							.where(eq(tables.affiliation.id, a.id))
					: tx.insert(tables.affiliation).values({
							id: a.id,
							plant_id: a.plant_id,
							account_id: a.account_id,
							sending_church_id: a.sending_church_id,
							organization_id: a.organization_id,
							accepted_at: i.now,
							invitation_id: i.id,
							share_people: a.share_people,
							share_meetings: a.share_meetings,
							share_tasks: a.share_tasks,
							share_ministry_teams: a.share_ministry_teams,
							share_wiki: a.share_wiki,
							share_activity: a.share_activity,
							shared_findings: a.shared_findings,
						}),
			);
			const event = await appendEvent(
				tx,
				c,
				a.id,
				"accept",
				"affiliation.approved",
				prior?.revision ?? "0",
				a.revision,
			);
			setAuditDetails(c, event, { pair: pair, sourceInvitationId: i.id }, null);
			invalidate(tx, effects, c, pair, a.id, a.revision);
			c.writes.push(
				effects.notice(tx, {
					eventId: event,
					relationshipId: a.id,
					pair,
					kind: "relationship_approved",
					revision: a.revision,
					operationId: c.id,
				}),
			);
			return finishCommand(tx, c, () =>
				Q.invitationDecisionResult.parse({ status: "accepted", relationship: projection(a) }),
			);
		});
	}
	async function manage(
		tx: Transaction,
		session: z.infer<typeof sessionId>,
		selected: Owner,
		raw: unknown,
		resend: boolean,
	) {
		return auditSavepoint(tx, async () => {
			const q = Q.invitationCommandRequest.parse(raw),
				actor = await writeActor(tx, session, selected),
				i = await loadInvitation(tx, q.input.invitationId, session, true);
			if (!i) refuse();
			const pair = pairFor(i);
			if (actor.status !== "active" || !actsForSubject(actor, pair, i.subject_authority) || !i.pair_live) refuse();
			const c = await beginCommand(
				tx,
				actor,
				selected,
				resend ? "associations.resendInvitation" : "associations.revokeInvitation",
				q,
			);
			if (c.kind === "replay") return resend ? Q.invitationResult.parse(c.result) : Q.mutationResult.parse(c.result);
			checkRevision(q.expectedRevision, i.revision);
			if (i.state !== "pending" || expired(i)) refuse();
			const next = String(BigInt(i.revision) + 1n);
			if (!resend) {
				c.writes.push(
					tx
						.update(tables.invitation)
						.set({ state: "revoked", acted_at: i.now, revision: bump(tables.invitation.revision) })
						.where(eq(tables.invitation.id, i.id)),
				);
				await appendEvent(tx, c, i.id, "revoke", "invitation.revoked", i.revision, next);
				return finishCommand(tx, c, () => Q.mutationResult.parse({ status: "committed" }));
			}
			if (i.now.getTime() - (i.resent_at ?? i.created_at).getTime() < 60000) refuse("resend_cooldown");
			const proof = randomBytes(32).toString("base64url"),
				expiresAt = new Date(i.created_at.getTime() + 30 * DAY).toISOString();
			c.writes.push(
				tx
					.update(tables.invitation)
					.set({ token_hash: hash(proof), resent_at: i.now, revision: bump(tables.invitation.revision) })
					.where(eq(tables.invitation.id, i.id)),
			);
			await appendEvent(tx, c, i.id, "resend", null, i.revision, next);
			await effects.invitation(
				tx,
				{
					invitationId: i.id,
					owner: subjectOwner(pair),
					recipientEmail: i.recipient_email,
					proof,
					inviterDescription: i.inviter_description,
					expiresAt,
					operationId: c.id,
				},
				c.writes,
			);
			return finishCommand(tx, c, () =>
				Q.invitationResult.parse({
					status: "pending",
					invitationId: i.id,
					pair,
					revision: next,
					expiresAt,
					inviterDescription: i.inviter_description,
				}),
			);
		});
	}
	async function end(tx: Transaction, session: z.infer<typeof sessionId>, selected: Owner, raw: unknown) {
		return auditSavepoint(tx, async () => {
			const q = Q.endRelationshipRequest.parse(raw),
				pair = q.input.pair;
			// Shared Discovery conversion order: account, profile, then affiliation. Organization actors take the subject
			// account lock too; the pair alone cannot arbitrate conversion against an organization ending its link.
			if (pair.kind === "discovery") {
				await tx
					.select({ id: tables.account.id })
					.from(tables.account)
					.where(eq(tables.account.id, pair.accountId))
					.for("update");
				await tx
					.select({ id: tables.discovery.id })
					.from(tables.discovery)
					.where(eq(tables.discovery.account_id, pair.accountId))
					.for("update");
			}
			const actor = await writeActor(tx, session, selected);
			const a = await loadAffiliation(tx, q.input.relationshipId, true);
			if (
				!a ||
				actor.status !== "active" ||
				!a.live ||
				JSON.stringify(pairOf(a)) !== JSON.stringify(pair) ||
				!(actsForSubject(actor, pair, true) || (sameOwner(selected, pair.organization) && administrator(actor)))
			)
				refuse();
			const c = await beginCommand(tx, actor, selected, "associations.end", q);
			if (c.kind === "replay") return Q.mutationResult.parse(c.result);
			if (a.ended_at !== null) return finishCommand(tx, c, () => Q.mutationResult.parse({ status: "committed" }));
			checkRevision(q.expectedRevision, a.revision);
			const next = String(BigInt(a.revision) + 1n);
			c.writes.push(
				tx
					.update(tables.affiliation)
					.set({ ended_at: sql`clock_timestamp()`, revision: bump(tables.affiliation.revision) })
					.where(eq(tables.affiliation.id, a.id)),
			);
			const event = await appendEvent(tx, c, a.id, "remove", "affiliation.ended", a.revision, next);
			setAuditDetails(c, event, { pair, sourceInvitationId: a.invitation_id }, q.input.reason);
			invalidate(tx, effects, c, pair, a.id, next);
			c.writes.push(
				effects.notice(tx, {
					eventId: event,
					relationshipId: a.id,
					pair,
					kind: "relationship_ended",
					revision: next,
					operationId: c.id,
				}),
			);
			return finishCommand(tx, c, () => Q.mutationResult.parse({ status: "committed" }));
		});
	}
	return {
		"associations.invite": invite,
		"associations.acceptInvitation": async (tx, s, o, q) =>
			Q.acceptedInvitationResult.parse(await decide(tx, s, o, q, "associations.acceptInvitation")),
		"associations.respondInvitation": (tx, s, o, q) => decide(tx, s, o, q, "associations.respondInvitation"),
		"associations.declineInvitation": async (tx, s, o, q) =>
			Q.declinedInvitationResult.parse(await decide(tx, s, o, q, "associations.declineInvitation")),
		"associations.resendInvitation": async (tx, s, o, q) => Q.invitationResult.parse(await manage(tx, s, o, q, true)),
		"associations.revokeInvitation": async (tx, s, o, q) => Q.mutationResult.parse(await manage(tx, s, o, q, false)),
		"associations.end": end,
	};
}

const invitationDetailRequest = z.strictObject({ invitationId: recordId, proof: z.string().min(1).max(4096) });

/**
 * Bounded invitation-detail read for the native answer page (WP-007/ui ruling D48). Before any detail leaves, it
 * applies the same checks as an answer: the emailed proof, a live valid pair, the shipped authorizedReceiver rule
 * (exact receiving organization, Owner or Admin, original addressed recipient), a pending unexpired request and a
 * live inviter. Anything else is the one `unavailable` result. It reads only. Follow-up: make it a contract operation.
 */
export async function readAnswerableInvitation(
	tx: Transaction,
	session: z.infer<typeof sessionId>,
	selected: Owner,
	raw: unknown,
) {
	const q = invitationDetailRequest.safeParse(raw);
	if (!q.success) return { status: "unavailable" } as const;
	// A read: nothing is locked; the answer command re-reads and locks what it changes.
	const i = await loadInvitation(tx, q.data.invitationId, session, false);
	if (!i || !proofMatches(q.data.proof, i.token_hash)) return { status: "unavailable" } as const;
	const pair = pairFor(i),
		actor = await currentActor(tx, session, selected);
	if (actor.status !== "active" || !i.pair_live || !authorizedReceiver(actor, i, pair))
		return { status: "unavailable" } as const;
	if (i.state !== "pending" || expired(i) || !i.inviter_live) return { status: "unavailable" } as const;
	return Q.invitationResult.parse({
		status: "pending",
		invitationId: i.id,
		pair,
		revision: i.revision,
		expiresAt: new Date(i.created_at.getTime() + 30 * DAY).toISOString(),
		inviterDescription: i.inviter_description,
	});
}
