import { sql } from "@everyfield/db/query";
import "server-only";
import { nextCookies } from "better-auth/next-js";
import { after } from "next/server";
import { createHmac } from "node:crypto";
import { database } from "../database";
import { z } from "zod";
import { mailEnv } from "../mail-env.ts";
import { createIdentityService, trustedIdentityIp, type IdentityConfig } from "@everyfield/domain/identity";
import { invitationService } from "../invitations";
import { createMailService, queueOnlyTransport, runDueMail, type MailPass, type MailTransport } from "../jobs/mail";

// Explicit credentials and keys are required. Never fall back to the operator DATABASE_URL.
const env = z.object({
	IDENTITY_DATABASE_URL: z.string().min(1),
	IDENTITY_AUTH_DATABASE_URL: z.string().min(1),
	IDENTITY_ORIGIN: z.url(),
	IDENTITY_SECRET: z.string().min(32),
	...mailEnv,
});

/** Identity mail keys: a password-reset link and an email-verification link, each to the account's own contact. */
const IDENTITY_MAIL = ["password_reset/", "email_verification/"];

/**
 * The identity mount's mail service. Its rule holds at enqueue and again just before the handoff: a reset or
 * verification link goes only to its own account, at the address that account's contact has now.
 */
function identityMail(v: z.infer<typeof env>, transport: MailTransport) {
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

/** The identity service's `enqueueMail`: the mail it asks for, queued under the mount's own rule. */
function identityMailQueue(v: z.infer<typeof env>): IdentityConfig["enqueueMail"] {
	const mail = identityMail(v, queueOnlyTransport);
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

/** The identity mail queue as the identity service uses it; null when the deployment has no identity configuration. */
export function identityMailEnqueue(): IdentityConfig["enqueueMail"] | null {
	const parsed = env.safeParse(process.env);
	return parsed.success ? identityMailQueue(parsed.data) : null;
}

/**
 * The scheduled runner's identity mail pass: one bounded batch of this mount's due mail through `transport`, each
 * rechecked under the mount's own rule. Null when the deployment has no configuration for this mount.
 */
export function identityMailPass(transport: MailTransport): MailPass | null {
	const parsed = env.safeParse(process.env);
	if (!parsed.success) return null;
	const db = database(parsed.data.IDENTITY_DATABASE_URL),
		mail = identityMail(parsed.data, transport);
	return (limit, until) => runDueMail(db, mail, IDENTITY_MAIL, limit, until);
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
			trustedIp: (request) => trustedIdentityIp(request, process.env.VERCEL === "1"),
			enqueueMail: identityMailQueue(v),
			diagnostic: (value) => console.error(JSON.stringify({ component: "identity", ...value })),
			// Invitation-origin registration and resume (REQ-IDN-003, REQ-IDN-030). The invitation service rechecks
			// the proof, address and revision inside its own transaction.
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
