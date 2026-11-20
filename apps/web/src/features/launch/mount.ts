import type { Database } from "@everyfield/db/client";
import { authorizeLaunchNotices, createLaunchWriter } from "@everyfield/domain/launch";
import "server-only";
import { serverConfig, type ServerConfig } from "../../server/config.ts";
import { database } from "../../server/database";
import { mountMailService, seatedNotificationService } from "@everyfield/domain/jobs";
import { launchNotices } from "./notices";

let mount: ReturnType<typeof create> | undefined;
function create(v: ServerConfig) {
	const db: Database = database(v.IDENTITY_DATABASE_URL);
	const notifications = seatedNotificationService(mountMailService({ db, env: v, authorize: authorizeLaunchNotices }));
	const notices = launchNotices(notifications);
	return { db, notices, writer: createLaunchWriter({ notices }) };
}
export function launchMount() {
	mount ??= create(serverConfig());
	return mount;
}
