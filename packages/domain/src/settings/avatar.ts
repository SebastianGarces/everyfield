import * as q from "@everyfield/contracts/settings";
import type { NativeAccountProducer, NativeSettingsContext } from "@everyfield/contracts/settings/server";
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
const resultRecord = z.object({ result: q.avatarResult });
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
				if (c.kind === "replay") return resultRecord.parse(c.value).result;
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
				const result = await finish(s, c, resultRecord, () => ({
					result: { status: "available", avatar: { accountId: a.account.id, versionId: f.id } },
				}));
				return result.result;
			}),
		removeAvatar: (tx, ctx, raw) =>
			reply(tx, async (s) => {
				const v = parse(q.removeAvatarRequest, raw);
				const a = await self(s, ctx);
				const c = await begin(s, { ...ctx }, a.account.id, "account.removeAvatar", v);
				if (c.kind === "replay") return resultRecord.parse(c.value).result;
				revision(v.expectedRevision, a.account.revision);
				await change(s, c, a.account, null);
				return (await finish(s, c, resultRecord, () => ({ result: { status: "absent" } }))).result;
			}),
	};
}
function authorization(ctx: NativeSettingsContext, uploadId: string, upload: boolean): ResourceAuthorizer {
	return async (tx, file, intent) => {
		const a = await self(tx, ctx, "preview");
		if (
			(!upload && file.id !== uploadId) ||
			file.tenant_id !== a.account.id ||
			file.purpose !== "avatar" ||
			intent === "cleanup" ||
			(!upload && a.account.avatar_object_id !== file.id)
		)
			return null;
		return { kind: "account", actorId: a.account.id };
	};
}
// Called by the native byte adapter, before the reference-finalizing transaction.
export async function uploadAvatar(
	db: Database,
	storage: PrivateStorage,
	ctx: NativeSettingsContext,
	raw: { uploadId: string; bytes: Uint8Array },
) {
	const id = parse(z.uuid(), raw.uploadId);
	const file = await db.transaction(async (tx) => {
		const a = await self(tx, ctx, "preview");
		const [f] = await tx
			.select()
			.from(t.file_object)
			.where(
				and(
					eq(t.file_object.id, id),
					eq(t.file_object.tenant_id, a.account.id),
					eq(t.file_object.purpose, "avatar"),
					eq(t.file_object.state, "pending"),
				),
			)
			.for("update");
		if (!f) deny();
		return f;
	});
	await validateAvatar(raw.bytes, file.media_type);
	if (raw.bytes.length !== Number(file.max_bytes)) deny("invalid_input");
	const digest = createHash("sha256").update(raw.bytes).digest("hex");
	await db.transaction(async (tx) => {
		const auth = authorization(ctx, id, true);
		if (!(await auth(tx, file, "put"))) deny();
		await tx
			.update(t.file_object)
			.set({ byte_count: String(raw.bytes.length), sha256: digest })
			.where(and(eq(t.file_object.id, id), eq(t.file_object.state, "pending")));
	});
	return putPrivateObject(db, storage, authorization(ctx, id, true), {
		tenantId: file.tenant_id,
		purpose: "avatar",
		mediaType: file.media_type,
		bytes: raw.bytes,
		uploadKey: file.upload_key,
	});
}
export async function readAvatar(db: Database, storage: PrivateStorage, ctx: NativeSettingsContext, versionId: string) {
	return readAuthorizedObject(db, storage, authorization(ctx, parse(z.uuid(), versionId), false), versionId);
}
