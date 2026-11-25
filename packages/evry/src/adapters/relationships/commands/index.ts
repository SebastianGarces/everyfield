import { sql, type SQL } from "@everyfield/db/query";
import { readSharingDisclosure } from "@everyfield/domain/organizations";
import { normalizedEmail } from "@everyfield/contracts/identity";
import { z } from "zod";
import type { EvryActor } from "../../../context/actor.ts";
import {
	accountContext,
	change,
	committed,
	nativeWrite,
	notes,
	organizationAdmin,
	plantAdmin,
	rowId,
	target,
} from "../../native.ts";
import { COLUMN } from "../../sharing/commands/index.ts";
import { SHARING_CATEGORIES, SHARING_CATEGORY_LABEL } from "../../../catalog/labels.ts";
import { gatedTransaction } from "@everyfield/domain/operations";

const KIND_TEXT = { sending_church: "sending church", sending_network: "network" } as const;

export const invite = nativeWrite({
	operation: "associations.invite",
	description:
		"Propose asking a sending church or network, by its exact name, to connect with this church. The email goes to recipientEmail when given, else to the organization's contact address. Nothing is sent until the user approves the exact review.",
	input: z.strictObject({
		organizationName: z.string().trim().min(1).max(200),
		recipientEmail: normalizedEmail.pipe(z.string().max(320)).optional(),
	}),
	allowed: plantAdmin,
	async review(actor, value, { db }) {
		const found = await db.execute(
			sql`SELECT o.id,o.kind FROM organization o WHERE lower(o.name)=lower(${value.organizationName}) AND o.id<>${actor.owner.id}::uuid
				AND NOT EXISTS(SELECT FROM affiliation a WHERE a.plant_id=${actor.owner.id}::uuid AND a.organization_id=o.id AND a.ended_at IS NULL)
				AND NOT EXISTS(SELECT FROM lifecycle_witness w WHERE w.opaque_subject_id=o.id AND w.state <> 'cancelled')
				ORDER BY o.id LIMIT 2`,
		);
		if (found.rows.length !== 1) return null;
		const organization = z
			.strictObject({ id: z.uuid(), kind: z.enum(["sending_church", "sending_network"]) })
			.parse(found.rows[0]);
		const pair = {
			kind: "plant" as const,
			subject: { kind: "plant" as const, id: actor.owner.id },
			organization: { kind: "organization" as const, id: organization.id, organizationKind: organization.kind },
		};
		const disclosure = await gatedTransaction(db, async (tx) => {
			actor.authority.observe(tx);
			return readSharingDisclosure(tx, actor.session, actor.owner, pair);
		});
		const shared =
			"choices" in disclosure
				? SHARING_CATEGORIES.filter((c) => (disclosure.choices as Record<string, boolean>)[c])
				: [];
		const lines = [
			"Nothing is shared until they accept.",
			shared.length
				? `If they accept, they can see: ${shared.map((c) => SHARING_CATEGORY_LABEL[c]).join(", ")}. You can change this in Settings > Sharing.`
				: "If they accept, they see nothing until you choose what to share in Settings > Sharing.",
		];
		const email = value.recipientEmail ?? null;
		return sql`SELECT jsonb_build_object('target',jsonb_build_object('kind','organization','id',o.id,'label',o.name),
				'changes',jsonb_build_array(
					jsonb_build_object('field','connection','before',NULL,'after',${KIND_TEXT[organization.kind]}::text),
					jsonb_build_object('field','recipientEmail','before',NULL,'after',coalesce(${email}::text,o.contact_email))),
				'notes',${notes(lines)})
				||CASE WHEN coalesce(${email}::text,o.contact_email) IS NULL
					THEN jsonb_build_object('refusal','Tell me the email of an Owner or Admin at '||o.name||' and I will prepare this again.') ELSE '{}'::jsonb END AS review,
			jsonb_build_object('expectedRevision',pl.revision::text,'input',jsonb_build_object('pair',${JSON.stringify(pair)}::jsonb,
				'recipientEmail',coalesce(${email}::text,o.contact_email,''))) AS args
			FROM organization o JOIN plant pl ON pl.id=${actor.owner.id}::uuid WHERE o.id=${organization.id}::uuid`;
	},
	async run(tx, context, request, { ports }) {
		const sent = await ports.organizations["associations.invite"](tx, context.session, context.selected, request);
		return { receiptId: sent.invitationId, revision: sent.revision };
	},
});

export const end = nativeWrite({
	operation: "associations.end",
	description:
		"Propose ending this church's connection with an organization (organizationId from privacy.getSharing); sharing with it stops. Nothing changes until the user approves the exact review.",
	input: z.strictObject({ organizationId: z.uuid() }),
	allowed: plantAdmin,
	review(actor, value) {
		const shared = sql.join(
			SHARING_CATEGORIES.map(
				(c) => sql`CASE WHEN a.${sql.identifier(COLUMN[c])} THEN ${SHARING_CATEGORY_LABEL[c]}::text END`,
			),
			sql`,`,
		);
		return sql`SELECT jsonb_build_object('target',jsonb_build_object('kind','connection','id',a.id,'label',o.name),
				'changes',jsonb_build_array(jsonb_build_object('field','connection','before','connected','after','ended')),
				'notes',jsonb_build_array(
					CASE WHEN concat_ws(', ',${shared})='' THEN o.name||' already sees nothing you share.'
						ELSE o.name||' stops seeing what you share now: '||concat_ws(', ',${shared})||'.' END,
					'They are told the connection ended. To connect again, either side sends a new invitation.')) AS review,
			jsonb_build_object('expectedRevision',a.revision::text,'input',jsonb_build_object('relationshipId',a.id,
				'pair',jsonb_build_object('kind','plant','subject',jsonb_build_object('kind','plant','id',a.plant_id),
					'organization',jsonb_build_object('kind','organization','id',o.id,'organizationKind',o.kind)),
				'confirmed',true,'reason',NULL)) AS args
			FROM affiliation a JOIN organization o ON o.id=a.organization_id
			WHERE a.plant_id=${actor.owner.id}::uuid AND a.organization_id=${value.organizationId}::uuid AND a.ended_at IS NULL`;
	},
	async run(tx, context, request, { ports }) {
		committed(await ports.organizations["associations.end"](tx, context.session, context.selected, request));
	},
});

const invitationInput = z.strictObject({
	invitationId: rowId.describe("From associations.listInvitations"),
});
const sender = (actor: EvryActor) => plantAdmin(actor) || organizationAdmin(actor) || accountContext(actor);
const pending = (
	id: string,
) => sql`FROM invitation i JOIN relationship_invitation r ON r.invitation_id=i.id JOIN organization o ON o.id=r.organization_id
	WHERE i.id=${id}::uuid AND i.state='pending' AND coalesce(i.resent_at,i.created_at)>clock_timestamp()-interval '720 hours'`;
const sentBy = (actor: EvryActor) =>
	actor.owner.kind === "plant"
		? sql`r.plant_id=${actor.owner.id}::uuid`
		: actor.owner.kind === "organization"
			? sql`r.sending_church_id=${actor.owner.id}::uuid`
			: sql`r.account_id=${actor.owner.id}::uuid`;
const about = (label: SQL) => target("invitation", sql`i.id`, label);
const invitationArgs = sql`jsonb_build_object('expectedRevision',i.revision::text,'input',jsonb_build_object('invitationId',i.id))`;
const moved = (after: string) => sql`jsonb_build_array(${change("invitation", sql`'"pending"'::jsonb`, after)})`;

export const resendInvitation = nativeWrite({
	operation: "associations.resendInvitation",
	description:
		"Propose emailing a pending link invitation this side sent again, with a new link; the old link stops working. Nothing is sent until the user approves the exact review.",
	input: invitationInput,
	allowed: sender,
	review(actor, value) {
		return sql`SELECT jsonb_build_object('target',${about(sql`o.name`)},'changes',${moved("sent_again")},
				'notes',jsonb_build_array('Everyfield emails '||o.name||' a new link that works for 30 days. The earlier link stops working.')) AS review,
			${invitationArgs} AS args ${pending(value.invitationId)} AND ${sentBy(actor)}`;
	},
	async run(tx, context, request, { ports }) {
		const sent = await ports.organizations["associations.resendInvitation"](
			tx,
			context.session,
			context.selected,
			request,
		);
		return { receiptId: sent.invitationId, revision: sent.revision };
	},
});

export const revokeInvitation = nativeWrite({
	operation: "associations.revokeInvitation",
	description:
		"Propose withdrawing a pending link invitation this side sent, so its link stops working. Nothing changes until the user approves the exact review.",
	input: invitationInput,
	allowed: sender,
	review(actor, value) {
		return sql`SELECT jsonb_build_object('target',${about(sql`o.name`)},'changes',${moved("revoked")},
				'notes',jsonb_build_array('The link sent to '||o.name||' stops working. You can invite them again later.')) AS review,
			${invitationArgs} AS args ${pending(value.invitationId)} AND ${sentBy(actor)}`;
	},
	async run(tx, context, request, { ports }) {
		committed(
			await ports.organizations["associations.revokeInvitation"](tx, context.session, context.selected, request),
		);
	},
});

export const declineInvitation = nativeWrite({
	operation: "associations.declineInvitation",
	description:
		"Propose declining a pending link invitation this organization received. It ends only that invitation and makes no link. Only the Owner or Admin whose email it was sent to can decline it. Nothing changes until the user approves the exact review.",
	input: invitationInput,
	allowed: organizationAdmin,
	review(actor, value) {
		return sql`SELECT jsonb_build_object('target',${about(sql`r.inviter_description`)},'changes',${moved("declined")},
				'notes',jsonb_build_array('No link is made. '||r.inviter_description||' can invite you again.'))
				||CASE WHEN coalesce(relationship_recipient(${actor.session})=i.recipient_email,false) THEN '{}'::jsonb
					ELSE jsonb_build_object('refusal','This invitation was sent to someone else here, so only they can decline it.') END AS review,
			${invitationArgs} AS args ${pending(value.invitationId)} AND r.organization_id=${actor.owner.id}::uuid`;
	},
	async run(tx, context, request, { ports }) {
		const input = request.input as { invitationId: string };
		committed(
			await ports.organizations["associations.declineInvitation"](tx, context.session, context.selected, {
				...request,
				input: { ...input, decision: "decline" },
			}),
		);
	},
});

export const RELATIONSHIP_COMMANDS = {
	"associations.invite": invite,
	"associations.resendInvitation": resendInvitation,
	"associations.revokeInvitation": revokeInvitation,
	"associations.declineInvitation": declineInvitation,
	"associations.end": end,
} as const;
