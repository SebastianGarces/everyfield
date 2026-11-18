import type { Database } from "@everyfield/db/client";
import { authorizePhaseNotices, createPhaseWriter, type PhaseNotices } from "@everyfield/domain/phases";
import "server-only";
import { z } from "zod";
import { mailEnv } from "../../server/mail-env.ts";
import { database } from "../../server/database";
import { createMailService } from "../../server/jobs/mail";
import { createNotificationService } from "../../server/jobs/notifications";
import { phaseNotices } from "./notices";

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
export function phasesMount() {
	const v = env.safeParse(process.env);
	if (!v.success) return null;
	mount ??= create(v.data);
	return mount;
}
