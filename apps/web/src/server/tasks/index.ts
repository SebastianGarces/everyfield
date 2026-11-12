import type { Database } from "@everyfield/db/client";
import { authorizeTaskReminders, createTaskWriter } from "@everyfield/domain/tasks";
import "server-only";
import { z } from "zod";
import { mailEnv } from "../mail-env.ts";
import { database } from "../database";
import { mountMailService, seatedNotificationService } from "../jobs/seated-notifications";
import { taskReminders } from "./reminders";

// The tasks mount (WP-024). Task screens reach the writer through their server actions and run each command in
// withTaskWrite, which binds the request's verified actor. Every task write that changes owed reminders queues them
// in the same transaction through WP-031's notification service; the runner's notice mail pass sends them later.

const env = z.object({
	IDENTITY_DATABASE_URL: z.string().min(1),
	...mailEnv,
});

let mount: ReturnType<typeof create> | undefined;
function create(v: z.infer<typeof env>) {
	const db: Database = database(v.IDENTITY_DATABASE_URL);
	const notifications = seatedNotificationService(mountMailService({ db, env: v, authorize: authorizeTaskReminders }));
	// Meeting finalization passes `reminders` to the generated-work producers in its own command.
	const reminders = taskReminders(notifications);
	return { db, reminders, writer: createTaskWriter({ reminders }) };
}
/** The task writer, its reminder port and database, or null when the deployment has no identity and mail configuration. */
export function tasksMount() {
	const v = env.safeParse(process.env);
	if (!v.success) return null;
	mount ??= create(v.data);
	return mount;
}
