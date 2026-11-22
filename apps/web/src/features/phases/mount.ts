import type { Database } from "@everyfield/db/client";
import { authorizePhaseNotices, createPhaseWriter, type PhaseNotices } from "@everyfield/domain/phases";
import "server-only";
import { serverConfig, type ServerConfig } from "../../server/config.ts";
import { database } from "../../server/database";
import { createMailService, createNotificationService } from "@everyfield/domain/jobs";
import { phaseNotices } from "./notices";

let mount: ReturnType<typeof create> | undefined;
function create(v: ServerConfig) {
	const db: Database = database(v.IDENTITY_DATABASE_URL);
	const mail = createMailService({
		db,
		encryptionKey: Buffer.from(v.IDENTITY_MAIL_KEY, "hex"),
		addressKey: Buffer.from(v.IDENTITY_ADDRESS_KEY, "hex"),
		from: v.IDENTITY_MAIL_FROM,
		authorize: authorizePhaseNotices,
	});
	const notices: PhaseNotices = phaseNotices((eligible) => createNotificationService({ mail, eligible }));
	return { db, notices, writer: createPhaseWriter({ notices }) };
}
export function phasesMount() {
	mount ??= create(serverConfig());
	return mount;
}
