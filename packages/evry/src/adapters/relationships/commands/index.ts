import { sql } from "@everyfield/db/query";
import { readSharingDisclosure } from "@everyfield/domain/organizations";
import { normalizedEmail } from "@everyfield/contracts/identity";
import { z } from "zod";
import { committed, nativeWrite, notes, plantAdmin } from "../../native.ts";
import { COLUMN } from "../../sharing/commands/index.ts";
import { SHARING_CATEGORIES, SHARING_CATEGORY_LABEL } from "../../../catalog/labels.ts";

// The church's connections with a sending church or network: asking one to connect and ending a connection, through
// the same native commands the Settings connections screen runs. Nothing is shared with an organization until it
// accepts; ending a connection stops what the church shares at once.

const KIND_TEXT = { sending_church: "sending church", sending_network: "network" } as const;

/**
 * Asking one organization to connect. The organization is found by its exact name among the sending churches and
 * networks the church may ask (not itself, not one it is already connected to). The invitation goes to the address the
 * user gives, or else to the organization's contact address; with neither, the review says what is missing.
 */
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
				AND NOT EXISTS(SELECT FROM lifecycle_witness w WHERE w.opaque_subject_id=o.id AND w.state NOT IN ('active','cancelled'))
				ORDER BY o.id LIMIT 2`,
		);
		if (found.rows.length !== 1) return null;
		const organization = z
			.object({ id: z.uuid(), kind: z.enum(["sending_church", "sending_network"]) })
			.parse(found.rows[0]);
		const pair = {
			kind: "plant" as const,
			subject: { kind: "plant" as const, id: actor.owner.id },
			organization: { kind: "organization" as const, id: organization.id, organizationKind: organization.kind },
		};
		// What the organization would see once it accepts: the exact pair's saved choices, or the first-time defaults.
		const disclosure = await db.transaction(async (tx) => {
			actor.authority.observe(tx);
			return readSharingDisclosure(tx, actor.session as never, actor.owner, pair);
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
		const sent = await ports.organizations["associations.invite"](
			tx,
			context.session,
			context.selected,
			request as never,
		);
		return { receiptId: sent.invitationId, revision: sent.revision };
	},
});

/** Ending a live connection: the review says which categories stop being shared. */
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
		committed(await ports.organizations["associations.end"](tx, context.session, context.selected, request as never));
	},
});

/** The installed connection reviewed writes, keyed by operation. */
export const RELATIONSHIP_COMMANDS = { "associations.invite": invite, "associations.end": end } as const;
