import "server-only";
import { S3Client } from "@aws-sdk/client-s3";
import { owner, sessionId, type Owner } from "@everyfield/contracts/common";
import { sectionResult, settingsError, type SettingsError } from "@everyfield/contracts/settings";
import * as N from "@everyfield/contracts/settings/native";
import type { SettingsReply } from "@everyfield/contracts/settings/server";
import type { Transaction } from "@everyfield/db/client";
import { and, eq, gt, inArray, isNull, sql } from "@everyfield/db/query";
import type { PrivateStorage } from "@everyfield/db/schema";
import * as t from "@everyfield/db/tables";
import type { RequestActor } from "@everyfield/domain/access";
import { trustedIdentityIp } from "@everyfield/domain/identity";
import {
	avatarOperations,
	createAccountCredentials,
	deletionOperations,
	readAvatar,
	sectionOperations,
	timezoneOperations,
	uploadAvatar,
	withSettingsWrite,
	type SectionViewer,
} from "@everyfield/domain/settings";
import { cookies, headers } from "next/headers";
import { after } from "next/server";
import { createHmac, randomUUID } from "node:crypto";
import { z } from "zod";
import { database } from "@/server/database";
import { createMailService } from "@/server/jobs/mail";
import { enqueueJob, queueJobs } from "@/server/jobs/queue";
import { protectedTemplate } from "@/server/jobs/templates";
import { current as organizationMount } from "@/server/organizations";
import { getSession, getViewer } from "@/server/request-context";
import type { SettingsViewer } from "./port";

// The settings mount (WP-010): the one door from the settings server actions to the settings domain. The session and
// actor come from the request's getViewer. A section read uses that viewer on the pool, without a transaction; every
// write binds that actor in its own transaction (withSettingsWrite) and the domain checks authority again. Changes
// queue their jobs and mail in the same transaction; a worker acts on them. Email and password changes go through
// Better Auth, outside any app transaction. Photo bytes need the private bucket (PRIVATE_STORAGE_*); without it the
// photo calls are refused and every other section still works.

type Viewer = NonNullable<Awaited<ReturnType<typeof getViewer>>>;
type Signed = SectionViewer & { accountId: string };
type Mount = NonNullable<ReturnType<typeof create>>;
type Context = { session: RequestActor["session"]; selected: Owner };

const env = z.object({
	IDENTITY_AUTH_DATABASE_URL: z.string().min(1),
	IDENTITY_ORIGIN: z.url(),
	IDENTITY_SECRET: z.string().min(32),
	IDENTITY_MAIL_KEY: z.string().regex(/^[a-f0-9]{64}$/),
	IDENTITY_ADDRESS_KEY: z.string().regex(/^[a-f0-9]{64}$/),
	IDENTITY_MAIL_FROM: z.email(),
});
const storageEnv = z.object({
	PRIVATE_STORAGE_BUCKET: z.string().min(1),
	PRIVATE_STORAGE_ENDPOINT: z.url(),
	PRIVATE_STORAGE_REGION: z.string().min(1),
	PRIVATE_STORAGE_ACCESS_KEY_ID: z.string().min(1),
	PRIVATE_STORAGE_SECRET_ACCESS_KEY: z.string().min(1),
});

let mount: ReturnType<typeof create> | undefined;
function create(v: z.infer<typeof env>) {
	const organizations = organizationMount();
	if (!organizations) return null;
	const db = organizations.db,
		origin = v.IDENTITY_ORIGIN,
		addressKey = Buffer.from(v.IDENTITY_ADDRESS_KEY, "hex");
	const addressHash = (address: string) =>
		createHmac("sha256", addressKey).update(address.trim().toLowerCase()).digest("hex");
	const effects = {
		// A plant's digest schedule or time zone changed: the digest job plans the next sends again.
		replan: (tx: Transaction, i: { owner: Owner; revision: string; operationId: string; kind: string }) =>
			enqueueJob(tx, {
				tenant: i.owner.id,
				kind: "digest",
				subject: i.owner.id,
				key: `settings/${i.kind}/${i.operationId}`,
				revision: i.revision,
				eligibleAt: new Date().toISOString(),
			}),
		// A material plant fact changed: assessments that read the old value are computed again.
		invalidate: async (tx: Transaction, i: { owner: Owner; revision: string; operationId: string }) => {
			await enqueueJob(tx, {
				tenant: i.owner.id,
				kind: "assessment",
				subject: i.owner.id,
				key: `settings/${i.operationId}`,
				revision: i.revision,
				eligibleAt: new Date().toISOString(),
			});
		},
	};
	const mail = createMailService({
		db,
		encryptionKey: Buffer.from(v.IDENTITY_MAIL_KEY, "hex"),
		addressKey,
		from: v.IDENTITY_MAIL_FROM,
		// An email-change link goes only to the address of the account's live proof; a security notice only to its
		// own account.
		authorize: async (tx, list) => {
			const proofs = await tx
				.select({ account: t.identity_proof.account_id, address: t.identity_proof.proposed_email })
				.from(t.identity_proof)
				.where(
					and(
						inArray(
							t.identity_proof.account_id,
							list.map((m) => m.tenant),
						),
						eq(t.identity_proof.purpose, "email_change"),
						isNull(t.identity_proof.superseded_at),
						isNull(t.identity_proof.consumed_at),
						gt(t.identity_proof.expires_at, sql`clock_timestamp()`),
					),
				);
			return new Set(
				list
					.filter(
						(m) =>
							m.recipient === m.tenant &&
							(m.purpose === "email_change"
								? proofs.some((p) => p.account === m.tenant && p.address && addressHash(p.address) === m.addressHash)
								: m.purpose === "notification" && m.logicalKey.startsWith("security/")),
					)
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
	const sections = sectionOperations({
		organizations: organizations.adapter,
		organizationEffects: organizations.effects,
		effects,
		// The mail worker's suppression list, keyed the same way: HMAC of the trimmed, lower-case address.
		async suppression(db, email) {
			const rows = await db
				.select({ id: t.suppression.id })
				.from(t.suppression)
				.where(and(eq(t.suppression.address_hash, addressHash(email)), isNull(t.suppression.cleared_at)))
				.limit(1);
			return rows.length ? "suppressed" : "clear";
		},
	});
	// Old or never-finalized photo bytes: the cleanup worker removes the file once nothing references it.
	const avatar = avatarOperations({
		queue: (tx, i) =>
			queueJobs(tx, [
				{
					tenant: i.accountId,
					kind: "object_cleanup",
					subject: i.fileId,
					key: `avatar/${i.fileId}/${i.eligibleAt}`,
					revision: "1",
					eligibleAt: i.eligibleAt,
				},
			]),
	});
	// The purge job becomes eligible at the cancellation deadline.
	const deletion = deletionOperations({
		queue: (tx, i) =>
			queueJobs(tx, [
				{
					tenant: i.subject.id,
					kind: "lifecycle_purge",
					subject: i.witnessId,
					key: `purge/${i.requestId}`,
					revision: i.revision,
					eligibleAt: i.eligibleAt,
				},
			]),
	});
	const credentials = createAccountCredentials({
		db,
		authDb: database(v.IDENTITY_AUTH_DATABASE_URL),
		admissionDb: db,
		origin,
		secret: v.IDENTITY_SECRET,
		// The browser's own request: its session cookie and Origin header go to Better Auth unchanged. The viewer is
		// this request's cached lookup (D60), so the call reads no session again.
		async request() {
			const request = new Request(`${origin}/api/auth/settings`, { method: "POST", headers: await headers() });
			const viewer = await signedIn();
			return {
				request,
				trustedIp: trustedIdentityIp(request, process.env.VERCEL === "1"),
				viewer: viewer && {
					accountId: viewer.accountId,
					email: viewer.principal.email,
					verified: viewer.principal.verified,
				},
			};
		},
		later: after,
		// Better Auth's new session cookie after a password or email change.
		async responseCookies(_ctx, list) {
			const jar = await cookies();
			for (const cookie of list.map(parseSetCookie)) if (cookie) jar.set(cookie);
		},
		deliverVerification: async (tx, i, writes) => {
			const url = `${origin}/confirm-email?token=${encodeURIComponent(i.token)}`;
			await mail.append(
				tx,
				{
					owner: { kind: "account", id: i.accountId },
					purpose: "email_change",
					logicalKey: `email-change/${randomUUID()}`,
					recipient: i.accountId,
					address: i.address,
					content: protectedTemplate({ purpose: "email_change", url }, origin),
					operation: null,
					notice: null,
					eligibleAt: new Date().toISOString(),
				},
				writes,
			);
		},
		securityNotice: (tx, i, writes) =>
			mail.append(
				tx,
				{
					owner: { kind: "account", id: i.accountId },
					purpose: "notification",
					logicalKey: `security/${i.correlationId}`,
					recipient: i.accountId,
					address: i.address,
					content:
						i.action === "password_changed"
							? {
									subject: "Your EveryField password changed",
									text: "The password for your EveryField account changed. Other devices were signed out.\n\nIf you did not change it, reset your password now.",
								}
							: {
									subject: "Your EveryField sign-in email changed",
									text: "The email you use to sign in to EveryField changed. This address no longer signs in.\n\nIf you did not change it, contact EveryField support now.",
								},
					operation: null,
					notice: null,
					eligibleAt: new Date().toISOString(),
				},
				writes,
			),
	});
	const storage = storageEnv.safeParse(process.env);
	const privateStorage: PrivateStorage | null = storage.success
		? {
				bucket: storage.data.PRIVATE_STORAGE_BUCKET,
				client: new S3Client({
					endpoint: storage.data.PRIVATE_STORAGE_ENDPOINT,
					region: storage.data.PRIVATE_STORAGE_REGION,
					credentials: {
						accessKeyId: storage.data.PRIVATE_STORAGE_ACCESS_KEY_ID,
						secretAccessKey: storage.data.PRIVATE_STORAGE_SECRET_ACCESS_KEY,
					},
				}),
			}
		: null;
	return {
		db,
		origin,
		sections,
		timezones: timezoneOperations(effects),
		avatar,
		deletion,
		credentials,
		storage: privateStorage,
	};
}
function settingsMount() {
	const v = env.safeParse(process.env);
	if (!v.success) return null;
	mount ??= create(v.data);
	return mount;
}

/** One Set-Cookie header as the options Next.js cookies().set takes, or null when it has no name. */
function parseSetCookie(header: string) {
	const [pair = "", ...attributes] = header.split(";").map((part) => part.trim());
	const split = pair.indexOf("=");
	if (split < 1) return null;
	const cookie: Parameters<Awaited<ReturnType<typeof cookies>>["set"]>[0] = {
		name: pair.slice(0, split),
		value: decodeURIComponent(pair.slice(split + 1)),
	};
	for (const attribute of attributes) {
		const [key = "", value = ""] = attribute.split(/=(.*)/s);
		switch (key.toLowerCase()) {
			case "path":
				cookie.path = value;
				break;
			case "domain":
				cookie.domain = value;
				break;
			case "max-age":
				cookie.maxAge = Number(value);
				break;
			case "expires":
				cookie.expires = new Date(value);
				break;
			case "httponly":
				cookie.httpOnly = true;
				break;
			case "secure":
				cookie.secure = true;
				break;
			case "samesite":
				cookie.sameSite = value.toLowerCase() as "lax" | "strict" | "none";
				break;
		}
	}
	return cookie;
}

/** What the settings screens need to know about the viewer; null when signed out or without an active actor. */
export function settingsViewerOf(v: Viewer | null): SettingsViewer | null {
	const authority = v?.authority;
	if (!authority || v.status !== "active") return null;
	const context = authority.actor.context;
	if (context.kind !== "seat") return { context: "account", accountId: v.accountId };
	if (context.owner.kind === "plant")
		return { context: "plant", accountId: v.accountId, plant: context.owner, role: context.role };
	return { context: "organization", accountId: v.accountId, organization: context.owner, role: context.role };
}

const RETRY = {
	access_denied: "never",
	invalid_input: "never",
	unavailable: "never",
	proof_invalid: "never",
	temporary: "same_request",
	unknown: "reconcile",
} as const;
function refusal(code: keyof typeof RETRY): { status: "refused"; error: SettingsError } {
	return {
		status: "refused",
		error: settingsError.parse({ code, details: {}, correlationId: randomUUID(), retry: RETRY[code] }),
	};
}

/**
 * Reads one settings section for this request's viewer on the pool: one statement, two for notifications, and no
 * transaction. The domain parses the request before it reads. A thrown error is logged and reads as temporary.
 */
export async function readSection(raw: unknown): Promise<SettingsReply<z.infer<typeof sectionResult>>> {
	const viewer = await signedIn();
	const ops = settingsMount();
	if (!viewer || !ops) return refusal("access_denied");
	try {
		return await ops.sections.getSection(ops.db, viewer, raw);
	} catch (error) {
		console.error(JSON.stringify({ component: "settings", outcome: "read_failed", error: String(error) }));
		return refusal("temporary");
	}
}

/**
 * Runs one settings write for this request's viewer. The raw browser input is parsed with the contract `schema`
 * first; a request it refuses never reaches the database. `section` names the section: your account and
 * notifications belong to your account, every other section to the plant or organization of your seat. The write
 * binds the actor in its transaction. A thrown error is logged and reads as unknown: the screen then offers to load
 * the latest value.
 */
export async function run<S extends z.ZodType, T>(
	schema: S,
	raw: unknown,
	section: (input: z.output<S>) => string,
	operation: (ops: Mount, tx: Transaction, context: Context, input: z.output<S>) => Promise<SettingsReply<T>>,
): Promise<SettingsReply<T>> {
	const viewer = await signedIn();
	const ops = settingsMount();
	if (!viewer || !ops) return refusal("access_denied");
	const input = schema.safeParse(raw);
	if (!input.success) return refusal("invalid_input");
	const self = ["account", "notifications"].includes(section(input.data));
	const selected = self ? owner.parse({ kind: "account", id: viewer.accountId }) : viewer.authority.actor.context.owner;
	const context = { session: viewer.authority.session, selected };
	try {
		return await withSettingsWrite(ops.db, viewer.authority, context, (tx) => operation(ops, tx, context, input.data));
	} catch (error) {
		console.error(JSON.stringify({ component: "settings", outcome: "write_failed", error: String(error) }));
		return refusal("unknown");
	}
}

/**
 * Runs one Better Auth credential change (email or password) for this request's viewer, after the contract `schema`
 * parses the browser input. Better Auth changes its own tables outside any app transaction, so no app lock is held
 * while it runs; the domain checks the live session and account first and records the security event after the
 * change.
 */
export async function credential<S extends z.ZodType, T>(
	schema: S,
	raw: unknown,
	operation: (ops: Mount["credentials"], tx: Transaction, context: Context, input: z.output<S>) => Promise<T>,
): Promise<T | { status: "refused"; error: SettingsError }> {
	const viewer = await signedIn();
	const ops = settingsMount();
	if (!viewer || !ops) return refusal("access_denied");
	const input = schema.safeParse(raw);
	if (!input.success) return refusal("invalid_input");
	const context = {
		session: viewer.authority.session,
		selected: owner.parse({ kind: "account", id: viewer.accountId }),
	};
	try {
		return await operation(ops.credentials, NO_TRANSACTION, context, input.data);
	} catch (error) {
		console.error(JSON.stringify({ component: "settings", outcome: "credential_failed", error: String(error) }));
		return refusal("unknown");
	}
}
/** The credential operations open their own short transactions; the contract's transaction argument is unused. */
const NO_TRANSACTION = undefined as unknown as Transaction;

/** The photo bytes for one staged upload, verified by type and size again before they reach the private bucket. */
export async function storeAvatarBytes(accountId: string, uploadId: string, bytes: Uint8Array) {
	const viewer = await signedIn();
	const ops = settingsMount();
	if (!viewer || !ops?.storage || viewer.accountId !== accountId) return "unavailable" as const;
	const context = { session: viewer.authority.session, selected: owner.parse({ kind: "account", id: accountId }) };
	try {
		await uploadAvatar(ops.db, ops.storage, context, { uploadId, bytes });
		return "stored" as const;
	} catch (error) {
		const code = error instanceof Error ? error.message : "";
		if (code === "invalid_input" || code === "invalid_avatar") return "invalid" as const;
		console.error(JSON.stringify({ component: "settings", outcome: "avatar_upload_failed", error: String(error) }));
		return "unavailable" as const;
	}
}

/** The bytes of the viewer's own current photo version, or null. Only its own account may read it. */
export async function avatarBytes(accountId: string, versionId: string) {
	const viewer = await signedIn();
	const ops = settingsMount();
	if (!viewer || !ops?.storage || viewer.accountId !== accountId) return null;
	const context = { session: viewer.authority.session, selected: owner.parse({ kind: "account", id: accountId }) };
	try {
		return await readAvatar(ops.db, ops.storage, context, versionId);
	} catch {
		return null;
	}
}

// The restricted deletion page (REQ-IDN-032). After a personal deletion request every normal session ends. A fresh
// proof of the original login opens a ten-minute restricted session for that exact request; its handle lives in an
// HttpOnly cookie and permits only the request's status and its cancellation.
const DELETION_COOKIE = "evf-deletion";
const restrictedCookie = z.strictObject({ handle: sessionId, request: N.getAccountDeletionStatusRequest });
type Restricted = z.infer<typeof restrictedCookie>;

/** Checks the original login's password and opens the restricted session for its current deletion request. */
export async function openRestrictedDeletion(raw: unknown) {
	const ops = settingsMount();
	if (!ops) return refusal("access_denied");
	const request = new Request(`${ops.origin}/`, { headers: await headers() });
	const opened = await ops.credentials
		.openAccountDeletion(raw, trustedIdentityIp(request, process.env.VERCEL === "1"))
		.catch((error) => {
			console.error(JSON.stringify({ component: "settings", outcome: "restricted_open_failed", error: String(error) }));
			return { status: "refused" as const, code: "unknown" as const };
		});
	if (opened.status === "refused")
		return refusal(
			opened.code === "temporary" || opened.code === "unknown" || opened.code === "invalid_input"
				? opened.code
				: "proof_invalid",
		);
	const value: Restricted = {
		handle: opened.value.session.handle,
		request: N.getAccountDeletionStatusRequest.parse({
			subject: opened.value.subject,
			requestId: opened.value.requestId,
		}),
	};
	(await cookies()).set({
		name: DELETION_COOKIE,
		value: JSON.stringify(value),
		httpOnly: true,
		secure: new URL(ops.origin).protocol === "https:",
		sameSite: "strict",
		path: "/",
		maxAge: 10 * 60,
	});
	return restrictedStatus();
}

async function restricted(): Promise<Restricted | null> {
	const raw = (await cookies()).get(DELETION_COOKIE)?.value;
	if (!raw) return null;
	try {
		return restrictedCookie.parse(JSON.parse(raw));
	} catch {
		return null;
	}
}

/** The exact request's status for the restricted session, or a refusal once the session expired. */
export async function restrictedStatus() {
	const ops = settingsMount(),
		session = await restricted();
	if (!ops || !session) return refusal("proof_invalid");
	const context = { kind: "restricted_deletion" as const, handle: session.handle };
	return logged("restricted_status_failed", () =>
		ops.db.transaction((tx) => ops.deletion.getAccountDeletionStatus(tx, context, session.request)),
	);
}

/** Cancels the exact request strictly before its deadline. A cancelled request ends the restricted session. */
export async function cancelRestrictedDeletion(expectedRevision: string) {
	const ops = settingsMount(),
		session = await restricted();
	if (!ops || !session) return refusal("proof_invalid");
	const request = N.cancelAccountDeletionRequest.safeParse({
		requestKey: randomUUID(),
		expectedRevision,
		input: session.request,
	});
	if (!request.success) return refusal("invalid_input");
	const context = { kind: "restricted_deletion" as const, handle: session.handle };
	const reply = await logged("restricted_cancel_failed", () =>
		ops.db.transaction((tx) => ops.deletion.cancelAccountDeletion(tx, context, request.data)),
	);
	if (reply.status === "ok" && reply.value.status === "cancelled") (await cookies()).delete(DELETION_COOKIE);
	return reply;
}

/** A thrown error is logged and reads as unknown: the page then offers to load the latest status. */
async function logged<T>(outcome: string, body: () => Promise<SettingsReply<T>>): Promise<SettingsReply<T>> {
	try {
		return await body();
	} catch (error) {
		console.error(JSON.stringify({ component: "settings", outcome, error: String(error) }));
		return refusal("unknown");
	}
}

/** The active viewer with the user row Better Auth already read for this request's session. */
async function signedIn(): Promise<Signed | null> {
	const [v, session] = await Promise.all([getViewer(), getSession()]);
	if (v?.status !== "active" || !v.authority || !session) return null;
	const principal = {
		display_name: session.user.name,
		email: session.user.email,
		verified: session.user.emailVerified,
	};
	return { authority: v.authority, principal, accountId: v.accountId };
}
