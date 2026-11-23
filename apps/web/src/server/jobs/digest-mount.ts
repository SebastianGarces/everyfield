import "server-only";
import type { Database } from "@everyfield/db/client";
import {
	authorizeDigestMail,
	createDigestWorker,
	MAIL_PASSES,
	mailUnsubscribe,
	mountMailService,
	runDueMail,
	type DigestWorker,
	type MailPass,
	type MailTransport,
} from "@everyfield/domain/jobs";
import { serverConfig, serverEnv } from "../config.ts";

let mounted: DigestWorker | undefined;
export function digestsMount(db: Database): DigestWorker {
	const config = serverConfig();
	mounted ??= createDigestWorker({
		origin: config.IDENTITY_ORIGIN,
		mail: mountMailService({
			db,
			env: config,
			authorize: authorizeDigestMail,
			unsubscribe: mailUnsubscribe(serverEnv()),
		}),
	});
	return mounted;
}

export function digestMailPass(db: Database, transport: MailTransport): MailPass {
	const mail = mountMailService({
		db,
		env: serverConfig(),
		authorize: authorizeDigestMail,
		unsubscribe: mailUnsubscribe(serverEnv()),
		transport,
	});
	return (limit, until) => runDueMail(db, mail, MAIL_PASSES.digest, limit, until);
}
