import "server-only";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { and, eq, isNull, sql } from "@everyfield/db/query";
import * as t from "@everyfield/db/tables";
import type { Database, Transaction } from "@everyfield/db/client";
import { credentialOutcome, type CredentialOutcome } from "@everyfield/contracts/identity";
import * as n from "@everyfield/contracts/settings/native";
import type { NativeAccountProducer, NativeSettingsContext } from "@everyfield/contracts/settings/server";
import { identityAuth } from "../identity/auth.ts";
import { attemptBudget, IdentityRefusal } from "../identity/budget.ts";
import { self, now, hash, deny, Refusal, reply, parse, type Tx } from "./core.ts";
export interface CredentialConfig {
	db: Database;
	authDb: Database;
	admissionDb: Database;
	origin: string;
	secret: string;
	// Native adapter binds actual cookie and overwritten trusted IP to this session.
	request(ctx: NativeSettingsContext): Promise<{ request: Request; trustedIp: string | null }>;
	responseCookies(ctx: NativeSettingsContext, cookies: string[]): Promise<void>;
	deliverVerification(input: { accountId: string; address: string; token: string }): Promise<void>;
	securityNotice(
		tx: Transaction,
		input: { accountId: string; address: string; action: "password_changed" | "email_changed"; correlationId: string },
	): Promise<string>;
}
export function createAccountCredentials(
	config: CredentialConfig,
): Pick<NativeAccountProducer<Tx>, "requestEmailChange" | "confirmEmailChange" | "changePassword"> {
	const budget = attemptBudget(config.admissionDb, config.secret);
	const auth = identityAuth({
		db: config.authDb,
		origin: config.origin,
		secret: config.secret,
		emailChange: true,
		deliver: async (user, purpose, token) => {
			if (purpose !== "email_verification") throw Error("unsupported_credential_mail");
			const a = await config.db.transaction(async (tx) => {
				const [account] = await tx.select().from(t.account).where(eq(t.account.auth_user_id, user.id)).for("update");
				if (!account) deny();
				await tx
					.update(t.identity_proof)
					.set({ superseded_at: now })
					.where(
						and(
							eq(t.identity_proof.account_id, account.id),
							eq(t.identity_proof.purpose, "email_change"),
							isNull(t.identity_proof.superseded_at),
							isNull(t.identity_proof.consumed_at),
						),
					);
				await tx.insert(t.identity_proof).values({
					account_id: account.id,
					purpose: "email_change",
					token_hash: hash(token),
					proposed_email: user.email,
					expires_at: sql`clock_timestamp()+interval '24 hours'`,
				});
				return account;
			});
			await config.deliverVerification({ accountId: a.id, address: user.email, token });
		},
	});
	async function prepare(ctx: NativeSettingsContext) {
		const a = await config.db.transaction((tx) => self(tx, ctx, "preview"));
		const ingress = await config.request(ctx);
		if (
			!ingress.trustedIp ||
			new URL(ingress.request.url).origin !== config.origin ||
			ingress.request.headers.get("origin") !== config.origin
		)
			deny();
		const checked = await auth.api.getSession({ headers: ingress.request.headers });
		if (!checked || checked.session.id !== ctx.session || checked.user.id !== a.account.auth_user_id) deny();
		return { ...a, ingress };
	}
	async function recorded(
		accountId: string,
		address: string,
		action: "password_changed" | "email_changed",
		correlationId: string,
	): Promise<CredentialOutcome> {
		try {
			const reporting = await config.db.transaction(async (tx) => {
				const [event] = await tx
					.insert(t.audit_event)
					.values({
						tenant_id: accountId,
						subject_id: accountId,
						actor_id: accountId,
						kind: "edit",
						action: action === "email_changed" ? "identity.email_changed" : "identity.credential_changed",
						occurred_at: now,
						recorded_at: now,
						event_key: correlationId,
					})
					.returning({ id: t.audit_event.id });
				const mailIntentId = await config.securityNotice(tx, { accountId, address, action, correlationId });
				return { status: "recorded" as const, eventId: event!.id, mailIntentId };
			});
			return credentialOutcome.parse({ status: "succeeded", accountId, action, correlationId, reporting });
		} catch {
			return credentialOutcome.parse({
				status: "succeeded",
				accountId,
				action,
				correlationId,
				reporting: { status: "pending_investigation" },
			});
		}
	}
	return {
		requestEmailChange: async (_tx, ctx, raw) =>
			reply(_tx, async () => {
				const v = parse(n.requestEmailChange, raw);
				const a = await prepare(ctx);
				if (v.newEmail === a.principal.email) deny("invalid_input");
				const reservation = await budget
					.reserve("email_change", a.principal.email, a.ingress.trustedIp)
					.catch(() => deny("temporary"));
				try {
					await auth.api.changeEmail({ headers: a.ingress.request.headers, body: { newEmail: v.newEmail } });
					await budget.finish(reservation, true);
					return { status: "verification_requested" as const };
				} catch {
					await budget.finish(reservation, false);
					deny("temporary");
				}
			}),
		confirmEmailChange: async (_tx, ctx, raw) => {
			const correlationId = randomUUID();
			let committedAccount: string | undefined;
			try {
				const v = n.confirmEmailChange.parse(raw);
				const a = await prepare(ctx);
				// Consume only the live exact requester's proof. No app transaction remains
				// open while Better Auth changes its credential tables on a separate client.
				await config.db
					.transaction(async (tx) => {
						await self(tx, ctx, "preview");
						const [p] = await tx
							.select()
							.from(t.identity_proof)
							.where(
								and(
									eq(t.identity_proof.account_id, a.account.id),
									eq(t.identity_proof.token_hash, hash(v.proof)),
									eq(t.identity_proof.purpose, "email_change"),
									isNull(t.identity_proof.superseded_at),
									isNull(t.identity_proof.consumed_at),
									sql`${t.identity_proof.expires_at}>clock_timestamp()`,
								),
							)
							.for("update");
						if (!p) deny("proof_invalid");
						await tx.update(t.identity_proof).set({ consumed_at: now }).where(eq(t.identity_proof.id, p.id));
					})
					.catch(async (e) => {
						if (e instanceof Refusal && e.code === "proof_invalid") {
							const r = await budget.reserve("email_change", a.principal.email, a.ingress.trustedIp);
							await budget.finish(r, false);
						}
						throw e;
					});
				const changed = await auth.api.verifyEmail({
					headers: a.ingress.request.headers,
					query: { token: v.proof },
					asResponse: true,
				});
				if (!changed.ok)
					return credentialOutcome.parse({ status: changed.status >= 500 ? "unknown" : "refused", correlationId });
				committedAccount = a.account.id;
				await config.responseCookies(ctx, changed.headers.getSetCookie());
				return await recorded(a.account.id, a.principal.email, "email_changed", correlationId);
			} catch (e) {
				if (committedAccount)
					return credentialOutcome.parse({
						status: "succeeded",
						accountId: committedAccount,
						action: "email_changed",
						correlationId,
						reporting: { status: "pending_investigation" },
					});
				return credentialOutcome.parse({
					status:
						e instanceof Refusal || e instanceof IdentityRefusal || e instanceof z.ZodError || isRefused(e)
							? "refused"
							: "unknown",
					correlationId,
				});
			}
		},
		changePassword: async (_tx, ctx, raw) => {
			const correlationId = randomUUID();
			let reservation: Awaited<ReturnType<typeof budget.reserve>> | undefined;
			let committedAccount: string | undefined;
			try {
				const v = n.changePasswordRequest.parse(raw);
				const a = await prepare(ctx);
				reservation = await budget.reserve("password_change", a.principal.email, a.ingress.trustedIp);
				await auth.api.verifyPassword({ headers: a.ingress.request.headers, body: { password: v.currentPassword } });
				if (v.currentPassword === v.newPassword) {
					await budget.finish(reservation, false);
					return {
						status: "refused",
						correlationId: credentialOutcome.options[0].shape.correlationId.parse(correlationId),
					};
				}
				const changed = await auth.api.changePassword({
					headers: a.ingress.request.headers,
					body: { currentPassword: v.currentPassword, newPassword: v.newPassword, revokeOtherSessions: true },
					asResponse: true,
				});
				if (!changed.ok) {
					await budget.finish(reservation, false);
					return credentialOutcome.parse({ status: changed.status >= 500 ? "unknown" : "refused", correlationId });
				}
				committedAccount = a.account.id;
				// The host consumes supported Set-Cookie headers separately. Never store token.
				await config.responseCookies(ctx, changed.headers.getSetCookie());
				await budget.finish(reservation, true);
				return await recorded(a.account.id, a.principal.email, "password_changed", correlationId);
			} catch (e) {
				if (committedAccount)
					return credentialOutcome.parse({
						status: "succeeded",
						accountId: committedAccount,
						action: "password_changed",
						correlationId,
						reporting: { status: "pending_investigation" },
					});
				if (reservation) await budget.finish(reservation, false);
				return credentialOutcome.parse({
					status:
						e instanceof Refusal || e instanceof IdentityRefusal || e instanceof z.ZodError || isRefused(e)
							? "refused"
							: "unknown",
					correlationId,
				});
			}
		},
	};
}
function isRefused(e: unknown) {
	return (
		typeof e === "object" &&
		e !== null &&
		"statusCode" in e &&
		typeof e.statusCode === "number" &&
		e.statusCode >= 400 &&
		e.statusCode < 500
	);
}
