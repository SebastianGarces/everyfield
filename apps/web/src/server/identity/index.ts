import { sql } from "@everyfield/db/query";
import "server-only";
import { asLogId, logLine } from "@everyfield/domain/log";
import { nextCookies } from "better-auth/next-js";
import { after } from "next/server";
import { createHmac } from "node:crypto";
import { database } from "../database";
import { z } from "zod";
import { mailEnv } from "../mail-env.ts";
import { createIdentityService, trustedIdentityIp, type IdentityConfig } from "@everyfield/domain/identity";
import { invitationService } from "../invitations";
import { createMailService, MAIL_PASSES, runDueMail, type MailPass, type MailTransport } from "../jobs/mail";
import { trustsVercelForwardedFor } from "@everyfield/db/deployment";

const env = z.object({
	IDENTITY_DATABASE_URL: z.string().min(1),
	IDENTITY_AUTH_DATABASE_URL: z.string().min(1),
	IDENTITY_ORIGIN: z.url(),
	IDENTITY_SECRET: z.string().min(32),
	...mailEnv,
});

function identityMail(v: z.infer<typeof env>, transport?: MailTransport) {
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

function identityMailQueue(v: z.infer<typeof env>): IdentityConfig["enqueueMail"] {
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

export function identityMailEnqueue(): IdentityConfig["enqueueMail"] | null {
	const parsed = env.safeParse(process.env);
	return parsed.success ? identityMailQueue(parsed.data) : null;
}

export function identityMailPass(transport: MailTransport): MailPass | null {
	const parsed = env.safeParse(process.env);
	if (!parsed.success) return null;
	const db = database(parsed.data.IDENTITY_DATABASE_URL),
		mail = identityMail(parsed.data, transport);
	return (limit, until) => runDueMail(db, mail, MAIL_PASSES.identity, limit, until);
}

let service: ReturnType<typeof createIdentityService> | undefined;
function identityMount() {
	const parsed = env.safeParse(process.env);
	if (!parsed.success) return null;
	if (!service) {
		const v = parsed.data,
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
			trustedIp: (request) => trustedIdentityIp(request, trustsVercelForwardedFor(process.env)),
			enqueueMail: identityMailQueue(v),
			diagnostic: (value) => logLine({ component: "identity", ...value, correlationId: asLogId(value.correlationId) }),
			invitations: invitationService() ?? undefined,
		});
	}
	return service;
}

export function identityHandler(request: Request): Promise<Response> {
	const mount = identityMount();
	return mount
		? mount.handle(request)
		: Promise.resolve(
				Response.json({ code: "unavailable" }, { status: 503, headers: { "Cache-Control": "private, no-store" } }),
			);
}

export function requestAuth() {
	const mount = identityMount();
	if (!mount) throw Error("identity_unavailable");
	return mount.auth;
}
