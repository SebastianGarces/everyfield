import "server-only";
import { createHmac } from "node:crypto";
import { z } from "zod";
import { database } from "../database";
import { authorizeInvitationMail, createInvitationService } from "@everyfield/domain/identity";
import { accountPersonProducer } from "@everyfield/domain/people";
import { createMailService } from "../jobs/mail";

// The invitation mount (WP-008/ui ruling U1). It builds the shipped WP-008/api invitation service once, with the real
// WP-011 Person producer in the same transaction. The identity mount passes it to registration (invitation-origin
// sign-up and resume); the invitation and seat screens call it through features/identity server actions only.
// Mail is enqueued only, under the domain's own authorizeInvitationMail rule; WP-031 dispatches it.

const env = z.object({
	IDENTITY_DATABASE_URL: z.string().min(1),
	IDENTITY_ORIGIN: z.url(),
	IDENTITY_SECRET: z.string().min(32),
	IDENTITY_MAIL_KEY: z.string().regex(/^[a-f0-9]{64}$/),
	IDENTITY_ADDRESS_KEY: z.string().regex(/^[a-f0-9]{64}$/),
	IDENTITY_MAIL_FROM: z.email(),
});

let service: ReturnType<typeof createInvitationService> | undefined;

/** The invitation service, or null when the deployment has no identity configuration. */
export function invitationService(): ReturnType<typeof createInvitationService> | null {
	if (service) return service;
	const parsed = env.safeParse(process.env);
	if (!parsed.success) return null;
	const v = parsed.data;
	const db = database(v.IDENTITY_DATABASE_URL);
	const addressKey = Buffer.from(v.IDENTITY_ADDRESS_KEY, "hex");
	const mail = createMailService({
		db,
		encryptionKey: Buffer.from(v.IDENTITY_MAIL_KEY, "hex"),
		addressKey,
		from: v.IDENTITY_MAIL_FROM,
		authorize: (tx, m) =>
			authorizeInvitationMail(tx, m, (address) => createHmac("sha256", addressKey).update(address).digest("hex")),
		transport: {
			async send() {
				return { kind: "refused", retryable: true };
			},
			async lookup() {
				return { kind: "unknown" };
			},
		},
	});
	service = createInvitationService({
		db,
		origin: v.IDENTITY_ORIGIN,
		// The per-address invitation budget key. It is derived from the identity secret, so it never leaves the server.
		budgetSecret: createHmac("sha256", v.IDENTITY_SECRET).update("invitation-budget").digest("hex"),
		people: accountPersonProducer,
		enqueueMail: (tx, m) => {
			// Invitations belong to a plant or an organization; no other owner ever sends one.
			if (m.owner.kind === "global") throw new Error("unavailable");
			return mail.enqueue(tx, {
				owner: m.owner,
				purpose: m.purpose,
				logicalKey: m.logicalKey,
				recipient: m.recipientAccountId,
				address: m.recipientEmail,
				content: { subject: m.subject, text: m.text },
				operation: m.operationId,
				notice: null,
				eligibleAt: new Date().toISOString(),
			});
		},
	});
	return service;
}
