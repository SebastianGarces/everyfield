import { sql, type SQLWrapper } from "@everyfield/db/query";
import { z } from "zod";
import { liveResidency } from "../access/pipeline.ts";
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

/**
 * The milestone's `notification` job, as one statement for the command's write (D70). Keyed
 * `affiliation/<occurrence>/<revision>` by the occurrence and the revision it wrote, so a later re-approval queues its own job and a replay never reaches here.
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
			${`affiliation/${input.occurrence}/${input.revision}`}, ${sql.param(input.revision)}::bigint, 'ready', clock_timestamp(), 0, 4, 0)
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
function milestoneNotice(occurrence: Milestone, organization: string) {
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

// Residency notices (T-365, D-1414 to D-1416). The director confirming a milestone the linked resident marked done, and
// the director writing feedback on one of the resident's milestones, each queue one `notification` job in the write's
// own statement, only while the enrollment's person has a live residency link. The job names that link: the worker
// writes one notice, owned by the organization, to the link's account while that link is still live, and the mail
// mount sends its email only while it is. The notice names the milestone and the organization, never the feedback.

/** What the director did: confirmed the resident's milestone, or wrote feedback on it. */
export const residencyOccurrence = z.enum(["confirmation", "feedback"]);
export type ResidencyOccurrence = z.infer<typeof residencyOccurrence>;
/** The notice category each residency occurrence writes. */
export const residencyCategory = {
	confirmation: "residency_confirmation",
	feedback: "residency_feedback",
} as const satisfies Record<ResidencyOccurrence, string>;

/**
 * The occurrence's `notification` job, as a CTE body for the director's write statement (D70): one job per row of
 * `from`, which exposes enrollment `x`, milestone `m` and the live link `lk` (with its id), and for feedback the
 * `feedback` id. Keyed by the milestone, the feedback and the link, so a replayed write, which inserts nothing, queues
 * nothing, and a later link never inherits an earlier occurrence.
 */
export function queueResidencyJob(org: string, from: SQLWrapper, feedback: string | null = null) {
	const key =
		feedback === null
			? sql`'residency/confirmation/'||m.id::text||'/'||lk.id::text`
			: sql`'residency/feedback/'||m.id::text||'/'||${feedback}::text||'/'||lk.id::text`;
	return sql`INSERT INTO job (tenant_id, kind, subject_record_id, producer_key, source_revision, state, eligible_at,
		attempt_count, max_attempts, claim_generation)
		SELECT ${org}::uuid, 'notification', x.id, ${key}, 1, 'ready', clock_timestamp(), 0, 4, 0 FROM ${from}
		ON CONFLICT (kind, subject_record_id, producer_key) DO NOTHING`;
}

/** A residency job key: `residency/<occurrence>/<milestone>[/<feedback>]/<link>`. */
export function residencyJobOf(key: string) {
	const [, occurrence, milestone, ...rest] = key.split("/");
	const parsed = residencyOccurrence.parse(occurrence);
	const link = z.uuid().parse(rest.at(-1));
	return {
		occurrence: parsed,
		milestoneId: z.uuid().parse(milestone),
		feedbackId: parsed === "feedback" ? z.uuid().parse(rest[0]) : null,
		linkId: link,
	};
}

const residencyRow = z.object({
	organization: z.string(),
	organization_kind: z.enum(["sending_church", "sending_network"]),
	recipient: z.uuid(),
	milestone: z.string(),
	holds: z.boolean(),
	happened: z.boolean(),
});

/** What a residency notice says: the milestone and the organization, never the feedback's words (D-1414). */
function residencyNotice(occurrence: ResidencyOccurrence, organization: string, milestone: string) {
	const church = organization.slice(0, 150);
	const title = `“${milestone.slice(0, 300)}”`;
	return {
		confirmation: {
			title: `${church} confirmed ${title}`,
			text: "Your director confirmed this milestone you marked done.",
		},
		feedback: {
			title: `New feedback from ${church} on ${title}`,
			text: "Your director wrote feedback on this milestone. Read it in My residency.",
		},
	}[occurrence];
}

/**
 * The residency notice as the worker sees it when the job runs: the organization, the link's account, whether that
 * link is still live (D-1416) and the notice text. Null when the enrollment, milestone, feedback or link is not this
 * organization's, or the confirmation is gone. One statement that holds the link, so leaving waits for this job's
 * notice and mail, and the mail check after it sees the leave. The caller is the trusted worker for the job's tenant.
 */
export async function planResidencyNotice(
	db: Reader,
	org: string,
	input: { enrollmentId: string } & ReturnType<typeof residencyJobOf>,
) {
	const happened =
		input.occurrence === "confirmation"
			? sql`EXISTS(SELECT FROM enrollment_milestone c JOIN development_milestone cm ON cm.id=c.milestone_id
				AND cm.organization_id=c.organization_id WHERE c.enrollment_id=e.id AND c.organization_id=e.organization_id
				AND cm.lineage=m.lineage AND c.source='resident' AND c.confirmed_at IS NOT NULL)`
			: sql`EXISTS(SELECT FROM assignment_feedback f WHERE f.id=${sql.param(input.feedbackId)}::uuid
				AND f.enrollment_id=e.id AND f.organization_id=e.organization_id)`;
	const r = await db.execute(sql`SELECT o.name AS organization, o.kind AS organization_kind, l.account_id AS recipient,
			m.title AS milestone, ${liveResidency} AS holds, ${happened} AS happened
		FROM development_enrollment e JOIN organization o ON o.id=e.organization_id
		JOIN development_milestone m ON m.id=${sql.param(input.milestoneId)}::uuid AND m.organization_id=e.organization_id
		JOIN residency_link l ON l.id=${sql.param(input.linkId)}::uuid AND l.organization_id=e.organization_id
			AND l.person_id=e.person_id AND l.account_id IS NOT NULL
		WHERE e.id=${sql.param(input.enrollmentId)}::uuid AND e.organization_id=${sql.param(org)}::uuid
		FOR SHARE OF l`);
	if (!r.rows[0]) return null;
	const row = residencyRow.parse(r.rows[0]);
	if (!row.happened) return null;
	return {
		holds: row.holds,
		recipient: row.recipient,
		organizationKind: row.organization_kind,
		...residencyNotice(input.occurrence, row.organization, row.milestone),
	};
}

/**
 * Which residency notice mail may go out, as a locking SELECT of mail ids over `input` (rows of id, recipient and
 * notice, under the alias `i`): the notice is the recipient's own residency notice and the recipient still holds a live
 * residency link to the organization that owns it (D-1416), in place of a seat.
 */
export function residencyMailGrants(input: SQLWrapper): SQLWrapper {
	return sql`SELECT i.id FROM ${input}
		JOIN notice n ON n.id=i.notice AND n.recipient_id=i.recipient AND n.purpose IN ('residency_confirmation','residency_feedback')
		JOIN residency_link l ON l.account_id=i.recipient AND l.organization_id=n.tenant_id
		WHERE ${liveResidency}
		FOR SHARE OF n, l`;
}
