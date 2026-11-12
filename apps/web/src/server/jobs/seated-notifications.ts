import type { Database } from "@everyfield/db/client";
import { reminderRecipients } from "@everyfield/domain/tasks";
import "server-only";
import type { z } from "zod";
import type { mailEnv } from "../mail-env.ts";
import { createMailService, type AuthorizeMail, type MailUnsubscribe } from "./mail.ts";
import { createNotificationService } from "./notifications.ts";

// The mail and notification services the server mounts share. Mail is queued only: until mail sending exists, every
// mount uses a transport that refuses each send as retryable, so the mail waits in the queue. Notices reach a recipient
// only while they hold an accepted seat in the church, at that seat's address.

/** A mail service whose transport refuses every send, so it queues mail and sends none. */
export function queuedMailService(config: {
	db: Database;
	env: z.infer<z.ZodObject<typeof mailEnv>>;
	authorize: AuthorizeMail;
	unsubscribe?: MailUnsubscribe;
}) {
	return createMailService({
		db: config.db,
		encryptionKey: Buffer.from(config.env.IDENTITY_MAIL_KEY, "hex"),
		addressKey: Buffer.from(config.env.IDENTITY_ADDRESS_KEY, "hex"),
		from: config.env.IDENTITY_MAIL_FROM,
		authorize: config.authorize,
		...(config.unsubscribe !== undefined ? { unsubscribe: config.unsubscribe } : {}),
		transport: {
			async send() {
				return { kind: "refused", retryable: true };
			},
			async lookup() {
				return { kind: "unknown" };
			},
		},
	});
}

/** The notification service for one church's notices, sent to each recipient's accepted seat. */
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
