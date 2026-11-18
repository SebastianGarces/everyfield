import type { Database } from "@everyfield/db/client";
import { authorizeTaskReminders, createTaskWriter } from "@everyfield/domain/tasks";
import "server-only";
import { z } from "zod";
import { mailEnv } from "../mail-env.ts";
import { database } from "../database";
import { mountMailService, seatedNotificationService } from "../jobs/seated-notifications";
import { taskReminders } from "./reminders";

const env = z.object({
	IDENTITY_DATABASE_URL: z.string().min(1),
	...mailEnv,
});

let mount: ReturnType<typeof create> | undefined;
function create(v: z.infer<typeof env>) {
	const db: Database = database(v.IDENTITY_DATABASE_URL);
	const notifications = seatedNotificationService(mountMailService({ db, env: v, authorize: authorizeTaskReminders }));
	const reminders = taskReminders(notifications);
	return { db, reminders, writer: createTaskWriter({ reminders }) };
}
export function tasksMount() {
	const v = env.safeParse(process.env);
	if (!v.success) return null;
	mount ??= create(v.data);
	return mount;
}
