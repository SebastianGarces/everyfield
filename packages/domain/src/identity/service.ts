import {
	identityError,
	invalidSessionReturn,
	passwordRecoveryRequest,
	recoverPasswordRequest,
	registrationOptions,
	registrationRequest,
	registrationResult,
	registrationStatus,
	resumeRegistrationRequest,
	safeReturn,
	seatInvitationAcceptedResult,
	selfSessionRequest,
	sessionResult,
	signInRequest,
	verifyEmailRequest,
} from "@everyfield/contracts/identity";
import type { Database, Transaction } from "@everyfield/db/client";
import { and, eq, gt, sql } from "@everyfield/db/query";
import * as tables from "@everyfield/db/tables";
import type { BetterAuthPlugin } from "better-auth";
import { verifyPassword } from "better-auth/crypto";
import { createHash, randomUUID } from "node:crypto";
import { isIP } from "node:net";
import "server-only";
import { z } from "zod";
import { identityAuth } from "./auth.ts";
import { attemptBudget, IdentityRefusal, transaction } from "./budget.ts";
import { InvitationRefusal } from "./invitation-core.ts";
import type { createInvitationService } from "./invitations.ts";
import { readIdentityAccount, readIdentitySession, userRow } from "./reads.ts";

export type IdentityMail = {
	accountId: string;
	address: string;
	purpose: "password_reset" | "email_verification";
	logicalKey: string;
	subject: string;
	text: string;
};
export type IdentityConfig = {
	db: Database;
	authDb: Database;
	admissionDb: Database;
	origin: string;
	secret: string;
	scheduleDelivery: (work: () => Promise<void>) => void;
	// The host adapter must overwrite ingress headers. Null means no trustworthy IP.
	trustedIp: (request: Request) => string | null;
	enqueueMail: (tx: Transaction, mail: IdentityMail) => Promise<string>;
	diagnostic: (value: { correlationId: string; outcome: "unknown" | "reporting_pending" | "delivery_failed" }) => void;
	invitations?: ReturnType<typeof createInvitationService>;
	plugins?: BetterAuthPlugin[];
	registrationMode?: "open" | "invitation_only" | "closed";
};

const headers = {
	"Cache-Control": "private, no-store",
	"Referrer-Policy": "no-referrer",
	"X-Content-Type-Options": "nosniff",
};
const json = (value: unknown, status = 200) => Response.json(value, { status, headers });
const digest = (value: string) => createHash("sha256").update(value).digest("hex");

export function createIdentityService(config: IdentityConfig) {
	const origin = new URL(config.origin).origin;
	if (origin !== config.origin) throw Error("canonical_origin_required");
	const budget = attemptBudget(config.admissionDb, config.secret);
	const auth = identityAuth({ db: config.authDb, origin, secret: config.secret, deliver, plugins: config.plugins });

	const account = (authUser: string) => readIdentityAccount(config.db, authUser);

	async function pending(
		authUser: string,
		kind: (typeof tables.account.$inferInsert)["registration_kind"],
		intent: string | null,
	) {
		return transaction(config.db, async (tx) => {
			await tx
				.insert(tables.account)
				.values({
					auth_user_id: authUser,
					registration_state: "pending_domain",
					registration_kind: kind,
					registration_digest: intent,
				})
				.onConflictDoNothing({ target: [tables.account.auth_user_id] });
			const row = await tx.select().from(tables.account).where(eq(tables.account.auth_user_id, authUser));
			return userRow.parse(row[0]);
		});
	}
	async function deliver(user: { id: string; email: string }, purpose: IdentityMail["purpose"], token: string) {
		const correlationId = randomUUID();
		try {
			const a = await account(user.id);
			if (!a) throw Error("account_unavailable");
			const url = new URL(purpose === "password_reset" ? "/reset-password" : "/verify-email", origin);
			url.searchParams.set("token", token);
			const subject = purpose === "password_reset" ? "Reset your password" : "Verify your email";
			await transaction(config.db, (tx) =>
				config.enqueueMail(tx, {
					accountId: a.id,
					address: user.email,
					purpose,
					logicalKey: `${purpose}/${digest(token)}`,
					subject,
					text: `${subject}\n\n${url.href}\n\nIf you did not request this, you can ignore this email.`,
				}),
			);
		} catch {
			config.diagnostic({ correlationId, outcome: "delivery_failed" });
		}
	}
	async function call(request: Request, path: string, body?: unknown) {
		const h = new Headers({ origin, "content-type": "application/json" });
		const cookie = request.headers.get("cookie");
		if (cookie) h.set("cookie", cookie);
		return auth.handler(
			new Request(`${origin}/api/auth/${path}`, {
				method: body === undefined ? "GET" : "POST",
				headers: h,
				...(body === undefined ? {} : { body: JSON.stringify(body) }),
			}),
		);
	}
	async function session(request: Request) {
		// The handler propagates renewal cookies. Never forward its user/token payload.
		const response = await call(request, "get-session");
		if (!response.ok) throw new IdentityRefusal("unavailable", 503);
		const raw: unknown = await response.json();
		if (!raw) return { response, authUser: null, value: sessionResult.parse({ status: "unauthenticated" }) };
		const s = z
			.object({ user: z.object({ id: z.uuid() }), session: z.object({ id: z.uuid(), expiresAt: z.coerce.date() }) })
			.parse(raw);
		return { response, authUser: s.user.id, value: await readIdentitySession(config.db, s) };
	}
	function cookies(result: Response, source: Response) {
		for (const value of source.headers.getSetCookie()) result.headers.append("set-cookie", value);
		return result;
	}
	async function boundedBody(request: Request): Promise<unknown> {
		if (request.headers.get("content-type")?.split(";")[0] !== "application/json")
			throw new IdentityRefusal("invalid_input", 422);
		const reader = request.body?.getReader();
		if (!reader) throw new IdentityRefusal("invalid_input", 422);
		const chunks: Uint8Array[] = [];
		let size = 0;
		try {
			for (;;) {
				const part = await reader.read();
				if (part.done) break;
				size += part.value.length;
				if (size > 24576) throw new IdentityRefusal("invalid_input", 413);
				chunks.push(part.value);
			}
			return JSON.parse(Buffer.concat(chunks).toString("utf8"));
		} catch (e) {
			if (e instanceof IdentityRefusal) throw e;
			throw new IdentityRefusal("invalid_input", 422);
		} finally {
			await reader.cancel();
		}
	}
	async function handle(request: Request): Promise<Response> {
		const correlationId = randomUUID();
		try {
			const url = new URL(request.url),
				path = url.pathname.replace(/^\/api\/auth\//, "");
			// Next uses its private listener URL behind a proxy. Validate Host against the fixed public authority; ignore forwarded host/protocol.
			if (request.headers.get("host") !== new URL(origin).host) throw new IdentityRefusal("origin_denied", 403);
			const gets = ["get-session", "registration-status", "registration-options", "recover-invalid-session"];
			const posts = [
				"register",
				"sign-in/email",
				"sign-out",
				"request-password-reset",
				"reset-password",
				"verify-email",
				"send-verification-email",
				"revoke-other-sessions",
				"resume-registration",
			];
			if (!(request.method === "GET" ? gets : request.method === "POST" ? posts : []).includes(path))
				return json({ code: "unavailable" }, 404);
			if (request.method === "GET") {
				if (path === "registration-options") {
					const proof = url.searchParams.get("invitationProof");
					const invitation = proof && config.invitations ? await config.invitations.describe({ proof }) : null;
					const subject = invitation?.status === "pending" ? invitation.subject : null;
					const kind =
						subject?.purpose === "seat"
							? subject.workspace.kind === "plant"
								? "plant_precreation"
								: subject.workspace.organizationKind === "sending_network"
									? "sending_network"
									: "sending_church"
							: "discovery";
					return json(
						registrationOptions.parse({
							mode: config.registrationMode ?? "open",
							kinds:
								invitation?.status === "pending"
									? [kind]
									: ["plant_precreation", "discovery", "sending_church", "sending_network"],
							invitation:
								invitation?.status === "pending"
									? { status: "invitation", kind, organizationName: invitation.workspaceName }
									: { status: "unavailable" },
						}),
					);
				}
				if (path === "recover-invalid-session")
					return json({ next: invalidSessionReturn(url.searchParams.get("returnTo")) });
				const s = await session(request);
				if (path === "registration-status") {
					if (s.value.status === "unauthenticated") throw new IdentityRefusal("unauthenticated", 401);
					return cookies(
						json(registrationStatus.parse({ status: s.value.status, accountId: s.value.accountId })),
						s.response,
					);
				}
				return cookies(json(s.value), s.response);
			}
			if (request.headers.get("origin") !== origin) throw new IdentityRefusal("origin_denied", 403);
			const suppliedIp = config.trustedIp(request),
				ip = suppliedIp && isIP(suppliedIp) ? suppliedIp : null;
			// Registration charges even malformed, duplicate and closed-mode submissions.
			const registration = path === "register" ? await budget.reserve("registration", null, ip) : null;
			const input = await boundedBody(request);
			if (path === "register") {
				const v = registrationRequest.parse(input);
				const invitation =
					v.kind === "invitation" && config.invitations
						? await config.invitations.describe({ proof: v.invitationProof })
						: null;
				if (
					v.kind === "invitation" &&
					(invitation?.status !== "pending" ||
						!(await config.invitations?.registrationEligible(v.invitationProof, v.email)))
				)
					return json({ status: "continue_identity_proof" });
				if ((config.registrationMode ?? "open") !== "open" && invitation?.status !== "pending")
					return json({ status: "continue_identity_proof" });
				const kind =
					v.kind === "invitation"
						? invitation?.status === "pending" && invitation.subject.purpose === "seat"
							? invitation.subject.workspace.kind === "plant"
								? "planter"
								: invitation.subject.workspace.organizationKind === "sending_network"
									? "network"
									: "sending_church"
							: "discovery"
						: v.kind === "plant_precreation"
							? "planter"
							: v.kind === "sending_network"
								? "network"
								: v.kind;
				const intent = digest(
					JSON.stringify({
						kind: v.kind,
						...(v.kind === "invitation" ? { invitationDigest: digest(v.invitationProof) } : {}),
						name: v.name,
						...("organizationName" in v ? { organizationName: v.organizationName } : {}),
					}),
				);
				if (registration) await budget.rememberRegistration(registration.id, v.email, kind, intent);
				const native = await call(request, "get-session");
				const self = z.object({ user: z.object({ id: z.uuid(), email: z.email() }) }).safeParse(await native.json());
				if (self.success && self.data.user.email === v.email) {
					try {
						await pending(self.data.user.id, kind, intent);
					} catch {
						config.diagnostic({ correlationId, outcome: "reporting_pending" });
					}
					if (registration) await budget.finish(registration, true);
					return json({ status: "continue_identity_proof" });
				}
				const result = await call(request, "sign-up/email", { email: v.email, name: v.name, password: v.password });
				// No caller credential, email equality, synthetic BA ID or returned cookie grants domain access.
				// Querying this credential is safe only to create a pending, unprivileged app row.
				if (result.ok) {
					const row = await config.authDb
						.select({ id: tables.auth_user.id })
						.from(tables.auth_user)
						.where(eq(tables.auth_user.email, v.email));
					if (row[0]) {
						try {
							await pending(z.uuid().parse(row[0].id), kind, intent);
						} catch {
							config.diagnostic({ correlationId, outcome: "reporting_pending" });
						}
					}
				} else config.diagnostic({ correlationId, outcome: "unknown" });
				if (registration) await budget.finish(registration, true);
				return json({ status: "continue_identity_proof" });
			}
			if (path === "sign-in/email") {
				const v = signInRequest.parse(input),
					reservation = await budget.reserve("login", v.email, ip);
				const result = await call(request, path, { email: v.email, password: v.password });
				await budget.finish(reservation, result.ok);
				if (!result.ok) throw new IdentityRefusal("invalid_credentials", 401);
				const resultBody = z.object({ user: z.object({ id: z.uuid() }) }).parse(await result.json());
				// Repairs interruption after credential creation. Authentication is the proof; no grants are created.
				if (!(await account(resultBody.user.id))) {
					const exists = await config.db
						.select({ id: tables.account.id })
						.from(tables.account)
						.where(eq(tables.account.auth_user_id, resultBody.user.id));
					if (exists.length) throw new IdentityRefusal("unauthenticated", 401);
					const native = await config.authDb
						.select({ email: tables.auth_user.email, created_at: tables.auth_user.created_at })
						.from(tables.auth_user)
						.where(eq(tables.auth_user.id, resultBody.user.id));
					const u = z.object({ email: z.email(), created_at: z.date() }).parse(native[0]);
					const saved = await budget.registrationIntent(u.email, u.created_at);
					// Expired throttle records must not destroy a valid identity. A fresh native self registration supplies its intent again.
					if (!saved) return cookies(json({ status: "signed_in", returnTo: safeReturn(v.returnTo) }), result);
					const intent = z
						.object({
							kind: z.enum(["planter", "discovery", "sending_church", "network"]),
							intent: z.string().regex(/^[a-f0-9]{64}$/),
						})
						.parse(JSON.parse(saved));
					await pending(resultBody.user.id, intent.kind, intent.intent);
				}
				return cookies(json({ status: "signed_in", returnTo: safeReturn(v.returnTo) }), result);
			}
			if (path === "request-password-reset" || path === "send-verification-email") {
				const v = passwordRecoveryRequest.parse(input);
				const reservation = await budget.reserve("reset", v.email, ip);
				await budget.finish(reservation, true);
				// Both addresses perform only admission work before responding. The host
				// schedules proof issuance in the response lifecycle, with no cookie or secret.
				try {
					config.scheduleDelivery(async () => {
						try {
							const deliveryRequest = new Request(`${origin}/api/auth/${path}`);
							const result = await call(deliveryRequest, path, {
								email: v.email,
								...(path === "request-password-reset"
									? { redirectTo: `${origin}/reset-password` }
									: { callbackURL: "/" }),
							});
							await result.body?.cancel();
							if (!result.ok) config.diagnostic({ correlationId, outcome: "delivery_failed" });
						} catch {
							config.diagnostic({ correlationId, outcome: "delivery_failed" });
						}
					});
				} catch {
					config.diagnostic({ correlationId, outcome: "delivery_failed" });
				}
				return json({ status: "accepted" });
			}
			if (path === "reset-password") {
				const v = recoverPasswordRequest.parse(input);
				const proof = await config.authDb
					.select({ value: tables.auth_verification.value })
					.from(tables.auth_verification)
					.where(
						and(
							eq(tables.auth_verification.identifier, `reset-password:${v.proof}`),
							gt(
								tables.auth_verification.expires_at,
								sql<Date>`clock_timestamp()`.mapWith((value: string) => new Date(value)),
							),
						),
					);
				if (!proof.length) throw new IdentityRefusal("invalid_proof", 400);
				const authUser = z.uuid().parse(proof[0]!.value),
					a = await account(authUser);
				if (!a) throw new IdentityRefusal("invalid_proof", 400);
				const credential = await config.authDb
					.select({ password_hash: tables.auth_account.password_hash })
					.from(tables.auth_account)
					.where(and(eq(tables.auth_account.user_id, authUser), eq(tables.auth_account.provider_id, "credential")));
				const hash = z.string().parse(credential[0]?.password_hash);
				if (await verifyPassword({ hash, password: v.newPassword })) throw new IdentityRefusal("invalid_input", 422);
				// A durable content-free attempt survives a failure to append the later outcome.
				await event(a.id, correlationId, "identity.credential_observed");
				let result: Response;
				try {
					result = await call(request, path, { token: v.proof, newPassword: v.newPassword });
				} catch {
					config.diagnostic({ correlationId, outcome: "unknown" });
					throw new IdentityRefusal("unavailable", 503);
				}
				if (!result.ok) {
					if (result.status >= 500) {
						config.diagnostic({ correlationId, outcome: "unknown" });
						throw new IdentityRefusal("unavailable", 503);
					}
					throw new IdentityRefusal("invalid_proof", 400);
				}
				try {
					const user = await config.authDb
						.select({ email: tables.auth_user.email })
						.from(tables.auth_user)
						.where(eq(tables.auth_user.id, authUser));
					await transaction(config.db, async (tx) => {
						await event(a.id, `${correlationId}/success`, "identity.credential_changed", tx);
						await config.enqueueMail(tx, {
							accountId: a.id,
							address: z.email().parse(user[0]?.email),
							purpose: "password_reset",
							logicalKey: `password_reset/outcome/${correlationId}`,
							subject: "Your password was reset",
							text: "Your Everyfield password was reset. Sign in with your new password. If this was not you, request password recovery.",
						});
					});
				} catch {
					config.diagnostic({ correlationId, outcome: "reporting_pending" });
				}
				return json({ status: "password_reset", next: "sign_in" });
			}
			if (path === "verify-email") {
				const v = verifyEmailRequest.parse(input),
					response = await call(request, `verify-email?token=${encodeURIComponent(v.proof)}`);
				if (!response.ok) throw new IdentityRefusal("invalid_proof", 400);
				return json({ status: "email_verified" });
			}
			if (path === "sign-out") {
				selfSessionRequest.parse(input);
				const response = await call(request, path, {});
				if (!response.ok) throw new IdentityRefusal("unavailable", 503);
				return cookies(json({ status: "signed_out" }), response);
			}
			const s = await session(request);
			if (s.value.status === "unauthenticated") throw new IdentityRefusal("unauthenticated", 401);
			if (path === "revoke-other-sessions") {
				selfSessionRequest.parse(input);
				const response = await call(request, path, {});
				if (!response.ok) throw new IdentityRefusal("unauthenticated", 401);
				return cookies(json({ status: "other_sessions_revoked" }), s.response);
			}
			const v = resumeRegistrationRequest.parse(input);
			// The producer rechecks the exact native identity, mailbox and source in its transaction.
			if (v.invitationProof) {
				if (!config.invitations) throw new IdentityRefusal("unavailable", 503);
				const accepted = seatInvitationAcceptedResult.parse(
					await config.invitations.resume(s.value.sessionId, v.invitationProof, v.requestKey),
				);
				return cookies(
					json(
						registrationResult.parse({
							status: "active",
							accountId: accepted.accountId,
						}),
					),
					s.response,
				);
			}
			return cookies(
				json(registrationStatus.parse({ status: s.value.status, accountId: s.value.accountId })),
				s.response,
			);
		} catch (error) {
			if (error instanceof InvitationRefusal) return json(error.value, error.value.code === "temporary" ? 503 : 400);
			const refusal =
				error instanceof IdentityRefusal
					? error
					: error instanceof z.ZodError
						? new IdentityRefusal("invalid_input", 422)
						: new IdentityRefusal("unavailable", 503);
			if (refusal.code === "unavailable") config.diagnostic({ correlationId, outcome: "unknown" });
			const code = refusal.code === "origin_denied" ? "access_denied" : refusal.code;
			return json(
				identityError.parse({
					code,
					details: code === "rate_limited" ? { retryAt: new Date(Date.now() + 3600_000).toISOString() } : {},
					correlationId,
					retry: code === "rate_limited" || code === "admission_unavailable" ? "same_request" : "never",
				}),
				refusal.status,
			);
		}
	}
	async function event(
		id: string,
		key: string,
		action: "identity.credential_observed" | "identity.credential_changed",
		tx?: Transaction,
	) {
		const result = await (tx ?? config.db)
			.insert(tables.audit_event)
			.values({
				tenant_id: id,
				subject_id: id,
				actor_id: id,
				kind: "outcome",
				occurred_at: sql<Date>`clock_timestamp()`.mapWith((value: string) => new Date(value)),
				recorded_at: sql<Date>`clock_timestamp()`.mapWith((value: string) => new Date(value)),
				event_key: key,
				action: action,
			})
			.returning({ id: tables.audit_event.id });
		return z.uuid().parse(result[0]?.id);
	}
	return { handle, auth };
}
