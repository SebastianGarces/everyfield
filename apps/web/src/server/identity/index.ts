import * as tables from "@everyfield/db/tables";
import { eq } from "@everyfield/db/query";
import "server-only";
import { nextCookies } from "better-auth/next-js";
import { after } from "next/server";
import { createHmac } from "node:crypto";
import { createDatabase } from "@everyfield/db/client";
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
			db = createDatabase({ connectionString: v.IDENTITY_DATABASE_URL, max: 5 }),
			authDb = createDatabase({ connectionString: v.IDENTITY_AUTH_DATABASE_URL, max: 5 }),
			admissionDb = createDatabase({ connectionString: v.IDENTITY_DATABASE_URL, max: 3 });
		const mail = createMailService({
			db,
			encryptionKey: Buffer.from(v.IDENTITY_MAIL_KEY, "hex"),
			addressKey: Buffer.from(v.IDENTITY_ADDRESS_KEY, "hex"),
			from: v.IDENTITY_MAIL_FROM,
			authorize: async (tx, m) => {
				if (m.recipient !== m.tenant || !["password_reset", "email_verification"].includes(m.purpose)) return false;
				const row = await tx
					.select({ auth_user_id: tables.account.auth_user_id })
					.from(tables.account)
					.where(eq(tables.account.id, m.tenant));
				if (!row.length) return false;
				const user = await authDb
					.select({ email: tables.auth_user.email })
					.from(tables.auth_user)
					.where(eq(tables.auth_user.id, row[0]!.auth_user_id));
				return (
					user.length === 1 &&
					createHmac("sha256", Buffer.from(v.IDENTITY_ADDRESS_KEY, "hex"))
						.update(z.email().parse(user[0]?.email))
						.digest("hex") === m.addressHash
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
