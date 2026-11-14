import type { Database } from "@everyfield/db/client";
import { sql } from "@everyfield/db/query";
import { createSeatService } from "@everyfield/domain/identity";
import { invitationRevokedResult, invitationSentResult, inviteSeatRequest } from "@everyfield/contracts/identity";
import { z } from "zod";
import type { EvryActor } from "../../../context/actor.ts";
import { change, nativeWrite, notes, plantAdmin, target } from "../../native.ts";

// The seat reviewed writes: invite someone, resend or revoke a pending invitation, change a seat's role and remove a
// seat. Each runs the seat or invitation command the Settings > Seats screen runs, on the executor's transaction, so
// the change, its audit row and the invitation email in the outbox commit with the proposal outcome.

/** A seat role a person can be given: the Owner is never invited, changed or removed here. */
const ordinaryRole = z.enum(["admin", "member"]);
const plant = (actor: EvryActor) => sql`FROM plant pl WHERE pl.id=${actor.owner.id}::uuid`;
const church = target("church", sql`pl.id`, sql`pl.name`);
const ROLE_TEXT = { admin: "an Admin", member: "a Member" } as const;
/** A pending seat invitation of this church that has not lapsed, as `i`. */
const invitation = (actor: EvryActor, id: string) =>
	sql`FROM invitation i WHERE i.id=${id}::uuid AND i.tenant_id=${actor.owner.id}::uuid AND i.purpose='seat'
		AND i.state='pending' AND i.created_at>clock_timestamp()-interval '720 hours'`;
/** A live ordinary seat of this church with its holder's name, as `s` and `n`. */
const seat = (actor: EvryActor, id: string) =>
	sql`FROM seat s CROSS JOIN LATERAL seat_identity(s.account_id) n WHERE s.id=${id}::uuid AND s.plant_id=${actor.owner.id}::uuid
		AND s.ended_at IS NULL AND s.role IN ('admin','member')`;
const seatOf = sql`jsonb_build_object('kind','seat','id',s.id,'label',n.display_name)`;
const invitationOf = sql`jsonb_build_object('kind','invitation','id',i.id,'label',i.recipient_email)`;

export const invite = nativeWrite({
	operation: "seats.invite",
	description:
		"Propose inviting someone by email to a seat in this church as an Admin or a Member. Nothing is sent until the user approves the exact review.",
	input: z.strictObject({ email: inviteSeatRequest.shape.input.shape.recipientEmail, role: ordinaryRole }),
	allowed: plantAdmin,
	review(actor, value) {
		return sql`SELECT jsonb_build_object('target',${church},'changes',jsonb_build_array(
				${change("invitation", sql`'null'::jsonb`, value.email)},${change("role", sql`'null'::jsonb`, value.role)}),
				'notes',${notes([`Everyfield emails ${value.email} a link to join as ${ROLE_TEXT[value.role]}. It works for 30 days.`])}) AS review,
			jsonb_build_object('expectedRevision',pl.revision::text,'input',jsonb_build_object('workspace',jsonb_build_object('kind','plant','id',pl.id),
				'recipientEmail',${value.email}::text,'role',${value.role}::text)) AS args
			${plant(actor)}`;
	},
	async run(tx, _context, request, { authority, ports }) {
		const sent = invitationSentResult.parse(await ports.invitations(tx).invite(authority, request));
		return { receiptId: sent.invitation.invitationId, revision: sent.invitation.revision };
	},
});

export const resendInvitation = nativeWrite({
	operation: "seats.resendInvitation",
	description:
		"Propose emailing a pending seat invitation again with a new link; the old link stops working. Nothing is sent until the user approves the exact review.",
	input: z.strictObject({ invitationId: z.uuid() }),
	allowed: plantAdmin,
	review(actor, value) {
		return sql`SELECT jsonb_build_object('target',${invitationOf},'changes',jsonb_build_array(${change("invitation", sql`'"pending"'::jsonb`, "sent_again")}),
				'notes',jsonb_build_array('Everyfield emails '||i.recipient_email||' a new link. The earlier link stops working.')) AS review,
			jsonb_build_object('expectedRevision',i.revision::text,'input',jsonb_build_object('invitationId',i.id)) AS args
			${invitation(actor, value.invitationId)}`;
	},
	async run(tx, _context, request, { authority, ports }) {
		const sent = invitationSentResult.parse(await ports.invitations(tx).resend(authority, request));
		return { receiptId: sent.invitation.invitationId, revision: sent.invitation.revision };
	},
});

export const revokeInvitation = nativeWrite({
	operation: "seats.revokeInvitation",
	description:
		"Propose revoking a pending seat invitation so its link stops working. Nothing changes until the user approves the exact review.",
	input: z.strictObject({ invitationId: z.uuid() }),
	allowed: plantAdmin,
	review(actor, value) {
		return sql`SELECT jsonb_build_object('target',${invitationOf},'changes',jsonb_build_array(${change("invitation", sql`'"pending"'::jsonb`, "revoked")}),
				'notes',jsonb_build_array('The link sent to '||i.recipient_email||' stops working. You can invite them again later.')) AS review,
			jsonb_build_object('expectedRevision',i.revision::text,'input',jsonb_build_object('invitationId',i.id)) AS args
			${invitation(actor, value.invitationId)}`;
	},
	async run(tx, _context, request, { authority, ports }) {
		const revoked = invitationRevokedResult.parse(await ports.invitations(tx).revoke(authority, request));
		return { receiptId: revoked.invitationId, revision: revoked.revision };
	},
});

export const changeOrdinaryRole = nativeWrite({
	operation: "seats.changeOrdinaryRole",
	description:
		"Propose changing one person's seat in this church to Admin or Member. The Owner's seat never changes here. Nothing changes until the user approves the exact review.",
	input: z.strictObject({ seatId: z.uuid(), role: ordinaryRole }),
	allowed: plantAdmin,
	review(actor, value) {
		return sql`SELECT jsonb_build_object('target',${seatOf},'changes',jsonb_build_array(${change("role", sql`to_jsonb(s.role)`, value.role)})) AS review,
			jsonb_build_object('expectedRevision',s.revision::text,'input',jsonb_build_object('seatId',s.id,'expectedRole',s.role,'to',${value.role}::text)) AS args
			${seat(actor, value.seatId)}`;
	},
	async run(tx, context, request, { authority }) {
		const changed = await createSeatService(tx as unknown as Database).changeOrdinaryRole(
			authority,
			context.selected,
			request,
		);
		return { revision: changed.revision };
	},
});

/**
 * The open tasks the seat's holder is assigned in this church, each handed back as "needs an owner" at the revision the
 * review saw: the same duties seats.remove locks and checks, so a task is never handed off unreviewed.
 */
const openTasks = sql`(SELECT coalesce(jsonb_agg(jsonb_build_object('kind','needs_owner','dutyId',t.id,'expectedRevision',t.revision::text) ORDER BY t.id),'[]'::jsonb)
	FROM task t WHERE t.plant_id=s.plant_id AND EXISTS(SELECT FROM task_assignee ta WHERE ta.task_id=t.id AND ta.account_id=s.account_id)
		AND t.deleted_at IS NULL AND t.status NOT IN ('complete','no_longer_needed'))`;
export const remove = nativeWrite({
	operation: "seats.remove",
	description:
		"Propose removing one person's seat so they lose access to this church; their open tasks then need a new owner. The Owner's seat is never removed here. Nothing changes until the user approves the exact review.",
	input: z.strictObject({ seatId: z.uuid() }),
	allowed: plantAdmin,
	review(actor, value) {
		return sql`SELECT jsonb_build_object('target',${seatOf},'changes',jsonb_build_array(${change("access", sql`to_jsonb(s.role)`, "removed")})
				||CASE WHEN jsonb_array_length(h.handoffs)>0 THEN jsonb_build_array(jsonb_build_object('field','openTasksNeedingOwner','before',NULL,'after',jsonb_array_length(h.handoffs))) ELSE '[]'::jsonb END,
				'notes',jsonb_build_array(n.display_name||' loses access to '||(SELECT name FROM plant WHERE id=s.plant_id)||' right away and is signed out here.')) AS review,
			jsonb_build_object('expectedRevision',s.revision::text,'input',jsonb_build_object('seatId',s.id,'expectedRole',s.role,'handoffs',h.handoffs)) AS args
			FROM seat s CROSS JOIN LATERAL seat_identity(s.account_id) n CROSS JOIN LATERAL (SELECT ${openTasks} AS handoffs) h
			WHERE s.id=${value.seatId}::uuid AND s.plant_id=${actor.owner.id}::uuid AND s.ended_at IS NULL AND s.role IN ('admin','member')`;
	},
	async run(tx, context, request, { authority, reminders }) {
		const removed = await createSeatService(tx as unknown as Database).remove(
			authority,
			context.selected,
			request,
			reminders,
		);
		return { revision: removed.revision };
	},
});

/** The installed seat reviewed writes, keyed by operation. */
export const SEAT_COMMANDS = {
	"seats.invite": invite,
	"seats.resendInvitation": resendInvitation,
	"seats.revokeInvitation": revokeInvitation,
	"seats.changeOrdinaryRole": changeOrdinaryRole,
	"seats.remove": remove,
} as const;
