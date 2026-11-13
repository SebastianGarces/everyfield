import type { Database } from "@everyfield/db/client";
import { authorizePhaseNotices, createPhaseWriter, type PhaseNotices } from "@everyfield/domain/phases";
import "server-only";
import { z } from "zod";
import { mailEnv } from "../mail-env.ts";
import { database } from "../database";
import { createMailService } from "../jobs/mail";
import { createNotificationService } from "../jobs/notifications";
import { phaseNotices } from "./notices";

// The phases mount (WP-038). A forward move queues its phase-advance notices in the move's transaction through WP-031's
// notification service; the runner's notice mail pass sends them later.

const env = z.object({
	IDENTITY_DATABASE_URL: z.string().min(1),
	...mailEnv,
});

let mount: ReturnType<typeof create> | undefined;
function create(v: z.infer<typeof env>) {
	const db: Database = database(v.IDENTITY_DATABASE_URL);
	const mail = createMailService({
		db,
		encryptionKey: Buffer.from(v.IDENTITY_MAIL_KEY, "hex"),
		addressKey: Buffer.from(v.IDENTITY_ADDRESS_KEY, "hex"),
		from: v.IDENTITY_MAIL_FROM,
		authorize: authorizePhaseNotices,
	});
	const notices: PhaseNotices = phaseNotices((eligible) => createNotificationService({ mail, eligible }));
	return { db, writer: createPhaseWriter({ notices }) };
}
/** The phase writer and its database, or null when the deployment has no identity and mail configuration. */
export function phasesMount() {
	const v = env.safeParse(process.env);
	if (!v.success) return null;
	mount ??= create(v.data);
	return mount;
}
