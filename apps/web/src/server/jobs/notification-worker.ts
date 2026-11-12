import { reminderSlot } from "@everyfield/contracts/meetings";
import type { Database, Transaction } from "@everyfield/db/client";
import { sql } from "@everyfield/db/query";
import { meetingMailGrants, meetingNotice, planNotifications } from "@everyfield/domain/meetings";
import {
	milestone,
	milestoneCategory,
	planMilestoneNotice,
	relationshipMailGrants,
} from "@everyfield/domain/organizations";
import { authorizePhaseNotices } from "@everyfield/domain/phases";
import { authorizeTaskReminders } from "@everyfield/domain/tasks";
import "server-only";
import { z } from "zod";
import { mailEnv } from "../mail-env.ts";
import { transaction } from "../platform/database.ts";
import {
	MAIL_PASSES,
	mailUnsubscribe,
	runDueMail,
	type AuthorizeMail,
	type createMailService,
	type MailPass,
	type MailTransport,
} from "./mail.ts";
import { claimDue, finishClaim, finishJob, lockClaim, recoverLease, type Claim, type JobResult } from "./queue.ts";
import { mountMailService, seatedNotificationService } from "./seated-notifications.ts";

// The notification worker (NTF-006, NTF-009), run by the scheduled runner. Meeting writes queue one `notification` job
// per announcement and reminder slot (syncReminderJobs in packages/domain/src/meetings); approving or ending a plant's
// connection, and changing what it shares, queue one per occurrence (queueMilestoneJob in
// packages/domain/src/organizations). Each due job reads its plan as of the run, and a planned slot or an occurrence
// that still holds writes one notice per current recipient, with its email, through the notification service, in the
// transaction that finishes the job.

const NOTICES_PER_RUN = 20;
/** The slot a meeting job key names: `meeting/announcement`, or `meeting/day_7/<start>` for a reminder. */
const slotOf = (key: string) => reminderSlot.parse(key.split("/")[1]);
/** The occurrence an affiliation job key names: `affiliation/approved/<revision>`. */
const milestoneOf = (key: string) => milestone.parse(key.split("/")[1]);

type Outcome = "lost" | "stale" | "passed" | "suppressed" | "planned";
const finish: Record<Exclude<Outcome, "lost">, JobResult> = {
	planned: { state: "succeeded" },
	// The meeting changed after this job and the change did not reach it (or the meeting is gone): its write already
	// queued what the meeting now owes.
	stale: { state: "superseded", code: "stale" },
	passed: { state: "cancelled", code: "passed" },
	suppressed: { state: "cancelled", code: "suppressed" },
};

export function createNotificationWorker(config: { mail: ReturnType<typeof createMailService> }) {
	const notifications = seatedNotificationService(config.mail);

	/** One claimed job: write its notices when its plan still owes them, or nothing. */
	async function deliver(tx: Transaction, claim: Claim, asOf: string): Promise<Outcome> {
		if (!(await lockClaim(tx, claim))) return "lost";
		return claim.producer_key.startsWith("affiliation/") ? deliverMilestone(tx, claim) : deliverSlot(tx, claim, asOf);
	}

	/**
	 * A connection or sharing milestone: one notice owned by the plant to each of its current Owners and Admins, while
	 * the occurrence still holds (D-796). A later change to the connection does not stale it: the notice keeps the
	 * revision its occurrence wrote.
	 */
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

	/** A meeting slot: its notices when the meeting's plan still has it planned, or nothing. */
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
		// The notice shows from when it is written: the plan's clock decides whether the slot is owed, not when it shows.
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

	/**
	 * Runs up to `limit` due notification jobs before `until`, one transaction each, after returning expired leases to
	 * the queue. A job that throws waits for its retry through the queue's backoff. Returns how many slots it wrote.
	 */
	async function run(db: Database, asOf: string, limit = NOTICES_PER_RUN, until = Infinity) {
		await recoverLease(db);
		let sent = 0;
		for (let n = 0; n < limit && Date.now() < until; n++) {
			const [claim] = await claimDue(db, ["notification"]);
			if (!claim) break;
			try {
				const outcome = await transaction(db, async (tx) => {
					const result = await deliver(tx, claim, asOf);
					// A claim lost before its finish rolls its notices back, so its retry writes them once.
					if (result !== "lost" && !(await finishClaim(tx, claim, finish[result])))
						throw Error("notification_claim_lost");
					return result;
				});
				if (outcome === "planned") sent++;
			} catch {
				// No error text: it can carry row values.
				console.error(JSON.stringify({ component: "notification", outcome: "error" }));
				await finishJob(db, claim, { state: "retry_wait", code: "notification_failed" });
			}
		}
		return sent;
	}

	return { run };
}
export type NotificationWorker = ReturnType<typeof createNotificationWorker>;

/**
 * Which notification mail may go out, checked at send time in one statement: a meeting notice under the meeting rule
 * (meetingMailGrants), a connection or sharing milestone under its own (relationshipMailGrants).
 */
export async function authorizeNotificationMail(
	tx: Transaction,
	mail: readonly { id: string; recipient: string | null; notice: string | null }[],
): Promise<ReadonlySet<string>> {
	const rows = mail.map((m) => ({ id: m.id, recipient: m.recipient, notice: m.notice }));
	const input = sql`jsonb_to_recordset(${JSON.stringify(rows)}::jsonb) i(id uuid,recipient uuid,notice uuid)`;
	const r =
		await tx.execute(sql`WITH meeting AS (${meetingMailGrants(input)}), relationship AS (${relationshipMailGrants(input)})
		SELECT id FROM meeting UNION SELECT id FROM relationship`);
	return new Set(
		z
			.array(z.object({ id: z.uuid() }))
			.parse(r.rows)
			.map((row) => row.id),
	);
}

let mounted: NotificationWorker | undefined;
/** The runner's notification worker, or null when the deployment has no mail configuration. Mail is queued here only: `noticeMailPass` sends it. */
export function notificationsMount(db: Database | null): NotificationWorker | null {
	const v = z.object(mailEnv).safeParse(process.env);
	if (!db || !v.success) return null;
	mounted ??= createNotificationWorker({
		mail: mountMailService({ db, env: v.data, authorize: authorizeNotificationMail, unsubscribe: mailUnsubscribe() }),
	});
	return mounted;
}

/**
 * Which notice email may go out, each under its own source's rule: a task reminder (authorizeTaskReminders), a phase
 * advance (authorizePhaseNotices), a meeting notice or a milestone (authorizeNotificationMail). Each rule grants only
 * notices of its own purposes, so a mail passes under at most one.
 */
const authorizeNoticeMail: AuthorizeMail = async (tx, mail) => {
	const granted = new Set<string>();
	for (const rule of [authorizeTaskReminders, authorizePhaseNotices, authorizeNotificationMail])
		for (const id of await rule(tx, mail)) granted.add(id);
	return granted;
};

/**
 * The scheduled runner's notice mail pass (`notice/` keys): one bounded batch through `transport`, each mail rechecked
 * under its notice's own rule and email preference just before the handoff. Null without mail configuration.
 */
export function noticeMailPass(db: Database | null, transport: MailTransport): MailPass | null {
	const v = z.object(mailEnv).safeParse(process.env);
	if (!db || !v.success) return null;
	const mail = mountMailService({
		db,
		env: v.data,
		authorize: authorizeNoticeMail,
		unsubscribe: mailUnsubscribe(),
		transport,
	});
	return (limit, until) => runDueMail(db, mail, MAIL_PASSES.notice, limit, until);
}
