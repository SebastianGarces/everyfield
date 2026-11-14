import type { Database } from "@everyfield/db/client";
import { authorizeLaunchNotices, createLaunchWriter } from "@everyfield/domain/launch";
import "server-only";
import { z } from "zod";
import { mailEnv } from "../mail-env.ts";
import { database } from "../database";
import { mountMailService, seatedNotificationService } from "../jobs/seated-notifications";
import { launchNotices } from "./notices";

// The Launch mount (WP-045). Completing a milestone queues its Launch notifications in the same transaction through
// WP-031's notification service; the runner's notice mail pass sends the email later.

const env = z.object({
	IDENTITY_DATABASE_URL: z.string().min(1),
	...mailEnv,
});

let mount: ReturnType<typeof create> | undefined;
function create(v: z.infer<typeof env>) {
	const db: Database = database(v.IDENTITY_DATABASE_URL);
	const notifications = seatedNotificationService(mountMailService({ db, env: v, authorize: authorizeLaunchNotices }));
	return { db, writer: createLaunchWriter({ notices: launchNotices(notifications) }) };
}
/** The Launch writer and its database, or null when the deployment has no identity and mail configuration. */
export function launchMount() {
	const v = env.safeParse(process.env);
	if (!v.success) return null;
	mount ??= create(v.data);
	return mount;
}
