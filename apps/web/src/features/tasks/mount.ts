import type { Database } from "@everyfield/db/client";
import { authorizeTaskReminders, createTaskWriter } from "@everyfield/domain/tasks";
import "server-only";
import { serverConfig, type ServerConfig } from "../../server/config.ts";
import { database } from "../../server/database";
import { mountMailService, seatedNotificationService } from "../../server/jobs/seated-notifications";
import { taskReminders } from "./reminders";

let mount: ReturnType<typeof create> | undefined;
function create(v: ServerConfig) {
	const db: Database = database(v.IDENTITY_DATABASE_URL);
	const notifications = seatedNotificationService(mountMailService({ db, env: v, authorize: authorizeTaskReminders }));
	const reminders = taskReminders(notifications);
	return { db, reminders, writer: createTaskWriter({ reminders }) };
}
export function tasksMount() {
	mount ??= create(serverConfig());
	return mount;
}
