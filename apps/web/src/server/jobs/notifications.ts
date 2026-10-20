import { and, eq, gt, isNull, or, sql } from "@everyfield/db/query";
import * as tables from "@everyfield/db/tables";
import "server-only";
import { readAccountContacts } from "@everyfield/domain/identity";
import { enqueueJobs } from "./queue";
import type { Transaction } from "@everyfield/db/client";
import { z } from "zod";
import { instant } from "@everyfield/contracts/common";
import { createMailService, type MailIntent } from "./mail.ts";
import { taskReminderTimes, meetingReminderTimes } from "./calendar.ts";
export { notificationCategory as category } from "@everyfield/contracts/settings";
import { notificationCategory as category } from "@everyfield/contracts/settings";
const sourceSchema = z.strictObject({
	kind: z.enum(["task", "meeting", "affiliation", "phase_transition", "launch_milestone", "article_editor_state"]),
	id: z.uuid(),
	revision: z.string().regex(/^[1-9]\d*$/),
});
export type NoticeSource = z.infer<typeof sourceSchema>;
const noticeInput = z.strictObject({
	owner: z.discriminatedUnion("kind", [
		z.strictObject({ kind: z.literal("plant"), id: z.uuid() }),
		z.strictObject({
			kind: z.literal("organization"),
			id: z.uuid(),
			organizationKind: z.enum(["sending_church", "sending_network"]),
		}),
	]),
	source: sourceSchema,
	recipient: z.uuid(),
	category,
	occurrence: z.string().min(1).max(150),
	eligibleAt: z.iso.datetime(),
	title: z.string().min(1).max(500),
	text: z.string().max(10_000),
	operation: z.uuid().nullable(),
});
export type NoticeInput = z.infer<typeof noticeInput>;
const policy = {
	task_due: { category: "task", purpose: "task_due", source: "task" },
	task_overdue: { category: "task", purpose: "task_due", source: "task" },
	meeting_announcement: {
		category: "meeting",
		purpose: "meeting_invitation",
		source: "meeting",
	},
	meeting_reminder: {
		category: "meeting",
		purpose: "meeting_reminder",
		source: "meeting",
	},
	planter_digest: { category: "digest", purpose: "planter_digest", source: null },
	oversight_digest: { category: "digest", purpose: "oversight_digest", source: null },
	relationship_milestone: {
		category: "relationship",
		purpose: "relationship_decision",
		source: "affiliation",
	},
	sharing_milestone: {
		category: "relationship",
		purpose: "relationship_decision",
		source: "affiliation",
	},
	phase_milestone: {
		category: "phase",
		purpose: "phase_transition",
		source: "phase_transition",
	},
	launch_milestone: {
		category: "launch",
		purpose: "launch_milestone",
		source: "launch_milestone",
	},
	wiki_upstream_review: {
		category: "reference_update",
		purpose: "reference_update",
		source: "article_editor_state",
	},
} as const;
export async function channelEnabled(
	tx: Transaction,
	recipient: string,
	preference: string,
	channel: "email" | "in_app",
) {
	const row = await tx
		.select({ enabled: tables.notification_preference.enabled })
		.from(tables.notification_preference)
		.where(
			and(
				and(
					eq(tables.notification_preference.account_id, recipient),
					eq(tables.notification_preference.category, sql`${preference}`),
				),
				eq(tables.notification_preference.channel, channel),
			),
		);
	return row[0] ? z.boolean().parse(row[0].enabled) : !(preference === "planter_digest" && channel === "in_app");
}
export async function lockSource(tx: Transaction, tenant: string, source: NoticeSource) {
	const s = sourceSchema.parse(source);
	if (s.kind === "phase_transition") {
		const phase = await tx
			.select({ id: tables.phase_transition.id })
			.from(tables.phase_transition)
			.where(
				and(
					and(
						and(
							and(eq(tables.phase_transition.id, s.id), eq(tables.phase_transition.plant_id, tenant)),
							eq(tables.phase_transition.kind, "movement"),
						),
						gt(tables.phase_transition.to_phase, tables.phase_transition.from_phase),
					),
					sql`${s.revision}='1'`,
				),
			)
			.for("share");
		return phase.length === 1;
	}
	if (s.kind === "affiliation") {
		const relationship = await tx
			.select({ id: tables.affiliation.id })
			.from(tables.affiliation)
			.where(
				and(
					and(
						eq(tables.affiliation.id, s.id),
						or(eq(tables.affiliation.plant_id, tenant), eq(tables.affiliation.organization_id, tenant)),
					),
					eq(tables.affiliation.revision, s.revision),
				),
			)
			.for("share");
		return relationship.length === 1;
	}
	const sources = {
		task: [tables.task, tables.task.plant_id],
		meeting: [tables.meeting, tables.meeting.plant_id],
		launch_milestone: [tables.launch_milestone, tables.launch_milestone.plant_id],
		article_editor_state: [tables.article_editor_state, tables.article_editor_state.organization_id],
	} as const;
	const [table, column] = sources[s.kind];
	const r = await tx
		.select({ id: table.id })
		.from(table)
		.where(and(eq(table.id, s.id), eq(column, tenant), eq(table.revision, s.revision)))
		.for("share");
	return r.length === 1;
}
export function createNotificationService(config: {
	mail: ReturnType<typeof createMailService>;
	eligible: (tx: Transaction, input: readonly NoticeInput[]) => Promise<readonly ({ address: string | null } | null)[]>;
}) {
	async function enqueueMany(tx: Transaction, inputs: readonly NoticeInput[]) {
		const values = inputs.map((input) => noticeInput.parse(input));
		const data = values.map((v, n) => {
			const p = policy[v.category];
			if (!p.source || p.source !== v.source.kind) throw Error("notification_source_mismatch");
			return {
				n,
				owner: v.owner.id,
				ownerKind: v.owner.kind,
				organizationKind: v.owner.kind === "organization" ? v.owner.organizationKind : null,
				source: v.source.id,
				sourceKind: v.source.kind,
				revision: v.source.revision,
				recipient: v.recipient,
				category: v.category,
				key: `${v.owner.id}/${v.category}/${v.source.id}/${v.source.revision}/${v.occurrence}`,
			};
		});
		if (!data.length) return [];
		const result =
			await tx.execute(sql`WITH input AS MATERIALIZED (SELECT * FROM jsonb_to_recordset(${JSON.stringify(data)}::jsonb) i(n int,owner uuid,"ownerKind" text,"organizationKind" text,source uuid,"sourceKind" text,revision bigint,recipient uuid,category text,key text)),
 tasks AS MATERIALIZED (SELECT t.* FROM task t WHERE t.id IN (SELECT source FROM input WHERE "sourceKind"='task') ORDER BY t.id FOR SHARE),
 meetings AS MATERIALIZED (SELECT m.* FROM meeting m WHERE m.id IN (SELECT source FROM input WHERE "sourceKind"='meeting') ORDER BY m.id FOR SHARE),
 affiliations AS MATERIALIZED (SELECT a.* FROM affiliation a WHERE a.id IN (SELECT source FROM input WHERE "sourceKind"='affiliation') ORDER BY a.id FOR SHARE),
 phases AS MATERIALIZED (SELECT p.* FROM phase_transition p WHERE p.id IN (SELECT source FROM input WHERE "sourceKind"='phase_transition') ORDER BY p.id FOR SHARE),
 launches AS MATERIALIZED (SELECT l.* FROM launch_milestone l WHERE l.id IN (SELECT source FROM input WHERE "sourceKind"='launch_milestone') ORDER BY l.id FOR SHARE),
 editors AS MATERIALIZED (SELECT e.* FROM article_editor_state e WHERE e.id IN (SELECT source FROM input WHERE "sourceKind"='article_editor_state') ORDER BY e.id FOR SHARE),
 admins AS MATERIALIZED (SELECT s.* FROM seat s WHERE s.account_id IN (SELECT recipient FROM input WHERE category='wiki_upstream_review') AND s.role IN ('owner','admin') AND s.ended_at IS NULL FOR SHARE)
 SELECT i.n,t.kind,o.kind AS organization_kind,
 CASE i."sourceKind" WHEN 'task' THEN EXISTS(SELECT FROM tasks s WHERE s.id=i.source AND s.plant_id=i.owner AND s.revision=i.revision)
 WHEN 'meeting' THEN EXISTS(SELECT FROM meetings s WHERE s.id=i.source AND s.plant_id=i.owner AND s.revision=i.revision)
 WHEN 'affiliation' THEN EXISTS(SELECT FROM affiliations s WHERE s.id=i.source AND i.owner IN(s.plant_id,s.organization_id) AND s.revision=i.revision)
 WHEN 'phase_transition' THEN EXISTS(SELECT FROM phases s WHERE s.id=i.source AND s.plant_id=i.owner AND s.kind='movement' AND s.to_phase>s.from_phase AND i.revision=1)
 WHEN 'launch_milestone' THEN EXISTS(SELECT FROM launches s WHERE s.id=i.source AND s.plant_id=i.owner AND s.revision=i.revision)
 WHEN 'article_editor_state' THEN EXISTS(SELECT FROM editors s WHERE s.id=i.source AND s.organization_id=i.owner AND s.revision=i.revision) ELSE false END AS source_live,
 CASE i."sourceKind" WHEN 'task' THEN EXISTS(SELECT FROM tasks s WHERE s.id=i.source AND s.assignee_id=i.recipient AND s.deleted_at IS NULL AND s.status NOT IN ('complete','no_longer_needed'))
 WHEN 'meeting' THEN EXISTS(SELECT FROM meetings s WHERE s.id=i.source AND s.status NOT IN ('cancelled','completed') AND s.starts_at>clock_timestamp())
 WHEN 'launch_milestone' THEN EXISTS(SELECT FROM launches s WHERE s.id=i.source AND s.completed_at IS NOT NULL AND s.removed_at IS NULL)
 ELSE true END AND (i.category<>'wiki_upstream_review' OR EXISTS(SELECT FROM admins s WHERE s.account_id=i.recipient AND s.organization_id=i.owner)) AS deliverable,
 coalesce((SELECT enabled FROM notification_preference p WHERE p.account_id=i.recipient AND p.category=i.category AND p.channel='in_app'),i.category<>'planter_digest') AS in_app,
 i.category<>'wiki_upstream_review' AND coalesce((SELECT enabled FROM notification_preference p WHERE p.account_id=i.recipient AND p.category=i.category AND p.channel='email'),true) AS email,
 n.id AS old_id,n.title AS old_title,n.safe_body AS old_body,n.eligible_at AS old_at,(SELECT m.id FROM mail m WHERE m.notice_id=n.id LIMIT 1) AS old_mail
 FROM input i LEFT JOIN tenant t ON t.id=i.owner LEFT JOIN organization o ON o.id=i.owner LEFT JOIN notice n ON n.recipient_id=i.recipient AND n.logical_key=i.key ORDER BY i.n`);
		const rows = z
			.array(
				z.object({
					n: z.number().int(),
					kind: z.string().nullable(),
					organization_kind: z.string().nullable(),
					source_live: z.boolean(),
					deliverable: z.boolean(),
					in_app: z.boolean(),
					email: z.boolean(),
					old_id: z.uuid().nullable(),
					old_title: z.string().nullable(),
					old_body: z.string().nullable(),
					old_at: z.coerce.date().nullable(),
					old_mail: z.uuid().nullable(),
				}),
			)
			.parse(result.rows);
		const viable = rows.filter((r) => {
			const v = values[r.n];
			if (!v) throw Error("notification_source_mismatch");
			if (
				r.kind !== v.owner.kind ||
				(v.owner.kind === "organization" && r.organization_kind !== v.owner.organizationKind)
			)
				throw Error("notification_owner_mismatch");
			if (!r.source_live) throw Error("notification_source_stale");
			return r.deliverable;
		});
		const eligible = await config.eligible(
			tx,
			viable.map((r) => values[r.n]!),
		);
		if (eligible.length !== viable.length) throw Error("notification_eligibility_mismatch");
		const recipients = new Map(viable.map((r, n) => [r.n, eligible[n]]));
		const output = values.map(() => ({ notice: null as string | null, mail: null as string | null }));
		const fresh = viable.flatMap((r) => {
			const v = values[r.n]!,
				recipient = recipients.get(r.n);
			if (!recipient) return [];
			if (r.old_id) {
				if (
					r.old_title !== v.title ||
					r.old_body !== v.text ||
					r.old_at?.toISOString() !== new Date(v.eligibleAt).toISOString()
				)
					throw Error("notification_identity_conflict");
				output[r.n] = { notice: r.old_id, mail: r.old_mail };
				return [];
			}
			return r.in_app || r.email ? [{ r, v, recipient, id: crypto.randomUUID() }] : [];
		});
		if (!fresh.length) return output;
		const inserted = await tx
			.insert(tables.notice)
			.values(
				fresh.map(({ r, v, id }) => ({
					id,
					tenant_id: v.owner.id,
					recipient_id: v.recipient,
					category: policy[v.category].category,
					purpose: policy[v.category].purpose,
					logical_key: data[r.n]!.key,
					source_record_id: v.source.id,
					source_revision: v.source.revision,
					title: v.title,
					safe_body: v.text,
					eligible_at: new Date(v.eligibleAt),
					created_at: new Date(),
					archived_at: r.in_app ? null : new Date(),
				})),
			)
			.onConflictDoUpdate({
				target: [tables.notice.recipient_id, tables.notice.logical_key],
				set: { logical_key: sql`excluded.logical_key` },
			})
			.returning();
		const mailInput: MailIntent[] = [],
			mailPositions: number[] = [];
		for (const { r, v, recipient } of fresh) {
			const row = inserted.find((n) => n.recipient_id === v.recipient && n.logical_key === data[r.n]!.key);
			if (
				!row ||
				row.title !== v.title ||
				row.safe_body !== v.text ||
				row.eligible_at.toISOString() !== new Date(v.eligibleAt).toISOString()
			)
				throw Error("notification_identity_conflict");
			output[r.n]!.notice = row.id;
			if (r.email && recipient.address) {
				mailPositions.push(r.n);
				mailInput.push({
					owner: v.owner,
					recipient: v.recipient,
					address: recipient.address,
					purpose: "notification",
					logicalKey: "notice/" + row.id,
					notice: row.id,
					operation: v.operation,
					eligibleAt: v.eligibleAt,
					content: { subject: v.title, text: v.text },
				});
			}
		}
		const mail = await config.mail.enqueueMany(tx, mailInput);
		mail.forEach((id, n) => {
			output[mailPositions[n]!]!.mail = id;
		});
		return output;
	}
	async function enqueue(tx: Transaction, input: NoticeInput) {
		const [result] = await enqueueMany(tx, [input]);
		if (!result) throw Error("notification_source_mismatch");
		return result;
	}

	async function cancelForEntity(tx: Transaction, tenant: string, source: NoticeSource, preserveCurrent = false) {
		if (!(await lockSource(tx, tenant, source))) throw Error("notification_source_stale");
		await tx
			.update(tables.notice)
			.set({
				cancelled_at: sql<Date>`coalesce(${tables.notice.cancelled_at}, clock_timestamp())`.mapWith(
					(value: string) => new Date(value),
				),
			})
			.where(
				and(
					and(eq(tables.notice.tenant_id, tenant), eq(tables.notice.source_record_id, source.id)),
					or(
						sql<unknown>`(NOT ${preserveCurrent})`,
						sql<unknown>`(${tables.notice.source_revision} != ${source.revision})`,
					),
				),
			);
		// Pending/known-refused work is safe to cancel. Unknown external effects stay unknown.
		await tx.execute(sql`UPDATE mail m SET state='cancelled' FROM notice n WHERE n.id=m.notice_id AND n.tenant_id=${tenant}
      AND n.source_record_id=${source.id} AND n.cancelled_at IS NOT NULL AND m.state IN ('pending','refused')`);
		await tx.execute(sql`UPDATE job j SET state='cancelled',claim_generation=claim_generation+1,lease_owner=NULL,lease_until=NULL,
      revision=j.revision+1,finished_at=clock_timestamp() FROM mail m JOIN notice n ON n.id=m.notice_id WHERE m.job_id=j.id AND n.tenant_id=${tenant}
      AND n.source_record_id=${source.id} AND n.cancelled_at IS NOT NULL AND m.state='cancelled' AND j.state IN ('ready','retry_wait','claimed')`);
	}
	// Actual task/meeting producers run these in the mutation transaction, after their new revision.
	async function syncTaskReminders(
		tx: Transaction,
		input: {
			base: Omit<NoticeInput, "category" | "occurrence" | "eligibleAt">;
			due: Parameters<typeof taskReminderTimes>[0];
			open: boolean;
			asOf: string;
		},
	) {
		const asOf = instant.parse(input.asOf);
		await cancelForEntity(tx, input.base.owner.id, input.base.source, input.open);
		if (!input.open) return [];
		return enqueueMany(
			tx,
			taskReminderTimes(input.due)
				.filter((t) => t.at >= asOf)
				.map((t) => ({
					...input.base,
					category: t.slot === "due" ? "task_due" : "task_overdue",
					occurrence: t.slot,
					eligibleAt: t.at,
				})),
		);
	}
	async function syncMeetingReminders(
		tx: Transaction,
		input: {
			base: Omit<NoticeInput, "category" | "occurrence" | "eligibleAt">;
			date: string;
			time: string;
			zone: string;
			scheduled: boolean;
			startsAt: string;
			asOf: string;
		},
	) {
		const asOf = instant.parse(input.asOf),
			startsAt = instant.parse(input.startsAt);
		await cancelForEntity(tx, input.base.owner.id, input.base.source, input.scheduled && startsAt > asOf);
		if (!input.scheduled || startsAt <= asOf) return [];
		return enqueueMany(
			tx,
			meetingReminderTimes(input.date, input.time, input.zone)
				.filter((t) => t.at >= asOf)
				.map((t) => ({ ...input.base, category: "meeting_reminder", occurrence: t.slot, eligibleAt: t.at })),
		);
	}
	return { enqueue, enqueueMany, cancelForEntity, syncTaskReminders, syncMeetingReminders };
}
// A Discovery receipt deliberately has no plant or inbox anchor.
export async function sendDiscoveryAssociationReceipt(
	tx: Transaction,
	mail: ReturnType<typeof createMailService>,
	input: {
		organization: string;
		account: string;
		occurrence: string;
		operation: string;
		content: MailIntent["content"];
		address: (tx: Transaction, accounts: readonly string[]) => Promise<ReadonlyMap<string, string>>;
		now: string;
		verifyOccurrence: (tx: Transaction) => Promise<boolean>;
	},
) {
	if (!(await input.verifyOccurrence(tx))) throw Error("association_occurrence_unavailable");
	z.uuid().parse(input.operation);
	const rows = await tx
		.select({ account_id: tables.seat.account_id })
		.from(tables.seat)
		.where(
			and(
				and(eq(tables.seat.organization_id, input.organization), eq(tables.seat.role, "owner")),
				isNull(tables.seat.ended_at),
			),
		)
		.for("share");
	const recipients = [...new Set([input.account, ...rows.map((r) => z.uuid().parse(r.account_id))])];
	const addresses = await input.address(tx, recipients);
	return mail.enqueueMany(
		tx,
		recipients.flatMap((recipient) => {
			const address = addresses.get(recipient);
			return address
				? [
						{
							owner: { kind: "account", id: recipient },
							recipient,
							address,
							purpose: "discovery_receipt",
							logicalKey: `association/${input.operation}/${input.occurrence}/${recipient}`,
							content: input.content,
							operation: null,
							notice: null,
							eligibleAt: input.now,
						},
					]
				: [];
		}),
	);
}

/** One durable notice batch for all links changed by a discovery conversion. */
export async function sendOnboardingRelationships(
	tx: Transaction,
	inputs: readonly Parameters<import("@everyfield/domain/organizations").OrganizationEffects["notice"]>[1][],
	mail: ReturnType<typeof createMailService>,
) {
	if (!inputs.length) return;
	const organizations = [...new Set(inputs.map((i) => i.pair.organization.id))];
	const owners = await tx.execute(
		sql`SELECT organization_id,account_id FROM seat WHERE organization_id=ANY(${sql.param(organizations)}::uuid[]) AND role='owner' AND ended_at IS NULL AND accepted_at<=clock_timestamp()`,
	);
	const notices = inputs.flatMap((i) =>
		[
			...new Set([
				...(i.actorId ? [i.actorId] : []),
				...owners.rows
					.filter((r) => r.organization_id === i.pair.organization.id)
					.map((r) => z.uuid().parse(r.account_id)),
			]),
		].map((recipient) => ({ i, recipient })),
	);
	const addresses = await readAccountContacts(tx, [...new Set(notices.map((n) => n.recipient))]);
	await enqueueJobs(
		tx,
		inputs.map((i) => ({
			tenant: i.pair.organization.id,
			kind: "assessment",
			subject: i.relationshipId,
			key: "onboarding/" + i.relationshipId + "/" + i.revision,
			revision: i.revision,
			eligibleAt: new Date().toISOString(),
		})),
	);
	await mail.enqueueMany(
		tx,
		notices.map(({ i, recipient }) => {
			const address = addresses.get(recipient);
			if (!address) throw Error("recipient_unavailable");
			return {
				owner: { kind: "account", id: recipient },
				purpose: i.pair.kind === "discovery" ? "discovery_receipt" : "relationship_receipt",
				logicalKey: "relationship/" + i.eventId + "/" + recipient,
				recipient,
				address,
				content: { subject: "Relationship updated", text: "A church relationship you are part of changed." },
				operation: null,
				notice: null,
				eligibleAt: new Date().toISOString(),
			};
		}),
	);
}
