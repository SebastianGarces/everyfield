import * as c from "@everyfield/contracts/people";
import type { PeopleContext } from "@everyfield/contracts/people";
import type { Database } from "@everyfield/db/client";
import { and, eq, sql } from "@everyfield/db/query";
import {
	createAuthorizedDownload,
	readPrivateObject,
	signPrivatePut,
	validateCommitment,
	warmCommitmentParser,
	type PrivateStorage,
	type ResourceAuthorizer,
} from "@everyfield/db/schema";
import * as tables from "@everyfield/db/tables";
import { createHash, randomUUID } from "node:crypto";
import "server-only";
import { z } from "zod";
import { writeVisibility, type RequestActor } from "../../access/session.ts";
import { lastWrite } from "../../operations/writes.ts";
import {
	authorizeCachedWrite,
	deny,
	mutation,
	parse,
	PeopleReadContext,
	readReply,
	reply,
	withPeopleWrite,
	type Context,
	type Tx,
	type WriteContext,
} from "../core.ts";
import { expectRevision, plantId } from "../fields/shared.ts";
import {
	adminRead,
	advance,
	attribution,
	historyJson,
	nextRevision,
	notFuture,
	personUpdate,
	readHistory,
	type History,
	type HistoryPage,
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
			? { kind: "person", personId: r.witness_id }
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
 'witness_id',r.witness_person_id,
 'external_witness',r.external_witness,'notes',r.notes,
 'media_type',(SELECT f.media_type FROM file_object f WHERE f.id=r.object_id),
 'byte_count',(SELECT f.byte_count FROM file_object f WHERE f.id=r.object_id),'voided_at',r.voided_at)`;
const latestFirst = sql`r.signed_on DESC,r.recorded_at DESC,r.id DESC`;

/** A retried create returns the card as saved: revision 1, its original date and kind, not voided. */
function asSaved(replay: Record<string, unknown>) {
	const { card, ...rest } = z
		.looseObject({ card: z.object({ occurredOn: z.string(), kind: c.commitmentKind }), commitment: z.looseObject({}) })
		.parse(replay);
	return { ...rest, commitment: { ...rest.commitment, ...card, revision: "1", voidedAt: null } };
}
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

const commitmentState = z.object({
	state: z.enum(["active", "withdrawn", "unknown"]),
	effectiveOn: z.string().nullable(),
});
/**
 * The card, the signed dates of the Person's other valid cards and, when recording the card made the commitment
 * active, the commitment it replaced (from its `people.recorded` audit row), read with the locked Person.
 */
const cardRow = z.object({
	id: z.uuid(),
	person_id: z.uuid(),
	kind: c.commitmentKind,
	signed_on: z.string(),
	revision: z.string(),
	voided: z.boolean(),
	others: z.array(z.string()),
	replaced: commitmentState.nullable(),
});
/**
 * REQ-PPL-015 and REQ-PPL-026: the current commitment after the card that made it active is corrected or voided. The
 * earliest valid card that still makes it active decides; without one, the commitment that card replaced comes back.
 */
function reactivatedBy(replaced: z.infer<typeof commitmentState>, valid: string[]) {
	const since = valid.filter((d) => replaced.state !== "withdrawn" || d > (replaced.effectiveOn ?? "")).sort()[0];
	if (since) return { state: "active" as const, effectiveOn: since };
	return replaced.state === "withdrawn" ? replaced : { state: "unknown" as const, effectiveOn: null };
}

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

/**
 * A commitment document the server read back from the private bucket and verified (saveCommitmentDocument): its
 * upload, type, size and hash. Only a checked document attaches to a card.
 */
type CheckedDocument = {
	uploadId: string;
	mediaType: z.infer<typeof c.commitmentMime>;
	byteCount: number;
	sha256: string;
};

export const commitments = {
	/**
	 * REQ-PPL-014: the card, its witness and checked document, the Core Group advance of an earlier stage and the
	 * commitment state change are one write with one audit row. A missing, expired or already attached upload, a foreign
	 * witness or a future date records nothing and leaves the upload pending.
	 */
	async createCommitment(tx: Tx, ctx: WriteContext, raw: unknown, document: CheckedDocument | null = null) {
		return reply(tx, async () => {
			const plant = plantId(ctx);
			// A document's request names its upload, so a retry with another upload is a conflict, not a replay.
			const input = parse(document ? c.saveCommitmentDocumentRequest : c.createCommitmentRequest, raw);
			let fresh: unknown;
			const stored = await mutation<unknown>(
				tx,
				ctx,
				"people.createCommitment",
				input,
				async (actor, receiptId, audit) => {
					const k = input.input;
					const witnessId = k.witness && "personId" in k.witness ? k.witness.personId : null;
					const external = k.witness && "external" in k.witness ? k.witness.external : null;
					if (witnessId === k.personId) deny("invalid_subject");
					// The upload row stays locked until COMMIT, so no other save or cleanup can take it meanwhile.
					const p = await subject(
						tx,
						ctx,
						k.personId,
						sql`jsonb_build_object(
 'witness',(SELECT w.display_name FROM person w WHERE w.id=${witnessId}::uuid AND w.tenant_id=${plant}::uuid AND w.plant_id=${plant}::uuid AND w.state='live'),
 'upload',${
		document
			? sql`(SELECT f.id FROM file_object f WHERE f.id=${document.uploadId}::uuid AND f.tenant_id=${plant}::uuid
   AND f.purpose='commitment' AND f.state='pending' AND f.opaque_key=${documentKey(plant, document.uploadId)}::text
   AND f.expires_at>clock_timestamp() AND f.max_bytes=${String(document.byteCount)}::bigint
   AND f.media_type=${document.mediaType}::text AND NOT file_is_referenced(f.id) FOR UPDATE OF f)`
			: sql`NULL`
 })`,
					);
					notFuture(p, k.occurredOn);
					const found = z.object({ witness: z.string().nullable(), upload: z.uuid().nullable() }).parse(p.extra);
					// Only a live same-church witness, and only this church's own pending upload.
					if (witnessId && found.witness === null) deny();
					if (document && !found.upload) deny();
					const id = randomUUID();
					const step = advance(p, "core_group");
					const current = afterCard(p, k.occurredOn);
					const set = {
						...step.set,
						...(current.state !== p.commitment_state || current.effectiveOn !== p.commitment_effective_on
							? { commitment_state: current.state, commitment_effective_on: current.effectiveOn }
							: {}),
					};
					if (document)
						audit.writes.push(sql`UPDATE file_object SET state='ready',byte_count=${String(document.byteCount)}::bigint,
 sha256=${document.sha256}::text,revision=revision+1 WHERE id=${document.uploadId}::uuid AND tenant_id=${plant}::uuid`);
					// The card follows the upload's update: its trigger requires a ready object.
					audit.writes.push(
						sql`INSERT INTO commitment(id,plant_id,person_id,kind,signed_on,recorded_at,witness_person_id,external_witness,object_id,notes)
 SELECT ${id}::uuid,${plant}::uuid,${p.id}::uuid,${k.kind}::text,${k.occurredOn}::date,${p.now.toISOString()}::timestamptz,
 ${witnessId}::uuid,${external}::text,${document?.uploadId ?? null}::uuid,${k.notes}::text
 ${document ? sql`WHERE EXISTS(SELECT FROM ${lastWrite(audit)})` : sql``}`,
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
							external_witness: external,
							notes: k.notes,
							media_type: document?.mediaType ?? null,
							byte_count: document?.byteCount ?? null,
							voided_at: null,
						}),
						person: { personId: p.id, stage, revision, stageChange: step.change },
						current: status(current.state, current.effectiveOn, revision),
						outcome: "changed",
						receiptId,
					};
					fresh = value;
					return {
						// The card's original date and kind stay in the receipt (the correction history holds them too), so a retry
						// after a correction or void still returns the card as it was saved.
						value: { ...receiptOf(value, "commitment", id), card: { occurredOn: k.occurredOn, kind: k.kind } },
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
				fresh ??
					asSaved(await replayed(tx, plant, stored, "commitment", sql`commitment`, commitmentJson, commitmentView)),
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
	 * card makes the current commitment unknown; correcting or voiding the card that made it active recomputes its date.
	 * A correction to the values the card already has changes nothing. Stage never changes.
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
 'revision',k.revision::text,'voided',k.voided_at IS NOT NULL,'others',(SELECT coalesce(jsonb_agg(o.signed_on::text),'[]')
 FROM commitment o WHERE o.person_id=k.person_id AND o.plant_id=k.plant_id AND o.id<>k.id AND o.voided_at IS NULL),
 'replaced',(SELECT a.before_value->'commitment' FROM audit_event a WHERE a.tenant_id=k.plant_id AND a.subject_id IN
 (SELECT k.person_id UNION ALL SELECT m.id FROM person m WHERE m.merged_into_person_id=k.person_id AND m.tenant_id=k.plant_id)
 AND a.action='people.recorded' AND a.metadata->>'recordId'=k.id::text ORDER BY a.occurred_at,a.id LIMIT 1))
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
					if (!after.voided && after.occurredOn === before.occurredOn && after.kind === before.kind) {
						const value = {
							personId: p.id,
							current: status(p.commitment_state, p.commitment_effective_on, p.revision),
							outcome: "noop",
							receiptId,
						};
						return { value, subject: p.id, action: "people.corrected", outcome: "noop" };
					}
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
					const valid = after.voided ? k.others : [...k.others, after.occurredOn];
					const activated = p.commitment_state === "active" && p.commitment_effective_on === k.signed_on;
					const current = !valid.length
						? { state: "unknown" as const, effectiveOn: null }
						: activated
							? reactivatedBy(k.replaced ?? { state: "unknown", effectiveOn: null }, valid)
							: currentOf(p);
					const set =
						current.state !== p.commitment_state || current.effectiveOn !== p.commitment_effective_on
							? { commitment_state: current.state, commitment_effective_on: current.effectiveOn }
							: {};
					audit.writes.push(...personUpdate(tx, plant, p, set));
					const revision = nextRevision(p, set);
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
			return commitmentsOf(input.personId, await readHistory(tx, ctx, input, (plant) => commitmentsJson(plant, input)));
		});
	},
};

/** One Person's card page and current commitment as one JSON value over the Person alias `p`, for this read or the person page's. */
export const commitmentsJson = (plant: string, input: HistoryPage) =>
	historyJson(
		plant,
		input,
		sql`commitment`,
		commitmentJson,
		latestFirst,
		sql`jsonb_build_object('state',p.commitment_state,'effective_on',p.commitment_effective_on::text,'revision',p.revision::text,
 'first',(SELECT jsonb_build_object('id',k.id,'on',k.signed_on::text) FROM commitment k WHERE k.person_id=p.id
   AND k.plant_id=p.plant_id AND k.voided_at IS NULL ORDER BY k.signed_on,k.recorded_at,k.id LIMIT 1),
 'witnesses',(SELECT coalesce(jsonb_object_agg(w.id,w.display_name),'{}') FROM person w WHERE w.tenant_id=p.plant_id
   AND w.id IN (SELECT k.witness_person_id FROM commitment k WHERE k.person_id=p.id AND k.plant_id=p.plant_id)))`,
	);
const currentRow = z.object({
	state: z.enum(["active", "withdrawn", "unknown"]),
	effective_on: z.string().nullable(),
	revision: z.string(),
	first: z.object({ id: z.uuid(), on: z.string() }).nullable(),
	witnesses: z.record(z.string(), z.string()),
});
export function commitmentsOf(personId: string, h: History) {
	const extra = currentRow.parse(h.extra);
	return c.commitmentsResult.parse({
		personId,
		// Without a valid card the current commitment is unknown, whatever was recorded before.
		current: status(extra.first ? extra.state : "unknown", extra.first ? extra.effective_on : null, extra.revision),
		firstAcquisition: extra.first
			? { status: "known", occurredOn: extra.first.on, evidenceId: extra.first.id }
			: { status: "none" },
		latest: h.latest ? commitmentView(h.plant, h.latest) : null,
		items: h.items.map((r) => commitmentView(h.plant, r)),
		witnessNames: extra.witnesses,
		next: h.next,
		total: h.total,
	});
}

/**
 * Current authority to read one commitment document: an Owner or Admin whose session, seat and lifecycle are live in
 * the same statement as the exact card that holds the object (C13, C27).
 */
function documentAuthority(ctx: PeopleContext, commitmentId: string): ResourceAuthorizer {
	return async (tx, file, intent) => {
		if (intent !== "read" || file.purpose !== "commitment" || file.tenant_id !== ctx.selected.id) return null;
		const [current] = await tx
			.select({ actorId: sql<string>`(SELECT i.account_id FROM live_session(${ctx.session}::uuid) i)` })
			.from(tables.commitment)
			.where(
				and(
					eq(tables.commitment.id, commitmentId),
					eq(tables.commitment.plant_id, file.tenant_id),
					eq(tables.commitment.object_id, file.id),
					adminRead(ctx),
				),
			);
		return current ? { kind: "account", actorId: current.actorId } : null;
	};
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
			.where(and(eq(tables.commitment.id, input.commitmentId), eq(tables.commitment.plant_id, plant), adminRead(ctx)));
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

// RT-2 design B: the browser puts a commitment document straight into the private bucket; the card is saved with it
// through createCommitment. The bytes never pass through our server on the way in, and no SQL runs while they move.

/** A document's object key: the church comes from the verified viewer, so another church's upload cannot be named. */
const documentKey = (plant: string, uploadId: string) => `private/${plant}/${uploadId}`;
/** A live Owner or Admin seat of this church for exactly this request's actor, in the statement that writes (D70). */
const documentWriter = (ctx: PeopleContext, actorId: string, plant: string) =>
	sql`EXISTS(SELECT FROM access_session(${ctx.session}::uuid) i JOIN seat s ON s.account_id=i.account_id
 WHERE i.account_id=${actorId}::uuid AND i.registration_state='active' AND s.plant_id=${plant}::uuid AND s.ended_at IS NULL
 AND s.accepted_at<=clock_timestamp() AND s.role<>'member' AND ${writeVisibility(sql`i.account_id`, ctx.selected)})`;

/**
 * Sign a commitment document upload (REQ-PPL-014): one statement checks the live Owner or Admin and the live Person,
 * inserts the pending upload and queues its orphan cleanup. The PUT URL is signed locally for the exact key, type and
 * length, works for five minutes and writes once. A PDF also warms this process's parse worker for the save.
 * The pending row decides nothing: the save checks authority again, so this statement takes no locks of its own.
 */
export async function signCommitmentDocument(
	db: Database,
	storage: PrivateStorage,
	ctx: PeopleContext,
	actorId: string,
	raw: unknown,
) {
	return readReply(async () => {
		const plant = plantId(ctx);
		const input = parse(c.signCommitmentDocumentRequest, raw);
		const id = randomUUID();
		const key = documentKey(plant, id);
		const result = await db.execute(sql`WITH upload AS (
 INSERT INTO file_object(id,tenant_id,purpose,opaque_key,media_type,max_bytes,state,upload_key,claim_generation,expires_at)
 SELECT ${id}::uuid,${plant}::uuid,'commitment',${key}::text,${input.mime}::text,${String(input.byteLength)}::bigint,
  'pending',${id}::text,0,clock_timestamp()+interval '15 minutes'
 FROM person p WHERE p.id=${input.personId}::uuid AND p.tenant_id=${plant}::uuid AND p.plant_id=${plant}::uuid
 AND p.state='live' AND ${documentWriter(ctx, actorId, plant)}
 RETURNING id,expires_at), cleanup AS (
 INSERT INTO job(tenant_id,kind,subject_record_id,producer_key,state,eligible_at,attempt_count,max_attempts,claim_generation)
 SELECT ${plant}::uuid,'object_cleanup',u.id,'commitment-upload/'||u.id,'ready',u.expires_at,0,4,0 FROM upload u
 ON CONFLICT DO NOTHING)
 SELECT id FROM upload`);
		if (!result.rows[0]) deny();
		if (input.mime === "application/pdf") warmCommitmentParser();
		const signed = await signPrivatePut(storage, key, input.mime, input.byteLength).catch(() => deny());
		return c.commitmentDocumentUpload.parse({ uploadId: id, ...signed });
	});
}

/**
 * Save a commitment card with the document the browser put into the bucket (RT-2 design B, REQ-PPL-014). The request's
 * viewer must be an Owner or Admin before the server reads the bucket. With no transaction open, the server reads the
 * object back and checks its type, size and content; then createCommitment saves the card and attaches the upload
 * through the shared native write (D70, C88), which checks live authority again and answers a retry from its key.
 */
export async function saveCommitmentDocument(
	db: Database,
	storage: PrivateStorage,
	authority: RequestActor,
	raw: unknown,
) {
	const checked = await readReply(async () => {
		const request = parse(c.saveCommitmentDocumentRequest, raw);
		const ctx = new PeopleReadContext(authority);
		authorizeCachedWrite(ctx);
		const uploadId = request.input.documentUploadId;
		const object = await readPrivateObject(storage, documentKey(plantId(ctx), uploadId), c.COMMITMENT_MAX_BYTES);
		const mime = c.commitmentMime.safeParse(object?.mediaType);
		// Not uploaded (or not completely): nothing to save. A retry of a saved card still finds its object.
		if (!object || !mime.success) deny();
		await validateCommitment(object.bytes, mime.data).catch(() =>
			deny("invalid_input", { reason: "unreadable_document" }),
		);
		const document: CheckedDocument = {
			uploadId,
			mediaType: mime.data,
			byteCount: object.bytes.length,
			sha256: createHash("sha256").update(object.bytes).digest("hex"),
		};
		return { request, document };
	});
	if (checked.status !== "ok") return checked;
	const { request, document } = checked.value;
	return withPeopleWrite(db, authority, (tx, ctx) => commitments.createCommitment(tx, ctx, request, document));
}
