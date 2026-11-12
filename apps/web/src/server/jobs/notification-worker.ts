import type { Database, Transaction } from "@everyfield/db/client";
import { authorizeMeetingNotices, meetingNotice, planNotifications } from "@everyfield/domain/meetings";
import { reminderRecipients } from "@everyfield/domain/tasks";
import "server-only";
import { z } from "zod";
import { mailEnv } from "../mail-env.ts";
import { transaction } from "../platform/database.ts";
import { createMailService, mailUnsubscribe } from "./mail.ts";
import { createNotificationService } from "./notifications.ts";
import { claimDue, finishClaim, finishJob, lockClaim, recoverLease, type Claim, type JobResult } from "./queue.ts";

// The notification worker (NTF-006), run by the scheduled runner. Meeting writes queue one `notification` job per
// announcement and reminder slot (syncReminderJobs in packages/domain/src/meetings). Each due job reads its meeting's
// plan as of the run, and a planned slot writes one notice per current recipient, with its email, through the
// notification service, in the transaction that finishes the job.

const NOTICES_PER_RUN = 20;
const slot = z.enum(["announcement", "day_7", "day_3", "day_1"]);
/** The slot a job key names: `meeting/announcement`, or `meeting/day_7/<start>` for a reminder. */
const slotOf = (key: string) => slot.parse(key.split("/")[1]);

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
	const notifications = createNotificationService({
		mail: config.mail,
		// A recipient gets a notice only while they hold an accepted seat in the church, at that seat's address.
		async eligible(tx, inputs) {
			const [plant, ...others] = new Set(inputs.map((i) => i.owner.id));
			if (others.length) throw Error("notification_owner_mismatch");
			const addresses = plant
				? await reminderRecipients(tx, plant, [...new Set(inputs.map((i) => i.recipient))])
				: null;
			return inputs.map((i) => {
				const address = addresses?.get(i.recipient);
				return address ? { address } : null;
			});
		},
	});

	/** One claimed job: write its slot's notices when the plan still has it planned, or nothing. */
	async function deliver(tx: Transaction, claim: Claim, asOf: string): Promise<Outcome> {
		if (!(await lockClaim(tx, claim))) return "lost";
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

let mounted: NotificationWorker | undefined;
/** The runner's notification worker, or null when the deployment has no mail configuration. Mail is queued here only. */
export function notificationsMount(db: Database | null): NotificationWorker | null {
	const v = z.object(mailEnv).safeParse(process.env);
	if (!db || !v.success) return null;
	mounted ??= createNotificationWorker({
		mail: createMailService({
			db,
			encryptionKey: Buffer.from(v.data.IDENTITY_MAIL_KEY, "hex"),
			addressKey: Buffer.from(v.data.IDENTITY_ADDRESS_KEY, "hex"),
			from: v.data.IDENTITY_MAIL_FROM,
			authorize: authorizeMeetingNotices,
			unsubscribe: mailUnsubscribe(),
			// This mount queues mail through a transport that refuses every send, so nothing is sent from it yet.
			transport: {
				async send() {
					return { kind: "refused", retryable: true };
				},
				async lookup() {
					return { kind: "unknown" };
				},
			},
		}),
	});
	return mounted;
}
