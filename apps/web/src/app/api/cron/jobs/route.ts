import { privateStorage } from "@everyfield/db/schema";
import { requestDatabase } from "@/server/database";
import { scheduledJobs } from "@/server/jobs/scheduled";
import { tasksMount } from "@/server/tasks";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// A turn may start in the first 60 s and run for 180 s.
export const maxDuration = 300;

// Every minute: runs due background jobs and closes lost ones (server/jobs/scheduled.ts).
export function GET(request: Request): Promise<Response> {
	return scheduledJobs({
		secret: process.env.CRON_SECRET,
		db: requestDatabase(),
		storage: privateStorage(),
		reminders: tasksMount()?.reminders ?? null,
	})(request);
}
