import * as q from "@everyfield/contracts/settings";
import type { NativeAccountProducer, SettingsContext } from "@everyfield/contracts/settings/server";
import type { Database } from "@everyfield/db/client";
import { and, eq, sql, type SQLWrapper } from "@everyfield/db/query";
import {
	putPrivateObject,
	readAuthorizedObject,
	validateAvatar,
	type PrivateStorage,
	type ResourceAuthorizer,
} from "@everyfield/db/schema";
import * as t from "@everyfield/db/tables";
import { createHash, randomUUID } from "node:crypto";
import "server-only";
import { z } from "zod";
import { seatHeld, writeVisibility } from "../access/session.ts";
import { hiding, workspaceAvatar } from "./photo-visibility.ts";
import { executeWrites } from "../operations/writes.ts";
import {
	appendEvent,
	auditChange,
	begin,
	deny,
	finish,
	parse,
	reply,
	revision,
	self,
	type NewCommand,
	type Tx,
} from "./core.ts";
export interface AvatarCleanup {
	/** The cleanup job for one avatar file, as an insert the caller adds to its own write statement (D70). */
	queue(tx: Tx, input: { accountId: string; fileId: string; eligibleAt: string }): SQLWrapper;
}
// The replay record holds nothing: personal settings audit never keeps the photo reference. A replay has the same
// request, so the reply is rebuilt from it.
const resultRecord = z.strictObject({});
/** The 15 minutes a staged upload stays open for its bytes and its finalize. */
const STAGING_MS = 15 * 60_000;
export function avatarOperations(
	cleanup: AvatarCleanup,
): Pick<NativeAccountProducer<Tx>, "requestAvatarUpload" | "getAvatar" | "finalizeAvatar" | "removeAvatar"> {
	/** The account's avatar reference changes from `before` to `after`: the account row, the old file's cleanup and the audit entry. */
	async function change(s: Tx, c: NewCommand, account: typeof t.account.$inferSelect, after: string | null) {
		const before = account.avatar_object_id;
		if (before === after) return;
		c.writes.push(
			s
				.update(t.account)
				.set({ avatar_object_id: after, revision: sql`${t.account.revision}+1` })
				.where(eq(t.account.id, account.id)),
		);
		// The old bytes are unreferenced once this commits; cleanup may start at once.
		if (before)
			c.writes.push(cleanup.queue(s, { accountId: account.id, fileId: before, eligibleAt: new Date().toISOString() }));
		const event = await appendEvent(
			s,
			c,
			account.id,
			"edit",
			"files.finalized",
			account.revision,
			String(BigInt(account.revision) + 1n),
		);
		auditChange(c, event, "account", { avatar: before }, { avatar: after });
	}
	return {
		// The staged file and its orphan cleanup commit in one statement, so a later failed upload or finalize leaves
		// no file without cleanup.
		requestAvatarUpload: (tx, ctx, raw) =>
			reply(tx, async (s) => {
				const input = parse(q.requestAvatarUpload, raw);
				const a = await self(s, ctx);
				const id = randomUUID(),
					expiresAt = new Date(Date.now() + STAGING_MS).toISOString();
				await executeWrites(s, [
					s.insert(t.file_object).values({
						id,
						tenant_id: a.account.id,
						purpose: "avatar",
						opaque_key: `private/${a.account.id}/${randomUUID()}`,
						media_type: input.mime,
						max_bytes: String(input.byteLength),
						state: "pending",
						upload_key: id,
						claim_generation: "0",
						expires_at: new Date(expiresAt),
					}),
					cleanup.queue(s, { accountId: a.account.id, fileId: id, eligibleAt: expiresAt }),
				]);
				return q.avatarUploadResult.parse({ uploadId: id, expiresAt });
			}),
		getAvatar: (tx, ctx, raw) =>
			reply(tx, async (s) => {
				const v = parse(q.getAvatarRequest, raw);
				const a = await self(s, ctx, "read");
				// The account's composite avatar foreign key already binds this reference to its tenant.
				if (a.account.avatar_object_id !== v.versionId) deny();
				const [file] = await s
					.select({ id: t.file_object.id })
					.from(t.file_object)
					.where(
						and(
							eq(t.file_object.id, v.versionId),
							eq(t.file_object.purpose, "avatar"),
							eq(t.file_object.state, "ready"),
						),
					)
					.for("share");
				if (!file) deny();
				return q.avatarResult.parse({ status: "available", avatar: { accountId: a.account.id, versionId: file.id } });
			}),
		finalizeAvatar: (tx, ctx, raw) =>
			reply(tx, async (s) => {
				const v = parse(q.finalizeAvatarRequest, raw);
				const a = await self(s, ctx);
				const c = await begin(s, { ...ctx }, a.account.id, "account.finalizeAvatar", v);
				const saved = q.avatarResult.parse({
					status: "available",
					avatar: { accountId: a.account.id, versionId: v.input.uploadId },
				});
				if (c.kind === "replay") return saved;
				revision(v.expectedRevision, a.account.revision);
				// The account's own uploaded, verified and unexpired file, locked until the reference commits.
				const [f] = await s
					.select({ id: t.file_object.id })
					.from(t.file_object)
					.where(
						and(
							eq(t.file_object.id, v.input.uploadId),
							eq(t.file_object.tenant_id, a.account.id),
							eq(t.file_object.purpose, "avatar"),
							eq(t.file_object.state, "ready"),
							sql`${t.file_object.expires_at}>clock_timestamp()`,
						),
					)
					.for("update");
				if (!f) deny();
				await change(s, c, a.account, f.id);
				await finish(s, c, resultRecord, () => ({}));
				return saved;
			}),
		removeAvatar: (tx, ctx, raw) =>
			reply(tx, async (s) => {
				const v = parse(q.removeAvatarRequest, raw);
				const a = await self(s, ctx);
				const c = await begin(s, { ...ctx }, a.account.id, "account.removeAvatar", v);
				const absent = q.avatarResult.parse({ status: "absent" });
				if (c.kind === "replay") return absent;
				revision(v.expectedRevision, a.account.revision);
				await change(s, c, a.account, null);
				await finish(s, c, resultRecord, () => ({}));
				return absent;
			}),
	};
}
/**
 * This context's own account, when the session is live, the account is fully registered and no lifecycle witness
 * hides it, in one statement. The upload is a write, so it keeps the share locks of access_session.
 */
function liveSelf(ctx: SettingsContext) {
	if (ctx.selected.kind !== "account") return sql`false`;
	const account = ctx.selected.id;
	return sql<boolean>`(${t.account.id}=${account}::uuid AND EXISTS(SELECT FROM access_session(${ctx.session}::uuid) x WHERE x.account_id=${account}::uuid AND x.registration_state='active') AND ${writeVisibility(account, ctx.selected)})`;
}
/** The upload's authorizer: only the live account's own staged file. */
function uploadAuthorization(ctx: SettingsContext): ResourceAuthorizer {
	return async (tx, file, intent) => {
		const [a] = await tx.select({ id: t.account.id }).from(t.account).where(liveSelf(ctx));
		if (!a || file.tenant_id !== a.id || file.purpose !== "avatar" || intent === "cleanup") return null;
		return { kind: "account", actorId: a.id };
	};
}
/**
 * The read rule of an account photo (REQ-IDN-006), as one condition on the version: the session is live and is the
 * context's own account, which is active and not hidden, and the version is the account's current photo as its own account sees it, or as the people
 * of a workspace where the viewer holds a live, unhidden seat see it (workspaceAvatar). Lock-free (C27).
 */
function avatarReadable(ctx: SettingsContext, account: string, version: string) {
	if (ctx.selected.kind !== "account") return sql<boolean>`false`;
	return sql<boolean>`EXISTS(SELECT FROM live_session(${ctx.session}::uuid) av_i WHERE av_i.account_id=${ctx.selected.id}::uuid
		AND av_i.registration_state='active'
		AND NOT ${hiding("av_h", sql`av_h.kind='account' AND av_h.opaque_subject_id=av_i.account_id`)}
		AND (
			(av_i.account_id=${account}::uuid AND EXISTS(SELECT FROM account av_x WHERE av_x.id=av_i.account_id AND av_x.avatar_object_id=${version}::uuid))
			OR EXISTS(SELECT FROM seat av_v WHERE av_v.account_id=av_i.account_id AND ${seatHeld("av_v")}
				AND NOT ${hiding("av_vw", sql`av_vw.seat_id=av_v.id`)}
				AND ${workspaceAvatar(sql`${account}::uuid`, sql`coalesce(av_v.plant_id,av_v.organization_id)`)}=${version}::uuid)
		))`;
}
/** The byte read's authorizer: the requested account's own photo file, readable by this viewer now. */
function readAuthorization(ctx: SettingsContext, accountId: string, versionId: string): ResourceAuthorizer {
	return async (tx, file, intent) => {
		if (intent !== "read" || file.id !== versionId || file.tenant_id !== accountId || file.purpose !== "avatar")
			return null;
		const [r] = await tx
			.execute<{ viewer: string | null }>(
				sql`SELECT ${ctx.selected.id}::uuid AS viewer WHERE ${avatarReadable(ctx, accountId, versionId)}`,
			)
			.then((x) => x.rows);
		return r?.viewer ? { kind: "account", actorId: r.viewer } : null;
	};
}
/** The allowed type the bytes start with; the full check decodes them. */
function signature(bytes: Uint8Array) {
	if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return "image/png";
	if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
	return "image/webp";
}
// Called by the native byte adapter, before the reference-finalizing transaction.
export async function uploadAvatar(
	db: Database,
	storage: PrivateStorage,
	ctx: SettingsContext,
	raw: { uploadId: string; bytes: Uint8Array },
) {
	const id = parse(z.uuid(), raw.uploadId);
	// The bytes are decoded first; the staged upload must then have their exact type and size.
	const mediaType = signature(raw.bytes);
	await validateAvatar(raw.bytes, mediaType);
	const digest = createHash("sha256").update(raw.bytes).digest("hex");
	// One statement: the live account's own pending upload of this type and size records the verified bytes.
	const [file] = await db
		.update(t.file_object)
		.set({ byte_count: String(raw.bytes.length), sha256: digest })
		.where(
			and(
				eq(t.file_object.id, id),
				eq(t.file_object.purpose, "avatar"),
				eq(t.file_object.state, "pending"),
				eq(t.file_object.media_type, mediaType),
				eq(t.file_object.max_bytes, String(raw.bytes.length)),
				sql`${t.file_object.tenant_id} IN (SELECT ${t.account.id} FROM ${t.account} WHERE ${liveSelf(ctx)})`,
			),
		)
		.returning();
	if (!file) deny();
	return putPrivateObject(db, storage, uploadAuthorization(ctx), {
		tenantId: file.tenant_id,
		purpose: "avatar",
		mediaType: file.media_type,
		bytes: raw.bytes,
		uploadKey: file.upload_key,
	});
}
/**
 * The bytes of one account photo version for the viewer whose own account context `ctx` is, or the storage layer's "unavailable" when the read rule
 * refuses it, the version is not current or the file is missing: every refusal looks the same.
 */
export async function readAvatar(
	db: Database,
	storage: PrivateStorage,
	ctx: SettingsContext,
	raw: { accountId: string; versionId: string },
) {
	const v = parse(z.strictObject({ accountId: z.uuid(), versionId: z.uuid() }), raw);
	return readAuthorizedObject(db, storage, readAuthorization(ctx, v.accountId, v.versionId), v.versionId);
}
