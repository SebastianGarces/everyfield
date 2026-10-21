import * as c from "@everyfield/contracts/people";
import type { PeopleContext } from "@everyfield/contracts/people";
import type { Database } from "@everyfield/db/client";
import { and, eq, sql } from "@everyfield/db/query";
import {
	createAuthorizedDownload,
	putPrivateObject,
	validateCommitment,
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
	readReply,
	Refusal,
	reply,
	type Context,
	type Tx,
	type WriteContext,
} from "../core.ts";
import { expectRevision, plantId, queueObjectCleanup, readAuthority } from "../fields/shared.ts";
import {
	advance,
	attribution,
	nextRevision,
	notFuture,
	personUpdate,
	readHistory,
	recordEvent,
	recorderSql,
	subject,
	type Subject,
	receiptOf,
	replayed,
} from "../assessments/shared.ts";

const commitmentRow = z.object({
	id: z.uuid(),
	person_id: z.uuid(),
	occurred_on: z.string(),
	recorded_at: z.coerce.date(),
	actor_id: z.uuid().nullable(),
	revision: z.string(),
	kind: c.commitmentKind,
	witness_id: z.uuid().nullable(),
	witness_name: z.string().nullable(),
	external_witness: z.string().nullable(),
	notes: z.string().nullable(),
	media_type: c.commitmentMime.nullable(),
	byte_count: z.coerce.number().nullable(),
	voided_at: z.coerce.date().nullable(),
});
type CommitmentRow = z.infer<typeof commitmentRow>;
function commitmentView(plant: string, raw: unknown) {
	const r: CommitmentRow = commitmentRow.parse(raw);
	return c.commitment.parse({
		id: r.id,
		personId: r.person_id,
		occurredOn: r.occurred_on,
		recordedAt: r.recorded_at.toISOString(),
		actor: attribution(plant, r.id, r.actor_id),
		revision: r.revision,
		kind: r.kind,
		witness: r.witness_id
			? { kind: "person", personId: r.witness_id, displayName: r.witness_name }
			: r.external_witness
				? { kind: "external", text: r.external_witness }
				: null,
		notes: r.notes,
		document: r.media_type
			? { status: "attached", mediaType: r.media_type, byteCount: r.byte_count }
			: { status: "none" },
		voidedAt: r.voided_at?.toISOString() ?? null,
	});
}
const commitmentJson = sql`jsonb_build_object('id',r.id,'person_id',r.person_id,'occurred_on',r.signed_on::text,
 'recorded_at',r.recorded_at,'actor_id',${recorderSql("r")},'revision',r.revision::text,'kind',r.kind,
 'witness_id',r.witness_person_id,'witness_name',(SELECT w.display_name FROM person w WHERE w.id=r.witness_person_id),
 'external_witness',r.external_witness,'notes',r.notes,
 'media_type',(SELECT f.media_type FROM file_object f WHERE f.id=r.object_id),
 'byte_count',(SELECT f.byte_count FROM file_object f WHERE f.id=r.object_id),'voided_at',r.voided_at)`;
const latestFirst = sql`r.signed_on DESC,r.recorded_at DESC,r.id DESC`;

type State = Subject["commitment_state"];
const status = (state: State, effectiveOn: string | null, personRevision: string) =>
	c.commitmentStatus.parse({ state, effectiveOn, personRevision });
/**
 * REQ-PPL-014 and REQ-PPL-026: a card makes an unknown commitment active. After a withdrawal only a card signed after
 * the withdrawal date makes it active again; an older signature never overrides the withdrawal.
 */
function afterCard(p: Subject, signedOn: string): { state: State; effectiveOn: string | null } {
	if (p.commitment_state === "unknown") return { state: "active", effectiveOn: signedOn };
	if (p.commitment_state === "withdrawn" && signedOn > (p.commitment_effective_on ?? ""))
		return { state: "active", effectiveOn: signedOn };
	return { state: p.commitment_state, effectiveOn: p.commitment_effective_on };
}
const currentOf = (p: Subject) => ({ state: p.commitment_state, effectiveOn: p.commitment_effective_on });

/** The card and the Person's other valid cards, read with the locked Person. */
const cardRow = z.object({
	id: z.uuid(),
	person_id: z.uuid(),
	kind: c.commitmentKind,
	signed_on: z.string(),
	revision: z.string(),
	voided: z.boolean(),
	others: z.number(),
});

async function lifecycle(tx: Tx, ctx: WriteContext, raw: unknown, to: "withdrawn" | "active") {
	return reply(tx, async () => {
		const plant = plantId(ctx);
		const name = to === "withdrawn" ? "people.withdrawCommitment" : "people.reactivateCommitment";
		const input = parse(to === "withdrawn" ? c.withdrawCommitmentRequest : c.reactivateCommitmentRequest, raw);
		return c.commitmentLifecycleResult.parse(
			await mutation<unknown>(tx, ctx, name, input, async (_actor, receiptId, audit) => {
				const { personId, effectiveOn, reason } = input.input;
				const p = await subject(tx, ctx, personId);
				expectRevision(p.revision, input.expectedRevision);
				const from = to === "withdrawn" ? "active" : "withdrawn";
				if (p.commitment_state === to) {
					const value = {
						personId,
						current: status(to, p.commitment_effective_on, p.revision),
						outcome: "noop",
						receiptId,
					};
					return { value, subject: p.id, action: "people.updated", outcome: "noop" };
				}
				if (p.commitment_state !== from) deny("invalid_subject");
				// A dated change happens after the state it ends began, and not in the future. Stage never changes.
				notFuture(p, effectiveOn);
				if (effectiveOn < (p.commitment_effective_on ?? "")) deny("invalid_input");
				const set = { commitment_state: to, commitment_effective_on: effectiveOn };
				audit.writes.push(...personUpdate(tx, plant, p, set));
				const revision = nextRevision(p, set);
				return {
					value: { personId, current: status(to, effectiveOn, revision), outcome: "changed", receiptId },
					subject: p.id,
					action: "people.updated",
					before: { revision: p.revision, commitment: currentOf(p) },
					after: { revision, commitment: { state: to, effectiveOn } },
					reason,
					metadata: recordEvent(to === "withdrawn" ? "commitment_withdrawn" : "commitment_reactivated"),
				};
			}),
		);
	});
}

export const commitments = {
	/** The pending private object a commitment document uploads into, with its orphan cleanup, in one statement. */
	async requestCommitmentUpload(tx: Tx, ctx: WriteContext, raw: unknown) {
		return readReply(async () => {
			const plant = plantId(ctx);
			const input = parse(c.requestCommitmentUploadRequest, raw);
			await lockOwner(tx, ctx);
			await authorize(tx, ctx, true);
			await subject(tx, ctx, input.personId);
			const id = randomUUID();
			const result = await tx.execute(sql`WITH upload AS (
 INSERT INTO file_object(id,tenant_id,purpose,opaque_key,media_type,max_bytes,state,upload_key,claim_generation,expires_at)
 VALUES (${id}::uuid,${plant}::uuid,'commitment',${`private/${plant}/${randomUUID()}`},${input.mime},${input.byteLength},'pending',${id},0,clock_timestamp()+interval '15 minutes')
 RETURNING id,expires_at), cleanup AS (${queueObjectCleanup(tx, plant, id, "upload", sql`(SELECT expires_at FROM upload)`).getSQL()})
 SELECT expires_at FROM upload`);
			const expiresAt = z.coerce.date().parse(result.rows[0]?.expires_at).toISOString();
			return c.commitmentUploadResult.parse({ uploadId: id, expiresAt });
		});
	},
	/**
	 * REQ-PPL-014: the card, its witness and document, the Core Group advance of an earlier stage and the commitment state
	 * change are one statement with one audit row. A missing, failed, expired or already attached upload records nothing.
	 */
	async createCommitment(tx: Tx, ctx: WriteContext, raw: unknown) {
		return reply(tx, async () => {
			const plant = plantId(ctx);
			const input = parse(c.createCommitmentRequest, raw);
			let fresh: unknown;
			const stored = await mutation<unknown>(
				tx,
				ctx,
				"people.createCommitment",
				input,
				async (actor, receiptId, audit) => {
					const k = input.input;
					const witnessId = k.witness && "personId" in k.witness ? k.witness.personId : null;
					if (witnessId === k.personId) deny("invalid_subject");
					const p = await subject(
						tx,
						ctx,
						k.personId,
						sql`jsonb_build_object(
 'witness',(SELECT w.display_name FROM person w WHERE w.id=${witnessId}::uuid AND w.tenant_id=${plant}::uuid AND w.plant_id=${plant}::uuid AND w.state='live'),
 'upload',(SELECT jsonb_build_object('media_type',f.media_type,'byte_count',f.byte_count) FROM file_object f
   WHERE f.id=${k.documentUploadId}::uuid AND f.tenant_id=${plant}::uuid AND f.purpose='commitment' AND f.state='ready'
   AND f.expires_at>clock_timestamp() AND NOT file_is_referenced(f.id)))`,
					);
					notFuture(p, k.occurredOn);
					const found = z
						.object({
							witness: z.string().nullable(),
							upload: z.object({ media_type: c.commitmentMime, byte_count: z.coerce.number() }).nullable(),
						})
						.parse(p.extra);
					// Only a live same-church witness, and only this church's own verified upload.
					if (witnessId && found.witness === null) deny();
					if (k.documentUploadId && !found.upload) deny();
					const id = randomUUID();
					const step = advance(p, "core_group");
					const current = afterCard(p, k.occurredOn);
					const set = {
						...step.set,
						...(current.state !== p.commitment_state || current.effectiveOn !== p.commitment_effective_on
							? { commitment_state: current.state, commitment_effective_on: current.effectiveOn }
							: {}),
					};
					audit.writes.push(
						tx.insert(tables.commitment).values({
							id,
							plant_id: plant,
							person_id: p.id,
							kind: k.kind,
							signed_on: k.occurredOn,
							recorded_at: p.now,
							witness_person_id: witnessId,
							external_witness: k.witness && "external" in k.witness ? k.witness.external : null,
							object_id: k.documentUploadId,
							notes: k.notes,
						}),
						...personUpdate(tx, plant, p, set),
					);
					const revision = nextRevision(p, set);
					const stage = step.change?.to ?? p.stage;
					const value = {
						commitment: commitmentView(plant, {
							id,
							person_id: p.id,
							occurred_on: k.occurredOn,
							recorded_at: p.now,
							actor_id: actor,
							revision: "1",
							kind: k.kind,
							witness_id: witnessId,
							witness_name: found.witness,
							external_witness: k.witness && "external" in k.witness ? k.witness.external : null,
							notes: k.notes,
							media_type: found.upload?.media_type ?? null,
							byte_count: found.upload?.byte_count ?? null,
							voided_at: null,
						}),
						person: { personId: p.id, stage, revision, stageChange: step.change },
						current: status(current.state, current.effectiveOn, revision),
						outcome: "changed",
						receiptId,
					};
					fresh = value;
					return {
						value: receiptOf(value, "commitment", id),
						subject: p.id,
						action: "people.recorded",
						before: { revision: p.revision, stage: p.stage, commitment: currentOf(p) },
						after: { revision, stage, commitment: current },
						metadata: recordEvent("commitment_recorded", id),
					};
				},
			);
			// A retry rebuilds the private record from its row; central audit holds only the receipt.
			return c.commitmentMutationResult.parse(
				fresh ?? (await replayed(tx, plant, stored, "commitment", sql`commitment`, commitmentJson, commitmentView)),
			);
		});
	},
	async withdrawCommitment(tx: Tx, ctx: WriteContext, raw: unknown) {
		return lifecycle(tx, ctx, raw, "withdrawn");
	},
	async reactivateCommitment(tx: Tx, ctx: WriteContext, raw: unknown) {
		return lifecycle(tx, ctx, raw, "active");
	},
	/**
	 * REQ-PPL-015 and REQ-PPL-026: correct a card's signed date or kind, or void a card that was never genuine, with a
	 * reason and its old and new values in the history. First acquisition follows the valid cards. Voiding the last valid
	 * card makes the current commitment unknown. Stage never changes.
	 */
	async correctCommitmentLifecycle(tx: Tx, ctx: WriteContext, raw: unknown) {
		return reply(tx, async () => {
			const plant = plantId(ctx);
			const input = parse(c.correctCommitmentRequest, raw);
			return c.commitmentLifecycleResult.parse(
				await mutation<unknown>(tx, ctx, "people.correctCommitmentLifecycle", input, async (_a, receiptId, audit) => {
					const { commitmentId, correction, reason } = input.input;
					const card = sql`(SELECT k.person_id FROM commitment k WHERE k.id=${commitmentId}::uuid AND k.plant_id=${plant}::uuid)`;
					const p = await subject(
						tx,
						ctx,
						card,
						sql`(SELECT jsonb_build_object('id',k.id,'person_id',k.person_id,'kind',k.kind,'signed_on',k.signed_on::text,
 'revision',k.revision::text,'voided',k.voided_at IS NOT NULL,'others',(SELECT count(*)::int FROM commitment o
 WHERE o.person_id=k.person_id AND o.plant_id=k.plant_id AND o.id<>k.id AND o.voided_at IS NULL))
 FROM commitment k WHERE k.id=${commitmentId}::uuid AND k.plant_id=${plant}::uuid)`,
					);
					const k = cardRow.parse(p.extra);
					expectRevision(k.revision, input.expectedRevision);
					if (k.voided) deny("invalid_subject");
					const before = { id: k.id, occurredOn: k.signed_on, kind: k.kind, voided: false };
					const after =
						correction.action === "void"
							? { ...before, voided: true }
							: { ...before, occurredOn: correction.occurredOn ?? k.signed_on, kind: correction.kind ?? k.kind };
					if (correction.action === "correct") notFuture(p, after.occurredOn);
					audit.writes.push(
						tx
							.update(tables.commitment)
							.set({
								signed_on: after.occurredOn,
								kind: after.kind,
								...(after.voided ? { voided_at: p.now } : {}),
								revision: sql`${tables.commitment.revision}+1`,
							})
							.where(and(eq(tables.commitment.id, k.id), eq(tables.commitment.plant_id, plant))),
					);
					const none = after.voided && k.others === 0;
					const set = none ? { commitment_state: "unknown" as const, commitment_effective_on: null } : {};
					audit.writes.push(...personUpdate(tx, plant, p, set));
					const revision = nextRevision(p, set);
					const current = none ? { state: "unknown" as const, effectiveOn: null } : currentOf(p);
					return {
						value: {
							personId: p.id,
							current: status(current.state, current.effectiveOn, revision),
							outcome: "changed",
							receiptId,
						},
						subject: p.id,
						action: "people.corrected",
						before: { revision: p.revision, commitment: before, current: currentOf(p) },
						after: { revision, commitment: after, current },
						reason,
						metadata: recordEvent("commitment_corrected", k.id),
					};
				}),
			);
		});
	},
	async getCommitments(tx: Tx, ctx: Context, raw: unknown) {
		return readReply(async () => {
			const input = parse(c.personRecordsRequest, raw);
			const h = await readHistory(
				tx,
				ctx,
				input,
				sql`commitment`,
				commitmentJson,
				latestFirst,
				sql`jsonb_build_object('state',p.commitment_state,'effective_on',p.commitment_effective_on::text,'revision',p.revision::text,
 'first',(SELECT jsonb_build_object('id',k.id,'on',k.signed_on::text) FROM commitment k WHERE k.person_id=p.id
   AND k.plant_id=p.plant_id AND k.voided_at IS NULL ORDER BY k.signed_on,k.recorded_at,k.id LIMIT 1))`,
			);
			const extra = z
				.object({
					state: z.enum(["active", "withdrawn", "unknown"]),
					effective_on: z.string().nullable(),
					revision: z.string(),
					first: z.object({ id: z.uuid(), on: z.string() }).nullable(),
				})
				.parse(h.extra);
			return c.commitmentsResult.parse({
				personId: input.personId,
				// Without a valid card the current commitment is unknown, whatever was recorded before.
				current: status(extra.first ? extra.state : "unknown", extra.first ? extra.effective_on : null, extra.revision),
				firstAcquisition: extra.first
					? { status: "known", occurredOn: extra.first.on, evidenceId: extra.first.id }
					: { status: "none" },
				latest: h.latest ? commitmentView(h.plant, h.latest) : null,
				items: h.items.map((r) => commitmentView(h.plant, r)),
				next: h.next,
				total: h.total,
			});
		});
	},
};

/**
 * Current authority for one commitment document. Uploads need an administrator of the church. Reads need an Owner or
 * Admin whose session, seat and lifecycle are live in the same statement as the exact card that holds the object.
 */
function documentAuthority(ctx: PeopleContext, commitmentId?: string): ResourceAuthorizer {
	return async (tx, file, intent) => {
		if (intent === "cleanup" || file.purpose !== "commitment" || file.tenant_id !== ctx.selected.id) return null;
		if (intent === "read") {
			const [current] = await tx
				.select({ actorId: sql<string>`(SELECT i.account_id FROM access_session(${ctx.session}::uuid) i)` })
				.from(tables.commitment)
				.where(
					and(
						eq(tables.commitment.id, commitmentId ?? ""),
						eq(tables.commitment.plant_id, file.tenant_id),
						eq(tables.commitment.object_id, file.id),
						readAuthority(ctx, true),
					),
				);
			return current ? { kind: "account", actorId: current.actorId } : null;
		}
		try {
			return { kind: "account", actorId: (await authorize(tx, ctx, true)).accountId };
		} catch (error) {
			if (error instanceof Refusal) return null;
			throw error;
		}
	};
}

/** The byte adapter: verify the PDF, JPG or PNG and store it privately before createCommitment attaches it. */
export async function uploadCommitmentDocument(
	db: Database,
	storage: PrivateStorage,
	ctx: PeopleContext,
	raw: unknown,
) {
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
						eq(tables.file_object.purpose, "commitment"),
						eq(tables.file_object.state, "pending"),
					),
				)
				.for("update");
			if (!pending) deny();
			// A failed upload changes nothing: the object stays pending and its cleanup removes it.
			if (input.bytes.length !== Number(pending.max_bytes)) deny("invalid_input");
			await validateCommitment(input.bytes, pending.media_type).catch(() => deny("invalid_input"));
			await tx
				.update(tables.file_object)
				.set({ byte_count: String(input.bytes.length), sha256: createHash("sha256").update(input.bytes).digest("hex") })
				.where(eq(tables.file_object.id, pending.id));
			return pending;
		});
		await putPrivateObject(db, storage, documentAuthority(ctx), {
			tenantId: plant,
			purpose: "commitment",
			mediaType: file.media_type,
			bytes: input.bytes,
			uploadKey: file.upload_key,
		}).catch(() => deny());
		return { uploadId: file.id };
	});
}

/**
 * REQ-KNOW-080: a five-minute signed link to the exact document object, issued only after the live authority check and
 * checked again after signing. A link already issued may work until it expires; no new link outlives revoked access.
 */
export async function getCommitmentDownload(db: Database, storage: PrivateStorage, ctx: PeopleContext, raw: unknown) {
	return readReply(async () => {
		const plant = plantId(ctx);
		const input = parse(c.commitmentDownloadRequest, raw);
		const [card] = await db
			.select({ objectId: tables.commitment.object_id })
			.from(tables.commitment)
			.where(
				and(
					eq(tables.commitment.id, input.commitmentId),
					eq(tables.commitment.plant_id, plant),
					readAuthority(ctx, true),
				),
			);
		if (!card?.objectId) deny();
		const link = await createAuthorizedDownload(
			db,
			storage,
			documentAuthority(ctx, input.commitmentId),
			card.objectId,
		).catch(() => deny());
		return c.commitmentDownloadResult.parse(link);
	});
}
