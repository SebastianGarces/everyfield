import { privateStorage } from "@everyfield/db/schema";
import { cleanupDatabase, jobDatabase } from "@/server/database";
import { digestMailPass, digestsMount } from "@/server/jobs/digest";
import { noticeMailPass, notificationsMount } from "@/server/jobs/notification-worker";
import { tasksMount } from "@/server/tasks";
import { runDueInvitationMail } from "@/server/invitations";
import { identityMailPass } from "@/server/identity";
import { organizationMailPass } from "@/server/organizations";
import { onboardingMailPass } from "@/server/onboarding";
import { settingsMailPass } from "@/features/settings/mail";
import { deliveryTransport, mailReady, queuedMailTransport } from "@/features/communication/mail";
import { scheduledJobs, scheduledMessages } from "@/server/jobs/scheduled";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// A turn may start in the first 60 s and run for 180 s.
export const maxDuration = 300;

// Every minute: runs due background jobs and closes lost ones (server/jobs/scheduled.ts).
export function GET(request: Request): Promise<Response> {
	const db = jobDatabase();
	const ready = mailReady();
	return scheduledJobs({
		secret: process.env.CRON_SECRET,
		db,
		storage: privateStorage(),
		cleanup: cleanupDatabase(),
		reminders: tasksMount()?.reminders ?? null,
		digests: digestsMount(db),
		notifications: notificationsMount(db),
		mail: ready ? (limit, until) => runDueInvitationMail(queuedMailTransport(ready), limit, until) : null,
		messages: ready && db ? scheduledMessages(db, deliveryTransport(ready), ready.keys) : null,
		mountMail: ready
			? {
					identity: identityMailPass(queuedMailTransport(ready)),
					organization: organizationMailPass(queuedMailTransport(ready)),
					settings: settingsMailPass(queuedMailTransport(ready)),
					onboarding: onboardingMailPass(queuedMailTransport(ready)),
					notice: noticeMailPass(db, queuedMailTransport(ready)),
					digest: digestMailPass(db, queuedMailTransport(ready)),
				}
			: undefined,
	})(request);
}
