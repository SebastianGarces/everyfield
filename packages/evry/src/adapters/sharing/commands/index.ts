import { sql } from "@everyfield/db/query";
import { z } from "zod";
import { committed, nativeWrite, plantAdmin } from "../../native.ts";
import { CATEGORIES, CATEGORY_LABEL } from "../reads/index.ts";

// Changing what the church shares with one connected organization, through the same native sharing command the
// Settings > Sharing section reaches. The review reads the live connection and its consent revision; a change made
// since refuses on approval instead of being overwritten.

const COLUMN = {
	people: "share_people",
	meetings: "share_meetings",
	tasks: "share_tasks",
	ministry_teams: "share_ministry_teams",
	wiki: "share_wiki",
	activity: "share_activity",
	shared_findings: "shared_findings",
} as const;

export const setSharing = nativeWrite({
	operation: "privacy.setSharing",
	description: `Propose starting or stopping one sharing category with a connected organization (organizationId from privacy.getSharing). Categories: ${CATEGORIES.map((c) => `${c} (${CATEGORY_LABEL[c]})`).join(", ")}. Nothing changes until the user approves the exact review.`,
	input: z.strictObject({ organizationId: z.uuid(), category: z.enum(CATEGORIES), enabled: z.boolean() }),
	allowed: plantAdmin,
	review(actor, value) {
		const column = sql.identifier(COLUMN[value.category]);
		return sql`SELECT jsonb_build_object('target',jsonb_build_object('kind','connection','id',a.id,'label',o.name),
				'changes',jsonb_build_array(jsonb_build_object('field',${value.category}::text,'before',to_jsonb(a.${column}),'after',${value.enabled}::boolean))) AS review,
			jsonb_build_object('expectedRevision',a.revision::text,'input',jsonb_build_object(
				'plant',jsonb_build_object('kind','plant','id',a.plant_id),
				'organization',jsonb_build_object('kind','organization','id',o.id,'organizationKind',o.kind),
				'relationshipId',a.id,'expectedConsentRevision',a.consent_revision::text,
				'category',${value.category}::text,'enabled',${value.enabled}::boolean)) AS args
			FROM affiliation a JOIN organization o ON o.id=a.organization_id
			WHERE a.plant_id=${actor.owner.id}::uuid AND a.organization_id=${value.organizationId}::uuid AND a.ended_at IS NULL`;
	},
	async run(tx, context, request, { ports }) {
		committed(await ports.organizations["privacy.setSharing"](tx, context.session, context.selected, request as never));
	},
});

/** The installed sharing reviewed writes, keyed by operation. */
export const SHARING_COMMANDS = { "privacy.setSharing": setSharing } as const;
