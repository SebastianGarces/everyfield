import "server-only";
import { createHmac } from "node:crypto";
import { z } from "zod";
import { mailEnv } from "../mail-env.ts";
import { sql } from "@everyfield/db/query";
import { database } from "../database";
import { authorizeInvitationMail, createInvitationService } from "@everyfield/domain/identity";
import { accountPersonProducer } from "@everyfield/domain/people";
import { createMailService, queueOnlyTransport, runDueMail, type MailTransport } from "../jobs/mail";

// The invitation mount (WP-008/ui ruling U1). It builds the shipped WP-008/api invitation service once, with the real
// WP-011 Person producer in the same transaction. The identity mount passes it to registration (invitation-origin
// sign-up and resume); the invitation and seat screens call it through features/identity server actions only.
// Mail is enqueued under the domain's own authorizeInvitationMail rule. The scheduled runner sends it with
// runDueInvitationMail, which rechecks the same rule just before the handoff (WP-028).

const env = z.object({
	IDENTITY_DATABASE_URL: z.string().min(1),
	IDENTITY_ORIGIN: z.url(),
	IDENTITY_SECRET: z.string().min(32),
	...mailEnv,
});

/** Invitation mail keys: the invitation itself and the receipt after acceptance (authorizeInvitationMail). */
export const INVITATION_MAIL = ["invitation/", "invitation-accepted/"];

function invitationMail(v: z.infer<typeof env>, transport: MailTransport) {
	const addressKey = Buffer.from(v.IDENTITY_ADDRESS_KEY, "hex");
	return createMailService({
		db: database(v.IDENTITY_DATABASE_URL),
		encryptionKey: Buffer.from(v.IDENTITY_MAIL_KEY, "hex"),
		addressKey,
		from: v.IDENTITY_MAIL_FROM,
		authorize: (tx, m) =>
			authorizeInvitationMail(tx, m, (address) => createHmac("sha256", addressKey).update(address).digest("hex")),
		transport,
	});
}

/**
 * Sends one bounded batch of due invitation mail through `transport`, or returns 0 when the deployment has no identity
 * configuration. Invitation mail is required mail: no email preference stops it, only an active bounce block.
 */
export function runDueInvitationMail(transport: MailTransport, limit: number, until: number): Promise<number> {
	const parsed = env.safeParse(process.env);
	if (!parsed.success) return Promise.resolve(0);
	return runDueMail(
		database(parsed.data.IDENTITY_DATABASE_URL),
		invitationMail(parsed.data, transport),
		INVITATION_MAIL,
		limit,
		until,
	);
}

let service: ReturnType<typeof createInvitationService> | undefined;

/** The invitation service, or null when the deployment has no identity configuration. */
export function invitationService(): ReturnType<typeof createInvitationService> | null {
	if (service) return service;
	const parsed = env.safeParse(process.env);
	if (!parsed.success) return null;
	const v = parsed.data;
	const db = database(v.IDENTITY_DATABASE_URL);
	const addressKey = Buffer.from(v.IDENTITY_ADDRESS_KEY, "hex");
	const mail = invitationMail(v, queueOnlyTransport);
	service = createInvitationService({
		db,
		origin: v.IDENTITY_ORIGIN,
		// The per-address invitation budget key. It is derived from the identity secret, so it never leaves the server.
		budgetSecret: createHmac("sha256", v.IDENTITY_SECRET).update("invitation-budget").digest("hex"),
		people: accountPersonProducer,
		// The same address hash the mail service writes and the bounce callback blocks (WP-028).
		addressBlocked: (email) => {
			const hash = createHmac("sha256", addressKey).update(email.trim().toLowerCase()).digest("hex");
			return sql`EXISTS (SELECT 1 FROM suppression WHERE address_hash = ${hash} AND cleared_at IS NULL)`;
		},
		enqueueMail: (tx, m, command) => {
			// Invitations belong to a plant or an organization; no other owner ever sends one.
			if (m.owner.kind === "global") throw new Error("unavailable");
			return mail.append(
				tx,
				{
					owner: m.owner,
					purpose: m.purpose,
					logicalKey: m.logicalKey,
					recipient: m.recipientAccountId,
					address: m.recipientEmail,
					content: { subject: m.subject, text: m.text },
					operation: m.operationId,
					notice: null,
					eligibleAt: new Date().toISOString(),
				},
				command.writes,
			);
		},
	});
	return service;
}
