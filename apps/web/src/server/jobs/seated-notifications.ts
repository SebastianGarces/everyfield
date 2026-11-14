import type { Database } from "@everyfield/db/client";
import { readAccountContacts } from "@everyfield/domain/identity";
import { reminderRecipients } from "@everyfield/domain/tasks";
import "server-only";
import type { z } from "zod";
import type { mailEnv } from "../mail-env.ts";
import { createMailService, type AuthorizeMail, type MailTransport, type MailUnsubscribe } from "./mail.ts";
import { createNotificationService } from "./notifications.ts";

// The mail and notification services the server mounts share. A request or worker that writes notices queues their
// mail with a service that has no transport; the scheduled runner's pass for that mail sends it through the email
// service. Notices reach a recipient only while they hold an accepted seat in the church, at that seat's address; a
// residency notice reaches a linked resident, who holds no seat, at their account's address.

/** A mount's mail service: without `transport` it only queues mail; the runner's pass gives it the email service. */
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

/**
 * The notification service for a linked resident's residency notices (T-365), sent to the account's own address: the
 * resident holds no seat (REQ-MUL-013). The caller has checked, under lock, that the resident's link is live (D-1416).
 */
export function residentNotificationService(mail: ReturnType<typeof createMailService>) {
	return createNotificationService({
		mail,
		async eligible(tx, inputs) {
			const addresses = await readAccountContacts(tx, [...new Set(inputs.map((i) => i.recipient))]);
			return inputs.map((i) => ({ address: addresses.get(i.recipient) ?? null }));
		},
	});
}
