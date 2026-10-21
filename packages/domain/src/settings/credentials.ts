import "server-only";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { and, eq, isNull, sql, type SQLWrapper } from "@everyfield/db/query";
import * as t from "@everyfield/db/tables";
import type { Database, Transaction } from "@everyfield/db/client";
import { credentialOutcome, type CredentialOutcome } from "@everyfield/contracts/identity";
import * as n from "@everyfield/contracts/settings/native";
import type { NativeAccountProducer, NativeSettingsContext } from "@everyfield/contracts/settings/server";
import { identityAuth } from "../identity/auth.ts";
import { executeWrites } from "../operations/writes.ts";
import { attemptBudget, IdentityRefusal } from "../identity/budget.ts";
import { accountId } from "@everyfield/contracts/common";
import { readViewer, writeVisibility } from "../access/session.ts";
import { now, hash, deny, Refusal, reply, parse, type Tx } from "./core.ts";
import { issueRestrictedDeletionSession } from "./deletion.ts";
export interface CredentialConfig {
	db: Database;
	authDb: Database;
	admissionDb: Database;
	origin: string;
	secret: string;
	// Native adapter binds actual cookie and overwritten trusted IP to this session.
	request(ctx: NativeSettingsContext): Promise<{ request: Request; trustedIp: string | null }>;
	responseCookies(ctx: NativeSettingsContext, cookies: string[]): Promise<void>;
	/** Adds the verification mail for the new address to `writes`, which commit with its proof row. */
	deliverVerification(
		tx: Transaction,
		input: { accountId: string; address: string; token: string },
		writes: SQLWrapper[],
	): Promise<void>;
	/** Adds the security notice to the old address to `writes`, which commit with the app security event. */
	securityNotice(
		tx: Transaction,
		input: { accountId: string; address: string; action: "password_changed" | "email_changed"; correlationId: string },
		writes: SQLWrapper[],
	): Promise<string>;
}
export function createAccountCredentials(config: CredentialConfig): Pick<
	NativeAccountProducer<Tx>,
	"requestEmailChange" | "confirmEmailChange" | "changePassword"
> & {
	openAccountDeletion(
		raw: unknown,
		trustedIp: string | null,
	): Promise<
		| {
				status: "ok";
				value: {
					session: Awaited<ReturnType<typeof issueRestrictedDeletionSession>>;
					subject: { kind: "account"; id: z.infer<typeof accountId> };
					requestId: string;
				};
		  }
		| { status: "refused"; code: Refusal["code"] }
	>;
} {
	const budget = attemptBudget(config.admissionDb, config.secret);
	const auth = identityAuth({
		db: config.authDb,
		origin: config.origin,
		secret: config.secret,
		emailChange: true,
		deliver: async (user, purpose, token) => {
			if (purpose !== "email_verification") throw Error("unsupported_credential_mail");
			// The new proof supersedes any older one first: one live proof per account is a unique index. The new proof
			// and its mail then commit together in one statement.
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
	/**
	 * The live self this credential call acts for: Better Auth's session for the browser's own cookie, and in parallel
	 * one app statement for the same session's account, unhidden and fully registered. Both must name this context.
	 */
	async function prepare(ctx: NativeSettingsContext) {
		const ingress = await config.request(ctx);
		// Without a trusted proxy address (a local server) the budgets count the own login only, as sign-in does.
		if (
			new URL(ingress.request.url).origin !== config.origin ||
			ingress.request.headers.get("origin") !== config.origin
		)
			deny();
		const [checked, viewer] = await Promise.all([
			auth.api.getSession({ headers: ingress.request.headers }),
			readViewer(config.db, ctx.session),
		]);
		if (
			!checked ||
			!checked.user.emailVerified ||
			checked.session.id !== ctx.session ||
			viewer?.registration !== "active" ||
			ctx.selected.kind !== "account" ||
			ctx.selected.id !== viewer.accountId
		)
			deny();
		return { account: { id: viewer.accountId }, principal: { email: checked.user.email }, ingress };
	}
	async function recorded(
		accountId: string,
		address: string,
		action: "password_changed" | "email_changed",
		correlationId: string,
	): Promise<CredentialOutcome> {
		try {
			// The security event and the notice to the old address commit together in one statement.
			const reporting = await config.db.transaction(async (tx) => {
				const eventId = randomUUID();
				const writes: SQLWrapper[] = [
					tx.insert(t.audit_event).values({
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
				const mailIntentId = await config.securityNotice(tx, { accountId, address, action, correlationId }, writes);
				await executeWrites(tx, writes);
				return { status: "recorded" as const, eventId, mailIntentId };
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
				// One statement consumes the live proof, while the account is still unhidden.
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
				// The current password is proved before an unchanged password is refused. Otherwise Better Auth's own
				// change proves it.
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
				// The host consumes supported Set-Cookie headers separately. Never store token.
				await config.responseCookies(ctx, changed.headers.getSetCookie());
				// Clearing the failure budget and recording the event are independent; a budget failure cannot undo the change.
				const [, outcome] = await Promise.all([
					budget.finish(reservation, true).catch(() => undefined),
					recorded(a.account.id, a.principal.email, "password_changed", correlationId),
				]);
				return outcome;
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
		/**
		 * Fresh proof for the restricted deletion page: the original login and its current password, under the sign-in
		 * failure budget. Better Auth checks the password; no session is created. The proof opens a restricted
		 * session for the account's current deletion request only.
		 */
		openAccountDeletion: async (raw: unknown, trustedIp: string | null) => {
			try {
				const v = n.openAccountDeletionRequest.parse(raw);
				const reservation = await budget.reserve("login", v.email, trustedIp);
				const context = await auth.$context;
				const found = await context.internalAdapter.findUserByEmail(v.email, { includeAccounts: true });
				const stored = found?.accounts.find((a) => a.providerId === "credential")?.password;
				// An unknown login hashes too, so the answer takes the same time either way.
				const valid = stored
					? await context.password.verify({ hash: stored, password: v.password })
					: !(await context.password.hash(v.password));
				await budget.finish(reservation, valid);
				if (!found || !valid) deny("proof_invalid");
				const provenAt = new Date();
				const opened = await config.db.transaction(async (tx) => {
					const [current] = await tx
						.select({ account: t.account.id, requestId: t.lifecycle_witness.request_id })
						.from(t.account)
						.innerJoin(
							t.lifecycle_witness,
							and(eq(t.lifecycle_witness.kind, "account"), eq(t.lifecycle_witness.opaque_subject_id, t.account.id)),
						)
						.where(eq(t.account.auth_user_id, found.user.id));
					if (!current?.requestId) deny("proof_invalid");
					const subject = { kind: "account" as const, id: accountId.parse(current.account) };
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
