import { sql, type SQLWrapper } from "@everyfield/db/query";
import { z } from "zod";
import { liveResidency, reviewShared } from "../access/pipeline.ts";
import { seatHeld } from "../access/session.ts";
import { queueJobsFor } from "../jobs/queue.ts";
import type { Reader } from "./core.ts";

export const milestone = z.enum(["approved", "ended", "sharing"]);
export type Milestone = z.infer<typeof milestone>;
export const milestoneCategory = {
	approved: "relationship_milestone",
	ended: "relationship_milestone",
	sharing: "sharing_milestone",
} as const satisfies Record<Milestone, string>;

export function queueMilestoneJob(input: {
	plantId: string;
	affiliationId: string;
	occurrence: Milestone;
	revision: string;
}): SQLWrapper {
	return queueJobsFor(sql``, {
		kind: "notification",
		tenant: sql`${sql.param(input.plantId)}::uuid`,
		subject: sql`${sql.param(input.affiliationId)}::uuid`,
		key: sql`${`affiliation/${input.occurrence}/${input.revision}`}::text`,
		revision: sql`${sql.param(input.revision)}::bigint`,
		conflict: "skipSameKey",
	});
}

const holds = (occurrence: SQLWrapper) =>
	sql`CASE ${occurrence} WHEN 'ended' THEN a.ended_at IS NOT NULL ELSE a.ended_at IS NULL AND a.accepted_at <= clock_timestamp() END`;

const planRow = z.object({
	organization: z.string(),
	holds: z.boolean(),
	recipients: z.array(z.uuid()),
});
function milestoneNotice(occurrence: Milestone, organization: string) {
	const name = organization.slice(0, 400);
	return {
		approved: { title: `Connection approved: ${name}`, text: `${name} is now connected with your church.` },
		ended: { title: `Connection ended: ${name}`, text: `Your church's connection with ${name} has ended.` },
		sharing: { title: `Sharing changed: ${name}`, text: `What your church shares with ${name} changed.` },
	}[occurrence];
}

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

export function relationshipMailGrants(input: SQLWrapper): SQLWrapper {
	return sql`SELECT i.id FROM ${input}
		JOIN notice n ON n.id=i.notice AND n.recipient_id=i.recipient AND n.purpose='relationship_decision'
			AND split_part(n.logical_key,'/',2) IN ('relationship_milestone','sharing_milestone')
		JOIN affiliation a ON a.id=n.source_record_id AND a.plant_id=n.tenant_id
		JOIN seat s ON s.account_id=i.recipient AND s.plant_id=a.plant_id AND s.role IN ('owner','admin') AND ${seatHeld("s")}
		WHERE ${holds(sql`split_part(n.logical_key,'/',5)`)}
		FOR SHARE OF n, a, s`;
}

const residencyOccurrence = z.enum(["confirmation", "feedback"]);
type ResidencyOccurrence = z.infer<typeof residencyOccurrence>;
export const residencyCategory = {
	confirmation: "residency_confirmation",
	feedback: "residency_feedback",
} as const satisfies Record<ResidencyOccurrence, string>;

export function queueResidencyJob(org: string, from: SQLWrapper, feedback: string | null = null) {
	const key =
		feedback === null
			? sql`'residency/confirmation/'||m.id::text||'/'||lk.id::text`
			: sql`'residency/feedback/'||m.id::text||'/'||${feedback}::text||'/'||lk.id::text`;
	return queueJobsFor(sql`FROM ${from}`, {
		kind: "notification",
		tenant: sql`${org}::uuid`,
		subject: sql`x.id`,
		key,
		revision: sql`1`,
		conflict: "skipSameKey",
	});
}

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
});

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

export async function planResidencyNotice(
	db: Reader,
	org: string,
	input: { enrollmentId: string } & ReturnType<typeof residencyJobOf>,
) {
	const r = await db.execute(sql`SELECT o.name AS organization, o.kind AS organization_kind, l.account_id AS recipient,
			m.title AS milestone, ${liveResidency} AS holds
		FROM development_enrollment e JOIN organization o ON o.id=e.organization_id
		JOIN development_milestone m ON m.id=${sql.param(input.milestoneId)}::uuid AND m.organization_id=e.organization_id
		JOIN residency_link l ON l.id=${sql.param(input.linkId)}::uuid AND l.organization_id=e.organization_id
			AND l.person_id=e.person_id AND l.account_id IS NOT NULL
		WHERE e.id=${sql.param(input.enrollmentId)}::uuid AND e.organization_id=${sql.param(org)}::uuid
		FOR SHARE OF l`);
	if (!r.rows[0]) return null;
	const row = residencyRow.parse(r.rows[0]);
	return {
		holds: row.holds,
		recipient: row.recipient,
		organizationKind: row.organization_kind,
		...residencyNotice(input.occurrence, row.organization, row.milestone),
	};
}

export function residencyMailGrants(input: SQLWrapper): SQLWrapper {
	return sql`SELECT i.id FROM ${input}
		JOIN notice n ON n.id=i.notice AND n.recipient_id=i.recipient AND n.purpose IN ('residency_confirmation','residency_feedback')
		JOIN residency_link l ON l.account_id=i.recipient AND l.organization_id=n.tenant_id
		WHERE ${liveResidency}
		FOR SHARE OF n, l`;
}

export function reviewJobOf(key: string) {
	return z.uuid().parse(key.split("/")[1]);
}

const reviewRow = z.object({
	organization_kind: z.enum(["sending_church", "sending_network"]),
	recipient: z.uuid(),
	person: z.string(),
	group_name: z.string(),
	sender: z.string().nullable(),
	holds: z.boolean(),
});

function reviewNotice(person: string, group: string, sender: string | null) {
	const name = person.slice(0, 200);
	return {
		title: `Answers to review: ${name}`,
		text: `${(sender ?? "A staff member").slice(0, 200)} sent you “${group}” for ${name} to review.`,
	};
}

export async function planReviewNotice(db: Reader, org: string, reviewId: string) {
	const r =
		await db.execute(sql`SELECT o.kind AS organization_kind, s.account_id AS recipient, p.display_name AS person,
			r.group_name, (SELECT i.display_name FROM seat_identity(r.sender_id) i) AS sender, ${reviewShared} AS holds
		FROM answer_review r JOIN organization o ON o.id=r.organization_id
		JOIN seat s ON s.id=r.reviewer_seat_id AND s.organization_id=r.organization_id
		JOIN person p ON p.id=r.person_id AND p.tenant_id=r.organization_id
		WHERE r.id=${sql.param(reviewId)}::uuid AND r.organization_id=${sql.param(org)}::uuid
		FOR SHARE OF r, s`);
	if (!r.rows[0]) return null;
	const row = reviewRow.parse(r.rows[0]);
	return {
		holds: row.holds,
		recipient: row.recipient,
		organizationKind: row.organization_kind,
		...reviewNotice(row.person, row.group_name, row.sender),
	};
}

export function reviewMailGrants(input: SQLWrapper): SQLWrapper {
	return sql`SELECT i.id FROM ${input}
		JOIN notice n ON n.id=i.notice AND n.recipient_id=i.recipient AND n.purpose='answer_review'
		JOIN answer_review r ON r.id=n.source_record_id AND r.organization_id=n.tenant_id
		JOIN seat s ON s.id=r.reviewer_seat_id AND s.account_id=i.recipient AND ${seatHeld("s")}
		WHERE ${reviewShared}
		FOR SHARE OF n, r, s`;
}
