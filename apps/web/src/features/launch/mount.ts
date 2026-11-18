import type { Database } from "@everyfield/db/client";
import { authorizeLaunchNotices, createLaunchWriter } from "@everyfield/domain/launch";
import "server-only";
import { z } from "zod";
import { mailEnv } from "../mail-env.ts";
import { database } from "../database";
import { mountMailService, seatedNotificationService } from "../jobs/seated-notifications";
import { launchNotices } from "./notices";

const env = z.object({
	IDENTITY_DATABASE_URL: z.string().min(1),
	...mailEnv,
});

let mount: ReturnType<typeof create> | undefined;
function create(v: z.infer<typeof env>) {
	const db: Database = database(v.IDENTITY_DATABASE_URL);
	const notifications = seatedNotificationService(mountMailService({ db, env: v, authorize: authorizeLaunchNotices }));
	const notices = launchNotices(notifications);
	return { db, notices, writer: createLaunchWriter({ notices }) };
}
export function launchMount() {
	const v = env.safeParse(process.env);
	if (!v.success) return null;
	mount ??= create(v.data);
	return mount;
}
