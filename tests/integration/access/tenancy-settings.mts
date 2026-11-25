import assert from "node:assert/strict";
import { sql } from "../../../packages/db/src/query.ts";
import { accountId } from "../../../packages/contracts/src/common/index.ts";
import { queueJobs } from "../../../packages/domain/src/jobs/queue.ts";
import { avatarOperations, readAvatar, uploadAvatar } from "../../../packages/domain/src/settings/index.ts";
import { gatedTransaction } from "../../../packages/domain/src/operations/writes.ts";
import { seedStorage, tenancyCase, type Tenancy, type TenancyOwner } from "./tenancy-case.mts";

const seeding = seedStorage("tenancy-avatar-seed");
const photo = Buffer.from(
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADUlEQVQImWPgEpH7DwABpAE8sdwFIwAAAABJRU5ErkJggg==",
	"base64",
);
const api = avatarOperations({
	queue: (tx, i) =>
		queueJobs(tx, [
			{
				tenant: i.accountId,
				kind: "object_cleanup",
				subject: i.fileId,
				key: `avatar/${i.fileId}`,
				revision: "1",
				eligibleAt: i.eligibleAt,
			},
		]),
});
const own = (owner: TenancyOwner) => ({
	session: owner.session,
	selected: { kind: "account" as const, id: accountId.parse(owner.id) },
});

export async function seedSettings(t: Tenancy) {
	const { a, ok } = t;
	const db = t.f.db;
	const ctx = own(t.ownerA);
	const upload = ok(
		await gatedTransaction(db, (tx) =>
			api.requestAvatarUpload(tx, ctx, { mime: "image/png", byteLength: photo.length }),
		),
	);
	await uploadAvatar(db, seeding, ctx, { uploadId: upload.uploadId, bytes: photo });
	const [account] = await t.rows<{ revision: string }>(
		sql`SELECT revision::text FROM account WHERE id = ${t.ownerA.id}`,
	);
	ok(
		await gatedTransaction(db, (tx) =>
			api.finalizeAvatar(tx, ctx, {
				input: { uploadId: upload.uploadId },
				expectedRevision: account!.revision,
				requestKey: t.key(),
			}),
		),
	);
	a.avatar = upload.uploadId;
}

export function settingsCases(t: Tenancy, who: TenancyOwner) {
	const { a, storage } = t;
	return [
		tenancyCase(
			"settings:readAvatar",
			async () => {
				try {
					return {
						status: "ok",
						value: await readAvatar(t.f.db, storage, own(who), { accountId: t.ownerA.id, versionId: a.avatar }),
					};
				} catch (error) {
					assert.ok(error instanceof Error, String(error));
					return { status: "refused", error: { code: error.message } };
				}
			},
			{ refused: "unavailable", control: null },
		),
	];
}
