import type { Database } from "@everyfield/db/client";
import { readAccountContacts } from "@everyfield/domain/identity";
import { reminderRecipients } from "@everyfield/domain/tasks";
import "server-only";
import type { z } from "zod";
import type { mailEnv } from "../mail-env.ts";
import { createMailService, type AuthorizeMail, type MailTransport, type MailUnsubscribe } from "./mail.ts";
import { createNotificationService } from "./notifications.ts";

export function mountMailService(config: {
	db: Database;
	env: z.infer<z.ZodObject<typeof mailEnv>>;
	authorize: AuthorizeMail;
	unsubscribe?: MailUnsubscribe;
	transport?: MailTransport;
}) {
	return createMailService({
		db: config.db,
		encryptionKey: Buffer.from(config.env.IDENTITY_MAIL_KEY, "hex"),
		addressKey: Buffer.from(config.env.IDENTITY_ADDRESS_KEY, "hex"),
		from: config.env.IDENTITY_MAIL_FROM,
		authorize: config.authorize,
		...(config.unsubscribe !== undefined ? { unsubscribe: config.unsubscribe } : {}),
		transport: config.transport,
	});
}

export function seatedNotificationService(mail: ReturnType<typeof createMailService>) {
	return createNotificationService({
		mail,
		async eligible(tx, inputs) {
			const [plant, ...others] = new Set(inputs.map((i) => i.owner.id));
			if (others.length) throw Error("notification_owner_mismatch");
			const addresses = plant
				? await reminderRecipients(tx, plant, [...new Set(inputs.map((i) => i.recipient))])
				: null;
			return inputs.map((i) => {
				const address = addresses?.get(i.recipient);
				return address ? { address } : null;
			});
		},
	});
}

export function accountNotificationService(mail: ReturnType<typeof createMailService>) {
	return createNotificationService({
		mail,
		async eligible(tx, inputs) {
			const addresses = await readAccountContacts(tx, [...new Set(inputs.map((i) => i.recipient))]);
			return inputs.map((i) => ({ address: addresses.get(i.recipient) ?? null }));
		},
	});
}
