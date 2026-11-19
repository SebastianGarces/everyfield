import "server-only";
import { asLogId, isTransient, logFailure, logLine, type LogWord } from "@everyfield/domain/log";
import { owner, sessionId, type Owner } from "@everyfield/contracts/common";
import { sectionResult, settingsError, type SettingsError } from "@everyfield/contracts/settings";
import * as N from "@everyfield/contracts/settings/native";
import type { SettingsReply } from "@everyfield/contracts/settings/server";
import type { Transaction } from "@everyfield/db/client";
import { and, eq, isNull } from "@everyfield/db/query";
import { privateStorage, StorageError } from "@everyfield/db/schema";
import * as t from "@everyfield/db/tables";
import type { RequestActor } from "@everyfield/domain/access";
import { personalCalendar } from "@everyfield/domain/intelligence";
import { trustedIdentityIp } from "@everyfield/domain/identity";
import {
	avatarOperations,
	createAccountCredentials,
	deletionOperations,
	readAvatar,
	Refusal,
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
import { serverConfig, serverEnv, type ServerConfig } from "../../server/config.ts";
import { database } from "../../server/database.ts";
import { enqueueJob, queueJobs } from "../../server/jobs/queue.ts";
import { current as organizationMount } from "../organizations/mount.ts";
import { getViewer } from "../../server/request-context.ts";
import { settingsMail } from "./mail.ts";
import type { SettingsViewer } from "./port.ts";
import { trustsVercelForwardedFor } from "@everyfield/db/deployment";
import { transient } from "../../server/platform/transient.ts";
import { parseJson } from "../../server/platform/json.ts";

type Viewer = Awaited<ReturnType<typeof getViewer>>;
type Signed = SectionViewer & { accountId: string };
type Mount = ReturnType<typeof create>;
type Context = { session: RequestActor["session"]; selected: Owner };

let mount: ReturnType<typeof create> | undefined;
function create(v: ServerConfig) {
	const organizations = organizationMount();
	const mail = settingsMail();
	const db = organizations.db,
		origin = v.IDENTITY_ORIGIN,
		addressKey = Buffer.from(v.IDENTITY_ADDRESS_KEY, "hex");
	const addressHash = (address: string) =>
		createHmac("sha256", addressKey).update(address.trim().toLowerCase()).digest("hex");
	const effects = {
		replan: (tx: Transaction, i: { owner: Owner; revision: string; operationId: string; kind: string }) =>
			enqueueJob(tx, {
				tenant: i.owner.id,
				kind: "digest",
				subject: i.owner.id,
				key: `settings/${i.kind}/${i.operationId}`,
				revision: i.revision,
				eligibleAt: new Date().toISOString(),
			}),
	};
	const sections = sectionOperations({
		organizations: organizations.adapter,
		organizationEffects: organizations.effects,
		effects,
		async suppression(db, email) {
			const rows = await db
				.select({ id: t.suppression.id })
				.from(t.suppression)
				.where(and(eq(t.suppression.address_hash, addressHash(email)), isNull(t.suppression.cleared_at)))
				.limit(1);
			return rows.length ? "suppressed" : "clear";
		},
	});
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
	const { workspaceNotice, ...credentialMail } = mail;
	const deletion = deletionOperations({
		workspaceNotice,
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
		async request() {
			const request = new Request(`${origin}/api/auth/settings`, { method: "POST", headers: await headers() });
			const viewer = await signedIn();
			return {
				request,
				trustedIp: trustedIdentityIp(request, trustsVercelForwardedFor(serverEnv())),
				viewer: viewer && {
					accountId: viewer.accountId,
					email: viewer.principal.email,
					verified: viewer.principal.verified,
				},
			};
		},
		later: after,
		diagnostic: (value) => logLine({ component: "settings", ...value, correlationId: asLogId(value.correlationId) }),
		async responseCookies(_ctx, list) {
			const jar = await cookies();
			for (const cookie of list.map(parseSetCookie)) if (cookie) jar.set(cookie);
		},
		...credentialMail,
	});
	return {
		db,
		origin,
		sections,
		timezones: timezoneOperations(effects, personalCalendar),
		avatar,
		deletion,
		credentials,
		storage: privateStorage(),
	};
}
function settingsMount() {
	mount ??= create(serverConfig());
	return mount;
}

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

export function settingsCommands() {
	const ops = settingsMount();
	return {
		settings: {
			updatePlantProfile: ops.sections.updatePlantProfile,
			setDigestSchedule: ops.sections.setDigestSchedule,
			previewPlantTimezone: ops.timezones.previewPlantTimezone,
			setPlantTimezone: ops.timezones.setPlantTimezone,
		},
		account: { finalizeAvatar: ops.avatar.finalizeAvatar, requestAccountDeletion: ops.deletion.requestAccountDeletion },
	};
}

export function settingsViewerOf(v: Viewer): SettingsViewer | null {
	const authority = v.authority;
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

export async function readSection(
	session: Session,
	raw: unknown,
): Promise<SettingsReply<z.infer<typeof sectionResult>>> {
	const viewer = signedAs(session);
	if (!viewer) return refusal("access_denied");
	const ops = settingsMount();
	return transient(
		{ component: "settings", outcome: "read_failed" },
		() => ops.sections.getSection(ops.db, viewer, raw),
		refusal("temporary"),
	);
}

export async function run<S extends z.ZodType, T>(
	schema: S,
	raw: unknown,
	section: (input: z.output<S>) => string,
	operation: (ops: Mount, tx: Transaction, context: Context, input: z.output<S>) => Promise<SettingsReply<T>>,
): Promise<SettingsReply<T>> {
	const viewer = await signedIn();
	if (!viewer) return refusal("access_denied");
	const input = schema.safeParse(raw);
	if (!input.success) return refusal("invalid_input");
	const self = ["account", "notifications"].includes(section(input.data));
	const selected = self ? owner.parse({ kind: "account", id: viewer.accountId }) : viewer.authority.actor.context.owner;
	const context = { session: viewer.authority.session, selected };
	const ops = settingsMount();
	return transient(
		{ component: "settings", outcome: "write_failed" },
		() => withSettingsWrite(ops.db, viewer.authority, context, (tx) => operation(ops, tx, context, input.data)),
		refusal("unknown"),
	);
}

export async function credential<S extends z.ZodType, T>(
	schema: S,
	raw: unknown,
	operation: (ops: Mount["credentials"], context: Context, input: z.output<S>) => Promise<T>,
): Promise<T | { status: "refused"; error: SettingsError }> {
	const viewer = await signedIn();
	if (!viewer) return refusal("access_denied");
	const input = schema.safeParse(raw);
	if (!input.success) return refusal("invalid_input");
	const ops = settingsMount();
	const context = {
		session: viewer.authority.session,
		selected: owner.parse({ kind: "account", id: viewer.accountId }),
	};
	return transient(
		{ component: "settings", outcome: "credential_failed" },
		() => operation(ops.credentials, context, input.data),
		refusal("unknown"),
	);
}

export async function storeAvatarBytes(accountId: string, uploadId: string, bytes: Uint8Array) {
	const viewer = await signedIn();
	const ops = settingsMount();
	if (!viewer || !ops.storage || viewer.accountId !== accountId) return "unavailable" as const;
	const context = { session: viewer.authority.session, selected: owner.parse({ kind: "account", id: accountId }) };
	try {
		await uploadAvatar(ops.db, ops.storage, context, { uploadId, bytes });
		return "stored" as const;
	} catch (error) {
		if (
			(error instanceof Refusal && error.code === "invalid_input") ||
			(error instanceof StorageError && error.code === "invalid_avatar")
		)
			return "invalid" as const;
		if (!isTransient(error)) throw error;
		logFailure({ component: "settings", outcome: "avatar_upload_failed" }, error);
		return "unavailable" as const;
	}
}

export async function avatarBytes(accountId: string, versionId: string) {
	const viewer = await signedIn();
	const ops = settingsMount();
	if (!viewer || !ops.storage) return null;
	const context = {
		session: viewer.authority.session,
		selected: owner.parse({ kind: "account", id: viewer.accountId }),
	};
	try {
		return await readAvatar(ops.db, ops.storage, context, { accountId, versionId });
	} catch (error) {
		if (error instanceof Refusal || error instanceof StorageError) return null;
		throw error;
	}
}

const DELETION_COOKIE = "evf-deletion";
const restrictedCookie = z.strictObject({
	handle: sessionId,
	request: z.union([N.getAccountDeletionStatusRequest, N.getWorkspaceDeletionStatusRequest]),
});
type Restricted = z.infer<typeof restrictedCookie>;

export async function openRestrictedDeletion(kind: "account" | "plant", raw: unknown) {
	const ops = settingsMount();
	const request = new Request(`${ops.origin}/`, { headers: await headers() });
	const ip = trustedIdentityIp(request, trustsVercelForwardedFor(serverEnv()));
	const opened = await transient(
		{ component: "settings", outcome: "restricted_open_failed" },
		() =>
			kind === "account"
				? ops.credentials.openAccountDeletion(raw, ip)
				: ops.credentials.openWorkspaceDeletion(raw, ip),
		{ status: "refused", code: "unknown" } as const,
	);
	if (opened.status === "refused")
		return refusal(
			opened.code === "temporary" || opened.code === "unknown" || opened.code === "invalid_input"
				? opened.code
				: "proof_invalid",
		);
	const value: Restricted = {
		handle: opened.value.session.handle,
		request: restrictedCookie.shape.request.parse({ subject: opened.value.subject, requestId: opened.value.requestId }),
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
	return restrictedStatus(kind);
}

async function restricted(kind: "account" | "plant"): Promise<Restricted | null> {
	const raw = (await cookies()).get(DELETION_COOKIE)?.value;
	if (!raw) return null;
	const session = restrictedCookie.safeParse(parseJson(raw));
	return session.success && session.data.request.subject.kind === kind ? session.data : null;
}

export async function restrictedStatus(kind: "account" | "plant") {
	const ops = settingsMount(),
		session = await restricted(kind);
	if (!session) return refusal("proof_invalid");
	const context = { kind: "restricted_deletion" as const, handle: session.handle };
	const { request } = session;
	return logged("restricted_status_failed", () =>
		ops.db.transaction((tx) =>
			kind === "account"
				? ops.deletion.getAccountDeletionStatus(tx, context, N.getAccountDeletionStatusRequest.parse(request))
				: ops.deletion.getWorkspaceDeletionStatus(tx, context, N.getWorkspaceDeletionStatusRequest.parse(request)),
		),
	);
}

export async function cancelRestrictedDeletion(kind: "account" | "plant", expectedRevision: string) {
	const ops = settingsMount(),
		session = await restricted(kind);
	if (!session) return refusal("proof_invalid");
	const command = { requestKey: randomUUID(), expectedRevision, input: session.request };
	const context = { kind: "restricted_deletion" as const, handle: session.handle };
	const reply = await logged("restricted_cancel_failed", () =>
		ops.db.transaction((tx) => {
			if (kind === "account") {
				const v = N.cancelAccountDeletionRequest.safeParse(command);
				return v.success ? ops.deletion.cancelAccountDeletion(tx, context, v.data) : refused("invalid_input");
			}
			const v = N.cancelWorkspaceDeletionRequest.safeParse(command);
			return v.success ? ops.deletion.cancelWorkspaceDeletion(tx, context, v.data) : refused("invalid_input");
		}),
	);
	if (reply.status === "ok" && reply.value.status === "cancelled") (await cookies()).delete(DELETION_COOKIE);
	return reply;
}

const refused = async (code: keyof typeof RETRY) => refusal(code);

async function logged<T, O extends string>(
	outcome: LogWord<O>,
	body: () => Promise<SettingsReply<T>>,
): Promise<SettingsReply<T>> {
	return transient({ component: "settings", outcome }, body, refusal("unknown"));
}

export type Session = Awaited<ReturnType<typeof getViewer>>;

function signedAs(v: Session): Signed | null {
	if (v.status !== "active" || !v.authority) return null;
	const principal = { display_name: v.displayName, email: v.email, verified: v.verified };
	return { authority: v.authority, principal, accountId: v.accountId };
}

const signedIn = async () => signedAs(await getViewer());
