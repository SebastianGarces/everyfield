import { sql } from "@everyfield/db/query";
import "server-only";
import { nextCookies } from "better-auth/next-js";
import { after } from "next/server";
import { createHmac } from "node:crypto";
import { database } from "../database";
import { z } from "zod";
import { createIdentityService, trustedIdentityIp } from "@everyfield/domain/identity";
import { invitationService } from "../invitations";
import { createMailService } from "../jobs/mail";

let service: ReturnType<typeof createIdentityService> | undefined;
function identityMount() {
	// Explicit credentials and keys are required. Never fall back to the operator DATABASE_URL.
	const env = z
		.object({
			IDENTITY_DATABASE_URL: z.string().min(1),
			IDENTITY_AUTH_DATABASE_URL: z.string().min(1),
			IDENTITY_ORIGIN: z.url(),
			IDENTITY_SECRET: z.string().min(32),
			IDENTITY_MAIL_KEY: z.string().regex(/^[a-f0-9]{64}$/),
			IDENTITY_ADDRESS_KEY: z.string().regex(/^[a-f0-9]{64}$/),
			IDENTITY_MAIL_FROM: z.email(),
		})
		.safeParse(process.env);
	if (!env.success) return null;
	if (!service) {
		const v = env.data,
			db = database(v.IDENTITY_DATABASE_URL),
			authDb = database(v.IDENTITY_AUTH_DATABASE_URL),
			admissionDb = db;
		const mail = createMailService({
			db,
			encryptionKey: Buffer.from(v.IDENTITY_MAIL_KEY, "hex"),
			addressKey: Buffer.from(v.IDENTITY_ADDRESS_KEY, "hex"),
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
								createHmac("sha256", Buffer.from(v.IDENTITY_ADDRESS_KEY, "hex")).update(email).digest("hex") ===
									m.addressHash
							);
						})
						.map((m) => m.id),
				);
			},
			// This mount issues intents only. WP-031 owns dispatch; no real provider is configured here.
			transport: {
				async send() {
					return { kind: "refused", retryable: true };
				},
				async lookup() {
					return { kind: "unknown" };
				},
			},
		});
		service = createIdentityService({
			db,
			authDb,
			admissionDb,
			plugins: [nextCookies()],
			scheduleDelivery: after,
			origin: v.IDENTITY_ORIGIN,
			secret: v.IDENTITY_SECRET,
			trustedIp: (request) => trustedIdentityIp(request, process.env.VERCEL === "1"),
			enqueueMail: (tx, m) =>
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
				}),
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
