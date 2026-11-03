import { privateStorage } from "@everyfield/db/schema";
import { jobDatabase } from "@/server/database";
import { scheduledJobs } from "@/server/jobs/scheduled";
import { tasksMount } from "@/server/tasks";
import { runDueInvitationMail } from "@/server/invitations";
import { mailReady, queuedMailTransport } from "@/features/communication/mail";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// A turn may start in the first 60 s and run for 180 s.
export const maxDuration = 300;

// Every minute: runs due background jobs and closes lost ones (server/jobs/scheduled.ts).
export function GET(request: Request): Promise<Response> {
	const ready = mailReady();
	return scheduledJobs({
		secret: process.env.CRON_SECRET,
		db: jobDatabase(),
		storage: privateStorage(),
		reminders: tasksMount()?.reminders ?? null,
		mail: ready ? (limit, until) => runDueInvitationMail(queuedMailTransport(ready), limit, until) : null,
	})(request);
}
