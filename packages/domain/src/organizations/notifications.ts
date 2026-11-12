import { sql, type SQLWrapper } from "@everyfield/db/query";
import { z } from "zod";
import { seatHeld } from "../access/session.ts";
import type { Reader } from "./core.ts";

// Connection and sharing milestones (REQ-NTF-009, NTF-009). Approving or ending a plant's connection, and changing what
// the plant shares, queue one `notification` job for the affiliation in the command's own write statement (D70). The
// notification worker reads the plan below when the job runs and writes one notice per current plant Owner or Admin.
// The organization's seat holders are never told (D-795).

/** What happened to the connection: approved, ended, or a change to what the church shares. */
export const milestone = z.enum(["approved", "ended", "sharing"]);
export type Milestone = z.infer<typeof milestone>;
/** The notice category each milestone writes. */
export const milestoneCategory = {
	approved: "relationship_milestone",
	ended: "relationship_milestone",
	sharing: "sharing_milestone",
} as const satisfies Record<Milestone, string>;

/** The job key of one occurrence: the milestone and the affiliation revision its write produced. */
export const milestoneKey = (occurrence: Milestone, revision: string) => `affiliation/${occurrence}/${revision}`;

/**
 * The milestone's `notification` job, as one statement for the command's write (D70). Keyed by the occurrence and the
 * revision it wrote, so a later re-approval queues its own job and a replay never reaches here.
 */
export function queueMilestoneJob(input: {
	plantId: string;
	affiliationId: string;
	occurrence: Milestone;
	revision: string;
}): SQLWrapper {
	return sql`INSERT INTO job (tenant_id, kind, subject_record_id, producer_key, source_revision, state, eligible_at,
		attempt_count, max_attempts, claim_generation)
		VALUES (${sql.param(input.plantId)}::uuid, 'notification', ${sql.param(input.affiliationId)}::uuid,
			${milestoneKey(input.occurrence, input.revision)}, ${sql.param(input.revision)}::bigint, 'ready', clock_timestamp(), 0, 4, 0)
		ON CONFLICT (kind, subject_record_id, producer_key) DO NOTHING`;
}

/**
 * Whether a milestone's fact still holds on the row now (D-796): an approval or a sharing change while the connection is
 * active, an end while it is ended. Columns of `affiliation` under the alias `a`.
 */
const holds = (occurrence: SQLWrapper) =>
	sql`CASE ${occurrence} WHEN 'ended' THEN a.ended_at IS NOT NULL ELSE a.ended_at IS NULL AND a.accepted_at <= clock_timestamp() END`;

const planRow = z.object({
	organization: z.string(),
	holds: z.boolean(),
	recipients: z.array(z.uuid()),
});
/** What a milestone's notice says. It names the organization and the plant's own committed event, nothing more. */
export function milestoneNotice(occurrence: Milestone, organization: string) {
	const name = organization.slice(0, 400);
	return {
		approved: { title: `Connection approved: ${name}`, text: `${name} is now connected with your church.` },
		ended: { title: `Connection ended: ${name}`, text: `Your church's connection with ${name} has ended.` },
		sharing: { title: `Sharing changed: ${name}`, text: `What your church shares with ${name} changed.` },
	}[occurrence];
}

/**
 * The milestone plan as the worker sees it when the job runs: whether the occurrence still holds, its recipients (the
 * plant's current Owner and Admin seat holders, accepted and not ended) and the notice text. Null when the connection is
 * gone, is not this plant's, or has not reached the job's revision. One statement; the caller is the trusted worker for
 * the job's own tenant.
 */
export async function planMilestoneNotice(
	db: Reader,
	plantId: string,
	input: { affiliationId: string; occurrence: Milestone; revision: string },
) {
	const r = await db.execute(sql`SELECT o.name AS organization, ${holds(sql`${input.occurrence}::text`)} AS holds,
			ARRAY(SELECT DISTINCT s.account_id FROM seat s WHERE s.plant_id = a.plant_id AND s.role IN ('owner', 'admin')
				AND ${seatHeld("s")} ORDER BY 1) AS recipients
		FROM affiliation a JOIN organization o ON o.id = a.organization_id
		WHERE a.id = ${sql.param(input.affiliationId)}::uuid AND a.plant_id = ${sql.param(plantId)}::uuid
			AND a.revision >= ${sql.param(input.revision)}::bigint`);
	if (!r.rows[0]) return null;
	const row = planRow.parse(r.rows[0]);
	return { holds: row.holds, recipients: row.recipients, ...milestoneNotice(input.occurrence, row.organization) };
}

/**
 * Which milestone notice mail may go out, as a locking SELECT of mail ids over `input` (rows of id, recipient and
 * notice, under the alias `i`): the notice is the recipient's own connection or sharing milestone, the recipient still
 * holds an Owner or Admin seat in the plant, and the occurrence still holds. The notification mail mount runs it with
 * the meeting check in one statement.
 */
export function relationshipMailGrants(input: SQLWrapper): SQLWrapper {
	return sql`SELECT i.id FROM ${input}
		JOIN notice n ON n.id=i.notice AND n.recipient_id=i.recipient AND n.purpose='relationship_decision'
			AND split_part(n.logical_key,'/',2) IN ('relationship_milestone','sharing_milestone')
		JOIN affiliation a ON a.id=n.source_record_id AND a.plant_id=n.tenant_id
		JOIN seat s ON s.account_id=i.recipient AND s.plant_id=a.plant_id AND s.role IN ('owner','admin') AND ${seatHeld("s")}
		WHERE ${holds(sql`split_part(n.logical_key,'/',5)`)}
		FOR SHARE OF n, a, s`;
}
