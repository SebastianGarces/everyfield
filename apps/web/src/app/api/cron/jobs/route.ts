import { privateStorage } from "@everyfield/db/schema";
import { cleanupDatabase, jobDatabase } from "@/server/database";
import { digestMailPass, digestsMount } from "@/server/jobs/digest";
import { noticeMailPass, notificationsMount } from "@/features/notifications/worker";
import { tasksMount } from "@/features/tasks/mount";
import { runDueInvitationMail } from "@/server/invitations";
import { identityMailPass } from "@/server/identity";
import { organizationMailPass } from "@/features/organizations/mount";
import { onboardingMailPass } from "@/features/onboarding/mount";
import { settingsMailPass } from "@/features/settings/mail";
import { feedbackMailPass } from "@/features/feedback/mail";
import { feedbackPublicationMount } from "@/features/feedback/publication";
import { deliveryTransport, mailReady, queuedMailTransport } from "@/server/mail/transport";
import { scheduledJobs, scheduledMessages } from "@/server/jobs/scheduled";
import { cronRoute } from "@/server/platform/cron";
import { configured } from "@/server/platform/boundary";
import { assessmentsMount } from "@/server/jobs/assessment";
import { serverEnv } from "@/server/config";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

export const GET = configured(function GET(request: Request): Promise<Response> {
	const db = jobDatabase();
	const ready = mailReady();
	return cronRoute(
		serverEnv().CRON_SECRET,
		scheduledJobs({
			db,
			storage: privateStorage(),
			cleanup: cleanupDatabase(),
			reminders: tasksMount().reminders,
			digests: digestsMount(db),
			notifications: notificationsMount(db),
			feedbackPublication: feedbackPublicationMount(db),
			assessments: assessmentsMount(db),
			mail: ready ? (limit, until) => runDueInvitationMail(queuedMailTransport(ready), limit, until) : null,
			messages: ready ? scheduledMessages(db, deliveryTransport(ready), ready.keys) : null,
			mountMail: ready
				? {
						identity: identityMailPass(queuedMailTransport(ready)),
						organization: organizationMailPass(queuedMailTransport(ready)),
						settings: settingsMailPass(queuedMailTransport(ready)),
						onboarding: onboardingMailPass(queuedMailTransport(ready)),
						notice: noticeMailPass(db, queuedMailTransport(ready)),
						digest: digestMailPass(db, queuedMailTransport(ready)),
						feedback: feedbackMailPass(queuedMailTransport(ready)),
					}
				: undefined,
		}),
	)(request);
});
