import { sql } from "@everyfield/db/query";
import "server-only";
import { asLogId, logLine } from "@everyfield/domain/log";
import { nextCookies } from "better-auth/next-js";
import { after } from "next/server";
import { createHmac } from "node:crypto";
import { database } from "../database";
import { z } from "zod";
import { serverConfig, serverEnv, type ServerConfig } from "../config.ts";
import { createIdentityService, trustedIdentityIp, type IdentityConfig } from "@everyfield/domain/identity";
import { invitationService } from "../invitations";
import { createMailService, MAIL_PASSES, runDueMail, type MailPass, type MailTransport } from "@everyfield/domain/jobs";
import { trustsVercelForwardedFor } from "@everyfield/db/deployment";
import { configured, mutatingRoute } from "../platform/boundary.ts";

function identityMail(v: ServerConfig, transport?: MailTransport) {
	const addressKey = Buffer.from(v.IDENTITY_ADDRESS_KEY, "hex");
	return createMailService({
		db: database(v.IDENTITY_DATABASE_URL),
		encryptionKey: Buffer.from(v.IDENTITY_MAIL_KEY, "hex"),
		addressKey,
		from: v.IDENTITY_MAIL_FROM,
		authorize: async (tx, mail) => {
			const accounts = mail.map((m) => m.tenant);
			const result = await tx.execute(
				sql`SELECT a.id,c.email FROM account a CROSS JOIN LATERAL access_account_contact(a.id) c WHERE a.id=ANY(${sql.param(accounts)}::uuid[]) FOR SHARE OF a`,
			);
			const contacts = new Map(result.rows.map((row) => [z.uuid().parse(row.id), z.email().parse(row.email)]));
			return new Set(
				mail
					.filter((m) => {
						const email = contacts.get(m.tenant);
						return (
							m.recipient === m.tenant &&
							["password_reset", "email_verification"].includes(m.purpose) &&
							email &&
							createHmac("sha256", addressKey).update(email).digest("hex") === m.addressHash
						);
					})
					.map((m) => m.id),
			);
		},
		transport,
	});
}

function identityMailQueue(v: ServerConfig): IdentityConfig["enqueueMail"] {
	const mail = identityMail(v);
	return (tx, m) =>
		mail.enqueue(tx, {
			owner: { kind: "account", id: m.accountId },
			purpose: m.purpose,
			logicalKey: m.logicalKey,
			recipient: m.accountId,
			address: m.address,
			content: { subject: m.subject, text: m.text },
			operation: null,
			notice: null,
			eligibleAt: new Date().toISOString(),
		});
}

export const identityMailEnqueue = (): IdentityConfig["enqueueMail"] => identityMailQueue(serverConfig());

export function identityMailPass(transport: MailTransport): MailPass {
	const v = serverConfig();
	const db = database(v.IDENTITY_DATABASE_URL),
		mail = identityMail(v, transport);
	return (limit, until) => runDueMail(db, mail, MAIL_PASSES.identity, limit, until);
}

let service: ReturnType<typeof createIdentityService> | undefined;
function identityMount() {
	if (!service) {
		const v = serverConfig(),
			db = database(v.IDENTITY_DATABASE_URL),
			authDb = database(v.IDENTITY_AUTH_DATABASE_URL),
			admissionDb = db;
		service = createIdentityService({
			db,
			authDb,
			admissionDb,
			plugins: [nextCookies()],
			scheduleDelivery: after,
			origin: v.IDENTITY_ORIGIN,
			secret: v.IDENTITY_SECRET,
			trustedIp: (request) => trustedIdentityIp(request, trustsVercelForwardedFor(serverEnv())),
			enqueueMail: identityMailQueue(v),
			diagnostic: (value) => logLine({ component: "identity", ...value, correlationId: asLogId(value.correlationId) }),
			invitations: invitationService(),
		});
	}
	return service;
}

export const identityHandler = configured((request: Request): Promise<Response> => identityMount().handle(request));

export function requestAuth() {
	return identityMount().auth;
}

export const identityWrite = mutatingRoute(identityHandler);
