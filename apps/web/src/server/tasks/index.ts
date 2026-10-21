import type { Database } from "@everyfield/db/client";
import { authorizeTaskReminders, createTaskWriter, reminderRecipients } from "@everyfield/domain/tasks";
import "server-only";
import { z } from "zod";
import { database } from "../database";
import { createMailService } from "../jobs/mail";
import { createNotificationService } from "../jobs/notifications";
import { taskReminders } from "./reminders";

// The tasks mount (WP-024). Task screens reach the writer through their server actions and run each command in
// withTaskWrite, which binds the request's verified actor. Every task write that changes owed reminders queues them
// in the same transaction through WP-031's notification service; the mail worker dispatches them later.

const env = z.object({
	IDENTITY_DATABASE_URL: z.string().min(1),
	IDENTITY_MAIL_KEY: z.string().regex(/^[a-f0-9]{64}$/),
	IDENTITY_ADDRESS_KEY: z.string().regex(/^[a-f0-9]{64}$/),
	IDENTITY_MAIL_FROM: z.email(),
});

let mount: ReturnType<typeof create> | undefined;
function create(v: z.infer<typeof env>) {
	const db: Database = database(v.IDENTITY_DATABASE_URL);
	const mail = createMailService({
		db,
		encryptionKey: Buffer.from(v.IDENTITY_MAIL_KEY, "hex"),
		addressKey: Buffer.from(v.IDENTITY_ADDRESS_KEY, "hex"),
		from: v.IDENTITY_MAIL_FROM,
		authorize: authorizeTaskReminders,
		transport: {
			async send() {
				return { kind: "refused", retryable: true };
			},
			async lookup() {
				return { kind: "unknown" };
			},
		},
	});
	const notifications = createNotificationService({
		mail,
		async eligible(tx, inputs) {
			const owners = new Set(inputs.map((i) => i.owner.id));
			if (owners.size > 1) throw Error("notification_owner_mismatch");
			const [plant] = owners;
			const addresses = plant
				? await reminderRecipients(tx, plant, [...new Set(inputs.map((i) => i.recipient))])
				: null;
			return inputs.map((i) => {
				const address = addresses?.get(i.recipient);
				return address ? { address } : null;
			});
		},
	});
	// Meeting finalization passes `reminders` to the generated-work producers in its own command.
	const reminders = taskReminders(notifications);
	return { db, reminders, writer: createTaskWriter({ reminders }) };
}
/** The task writer, its reminder port and database, or null when the deployment has no identity and mail configuration. */
export function tasksMount() {
	const v = env.safeParse(process.env);
	if (!v.success) return null;
	mount ??= create(v.data);
	return mount;
}
