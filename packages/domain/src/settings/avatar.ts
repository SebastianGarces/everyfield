import "server-only";
import { randomUUID, createHash } from "node:crypto";
import { z } from "zod";
import * as t from "@everyfield/db/tables";
import { and, eq, sql } from "@everyfield/db/query";
import {
	validateAvatar,
	putPrivateObject,
	readAuthorizedObject,
	type PrivateStorage,
	type ResourceAuthorizer,
} from "@everyfield/db/schema";
import type { Database } from "@everyfield/db/client";
import * as q from "@everyfield/contracts/settings";
import { receipt } from "@everyfield/contracts/common";
import type { NativeAccountProducer, NativeSettingsContext } from "@everyfield/contracts/settings/server";
import { native, self, reply, parse, now, revision, begin, finish, appendEvent, deny, type Tx } from "./core.ts";
export interface AvatarCleanup {
	enqueue(tx: Tx, input: { accountId: string; fileId: string; eligibleAt: string }): Promise<void>;
}
const resultRecord = z.object({ receipt, result: q.avatarResult });
export function avatarOperations(
	cleanup: AvatarCleanup,
): Pick<NativeAccountProducer<Tx>, "requestAvatarUpload" | "getAvatar" | "finalizeAvatar" | "removeAvatar"> {
	return {
		requestAvatarUpload: (tx, ctx, raw) =>
			reply(tx, async (s) => {
				native(ctx);
				const input = parse(q.requestAvatarUpload, raw);
				const a = await self(s, ctx);
				const [clock] = await s.select({ at: now }).from(t.account).where(eq(t.account.id, a.account.id));
				const id = randomUUID(),
					expiresAt = new Date(clock!.at.getTime() + 15 * 60_000).toISOString();
				await s.insert(t.file_object).values({
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
				});
				// This intent already exists if a later upload/finalize response or SQL save fails.
				await cleanup.enqueue(s, { accountId: a.account.id, fileId: id, eligibleAt: expiresAt });
				return q.avatarUploadResult.parse({ uploadId: id, expiresAt });
			}),
		getAvatar: (tx, ctx, raw) =>
			reply(tx, async (s) => {
				native(ctx);
				const v = parse(q.getAvatarRequest, raw);
				const a = await self(s, ctx);
				if (a.account.avatar_object_id !== v.versionId) deny();
				const [file] = await s
					.select({ id: t.file_object.id })
					.from(t.file_object)
					.where(
						and(
							eq(t.file_object.id, v.versionId),
							eq(t.file_object.tenant_id, a.account.id),
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
				native(ctx);
				const v = parse(q.finalizeAvatarRequest, raw);
				const a = await self(s, ctx);
				const c = await begin(
					s,
					{ ...ctx, purpose: "native", origin: { kind: "native" } },
					a.account.id,
					"account.finalizeAvatar",
					v,
				);
				if (c.kind === "replay") {
					const prior = resultRecord.parse(c.value);
					return prior.result;
				}
				revision(v.expectedRevision, a.account.revision);
				const [f] = await s
					.select()
					.from(t.file_object)
					.where(
						and(
							eq(t.file_object.id, v.input.uploadId),
							eq(t.file_object.tenant_id, a.account.id),
							eq(t.file_object.purpose, "avatar"),
							eq(t.file_object.state, "ready"),
						),
					)
					.for("update");
				const [clock] = await s.select({ at: now }).from(t.account).where(eq(t.account.id, a.account.id));
				if (!f || !f.expires_at || f.expires_at <= clock!.at) deny();
				const changed = a.account.avatar_object_id !== f.id;
				let events: string[] = [];
				if (changed) {
					await s
						.update(t.account)
						.set({ avatar_object_id: f.id, revision: sql`${t.account.revision}+1` })
						.where(eq(t.account.id, a.account.id));
					events = [
						await appendEvent(
							s,
							c,
							a.account.id,
							"edit",
							"files.finalized",
							a.account.revision,
							String(BigInt(a.account.revision) + 1n),
						),
					];
					if (a.account.avatar_object_id)
						await cleanup.enqueue(s, {
							accountId: a.account.id,
							fileId: a.account.avatar_object_id,
							eligibleAt: clock!.at.toISOString(),
						});
				}
				const result = await finish(
					s,
					c,
					resultRecord,
					events,
					(r) => ({
						receipt: r,
						result: { status: "available", avatar: { accountId: a.account.id, versionId: f.id } },
					}),
					changed,
				);
				return result.result;
			}),
		removeAvatar: (tx, ctx, raw) =>
			reply(tx, async (s) => {
				native(ctx);
				const v = parse(q.removeAvatarRequest, raw);
				const a = await self(s, ctx);
				const c = await begin(
					s,
					{ ...ctx, purpose: "native", origin: { kind: "native" } },
					a.account.id,
					"account.removeAvatar",
					v,
				);
				if (c.kind === "replay") return resultRecord.parse(c.value).result;
				revision(v.expectedRevision, a.account.revision);
				const changed = a.account.avatar_object_id !== null;
				let events: string[] = [];
				if (changed) {
					await s
						.update(t.account)
						.set({ avatar_object_id: null, revision: sql`${t.account.revision}+1` })
						.where(eq(t.account.id, a.account.id));
					const [clock] = await s.select({ at: now }).from(t.account).where(eq(t.account.id, a.account.id));
					await cleanup.enqueue(s, {
						accountId: a.account.id,
						fileId: a.account.avatar_object_id!,
						eligibleAt: clock!.at.toISOString(),
					});
					events = [
						await appendEvent(
							s,
							c,
							a.account.id,
							"edit",
							"files.finalized",
							a.account.revision,
							String(BigInt(a.account.revision) + 1n),
						),
					];
				}
				return (
					await finish(s, c, resultRecord, events, (r) => ({ receipt: r, result: { status: "absent" } }), changed)
				).result;
			}),
	};
}
function authorization(ctx: NativeSettingsContext, uploadId: string, upload: boolean): ResourceAuthorizer {
	return async (tx, file, intent) => {
		native(ctx);
		const a = await self(tx, ctx);
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
		native(ctx);
		const a = await self(tx, ctx);
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
