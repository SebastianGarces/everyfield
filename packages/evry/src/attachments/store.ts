import type { Database } from "@everyfield/db/client";
import { sql, type SqlLiteral } from "@everyfield/db/query";
import { readPrivateUpload, signPrivatePut, type PrivateStorage } from "@everyfield/db/schema";
import { IMPORT_BYTES_MAX, IMPORT_TOO_LARGE } from "@everyfield/contracts/documents";
import { liveRead } from "@everyfield/domain/access";
import { queueJobsFor } from "@everyfield/domain/jobs";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { EvryActor } from "../context/actor.ts";
import { currentAuthority } from "../context/authority.ts";
import { EvryRefusal } from "../context/errors.ts";

export const ATTACHMENTS = { bytes: IMPORT_BYTES_MAX, perTurn: 10, stagingHours: 24 } as const;
const MEDIA = {
	csv: "text/csv",
	txt: "text/plain",
	docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
	doc: "application/msword",
} as const;
export const extensionOf = (name: string) => /\.(csv|txt|docx|doc)$/i.exec(name)?.[1]?.toLowerCase() as keyof typeof MEDIA;

const stageInput = z.strictObject({
	name: z
		.string()
		.trim()
		.min(1)
		.max(200)
		.regex(/\.(csv|txt|docx|doc)$/i),
	byteLength: z.int().min(1).max(ATTACHMENTS.bytes),
});
export const attachment = z.strictObject({ id: z.uuid(), name: stageInput.shape.name });

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
	const media = MEDIA[extensionOf(input.name)];
	const id = randomUUID();
	const key = `private/${actor.owner.id}/${id}`;
	const r = await db.execute(sql`WITH c AS (
			SELECT c.id,c.tenant_id FROM conversation c WHERE c.id=${conversationId}::uuid AND c.account_id=${actor.accountId}::uuid
				AND c.tenant_id=${actor.owner.id}::uuid AND ${currentAuthority(actor)}
		), upload AS (
			INSERT INTO file_object(id,tenant_id,purpose,opaque_key,media_type,max_bytes,state,upload_key,claim_generation,expires_at)
			SELECT ${id}::uuid,c.tenant_id,'assistant_staging',${key}::text,${media}::text,${input.byteLength}::bigint,'pending',
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
	const signed = await signPrivatePut(storage, key, media, input.byteLength).catch(() => {
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
	const object = await readPrivateUpload(storage, row.key, ATTACHMENTS.bytes);
	if (object === "too_large") throw new EvryRefusal("invalid_input", IMPORT_TOO_LARGE);
	if (object === "missing") throw new EvryRefusal("attachment_gone");
	return object.bytes;
}

export async function stagedBytes(
	db: Database,
	storage: PrivateStorage | null,
	tenantId: string,
	conversationId: string,
	attachmentId: string,
): Promise<Uint8Array | null> {
	const r = await db.execute(sql`SELECT f.opaque_key AS key FROM file_object f WHERE f.id=${attachmentId}::uuid
		AND f.tenant_id=${tenantId}::uuid AND f.purpose='assistant_staging'
		AND f.upload_key=${uploadKey(conversationId, attachmentId)}::text AND f.state='pending' AND f.expires_at>clock_timestamp()`);
	const key = (r.rows[0] as { key: string } | undefined)?.key;
	if (!key || !storage) return null;
	const object = await readPrivateUpload(storage, key, ATTACHMENTS.bytes);
	return typeof object === "string" ? null : object.bytes;
}

export async function attachedFile(db: Database, actor: EvryActor, conversationId: string | null, attachmentId: string) {
	if (!conversationId) throw new EvryRefusal("attachment_elsewhere");
	const r = await db.execute(sql`SELECT ${attachmentsOf("c")} AS attachments FROM conversation c
		WHERE c.id=${conversationId}::uuid AND c.account_id=${actor.accountId}::uuid AND c.tenant_id=${actor.owner.id}::uuid`);
	const file = z
		.array(attachmentState)
		.parse(r.rows[0]?.attachments ?? [])
		.find((a) => a.id === attachmentId);
	if (!file) throw new EvryRefusal("attachment_elsewhere");
	if (file.status === "gone") throw new EvryRefusal("attachment_gone");
	return file;
}

export const attachmentsOf = <C extends string>(c: SqlLiteral<C>) =>
	sql.raw(`coalesce((SELECT jsonb_agg(x ORDER BY x."attachedAt" DESC, x.id) FROM (
		SELECT DISTINCT ON (a.id) a.id,a.name,e.created_at AS "attachedAt",f.expires_at AS "availableUntil",
			(SELECT k.body->'result'->'rows'->0->'fields'->>'fileDigest' FROM conversation_event k WHERE k.conversation_id=${c}.id
				AND k.kind='tool_result' AND k.body->>'operation'='people.previewImport' AND k.body->'input'->>'attachmentId'=a.id::text
				ORDER BY k.sequence DESC LIMIT 1) AS "checkedDigest",
			CASE WHEN f.id IS NULL OR f.state<>'pending' OR f.expires_at<=clock_timestamp() THEN 'gone'
				WHEN EXISTS(SELECT FROM conversation_event l CROSS JOIN LATERAL jsonb_to_recordset(coalesce(l.body->'attachments','[]'::jsonb)) b(id uuid,name text)
					WHERE l.conversation_id=${c}.id AND l.kind='user_message' AND l.sequence>e.sequence AND lower(b.name)=lower(a.name) AND b.id<>a.id) THEN 'replaced'
				ELSE 'available' END AS status
		FROM conversation_event e CROSS JOIN LATERAL jsonb_to_recordset(coalesce(e.body->'attachments','[]'::jsonb)) a(id uuid,name text)
		LEFT JOIN file_object f ON f.id=a.id AND f.tenant_id=${c}.tenant_id AND ${staged("f", c)}
		WHERE e.conversation_id=${c}.id AND e.kind='user_message'
		ORDER BY a.id,e.sequence DESC LIMIT 64) x),'[]'::jsonb)`);

export const attachmentState = z.object({
	id: z.uuid(),
	name: z.string(),
	attachedAt: z.coerce.date(),
	availableUntil: z.coerce.date().nullable(),
	status: z.enum(["available", "replaced", "gone"]),
	checkedDigest: z.string().nullable(),
});
