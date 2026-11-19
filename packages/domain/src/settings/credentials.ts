import "server-only";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { and, desc, eq, inArray, isNull, sql, type SQLWrapper } from "@everyfield/db/query";
import * as t from "@everyfield/db/tables";
import type { Database, Transaction } from "@everyfield/db/client";
import { credentialOutcome, type CredentialOutcome } from "@everyfield/contracts/identity";
import * as n from "@everyfield/contracts/settings/native";
import type { CredentialProducer, SettingsContext } from "@everyfield/contracts/settings/server";
import { identityAuth } from "../identity/auth.ts";
import { executeWrites } from "../operations/writes.ts";
import { attemptBudget, IdentityRefusal } from "../identity/budget.ts";
import { writeVisibility } from "../access/session.ts";
import { now, hash, deny, Refusal, recover, parse } from "./core.ts";
import { issueRestrictedDeletionSession } from "./deletion.ts";
export interface CredentialConfig {
	db: Database;
	authDb: Database;
	admissionDb: Database;
	origin: string;
	secret: string;
	request(ctx: SettingsContext): Promise<{
		request: Request;
		trustedIp: string | null;
		viewer: { accountId: string; email: string; verified: boolean } | null;
	}>;
	later?(work: () => Promise<unknown>): void;
	diagnostic(value: { correlationId: string; outcome: "reporting_pending" }): void;
	responseCookies(ctx: SettingsContext, cookies: string[]): Promise<void>;
	deliverVerification(
		tx: Transaction,
		input: { accountId: string; address: string; token: string },
		writes: SQLWrapper[],
	): Promise<void>;
	securityNotice(
		tx: Pick<Transaction, "insert">,
		input: { accountId: string; address: string; action: "password_changed" | "email_changed"; correlationId: string },
		writes: SQLWrapper[],
	): Promise<string>;
}
type OpenDeletion = (
	raw: unknown,
	trustedIp: string | null,
) => Promise<
	| {
			status: "ok";
			value: {
				session: Awaited<ReturnType<typeof issueRestrictedDeletionSession>>;
				subject: z.infer<typeof n.deletionSubject>;
				requestId: string;
			};
	  }
	| { status: "refused"; code: Refusal["code"] }
>;
export function createAccountCredentials(config: CredentialConfig): CredentialProducer & {
	openAccountDeletion: OpenDeletion;
	openWorkspaceDeletion: OpenDeletion;
} {
	const budget = attemptBudget(config.admissionDb, config.secret);
	const auth = identityAuth({
		db: config.authDb,
		origin: config.origin,
		secret: config.secret,
		emailChange: true,
		deliver: async (user, purpose, token) => {
			if (purpose !== "email_verification") throw Error("unsupported_credential_mail");
			await config.db.transaction(async (tx) => {
				const [account] = await tx
					.select({ id: t.account.id })
					.from(t.account)
					.where(eq(t.account.auth_user_id, user.id))
					.for("update");
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
				const writes: SQLWrapper[] = [
					tx.insert(t.identity_proof).values({
						account_id: account.id,
						purpose: "email_change",
						token_hash: hash(token),
						proposed_email: user.email,
						expires_at: sql`clock_timestamp()+interval '24 hours'`,
					}),
				];
				await config.deliverVerification(tx, { accountId: account.id, address: user.email, token }, writes);
				await executeWrites(tx, writes);
			});
		},
	});
	async function prepare(ctx: SettingsContext) {
		const ingress = await config.request(ctx);
		if (
			new URL(ingress.request.url).origin !== config.origin ||
			ingress.request.headers.get("origin") !== config.origin
		)
			deny();
		const viewer = ingress.viewer;
		if (!viewer?.verified || ctx.selected.kind !== "account" || ctx.selected.id !== viewer.accountId) deny();
		return { account: { id: viewer.accountId }, principal: { email: viewer.email }, ingress };
	}
	function settle(reservation: Awaited<ReturnType<typeof budget.reserve>>, success: boolean) {
		const work = () => budget.finish(reservation, success).catch(() => undefined);
		if (config.later) config.later(work);
		else return work();
	}
	function reportingPending(
		accountId: string,
		action: "password_changed" | "email_changed",
		correlationId: string,
	): CredentialOutcome {
		config.diagnostic({ correlationId, outcome: "reporting_pending" });
		return credentialOutcome.parse({
			status: "succeeded",
			accountId,
			action,
			correlationId,
			reporting: { status: "pending_investigation" },
		});
	}
	async function recorded(
		accountId: string,
		address: string,
		action: "password_changed" | "email_changed",
		correlationId: string,
	): Promise<CredentialOutcome> {
		try {
			const db = config.db,
				eventId = randomUUID();
			const writes: SQLWrapper[] = [
				db.insert(t.audit_event).values({
					id: eventId,
					tenant_id: accountId,
					subject_id: accountId,
					actor_id: accountId,
					kind: "edit",
					action: action === "email_changed" ? "identity.email_changed" : "identity.credential_changed",
					occurred_at: now,
					recorded_at: now,
					event_key: correlationId,
				}),
			];
			const mailIntentId = await config.securityNotice(db, { accountId, address, action, correlationId }, writes);
			await executeWrites(db, writes);
			const reporting = { status: "recorded" as const, eventId, mailIntentId };
			return credentialOutcome.parse({ status: "succeeded", accountId, action, correlationId, reporting });
		} catch {
			return reportingPending(accountId, action, correlationId);
		}
	}
	async function openDeletion(kind: "account" | "plant", raw: unknown, trustedIp: string | null) {
		try {
			const v = n.openAccountDeletionRequest.parse(raw);
			const reservation = await budget.reserve("login", v.email, trustedIp);
			const context = await auth.$context;
			const found = await context.internalAdapter.findUserByEmail(v.email, { includeAccounts: true });
			const stored = found?.accounts.find((a) => a.providerId === "credential")?.password;
			const valid = stored
				? await context.password.verify({ hash: stored, password: v.password })
				: !(await context.password.hash(v.password));
			await budget.finish(reservation, valid);
			if (!found || !valid) deny("proof_invalid");
			const provenAt = new Date();
			const opened = await config.db.transaction(async (tx) => {
				const w = t.lifecycle_witness;
				const [current] = await tx
					.select({ account: t.account.id, subject: w.opaque_subject_id, requestId: w.request_id })
					.from(t.account)
					.innerJoin(
						w,
						kind === "account"
							? and(eq(w.kind, "account"), eq(w.opaque_subject_id, t.account.id))
							: and(
									eq(w.kind, "plant"),
									eq(w.requester_opaque_id, t.account.id),
									inArray(w.state, ["pending_deletion", "purging"]),
								),
					)
					.where(eq(t.account.auth_user_id, found.user.id))
					.orderBy(desc(w.requested_at))
					.limit(1);
				if (!current?.requestId) deny("proof_invalid");
				const subject = n.deletionSubject.parse({ kind, id: current.subject });
				const session = await issueRestrictedDeletionSession(
					tx,
					{ subject, requestId: current.requestId },
					async () => ({ accountId: current.account, provenAt }),
				);
				return { session, subject, requestId: current.requestId };
			});
			return { status: "ok" as const, value: opened };
		} catch (e) {
			if (e instanceof Refusal || e instanceof IdentityRefusal || e instanceof z.ZodError)
				return { status: "refused" as const, code: e instanceof Refusal ? e.code : "proof_invalid" };
			throw e;
		}
	}
	return {
		requestEmailChange: async (ctx, raw) =>
			recover(async () => {
				const v = parse(n.requestEmailChange, raw);
				const a = await prepare(ctx);
				if (v.newEmail === a.principal.email) deny("invalid_input");
				const reservation = await budget
					.reserve("email_change", a.principal.email, a.ingress.trustedIp)
					.catch(() => deny("temporary"));
				try {
					await auth.api.changeEmail({ headers: a.ingress.request.headers, body: { newEmail: v.newEmail } });
				} catch {
					await budget.release(reservation).catch(() => undefined);
					deny("unknown");
				}
				await settle(reservation, true);
				return { status: "ok" as const, value: { status: "verification_requested" as const } };
			}),
		confirmEmailChange: async (ctx, raw) => {
			const correlationId = randomUUID();
			let committedAccount: string | undefined;
			try {
				const v = n.confirmEmailChange.parse(raw);
				const a = await prepare(ctx);
				const consumed = await config.db
					.update(t.identity_proof)
					.set({ consumed_at: now })
					.where(
						and(
							eq(t.identity_proof.account_id, a.account.id),
							eq(t.identity_proof.token_hash, hash(v.proof)),
							eq(t.identity_proof.purpose, "email_change"),
							isNull(t.identity_proof.superseded_at),
							isNull(t.identity_proof.consumed_at),
							sql`${t.identity_proof.expires_at}>clock_timestamp()`,
							writeVisibility(a.account.id, ctx.selected),
						),
					)
					.returning({ id: t.identity_proof.id });
				if (!consumed.length) {
					const r = await budget.reserve("email_change", a.principal.email, a.ingress.trustedIp);
					await budget.finish(r, false);
					deny("proof_invalid");
				}
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
				if (committedAccount) return reportingPending(committedAccount, "email_changed", correlationId);
				return credentialOutcome.parse({
					status:
						e instanceof Refusal || e instanceof IdentityRefusal || e instanceof z.ZodError || isRefused(e)
							? "refused"
							: "unknown",
					correlationId,
				});
			}
		},
		changePassword: async (ctx, raw) => {
			const correlationId = randomUUID();
			let reservation: Awaited<ReturnType<typeof budget.reserve>> | undefined;
			let committedAccount: string | undefined;
			try {
				const v = n.changePasswordRequest.parse(raw);
				const a = await prepare(ctx);
				reservation = await budget.reserve("password_change", a.principal.email, a.ingress.trustedIp);
				if (v.currentPassword === v.newPassword) {
					await auth.api.verifyPassword({ headers: a.ingress.request.headers, body: { password: v.currentPassword } });
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
				await config.responseCookies(ctx, changed.headers.getSetCookie());
				await settle(reservation, true);
				return await recorded(a.account.id, a.principal.email, "password_changed", correlationId);
			} catch (e) {
				if (committedAccount) return reportingPending(committedAccount, "password_changed", correlationId);
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
		openAccountDeletion: (raw, trustedIp) => openDeletion("account", raw, trustedIp),
		openWorkspaceDeletion: (raw, trustedIp) => openDeletion("plant", raw, trustedIp),
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
