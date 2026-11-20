import { reminderSlot } from "@everyfield/contracts/meetings";
import type { Database, Transaction } from "@everyfield/db/client";
import { sql } from "@everyfield/db/query";
import { meetingMailGrants, meetingNotice, planNotifications } from "@everyfield/domain/meetings";
import {
	milestone,
	milestoneCategory,
	planMilestoneNotice,
	planResidencyNotice,
	planReviewNotice,
	relationshipMailGrants,
	residencyCategory,
	residencyJobOf,
	residencyMailGrants,
	reviewJobOf,
	reviewMailGrants,
} from "@everyfield/domain/organizations";
import { authorizeLaunchNotices } from "@everyfield/domain/launch";
import { authorizePhaseNotices } from "@everyfield/domain/phases";
import { authorizeTaskReminders } from "@everyfield/domain/tasks";
import "server-only";
import { z } from "zod";
import { reviewPath } from "../organizations/reviews/model.ts";
import { milestonePath } from "../residency/model.ts";
import { serverConfig, serverEnv } from "../../server/config.ts";
import {
	transaction,
	MAIL_PASSES,
	mailUnsubscribe,
	runDueMail,
	type AuthorizeMail,
	type createMailService,
	type MailPass,
	type MailTransport,
	claimDue,
	finishClaim,
	finishJob,
	lockClaim,
	recoverLease,
	type Claim,
	type JobResult,
} from "@everyfield/domain/jobs";
import {
	accountNotificationService,
	mountMailService,
	seatedNotificationService,
} from "../../server/jobs/seated-notifications.ts";
import { logLine } from "@everyfield/domain/log";

const NOTICES_PER_RUN = 20;
const slotOf = (key: string) => reminderSlot.parse(key.split("/")[1]);
const milestoneOf = (key: string) => milestone.parse(key.split("/")[1]);

type Outcome = "lost" | "stale" | "passed" | "suppressed" | "planned";
const finish: Record<Exclude<Outcome, "lost">, JobResult> = {
	planned: { state: "succeeded" },
	stale: { state: "superseded", code: "stale" },
	passed: { state: "cancelled", code: "passed" },
	suppressed: { state: "cancelled", code: "suppressed" },
};

export function createNotificationWorker(config: {
	mail: ReturnType<typeof createMailService>;
	origin?: string | null;
}) {
	const notifications = seatedNotificationService(config.mail);
	const accounts = accountNotificationService(config.mail);

	async function deliver(tx: Transaction, claim: Claim, asOf: string): Promise<Outcome> {
		if (!(await lockClaim(tx, claim))) return "lost";
		if (claim.producer_key.startsWith("residency/")) return deliverResidency(tx, claim);
		if (claim.producer_key.startsWith("review/")) return deliverReview(tx, claim);
		return claim.producer_key.startsWith("affiliation/") ? deliverMilestone(tx, claim) : deliverSlot(tx, claim, asOf);
	}

	async function deliverResidency(tx: Transaction, claim: Claim): Promise<Outcome> {
		const org = claim.tenant_id;
		const enrollmentId = z.uuid().parse(claim.subject_record_id);
		const job = residencyJobOf(claim.producer_key);
		const plan = await planResidencyNotice(tx, org, { enrollmentId, ...job });
		if (!plan) return "stale";
		if (!plan.holds) return "suppressed";
		const link = config.origin ? `\n\nOpen My residency: ${config.origin}${milestonePath(job.milestoneId)}` : "";
		await accounts.enqueue(tx, {
			owner: { kind: "organization", id: org, organizationKind: plan.organizationKind },
			source: { kind: "development_enrollment", id: enrollmentId, revision: "1" },
			recipient: plan.recipient,
			category: residencyCategory[job.occurrence],
			occurrence: job.feedbackId ? `${job.milestoneId}/${job.feedbackId}` : job.milestoneId,
			eligibleAt: new Date().toISOString(),
			title: plan.title,
			text: plan.text,
			mailText: plan.text + link,
			operation: null,
		});
		return "planned";
	}

	async function deliverReview(tx: Transaction, claim: Claim): Promise<Outcome> {
		const org = claim.tenant_id;
		const reviewId = reviewJobOf(claim.producer_key);
		const plan = await planReviewNotice(tx, org, reviewId);
		if (!plan) return "stale";
		if (!plan.holds) return "suppressed";
		const link = config.origin ? `\n\nOpen it in Everyfield: ${config.origin}${reviewPath(reviewId)}` : "";
		await accounts.enqueue(tx, {
			owner: { kind: "organization", id: org, organizationKind: plan.organizationKind },
			source: { kind: "answer_review", id: reviewId, revision: "1" },
			recipient: plan.recipient,
			category: "answer_review",
			occurrence: reviewId,
			eligibleAt: new Date().toISOString(),
			title: plan.title,
			text: plan.text,
			mailText: plan.text + link,
			operation: null,
		});
		return "planned";
	}

	async function deliverMilestone(tx: Transaction, claim: Claim): Promise<Outcome> {
		const plant = claim.tenant_id;
		const affiliationId = z.uuid().parse(claim.subject_record_id);
		const occurrence = milestoneOf(claim.producer_key);
		const revision = z.string().parse(claim.source_revision);
		const plan = await planMilestoneNotice(tx, plant, { affiliationId, occurrence, revision });
		if (!plan) return "stale";
		if (!plan.holds) return "suppressed";
		const eligibleAt = new Date().toISOString();
		await notifications.enqueueMany(
			tx,
			plan.recipients.map((recipient) => ({
				owner: { kind: "plant" as const, id: plant },
				source: { kind: "affiliation" as const, id: affiliationId, revision },
				recipient,
				category: milestoneCategory[occurrence],
				occurrence,
				eligibleAt,
				title: plan.title,
				text: plan.text,
				operation: null,
			})),
		);
		return "planned";
	}

	async function deliverSlot(tx: Transaction, claim: Claim, asOf: string): Promise<Outcome> {
		const plant = claim.tenant_id;
		const meetingId = z.uuid().parse(claim.subject_record_id);
		const current = slotOf(claim.producer_key);
		const plan = await planNotifications(tx, plant, { meetingId, asOf });
		if (!plan || plan.revision !== claim.source_revision) return "stale";
		const planned = plan.slots.find((s) => s.slot === current);
		if (!planned) return "stale";
		if (planned.state !== "planned") return planned.state;
		if (!planned.recipients.length) return "planned";
		const content = await meetingNotice(tx, plant, meetingId, current);
		if (!content) return "stale";
		const eligibleAt = new Date().toISOString();
		await notifications.enqueueMany(
			tx,
			planned.recipients.map((recipient) => ({
				owner: { kind: "plant" as const, id: plant },
				source: { kind: "meeting" as const, id: meetingId, revision: plan.revision },
				recipient,
				category: current === "announcement" ? ("meeting_announcement" as const) : ("meeting_reminder" as const),
				occurrence: current,
				eligibleAt,
				title: content.title,
				text: content.text,
				operation: null,
			})),
		);
		return "planned";
	}

	async function run(db: Database, asOf: string, limit = NOTICES_PER_RUN, until = Infinity) {
		await recoverLease(db);
		let sent = 0;
		for (let n = 0; n < limit && Date.now() < until; n++) {
			const [claim] = await claimDue(db, ["notification"]);
			if (!claim) break;
			try {
				const outcome = await transaction(db, async (tx) => {
					const result = await deliver(tx, claim, asOf);
					if (result !== "lost" && !(await finishClaim(tx, claim, finish[result])))
						throw Error("notification_claim_lost");
					return result;
				});
				if (outcome === "planned") sent++;
			} catch {
				logLine({ component: "notification", outcome: "error" });
				await finishJob(db, claim, { state: "retry_wait", code: "notification_failed" });
			}
		}
		return sent;
	}

	return { run };
}
export type NotificationWorker = ReturnType<typeof createNotificationWorker>;

export async function authorizeNotificationMail(
	tx: Transaction,
	mail: readonly { id: string; recipient: string | null; notice: string | null }[],
): Promise<ReadonlySet<string>> {
	const rows = mail.map((m) => ({ id: m.id, recipient: m.recipient, notice: m.notice }));
	const input = sql`jsonb_to_recordset(${JSON.stringify(rows)}::jsonb) i(id uuid,recipient uuid,notice uuid)`;
	const r = await tx.execute(sql`WITH meeting AS (${meetingMailGrants(input)}),
		relationship AS (${relationshipMailGrants(input)}), residency AS (${residencyMailGrants(input)}),
		review AS (${reviewMailGrants(input)})
		SELECT id FROM meeting UNION SELECT id FROM relationship UNION SELECT id FROM residency UNION SELECT id FROM review`);
	return new Set(
		z
			.array(z.object({ id: z.uuid() }))
			.parse(r.rows)
			.map((row) => row.id),
	);
}

let mounted: NotificationWorker | undefined;
export function notificationsMount(db: Database): NotificationWorker {
	const config = serverConfig();
	mounted ??= createNotificationWorker({
		mail: mountMailService({
			db,
			env: config,
			authorize: authorizeNotificationMail,
			unsubscribe: mailUnsubscribe(serverEnv()),
		}),
		origin: new URL(config.IDENTITY_ORIGIN).origin,
	});
	return mounted;
}

const authorizeNoticeMail: AuthorizeMail = async (tx, mail) => {
	const granted = new Set<string>();
	for (const rule of [authorizeTaskReminders, authorizePhaseNotices, authorizeLaunchNotices, authorizeNotificationMail])
		for (const id of await rule(tx, mail)) granted.add(id);
	return granted;
};

export function noticeMailPass(db: Database, transport: MailTransport): MailPass {
	const mail = mountMailService({
		db,
		env: serverConfig(),
		authorize: authorizeNoticeMail,
		unsubscribe: mailUnsubscribe(serverEnv()),
		transport,
	});
	return (limit, until) => runDueMail(db, mail, MAIL_PASSES.notice, limit, until);
}
