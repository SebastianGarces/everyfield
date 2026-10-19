import { and, eq, gt, isNotNull, isNull, or, sql } from "@everyfield/db/query";
import * as tables from "@everyfield/db/tables";
import "server-only";
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
	eligible: (tx: Transaction, input: NoticeInput) => Promise<{ address: string | null } | null>;
}) {
	async function enqueue(tx: Transaction, input: NoticeInput) {
		const v = noticeInput.parse(input),
			p = policy[v.category];
		if (!p.source || p.source !== v.source.kind) throw Error("notification_source_mismatch");
		const tenant = await tx
			.select({ kind: tables.tenant.kind })
			.from(tables.tenant)
			.where(eq(tables.tenant.id, v.owner.id));
		if (tenant[0]?.kind !== v.owner.kind) throw Error("notification_owner_mismatch");
		if (v.owner.kind === "organization") {
			const org = await tx
				.select({ kind: tables.organization.kind })
				.from(tables.organization)
				.where(eq(tables.organization.id, v.owner.id))
				.for("share");
			if (org[0]?.kind !== v.owner.organizationKind) throw Error("notification_owner_mismatch");
		}
		if (!(await lockSource(tx, v.owner.id, v.source))) throw Error("notification_source_stale");
		if (v.source.kind === "task") {
			const task = await tx
				.select({ id: tables.task.id })
				.from(tables.task)
				.where(
					and(
						and(
							and(eq(tables.task.id, v.source.id), eq(tables.task.assignee_id, v.recipient)),
							isNull(tables.task.deleted_at),
						),
						sql<boolean>`(${tables.task.status} NOT IN ('complete', 'no_longer_needed'))`,
					),
				)
				.for("share");
			if (task.length !== 1) return { notice: null, mail: null };
		}
		if (v.source.kind === "meeting") {
			const meeting = await tx
				.select({ id: tables.meeting.id })
				.from(tables.meeting)
				.where(
					and(
						and(
							eq(tables.meeting.id, v.source.id),
							sql<boolean>`(${tables.meeting.status} NOT IN ('cancelled', 'completed'))`,
						),
						gt(
							tables.meeting.starts_at,
							sql<Date>`clock_timestamp()`.mapWith((value: string) => new Date(value)),
						),
					),
				)
				.for("share");
			if (meeting.length !== 1) return { notice: null, mail: null };
		}
		if (v.source.kind === "launch_milestone") {
			const launch = await tx
				.select({ id: tables.launch_milestone.id })
				.from(tables.launch_milestone)
				.where(
					and(
						and(eq(tables.launch_milestone.id, v.source.id), isNotNull(tables.launch_milestone.completed_at)),
						isNull(tables.launch_milestone.removed_at),
					),
				)
				.for("share");
			if (launch.length !== 1) return { notice: null, mail: null };
		}
		if (v.category === "wiki_upstream_review") {
			if (v.owner.kind !== "organization") throw Error("notification_owner_mismatch");
			const seat = await tx
				.select({ id: tables.seat.id })
				.from(tables.seat)
				.where(
					and(
						and(
							and(eq(tables.seat.account_id, v.recipient), eq(tables.seat.organization_id, v.owner.id)),
							isNull(tables.seat.ended_at),
						),
						sql<boolean>`(${tables.seat.role} IN ('owner', 'admin'))`,
					),
				)
				.for("share");
			if (seat.length !== 1) return { notice: null, mail: null };
		}
		const recipient = await config.eligible(tx, v);
		if (!recipient) return { notice: null, mail: null };
		const key = `${v.owner.id}/${v.category}/${v.source.id}/${v.source.revision}/${v.occurrence}`;
		const old = await tx
			.select({
				id: tables.notice.id,
				title: tables.notice.title,
				safe_body: tables.notice.safe_body,
				eligible_at: tables.notice.eligible_at,
			})
			.from(tables.notice)
			.where(and(eq(tables.notice.recipient_id, v.recipient), eq(tables.notice.logical_key, key)));
		if (old[0]) {
			if (
				old[0].title !== v.title ||
				old[0].safe_body !== v.text ||
				old[0].eligible_at.toISOString() !== new Date(v.eligibleAt).toISOString()
			)
				throw Error("notification_identity_conflict");
			const mail = await tx
				.select({ id: tables.mail.id })
				.from(tables.mail)
				.where(eq(tables.mail.notice_id, old[0].id));
			return { notice: z.uuid().parse(old[0].id), mail: mail[0] ? z.uuid().parse(mail[0].id) : null };
		}
		// Wiki editor notices remain in-app even when an email preference is supplied elsewhere.
		const inApp = await channelEnabled(tx, v.recipient, v.category, "in_app");
		const email = v.category !== "wiki_upstream_review" && (await channelEnabled(tx, v.recipient, v.category, "email"));
		if (!inApp && !email) return { notice: null, mail: null };
		const inserted =
			await tx.execute(sql`INSERT INTO notice(tenant_id,recipient_id,category,purpose,logical_key,source_record_id,
      source_revision,title,safe_body,eligible_at,created_at,archived_at)
      VALUES(${v.owner.id},${v.recipient},${p.category},${p.purpose},${key},${v.source.id},${v.source.revision},${v.title},${v.text},${v.eligibleAt},clock_timestamp(),CASE WHEN ${inApp} THEN NULL ELSE clock_timestamp() END)
      ON CONFLICT(recipient_id,logical_key) DO UPDATE SET logical_key=excluded.logical_key RETURNING id`);
		const id = z.uuid().parse(inserted.rows[0]!.id);
		const mail =
			email && recipient.address
				? await config.mail.enqueue(tx, {
						owner: v.owner,
						recipient: v.recipient,
						address: recipient.address,
						purpose: "notification",
						logicalKey: `notice/${id}`,
						notice: id,
						operation: v.operation,
						eligibleAt: v.eligibleAt,
						content: { subject: v.title, text: v.text },
					})
				: null;
		return { notice: id, mail };
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
		const result = [];
		for (const t of taskReminderTimes(input.due))
			if (t.at >= asOf)
				result.push(
					await enqueue(tx, {
						...input.base,
						category: t.slot === "due" ? "task_due" : "task_overdue",
						occurrence: t.slot,
						eligibleAt: t.at,
					}),
				);
		return result;
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
		const result = [];
		for (const t of meetingReminderTimes(input.date, input.time, input.zone))
			if (t.at >= asOf)
				result.push(
					await enqueue(tx, { ...input.base, category: "meeting_reminder", occurrence: t.slot, eligibleAt: t.at }),
				);
		return result;
	}
	return { enqueue, cancelForEntity, syncTaskReminders, syncMeetingReminders };
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
		address: (tx: Transaction, account: string) => Promise<string | null>;
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
	const ids = [];
	for (const recipient of recipients) {
		const address = await input.address(tx, recipient);
		if (!address) continue;
		ids.push(
			await mail.enqueue(tx, {
				owner: { kind: "account", id: recipient },
				recipient,
				address,
				purpose: "discovery_receipt",
				logicalKey: `association/${input.operation}/${input.occurrence}/${recipient}`,
				content: input.content,
				operation: null,
				notice: null,
				eligibleAt: input.now,
			}),
		);
	}
	return ids;
}
