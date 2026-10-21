import * as f from "@everyfield/contracts/people";
import type { PeopleContext } from "@everyfield/contracts/people";
import type { Database } from "@everyfield/db/client";
import { and, eq, sql } from "@everyfield/db/query";
import {
	putPrivateObject,
	readAuthorizedObject,
	validateAvatar,
	type PrivateStorage,
	type ResourceAuthorizer,
} from "@everyfield/db/schema";
import * as tables from "@everyfield/db/tables";
import { createHash, randomUUID } from "node:crypto";
import "server-only";
import { z } from "zod";
import {
	authorize,
	deny,
	lockOwner,
	mutation,
	parse,
	authorizeRead,
	readReply,
	Refusal,
	reply,
	type Context,
	type Tx,
	type WriteContext,
} from "../core.ts";
import { households } from "../households/index.ts";
import { tagsAndSkills } from "../tags-skills/index.ts";
import { expectRevision, livePerson, next, personFacts, plantId, queueObjectCleanup } from "./shared.ts";

/**
 * The person photo (REQ-PPL-005) uses the shared private-object flow, like the account avatar: a pending object, verified
 * bytes stored privately, then one write that points the Person at the exact version. Only people who can see the live
 * Person read the bytes, through the app; there is no storage link.
 */
const photo = {
	async requestPersonPhotoUpload(tx: Tx, ctx: WriteContext, raw: unknown) {
		return readReply(async () => {
			const plant = plantId(ctx);
			const input = parse(f.requestPhotoUploadRequest, raw);
			await lockOwner(tx, ctx);
			await authorize(tx, ctx, true);
			livePerson(await personFacts(tx, plant, input.personId));
			const id = randomUUID();
			// The object and its orphan cleanup are one statement: an upload never finalized is removed after expiry.
			const result = await tx.execute(sql`WITH upload AS (
 INSERT INTO file_object(id,tenant_id,purpose,opaque_key,media_type,max_bytes,state,upload_key,claim_generation,expires_at)
 VALUES (${id}::uuid,${plant}::uuid,'person_photo',${`private/${plant}/${randomUUID()}`},${input.mime},${input.byteLength},'pending',${id},0,clock_timestamp()+interval '15 minutes')
 RETURNING id,expires_at), cleanup AS (${queueObjectCleanup(tx, plant, id, "upload", sql`(SELECT expires_at FROM upload)`).getSQL()})
 SELECT expires_at FROM upload`);
			const expiresAt = z.coerce.date().parse(result.rows[0]?.expires_at).toISOString();
			return f.photoUploadResult.parse({ uploadId: id, expiresAt });
		});
	},
	async setPersonPhoto(tx: Tx, ctx: WriteContext, raw: unknown) {
		return reply(tx, async () => {
			const plant = plantId(ctx);
			const input = parse(f.setPersonPhotoRequest, raw);
			return f.photoMutationResult.parse(
				await mutation<unknown>(tx, ctx, "people.setPersonPhoto", input, async (_actor, receiptId, audit) => {
					const { personId, uploadId } = input.input;
					// Only this church's own verified, unexpired, unclaimed upload can become the photo. One read with the Person.
					const p = await personFacts(
						tx,
						plant,
						personId,
						sql`EXISTS(SELECT FROM file_object f WHERE f.id=${uploadId}::uuid AND f.tenant_id=${plant}::uuid
 AND f.purpose='person_photo' AND f.state='ready' AND f.expires_at>clock_timestamp()
 AND NOT EXISTS(SELECT FROM person o WHERE o.photo_object_id=f.id))`,
					);
					livePerson(p);
					expectRevision(p.revision, input.expectedRevision);
					const available = { status: "available", personId, versionId: uploadId };
					if (p.photo_object_id === uploadId) {
						const value = { photo: available, personRevision: p.revision, outcome: "noop", receiptId };
						return { value, subject: p.id, action: "people.updated", outcome: "noop" };
					}
					if (p.extra !== true) deny();
					audit.writes.push(
						tx
							.update(tables.person)
							.set({ photo_object_id: uploadId, revision: sql`${tables.person.revision}+1` })
							.where(and(eq(tables.person.id, p.id), eq(tables.person.revision, p.revision))),
					);
					if (p.photo_object_id) audit.writes.push(queueObjectCleanup(tx, plant, p.photo_object_id, "release"));
					return {
						value: { photo: available, personRevision: next(p.revision), outcome: "changed", receiptId },
						subject: p.id,
						action: "people.updated",
						before: { revision: p.revision, photo: p.photo_object_id },
						after: { revision: next(p.revision), photo: uploadId },
					};
				}),
			);
		});
	},
	async removePersonPhoto(tx: Tx, ctx: WriteContext, raw: unknown) {
		return reply(tx, async () => {
			const plant = plantId(ctx);
			const input = parse(f.removePersonPhotoRequest, raw);
			return f.photoMutationResult.parse(
				await mutation<unknown>(tx, ctx, "people.removePersonPhoto", input, async (_actor, receiptId, audit) => {
					const p = await personFacts(tx, plant, input.input.personId);
					livePerson(p);
					expectRevision(p.revision, input.expectedRevision);
					if (!p.photo_object_id) {
						const value = { photo: { status: "absent" }, personRevision: p.revision, outcome: "noop", receiptId };
						return { value, subject: p.id, action: "people.updated", outcome: "noop" };
					}
					audit.writes.push(
						tx
							.update(tables.person)
							.set({ photo_object_id: null, revision: sql`${tables.person.revision}+1` })
							.where(and(eq(tables.person.id, p.id), eq(tables.person.revision, p.revision))),
						queueObjectCleanup(tx, plant, p.photo_object_id, "release"),
					);
					return {
						value: { photo: { status: "absent" }, personRevision: next(p.revision), outcome: "changed", receiptId },
						subject: p.id,
						action: "people.updated",
						before: { revision: p.revision, photo: p.photo_object_id },
						after: { revision: next(p.revision), photo: null },
					};
				}),
			);
		});
	},
	async getPersonPhoto(tx: Tx, ctx: Context, raw: unknown) {
		return readReply(async () => {
			const plant = plantId(ctx);
			const input = parse(f.personFieldsRequest, raw);
			const { gate } = await authorizeRead(tx, ctx);
			const p = await personFacts(tx, plant, input.personId, undefined, gate);
			// A retired or merged Person's photo is unavailable (REQ-PPL-005).
			livePerson(p);
			return f.personPhotoResult.parse(
				p.photo_object_id
					? { status: "available", personId: p.id, versionId: p.photo_object_id }
					: { status: "absent" },
			);
		});
	},
};

/** Every household, tag, skill and photo operation, named as its catalog operation people.<name>. */
export const personFields = { ...households, ...tagsAndSkills, ...photo };

/**
 * Current authority for one person-photo object. Uploads need an administrator of the church; reads need a reader of the
 * church and the exact current photo of a live Person. Cleanup is the worker's, never a request's.
 */
function photoAuthority(ctx: PeopleContext, read?: { personId: string }): ResourceAuthorizer {
	return async (tx, file, intent) => {
		if (intent === "cleanup" || file.purpose !== "person_photo" || file.tenant_id !== ctx.selected.id) return null;
		try {
			if (intent !== "read") return { kind: "account", actorId: (await authorize(tx, ctx, true)).accountId };
			// C13 and C22: the live access check runs in the same statement as the exact current photo, on every pass the
			// storage layer makes, and holds no session lock.
			const { actor, gate } = await authorizeRead(tx, ctx);
			const [current] = await tx
				.select({ id: tables.person.id })
				.from(tables.person)
				.where(
					and(
						eq(tables.person.id, read?.personId ?? ""),
						eq(tables.person.tenant_id, file.tenant_id),
						eq(tables.person.state, "live"),
						eq(tables.person.photo_object_id, file.id),
						gate,
					),
				);
			return current ? { kind: "account", actorId: actor.accountId } : null;
		} catch (error) {
			if (error instanceof Refusal) return null;
			throw error;
		}
	};
}

/** The byte adapter: verify the image and store it privately before setPersonPhoto points the Person at it. */
export async function uploadPersonPhoto(db: Database, storage: PrivateStorage, ctx: PeopleContext, raw: unknown) {
	return readReply(async () => {
		const plant = plantId(ctx);
		const input = parse(z.object({ uploadId: z.uuid(), bytes: z.instanceof(Uint8Array) }), raw);
		const file = await db.transaction(async (tx) => {
			await authorize(tx, ctx, true);
			const [pending] = await tx
				.select()
				.from(tables.file_object)
				.where(
					and(
						eq(tables.file_object.id, input.uploadId),
						eq(tables.file_object.tenant_id, plant),
						eq(tables.file_object.purpose, "person_photo"),
						eq(tables.file_object.state, "pending"),
					),
				)
				.for("update");
			if (!pending) deny();
			// A failed upload changes nothing: the Person keeps its current photo.
			if (input.bytes.length !== Number(pending.max_bytes)) deny("invalid_input");
			await validateAvatar(input.bytes, pending.media_type).catch(() => deny("invalid_input"));
			await tx
				.update(tables.file_object)
				.set({ byte_count: String(input.bytes.length), sha256: createHash("sha256").update(input.bytes).digest("hex") })
				.where(eq(tables.file_object.id, pending.id));
			return pending;
		});
		await putPrivateObject(db, storage, photoAuthority(ctx), {
			tenantId: plant,
			purpose: "person_photo",
			mediaType: file.media_type,
			bytes: input.bytes,
			uploadKey: file.upload_key,
		}).catch(() => deny());
		return { uploadId: file.id };
	});
}

const signatures = [
	["image/png", [0x89, 0x50, 0x4e, 0x47]],
	["image/jpeg", [0xff, 0xd8, 0xff]],
	["image/webp", [0x52, 0x49, 0x46, 0x46]],
] as const;
/** The exact current photo version of a live Person the reader can see, as bytes for the app's own route. */
export async function readPersonPhoto(db: Database, storage: PrivateStorage, ctx: PeopleContext, raw: unknown) {
	return readReply(async () => {
		plantId(ctx);
		const input = parse(z.object({ personId: z.uuid(), versionId: z.uuid() }), raw);
		const bytes = await readAuthorizedObject(db, storage, photoAuthority(ctx, input), input.versionId).catch(() =>
			deny(),
		);
		const mediaType = signatures.find(([, magic]) => magic.every((b, i) => bytes[i] === b))?.[0];
		if (!mediaType) deny();
		return { bytes, mediaType };
	});
}
