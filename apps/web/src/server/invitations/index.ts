import "server-only";
import { createHmac } from "node:crypto";
import { serverConfig, type ServerConfig } from "../config.ts";
import { sql } from "@everyfield/db/query";
import { database } from "../database";
import type { Database, Transaction } from "@everyfield/db/client";
import { authorizeInvitationMail, createInvitationService, type InvitationConfig } from "@everyfield/domain/identity";
import { accountPersonProducer } from "@everyfield/domain/people";
import { createMailService, MAIL_PASSES, runDueMail, type MailTransport } from "../jobs/mail";

export const INVITATION_MAIL = MAIL_PASSES.mail;

export const invitationLink = (origin: string, path: string, invitationId: string, proof: string) =>
	`${origin}${path}?invitation=${invitationId}#${proof}`;

function invitationMail(v: ServerConfig, transport?: MailTransport) {
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

export function runDueInvitationMail(transport: MailTransport, limit: number, until: number): Promise<number> {
	const v = serverConfig();
	return runDueMail(database(v.IDENTITY_DATABASE_URL), invitationMail(v, transport), INVITATION_MAIL, limit, until);
}

let service: ReturnType<typeof createInvitationService> | undefined;

export function invitationService(): ReturnType<typeof createInvitationService> {
	service ??= createInvitationService(invitationConfig());
	return service;
}

export function invitationServiceOn(db: Database | Transaction): ReturnType<typeof createInvitationService> {
	return createInvitationService({ ...invitationConfig(), db: db as Database });
}

let configured: InvitationConfig | undefined;
function invitationConfig(): InvitationConfig {
	if (configured) return configured;
	const v = serverConfig();
	const db = database(v.IDENTITY_DATABASE_URL);
	const addressKey = Buffer.from(v.IDENTITY_ADDRESS_KEY, "hex");
	const mail = invitationMail(v);
	configured = {
		db,
		origin: v.IDENTITY_ORIGIN,
		budgetSecret: createHmac("sha256", v.IDENTITY_SECRET).update("invitation-budget").digest("hex"),
		people: accountPersonProducer,
		addressBlocked: (email) => {
			const hash = createHmac("sha256", addressKey).update(email.trim().toLowerCase()).digest("hex");
			return sql`EXISTS (SELECT 1 FROM suppression WHERE address_hash = ${hash} AND cleared_at IS NULL)`;
		},
		enqueueMail: (tx, m, command) => {
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
	};
	return configured;
}
