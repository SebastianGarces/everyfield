import type { Database } from "@everyfield/db/client";
import { sql, type SQL, type SqlLiteral } from "@everyfield/db/query";
import { readPrivateUpload, signPrivatePut, type PrivateStorage } from "@everyfield/db/schema";
import { liveRead, type WriteTx } from "@everyfield/domain/access";
import { queueJobsFor } from "@everyfield/domain/jobs";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { EvryActor } from "../context/actor.ts";
import { currentAuthority } from "../context/authority.ts";
import { EvryRefusal } from "../context/errors.ts";

export const ATTACHMENTS = {
	csvBytes: 10 * 1024 * 1024,
	photoBytes: 5 * 1024 * 1024,
	perTurn: 10,
	stagingHours: 24,
} as const;

const KINDS = [
	{ ext: /\.csv$/i, mediaType: "text/csv", max: ATTACHMENTS.csvBytes },
	{ ext: /\.jpe?g$/i, mediaType: "image/jpeg", max: ATTACHMENTS.photoBytes },
	{ ext: /\.png$/i, mediaType: "image/png", max: ATTACHMENTS.photoBytes },
	{ ext: /\.webp$/i, mediaType: "image/webp", max: ATTACHMENTS.photoBytes },
] as const;
const PHOTO_TYPES = ["image/jpeg", "image/png", "image/webp"] as const;
export const PHOTO_NAME = /\.(jpe?g|png|webp)$/i;
const fileName = z
	.string()
	.trim()
	.min(1)
	.max(200)
	.refine((n) => KINDS.some((k) => k.ext.test(n)));
const stageInput = z
	.strictObject({ name: fileName, byteLength: z.int().min(1).max(ATTACHMENTS.csvBytes) })
	.transform(({ name, byteLength }, ctx) => {
		const kind = KINDS.find((k) => k.ext.test(name) && byteLength <= k.max);
		if (!kind) ctx.addIssue({ code: "custom", message: "too large" });
		return { name, byteLength, mediaType: kind?.mediaType ?? "" };
	});
export const attachment = z.strictObject({ id: z.uuid(), name: fileName });

const uploadKey = (conversationId: string, id: string) => `evry-attachment/${conversationId}/${id}`;
const staged = <F extends string, C extends string>(f: SqlLiteral<F>, c: SqlLiteral<C>) =>
	`${f}.purpose='assistant_staging' AND ${f}.upload_key='evry-attachment/'||${c}.id||'/'||${f}.id`;
export const stagedIn = <F extends string, C extends string>(f: SqlLiteral<F>, c: SqlLiteral<C>) =>
	sql.raw(staged(f, c));
const canAttach = (actor: EvryActor) =>
	actor.owner.kind === "plant" && (actor.role === "owner" || actor.role === "admin");

export async function stageAttachment(
	db: Database,
	storage: PrivateStorage | null,
	actor: EvryActor,
	conversationId: string,
	raw: unknown,
) {
	const parsed = z.object({ id: z.uuid(), input: stageInput }).safeParse({ id: conversationId, input: raw });
	if (!parsed.success) throw new EvryRefusal("invalid_input");
	if (!storage || !canAttach(actor)) throw new EvryRefusal("access_denied");
	const { input } = parsed.data;
	const id = randomUUID();
	const key = `private/${actor.owner.id}/${id}`;
	const r = await db.execute(sql`WITH c AS (
			SELECT c.id,c.tenant_id FROM conversation c WHERE c.id=${conversationId}::uuid AND c.account_id=${actor.accountId}::uuid
				AND c.tenant_id=${actor.owner.id}::uuid AND ${currentAuthority(actor)}
		), upload AS (
			INSERT INTO file_object(id,tenant_id,purpose,opaque_key,media_type,max_bytes,state,upload_key,claim_generation,expires_at)
			SELECT ${id}::uuid,c.tenant_id,'assistant_staging',${key}::text,${input.mediaType}::text,${input.byteLength}::bigint,'pending',
				${uploadKey(conversationId, id)}::text,0,clock_timestamp()+make_interval(hours=>${ATTACHMENTS.stagingHours}) FROM c
			RETURNING id,tenant_id,expires_at
		), cleanup AS (${queueJobsFor(sql`FROM upload`, {
			kind: "object_cleanup",
			tenant: sql`upload.tenant_id`,
			subject: sql`upload.id`,
			key: sql`'evry-attachment/' || upload.id::text`,
			eligibleAt: sql`upload.expires_at`,
			conflict: "skip",
		})})
		SELECT id FROM upload`);
	if (!r.rows.length) throw new EvryRefusal("not_found");
	const signed = await signPrivatePut(storage, key, input.mediaType, input.byteLength).catch(() => {
		throw new EvryRefusal("source_unavailable");
	});
	return { attachment: { id, name: input.name }, upload: signed };
}

export async function readAttachment(
	db: Database,
	storage: PrivateStorage | null,
	actor: EvryActor,
	conversationId: string,
	attachmentId: string,
): Promise<Uint8Array> {
	const r = await db.execute(sql`SELECT f.opaque_key AS key,
			(f.state='pending' AND f.expires_at>clock_timestamp()) AS live
		FROM conversation c JOIN file_object f ON f.id=${attachmentId}::uuid AND f.tenant_id=c.tenant_id AND ${stagedIn("f", "c")}
		WHERE c.id=${conversationId}::uuid AND c.account_id=${actor.accountId}::uuid AND c.tenant_id=${actor.owner.id}::uuid
			AND ${liveRead({ session: actor.session, owner: actor.owner, seatId: actor.seatId ?? undefined }, true)}`);
	const row = r.rows[0] as { key: string; live: boolean } | undefined;
	if (!row) throw new EvryRefusal("attachment_elsewhere");
	if (!row.live || !storage) throw new EvryRefusal("attachment_gone");
	const object = await readPrivateUpload(storage, row.key, ATTACHMENTS.csvBytes);
	if (object === "too_large") throw new EvryRefusal("invalid_input");
	if (object === "missing") throw new EvryRefusal("attachment_gone");
	return object.bytes;
}

export const attachmentsOf = <C extends string>(c: SqlLiteral<C>) =>
	sql.raw(`coalesce((SELECT jsonb_agg(x ORDER BY x."attachedAt" DESC, x.id) FROM (
		SELECT DISTINCT ON (a.id) a.id,a.name,e.created_at AS "attachedAt",f.expires_at AS "availableUntil",
			(SELECT k.body->'result'->'rows'->0->'fields'->>'fileDigest' FROM conversation_event k WHERE k.conversation_id=${c}.id
				AND k.kind='tool_result' AND k.body->>'operation'='people.previewImport' AND k.body->'input'->>'attachmentId'=a.id::text
				ORDER BY k.sequence DESC LIMIT 1) AS "checkedDigest",
			CASE WHEN f.purpose='person_photo' THEN 'used'
				WHEN f.purpose IS DISTINCT FROM 'assistant_staging' OR f.state<>'pending' OR f.expires_at<=clock_timestamp() THEN 'gone'
				WHEN EXISTS(SELECT FROM conversation_event l CROSS JOIN LATERAL jsonb_to_recordset(coalesce(l.body->'attachments','[]'::jsonb)) b(id uuid,name text)
					WHERE l.conversation_id=${c}.id AND l.kind='user_message' AND l.sequence>e.sequence AND lower(b.name)=lower(a.name) AND b.id<>a.id) THEN 'replaced'
				ELSE 'available' END AS status
		FROM conversation_event e CROSS JOIN LATERAL jsonb_to_recordset(coalesce(e.body->'attachments','[]'::jsonb)) a(id uuid,name text)
		LEFT JOIN file_object f ON f.id=a.id AND f.tenant_id=${c}.tenant_id AND f.upload_key='evry-attachment/'||${c}.id||'/'||f.id
		WHERE e.conversation_id=${c}.id AND e.kind='user_message'
		ORDER BY a.id,e.sequence DESC LIMIT 64) x),'[]'::jsonb)`);

export const attachmentState = z.object({
	id: z.uuid(),
	name: z.string(),
	attachedAt: z.coerce.date(),
	availableUntil: z.coerce.date().nullable(),
	status: z.enum(["available", "replaced", "used", "gone"]),
	checkedDigest: z.string().nullable(),
});

export async function requireStagedPhoto(
	db: Database,
	actor: EvryActor,
	conversationId: string | null,
	attachmentId: string,
) {
	if (!conversationId) throw new EvryRefusal("attachment_elsewhere");
	const r = await db.execute(sql`SELECT ${attachmentsOf("c")} AS attachments FROM conversation c
		WHERE c.id=${conversationId}::uuid AND c.account_id=${actor.accountId}::uuid AND c.tenant_id=${actor.owner.id}::uuid`);
	const file = z
		.array(attachmentState)
		.parse(r.rows[0]?.attachments ?? [])
		.find((a) => a.id === attachmentId);
	if (!file || !PHOTO_NAME.test(file.name)) throw new EvryRefusal("attachment_elsewhere");
	if (file.status === "replaced") throw new EvryRefusal("file_changed");
	if (file.status !== "available") throw new EvryRefusal("attachment_gone");
}

export const stagedPhotoIn = <F extends string>(f: SqlLiteral<F>, conversation: SQL) =>
	sql`${sql.raw(f)}.purpose='assistant_staging' AND ${sql.raw(f)}.state='pending' AND ${sql.raw(f)}.expires_at>clock_timestamp()
		AND ${sql.raw(f)}.media_type=ANY(${sql.param([...PHOTO_TYPES])}::text[])
		AND ${sql.raw(f)}.upload_key='evry-attachment/'||${conversation}||'/'||${sql.raw(f)}.id`;

export function claimStagedPhoto(tx: WriteTx, plant: string, id: string) {
	return tx.execute(sql`UPDATE file_object f SET purpose='person_photo',state='ready',revision=f.revision+1
		WHERE f.id=${id}::uuid AND f.tenant_id=${plant}::uuid AND f.purpose='assistant_staging' AND f.state='pending'
			AND f.expires_at>clock_timestamp() AND f.sha256 IS NOT NULL AND f.byte_count IS NOT NULL
			AND f.media_type=ANY(${sql.param([...PHOTO_TYPES])}::text[]) AND f.upload_key LIKE 'evry-attachment/%'`);
}
