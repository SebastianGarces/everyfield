import { alias } from "@everyfield/db/columns";
import { getTableColumns, and, eq, gt, isNull, sql } from "@everyfield/db/query";
import * as tables from "@everyfield/db/tables";

import { randomBytes, timingSafeEqual } from "node:crypto";
import type { Transaction } from "@everyfield/db/client";
import { z } from "zod";
import { recordId, accountId, tenantId, revision, type Owner, type sessionId } from "@everyfield/contracts/common";
import * as Q from "@everyfield/contracts/organizations";
import type { OrganizationAdapter, RelationshipPair } from "@everyfield/contracts/organizations";
import {
	administrator,
	appendEvent,
	beginCommand,
	checkRevision,
	currentActor,
	endpointValues,
	finishCommand,
	hash,
	invalidate,
	loadAffiliation,
	liveOwner,
	lock,
	pairOf,
	projection,
	refuse,
	sameOwner,
	subjectAuthority,
	subjectOwner,
	validPair,
	type Actor,
	type OrganizationEffects,
} from "./core.ts";

const invitationRow = z.object({
	id: recordId,
	tenant_id: tenantId,
	recipient_email: z.string(),
	inviter_id: accountId.nullable(),
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
	subject_revision: revision,
});
type Invite = z.infer<typeof invitationRow>;
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
const receivingOrganization = alias(tables.organization, "receiving_organization");
const sendingOrganization = alias(tables.organization, "sending_organization");
async function loadInvitation(tx: Transaction, id: string) {
	const rows = await tx
		.select({
			...getTableColumns(tables.invitation),
			...getTableColumns(tables.relationship_invitation),
			revision: tables.invitation.revision,
			organization_kind: receivingOrganization.kind,
			subject_kind: sendingOrganization.kind,
		})
		.from(tables.invitation)
		.innerJoin(tables.relationship_invitation, eq(tables.relationship_invitation.invitation_id, tables.invitation.id))
		.innerJoin(receivingOrganization, eq(receivingOrganization.id, tables.relationship_invitation.organization_id))
		.leftJoin(sendingOrganization, eq(sendingOrganization.id, tables.relationship_invitation.sending_church_id))
		.where(eq(tables.invitation.id, id))
		.for("update", { of: tables.invitation });
	return rows[0] ? invitationRow.parse(rows[0]) : null;
}
async function assertInviter(tx: Transaction, i: Invite, pair: RelationshipPair) {
	if (!i.inviter_id || !(await liveOwner(tx, { kind: "account", id: i.inviter_id }))) return false;
	if (pair.kind === "discovery")
		return (
			i.inviter_id === pair.accountId &&
			(
				await tx
					.select({ id: tables.discovery.id })
					.from(tables.discovery)
					.where(and(eq(tables.discovery.account_id, pair.accountId), isNull(tables.discovery.converted_at)))
					.for("share")
			).length === 1 &&
			!(
				await tx
					.select({ id: tables.seat.id })
					.from(tables.seat)
					.where(and(eq(tables.seat.account_id, pair.accountId), isNull(tables.seat.ended_at)))
					.for("share")
			).length
		);
	return (
		(
			await tx
				.select({ id: tables.seat.id })
				.from(tables.seat)
				.where(
					and(
						and(
							and(
								and(
									eq(tables.seat.account_id, i.inviter_id),
									eq(sql<string>`coalesce(${tables.seat.plant_id}, ${tables.seat.organization_id})`, pair.subject.id),
								),
								sql<boolean>`(${tables.seat.role} IN ('owner', 'admin'))`,
							),
							isNull(tables.seat.ended_at),
						),
						sql<unknown>`(NOT exists(SELECT  FROM lifecycle_witness  AS w  WHERE ((w .seat_id = seat .id) AND (w .state != ('active')))))`,
					),
				)
				.for("share")
		).length === 1
	);
}
async function time(tx: Transaction) {
	return new Date((await tx.execute<{ now: string }>(sql`SELECT clock_timestamp() AS now`)).rows[0]!.now);
}
function proofMatches(proof: string, digest: string) {
	const a = Buffer.from(hash(proof)),
		b = Buffer.from(digest);
	return a.length === b.length && timingSafeEqual(a, b);
}
async function addressed(tx: Transaction, session: z.infer<typeof sessionId>, i: Invite) {
	return (
		(await tx.execute(sql`SELECT relationship_recipient(${session}) AS email`)).rows[0]?.email === i.recipient_email
	);
}
async function authorizedReceiver(
	tx: Transaction,
	actor: Actor,
	i: Invite,
	pair: RelationshipPair,
	session: z.infer<typeof sessionId>,
) {
	return sameOwner(actor.context.owner, pair.organization) && administrator(actor) && (await addressed(tx, session, i));
}
async function findPair(tx: Transaction, pair: RelationshipPair) {
	const r = await tx.execute(
		sql`SELECT id FROM affiliation WHERE plant_id IS NOT DISTINCT FROM ${sql.param(endpointValues(pair)[0])}::uuid AND account_id IS NOT DISTINCT FROM ${sql.param(endpointValues(pair)[1])}::uuid AND sending_church_id IS NOT DISTINCT FROM ${sql.param(endpointValues(pair)[2])}::uuid AND organization_id=${sql.param(endpointValues(pair)[3])} FOR UPDATE`,
	);
	return r.rows[0] ? loadAffiliation(tx, recordId.parse(r.rows[0].id), true) : null;
}
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
		const q = Q.inviteRelationshipRequest.parse(raw),
			pair = q.input.pair;
		await lock(tx, "pair/" + JSON.stringify(endpointValues(pair)));
		const actor = await currentActor(tx, session, selected);
		if (actor.status !== "active" || !(await subjectAuthority(tx, actor, pair)) || !(await validPair(tx, pair)))
			refuse();
		const c = await beginCommand(tx, actor, selected, "associations.invite", q);
		if (c.kind === "replay") return Q.invitationResult.parse(c.result);
		const subject = subjectOwner(pair);
		const table = subject.kind === "plant" ? "plant" : subject.kind === "account" ? "account" : "organization";
		const root = await tx.execute<{ revision: string; name?: string }>(
			sql`SELECT revision${sql.raw(subject.kind === "account" ? "" : ",name")} FROM ${sql.raw(table)} WHERE id=${sql.param(subject.id)} FOR SHARE`,
		);
		checkRevision(q.expectedRevision, revision.parse(root.rows[0]?.revision));
		if ((await findPair(tx, pair))?.ended_at === null) refuse("already_active");
		await lock(tx, "invite-address/" + q.input.recipientEmail);
		const limit = await tx
			.select({ count: sql<number>`(count(*))::int` })
			.from(tables.invitation)
			.where(
				and(
					eq(tables.invitation.recipient_email, q.input.recipientEmail),
					gt(tables.invitation.created_at, sql<unknown>`(clock_timestamp() - ('30 days')::interval)`),
				),
			);
		if (limit[0]!.count >= 3) refuse("invitation_limit");
		const pending = await tx.execute(
			sql`SELECT i.id FROM invitation i JOIN relationship_invitation r ON r.invitation_id=i.id WHERE r.plant_id IS NOT DISTINCT FROM ${sql.param(endpointValues(pair)[0])}::uuid AND r.account_id IS NOT DISTINCT FROM ${sql.param(endpointValues(pair)[1])}::uuid
      AND r.sending_church_id IS NOT DISTINCT FROM ${sql.param(endpointValues(pair)[2])}::uuid AND r.organization_id=${sql.param(endpointValues(pair)[3])} AND i.state='pending' AND i.created_at>clock_timestamp()-interval '30 days'`,
		);
		if (pending.rowCount) refuse("pending_invitation");
		const now = await time(tx),
			expiry = new Date(now.getTime() + 30 * 86400000).toISOString(),
			proof = randomBytes(32).toString("base64url");
		const purposes: Record<RelationshipPair["kind"], typeof tables.invitation.$inferInsert.purpose> = {
			plant: pair.organization.organizationKind === "sending_church" ? "plant_church" : "plant_network",
			sending_church: "church_network",
			discovery: pair.organization.organizationKind === "sending_church" ? "discovery_church" : "discovery_network",
		};
		const description =
			subject.kind === "account"
				? z
						.string()
						.trim()
						.min(1)
						.max(500)
						.parse((await tx.execute(sql`SELECT relationship_inviter_name(${session}) AS name`)).rows[0]?.name)
				: root.rows[0]!.name!;
		const inserted = await tx
			.insert(tables.invitation)
			.values({
				tenant_id: subject.id,
				purpose: purposes[pair.kind],
				recipient_email: q.input.recipientEmail,
				inviter_id: actor.accountId,
				token_hash: hash(proof),
				state: "pending",
				created_at: sql`${now}`,
			})
			.returning({ id: tables.invitation.id });
		const id = inserted[0]!.id;
		await tx.insert(tables.relationship_invitation).values({
			invitation_id: id,
			plant_id: endpointValues(pair)[0],
			account_id: endpointValues(pair)[1],
			sending_church_id: endpointValues(pair)[2],
			organization_id: pair.organization.id,
			inviter_description: description,
			subject_revision: q.expectedRevision,
		});
		const event = await appendEvent(tx, c, id, "create", null, "0", "1");
		await effects.invitation(tx, {
			invitationId: id,
			owner: subject,
			recipientEmail: q.input.recipientEmail,
			proof,
			inviterDescription: description,
			expiresAt: expiry,
			operationId: c.id,
		});
		return finishCommand(
			tx,
			c,
			(r) =>
				Q.invitationResult.parse({
					status: "pending",
					invitationId: id,
					pair,
					revision: "1",
					expiresAt: expiry,
					inviterDescription: description,
					receipt: r,
				}),
			[event],
		);
	}
	async function decide(
		tx: Transaction,
		session: z.infer<typeof sessionId>,
		selected: Owner,
		raw: unknown,
		name: "associations.acceptInvitation" | "associations.respondInvitation" | "associations.declineInvitation",
	) {
		const q =
			name === "associations.declineInvitation"
				? Q.declineInvitationRequest.parse(raw)
				: name === "associations.acceptInvitation"
					? Q.acceptInvitationRequest.parse(raw)
					: Q.respondInvitationRequest.parse(raw);
		// Address rows stay locked through decision, proof rotation and receipt commit.
		const i = await loadInvitation(tx, q.input.invitationId);
		if (!i) refuse();
		const pair = pairFor(i);
		await lock(tx, "pair/" + JSON.stringify(endpointValues(pair)));
		const actor = await currentActor(tx, session, selected);
		if (
			actor.status !== "active" ||
			!(await validPair(tx, pair)) ||
			!(await authorizedReceiver(tx, actor, i, pair, session))
		)
			refuse();
		const c = await beginCommand(tx, actor, selected, name, q);
		if (c.kind === "replay") {
			if (i.state === "accepted") {
				const a = await findPair(tx, pair);
				if (!a || a.ended_at !== null) refuse();
			}
			return Q.invitationDecisionResult.parse(c.result);
		}
		checkRevision(q.expectedRevision, i.revision);
		if (
			i.state !== "pending" ||
			(await time(tx)).getTime() >= i.created_at.getTime() + 30 * 86400000 ||
			!(await assertInviter(tx, i, pair))
		)
			refuse();
		if ("proof" in q.input && !proofMatches(q.input.proof, i.token_hash)) refuse();
		const accept = q.input.decision === "accept";
		await tx
			.update(tables.invitation)
			.set({
				state: accept ? "accepted" : "declined",
				acted_at: sql<Date>`clock_timestamp()`.mapWith((value: string) => new Date(value)),
				accepted_account_id: actor.accountId,
				revision: sql<unknown>`(${tables.invitation.revision} + 1)`,
			})
			.where(eq(tables.invitation.id, i.id));
		if (!accept) {
			const event = await appendEvent(tx, c, i.id, "remove", null, i.revision, String(BigInt(i.revision) + 1n));
			return finishCommand(
				tx,
				c,
				(r) => Q.invitationDecisionResult.parse({ status: "declined", invitationId: i.id, receipt: r }),
				[event],
			);
		}
		let a = await findPair(tx, pair);
		if (a?.ended_at === null) refuse("already_active");
		const previous = a?.revision ?? "0";
		if (a)
			await tx
				.update(tables.affiliation)
				.set({
					accepted_at: sql<Date>`clock_timestamp()`.mapWith((value: string) => new Date(value)),
					ended_at: null,
					invitation_id: i.id,
					revision: sql<unknown>`(${tables.affiliation.revision} + 1)`,
				})
				.where(eq(tables.affiliation.id, a.id));
		else {
			const r = await tx
				.insert(tables.affiliation)
				.values({
					plant_id: endpointValues(pair)[0],
					account_id: endpointValues(pair)[1],
					sending_church_id: endpointValues(pair)[2],
					organization_id: pair.organization.id,
					accepted_at: sql`clock_timestamp()`,
					invitation_id: i.id,
					share_people: pair.kind === "plant",
					share_meetings: pair.kind === "plant",
					share_tasks: pair.kind === "plant",
					share_ministry_teams: pair.kind === "plant",
					share_wiki: pair.kind === "plant",
					share_activity: pair.kind === "plant",
					shared_findings: pair.kind === "plant",
				})
				.returning({ id: tables.affiliation.id });
			a = await loadAffiliation(tx, r[0]!.id, true);
		}
		if (!a) refuse();
		a = (await loadAffiliation(tx, a.id, true))!;
		const event = await appendEvent(tx, c, a.id, "accept", "affiliation.approved", previous, a.revision);
		c.writes.push(
			tx
				.insert(tables.relationship_history)
				.values({ id: event, relationship_id: a.id, pair: pair, reason: null, source_invitation_id: i.id }),
		);
		await invalidate(tx, effects, pair, a.id, a.revision);
		await effects.notice(tx, {
			eventId: event,
			relationshipId: a.id,
			pair,
			kind: "relationship_approved",
			revision: a.revision,
			operationId: c.id,
		});
		return finishCommand(
			tx,
			c,
			(r) => Q.invitationDecisionResult.parse({ status: "accepted", relationship: projection(a), receipt: r }),
			[event],
		);
	}
	async function manage(
		tx: Transaction,
		session: z.infer<typeof sessionId>,
		selected: Owner,
		raw: unknown,
		resend: boolean,
	) {
		const q = Q.invitationCommandRequest.parse(raw),
			i = await loadInvitation(tx, q.input.invitationId);
		if (!i) refuse();
		const pair = pairFor(i),
			actor = await currentActor(tx, session, selected);
		if (actor.status !== "active" || !(await subjectAuthority(tx, actor, pair)) || !(await validPair(tx, pair)))
			refuse();
		const c = await beginCommand(
			tx,
			actor,
			selected,
			resend ? "associations.resendInvitation" : "associations.revokeInvitation",
			q,
		);
		if (c.kind === "replay") return resend ? Q.invitationResult.parse(c.result) : Q.mutationResult.parse(c.result);
		checkRevision(q.expectedRevision, i.revision);
		const now = await time(tx);
		if (i.state !== "pending" || now.getTime() >= i.created_at.getTime() + 30 * 86400000) refuse();
		const next = String(BigInt(i.revision) + 1n);
		if (!resend) {
			await tx
				.update(tables.invitation)
				.set({
					state: "revoked",
					acted_at: sql<Date>`clock_timestamp()`.mapWith((value: string) => new Date(value)),
					revision: sql<unknown>`(${tables.invitation.revision} + 1)`,
				})
				.where(eq(tables.invitation.id, i.id));
			const event = await appendEvent(tx, c, i.id, "revoke", "invitation.revoked", i.revision, next);
			return finishCommand(tx, c, (r) => Q.mutationResult.parse({ status: "committed", receipt: r }), [event]);
		}
		if (now.getTime() - (i.resent_at ?? i.created_at).getTime() < 60000) refuse("resend_cooldown");
		const proof = randomBytes(32).toString("base64url"),
			expiresAt = new Date(i.created_at.getTime() + 30 * 86400000).toISOString();
		await tx
			.update(tables.invitation)
			.set({
				token_hash: hash(proof),
				resent_at: sql<Date>`clock_timestamp()`.mapWith((value: string) => new Date(value)),
				revision: sql<unknown>`(${tables.invitation.revision} + 1)`,
			})
			.where(eq(tables.invitation.id, i.id));
		const event = await appendEvent(tx, c, i.id, "resend", null, i.revision, next);
		await effects.invitation(tx, {
			invitationId: i.id,
			owner: subjectOwner(pair),
			recipientEmail: i.recipient_email,
			proof,
			inviterDescription: i.inviter_description,
			expiresAt,
			operationId: c.id,
		});
		return finishCommand(
			tx,
			c,
			(r) =>
				Q.invitationResult.parse({
					status: "pending",
					invitationId: i.id,
					pair,
					revision: next,
					expiresAt,
					inviterDescription: i.inviter_description,
					receipt: r,
				}),
			[event],
		);
	}
	async function end(tx: Transaction, session: z.infer<typeof sessionId>, selected: Owner, raw: unknown) {
		const q = Q.endRelationshipRequest.parse(raw);
		// Shared Discovery conversion order: account, profile, then affiliation.
		// Organization actors take the subject account lock too; the pair alone
		// cannot arbitrate conversion against an organization ending its link.
		if (q.input.pair.kind === "discovery") {
			await tx
				.select({ id: tables.account.id })
				.from(tables.account)
				.where(eq(tables.account.id, q.input.pair.accountId))
				.for("update");
			await tx
				.select({ id: tables.discovery.id })
				.from(tables.discovery)
				.where(eq(tables.discovery.account_id, q.input.pair.accountId))
				.for("update");
		}
		await lock(tx, "pair/" + JSON.stringify(endpointValues(q.input.pair)));
		const a = await loadAffiliation(tx, q.input.relationshipId, true),
			actor = await currentActor(tx, session, selected);
		if (
			!a ||
			actor.status !== "active" ||
			JSON.stringify(pairOf(a)) !== JSON.stringify(q.input.pair) ||
			!(await validPair(tx, q.input.pair)) ||
			!(
				(await subjectAuthority(tx, actor, q.input.pair)) ||
				(sameOwner(selected, q.input.pair.organization) && administrator(actor))
			)
		)
			refuse();
		const c = await beginCommand(tx, actor, selected, "associations.end", q);
		if (c.kind === "replay") return Q.mutationResult.parse(c.result);
		if (a.ended_at !== null)
			return finishCommand(tx, c, (r) => Q.mutationResult.parse({ status: "committed", receipt: r }), [], false);
		checkRevision(q.expectedRevision, a.revision);
		await tx
			.update(tables.affiliation)
			.set({
				ended_at: sql<Date>`clock_timestamp()`.mapWith((value: string) => new Date(value)),
				revision: sql<unknown>`(${tables.affiliation.revision} + 1)`,
			})
			.where(eq(tables.affiliation.id, a.id));
		const next = String(BigInt(a.revision) + 1n),
			event = await appendEvent(tx, c, a.id, "remove", "affiliation.ended", a.revision, next);
		c.writes.push(
			tx.insert(tables.relationship_history).values({
				id: event,
				relationship_id: a.id,
				pair: q.input.pair,
				reason: q.input.reason,
				source_invitation_id: a.invitation_id,
			}),
		);
		await invalidate(tx, effects, q.input.pair, a.id, next);
		await effects.notice(tx, {
			eventId: event,
			relationshipId: a.id,
			pair: q.input.pair,
			kind: "relationship_ended",
			revision: next,
			operationId: c.id,
		});
		return finishCommand(tx, c, (r) => Q.mutationResult.parse({ status: "committed", receipt: r }), [event]);
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
const pendingInvitation = Q.invitationResult.omit({ receipt: true });

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
	const i = await loadInvitation(tx, q.data.invitationId);
	if (!i || !proofMatches(q.data.proof, i.token_hash)) return { status: "unavailable" } as const;
	const pair = pairFor(i),
		actor = await currentActor(tx, session, selected);
	if (
		actor.status !== "active" ||
		!(await validPair(tx, pair)) ||
		!(await authorizedReceiver(tx, actor, i, pair, session))
	)
		return { status: "unavailable" } as const;
	const expires = i.created_at.getTime() + 30 * 86400000;
	if (i.state !== "pending" || (await time(tx)).getTime() >= expires || !(await assertInviter(tx, i, pair)))
		return { status: "unavailable" } as const;
	return pendingInvitation.parse({
		status: "pending",
		invitationId: i.id,
		pair,
		revision: i.revision,
		expiresAt: new Date(expires).toISOString(),
		inviterDescription: i.inviter_description,
	});
}
