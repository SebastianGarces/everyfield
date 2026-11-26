import type { Database } from "@everyfield/db/client";
import { sql, type SQL, type SqlLiteral } from "@everyfield/db/query";
import {
	privateObjectPath,
	readPrivateUpload,
	signPrivatePut,
	type ObjectPath,
	type PrivateStorage,
} from "@everyfield/db/schema";
import { IMPORT_BYTES_MAX, IMPORT_TOO_LARGE } from "@everyfield/contracts/documents";
import { liveRead, type WriteTx } from "@everyfield/domain/access";
import { queueJobsFor } from "@everyfield/domain/jobs";
import { randomUUID } from "node:crypto";
import { COMMITMENT_MAX_BYTES } from "@everyfield/contracts/people";
import { z } from "zod";
import { accountContext, plantAdmin } from "../adapters/native.ts";
import type { EvryActor } from "../context/actor.ts";
import { currentAuthority, discoveryChat, discoveryHeld } from "../context/authority.ts";
import { EvryRefusal } from "../context/errors.ts";

export const ATTACHMENTS = {
	bytes: IMPORT_BYTES_MAX,
	photoBytes: 5 * 1024 * 1024,
	perTurn: 10,
	stagingHours: 24,
} as const;
const STAGING = "assistant_staging";
const photo = (mediaType: string) => ({ mediaType, purpose: STAGING, bytes: ATTACHMENTS.photoBytes });
const KINDS = {
	csv: { mediaType: "text/csv", purpose: STAGING, bytes: ATTACHMENTS.bytes },
	txt: { mediaType: "text/plain", purpose: STAGING, bytes: ATTACHMENTS.bytes },
	docx: {
		mediaType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
		purpose: STAGING,
		bytes: ATTACHMENTS.bytes,
	},
	doc: { mediaType: "application/msword", purpose: STAGING, bytes: ATTACHMENTS.bytes },
	pdf: { mediaType: "application/pdf", purpose: "commitment", bytes: COMMITMENT_MAX_BYTES },
	jpg: photo("image/jpeg"),
	jpeg: photo("image/jpeg"),
	png: photo("image/png"),
	webp: photo("image/webp"),
} as const;
const FILE_NAME = /\.(csv|txt|docx|doc|pdf|jpe?g|png|webp)$/i;
const PHOTO_TYPES = ["image/jpeg", "image/png", "image/webp"] as const;
export const PHOTO_NAME = /\.(jpe?g|png|webp)$/i;
export const extensionOf = (name: string) => FILE_NAME.exec(name)?.[1]?.toLowerCase() as keyof typeof KINDS;
const kindOf = (name: string) => KINDS[extensionOf(name)];

const stageInput = z
	.strictObject({
		name: z.string().trim().min(1).max(200).regex(FILE_NAME),
		byteLength: z.int().min(1),
	})
	.refine((v) => extensionOf(v.name) !== undefined && v.byteLength <= kindOf(v.name).bytes);
export const attachment = z.strictObject({ id: z.uuid(), name: stageInput.shape.name });

const uploadKey = (conversationId: string, id: string) => `evry-attachment/${conversationId}/${id}`;
const staged = <F extends string, C extends string>(f: SqlLiteral<F>, c: SqlLiteral<C>) =>
	`${f}.purpose IN ('assistant_staging','commitment') AND ${f}.upload_key='evry-attachment/'||${c}.id||'/'||${f}.id`;
export const stagedIn = <F extends string, C extends string>(f: SqlLiteral<F>, c: SqlLiteral<C>) =>
	sql.raw(staged(f, c));
const DOCUMENT_FILES: readonly (keyof typeof KINDS)[] = ["txt", "docx", "doc"];
const canAttach = (actor: EvryActor, name: string) =>
	plantAdmin(actor) || (accountContext(actor) && DOCUMENT_FILES.includes(extensionOf(name)));

export async function stageAttachment(
	db: Database,
	storage: PrivateStorage | null,
	actor: EvryActor,
	conversationId: string,
	raw: unknown,
) {
	const parsed = z.strictObject({ id: z.uuid(), input: stageInput }).safeParse({ id: conversationId, input: raw });
	if (!parsed.success) throw new EvryRefusal("invalid_input");
	if (!storage || !canAttach(actor, parsed.data.input.name)) throw new EvryRefusal("access_denied");
	const { input } = parsed.data;
	const kind = kindOf(input.name);
	const id = randomUUID();
	const key = privateObjectPath(actor.owner.id, id);
	const r = await db.execute(sql`WITH c AS (
			SELECT c.id,c.tenant_id FROM conversation c WHERE c.id=${conversationId}::uuid AND c.account_id=${actor.accountId}::uuid
				AND c.tenant_id=${actor.owner.id}::uuid AND ${currentAuthority(actor)} AND NOT ${discoveryChat("c")}
		), upload AS (
			INSERT INTO file_object(id,tenant_id,purpose,opaque_key,media_type,max_bytes,state,upload_key,claim_generation,expires_at)
			SELECT ${id}::uuid,c.tenant_id,${kind.purpose}::text,${key}::text,${kind.mediaType}::text,${input.byteLength}::bigint,'pending',
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
		SELECT (SELECT id FROM upload) AS id, ${discoveryHeld(actor, sql`${conversationId}::uuid`)} AS discovery`);
	const row = r.rows[0] as { id: string | null; discovery: boolean };
	if (row.discovery) throw new EvryRefusal("discovery_read_only");
	if (!row.id) throw new EvryRefusal("not_found");
	const signed = await signPrivatePut(storage, key, kind.mediaType, input.byteLength).catch(() => {
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
	const row = r.rows[0] as { key: ObjectPath; live: boolean } | undefined;
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
	const key = (r.rows[0] as { key: ObjectPath } | undefined)?.key;
	if (!key || !storage) return null;
	const object = await readPrivateUpload(storage, key, ATTACHMENTS.bytes);
	return typeof object === "string" ? null : object.bytes;
}

export async function attachedFile(
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
			CASE WHEN f.purpose='person_photo' THEN 'used'
				WHEN f.purpose NOT IN ('assistant_staging','commitment') OR f.state<>'pending' OR f.expires_at<=clock_timestamp() THEN 'gone'
				WHEN EXISTS(SELECT FROM conversation_event l CROSS JOIN LATERAL jsonb_to_recordset(coalesce(l.body->'attachments','[]'::jsonb)) b(id uuid,name text)
					WHERE l.conversation_id=${c}.id AND l.kind='user_message' AND l.sequence>e.sequence AND lower(b.name)=lower(a.name) AND b.id<>a.id) THEN 'replaced'
				ELSE 'available' END AS status
		FROM conversation_event e CROSS JOIN LATERAL jsonb_to_recordset(coalesce(e.body->'attachments','[]'::jsonb)) a(id uuid,name text)
		LEFT JOIN file_object f ON f.id=a.id AND f.tenant_id=${c}.tenant_id AND f.upload_key='evry-attachment/'||${c}.id||'/'||f.id
		WHERE e.conversation_id=${c}.id AND e.kind='user_message'
		ORDER BY a.id,e.sequence DESC LIMIT 64) x),'[]'::jsonb)`);

export const attachmentState = z.strictObject({
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
	const file = await attachedFile(db, actor, conversationId, attachmentId);
	if (!PHOTO_NAME.test(file.name)) throw new EvryRefusal("attachment_elsewhere");
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

export type StagedStatus = z.infer<typeof attachmentState>["status"];
export async function stagedFile(
	db: Pick<Database, "execute">,
	tenantId: string,
	conversationId: string,
	attachmentId: string,
): Promise<{ name: string; status: StagedStatus } | null> {
	const r = await db.execute(sql`SELECT x->>'name' AS name,
			CASE WHEN f.id IS NOT NULL AND file_is_referenced(f.id) THEN 'used' ELSE x->>'status' END AS status
		FROM conversation c CROSS JOIN LATERAL jsonb_array_elements(${attachmentsOf("c")}) x
		LEFT JOIN file_object f ON f.id=(x->>'id')::uuid AND f.tenant_id=c.tenant_id
		WHERE c.id=${conversationId}::uuid AND c.tenant_id=${tenantId}::uuid AND x->>'id'=${attachmentId}::text`);
	return (
		z
			.strictObject({ name: z.string(), status: z.enum(["available", "replaced", "gone", "used"]) })
			.optional()
			.parse(r.rows[0]) ?? null
	);
}
