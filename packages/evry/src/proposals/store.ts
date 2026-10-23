import type { Database } from "@everyfield/db/client";
import { sql, type SQL } from "@everyfield/db/query";
import { readAuthorizedObject, type PrivateStorage, type ResourceAuthorizer } from "@everyfield/db/schema";
import { liveRead } from "@everyfield/domain/access";
import { photoMediaType } from "@everyfield/domain/people";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { EvryActor } from "../context/actor.ts";
import { currentAuthority } from "../context/authority.ts";
import { EvryRefusal } from "../context/errors.ts";
import { liveJob } from "../runtime/job.ts";
import { fence, type RunLease } from "../runtime/run-store.ts";
import { PEOPLE_COMMANDS } from "../adapters/people/commands/index.ts";
import type { ReviewedWrite } from "./types.ts";

// Proposal commands are one statement each (D70): live authority, the change, the effect job and one audit row commit
// together, and zero changed rows means refused, changed or not found. A refusal reads the current review once more to
// say which, so a repeated approve or cancel returns the known state instead of failing.

/** Every installed reviewed write. A model may propose only these, and only when the actor may use them natively. */
export const REVIEWED_WRITES = PEOPLE_COMMANDS;
type Operation = keyof typeof REVIEWED_WRITES;
const operation = z.enum(Object.keys(REVIEWED_WRITES) as [Operation]);

/** REQ-EVR-012: approval lapses 15 minutes after the review revision was published. */
export const REVIEW_MINUTES = 15;

export function allowedWrites(actor: EvryActor) {
	return (Object.values(REVIEWED_WRITES) as ReviewedWrite<unknown>[]).filter((w) => w.allowed(actor));
}

function parse<S extends z.ZodType>(schema: S, raw: unknown): z.output<S> {
	const r = schema.safeParse(raw);
	if (!r.success) throw new EvryRefusal("invalid_input");
	return r.data;
}
function adapter(actor: EvryActor, op: Operation): ReviewedWrite<unknown> {
	const write = REVIEWED_WRITES[op] as ReviewedWrite<unknown>;
	if (!write.allowed(actor)) throw new EvryRefusal("access_denied");
	return write;
}
/** The actor's own proposal in this exact context, for an operation the actor may still use natively. */
const mine = (actor: EvryActor) =>
	sql`p.account_id=${actor.accountId}::uuid AND p.tenant_id=${actor.owner.id}::uuid
		AND p.operation=ANY(${sql.param(allowedWrites(actor).map((w) => w.operation))}::text[])`;
/** Proposal commands: the actor's own proposal under write authority. */
const owned = (actor: EvryActor) => sql`${mine(actor)} AND ${currentAuthority(actor)}`;
/**
 * The review read (C32): the actor's own proposal under the lock-free live check, so a sign-out or seat change never
 * waits for it. Reviewed writes need Owner or Admin, the same floor as the native command.
 */
const readable = (actor: EvryActor) =>
	sql`${mine(actor)} AND ${liveRead({ session: actor.session, owner: actor.owner, seatId: actor.seatId ?? undefined }, true)}`;
const digest = (revision: SQL) =>
	sql`encode(sha256(convert_to(jsonb_build_object('operation',p.operation,'revision',${revision},'args',r.args,'review',r.review)::text,'UTF8')),'hex')`;
const expiry = sql`clock_timestamp()+make_interval(mins=>${REVIEW_MINUTES})`;
const effectJob = (job: string, alias: string) =>
	sql`INSERT INTO job(id,tenant_id,kind,subject_record_id,producer_key,state,eligible_at,attempt_count,max_attempts,claim_generation)
		SELECT ${job}::uuid,tenant_id,'evry_effect',conversation_id,id||':'||revision||':'||${job},'ready',clock_timestamp(),0,1,0 FROM ${sql.raw(alias)}`;
const audit = (action: string, kind: string, alias: string) =>
	sql`INSERT INTO audit_event(tenant_id,actor_id,action,kind,subject_type,subject_id,metadata)
		SELECT tenant_id,account_id,${action},${kind},'conversation',conversation_id,
			jsonb_build_object('proposalId',id,'revision',revision,'digest',digest) FROM ${sql.raw(alias)}`;

/**
 * A proposal as its owner may see it now. The review status (pending, approved, cancelled, expired) is separate from
 * the recorded outcome of the approved revision. An approved revision without a saved outcome is executing while its
 * effect job can still make progress (runtime/job.ts) and unknown once it cannot. A review whose target is no longer
 * available withholds its fields; a saved receipt stays as it was. `now` is the database time the status was decided
 * at, so a card counts the approval down from the server's clock, never the browser's.
 */
const projection = (alias: string) =>
	sql.raw(`jsonb_build_object('id',${alias}.id,'conversationId',${alias}.conversation_id,'operation',${alias}.operation,
		'revision',${alias}.revision,'digest',${alias}.digest,'expiresAt',${alias}.expires_at,'approvedAt',${alias}.approved_at,
		'status',CASE WHEN ${alias}.state='pending' AND ${alias}.expires_at<=clock_timestamp() THEN 'expired' ELSE ${alias}.state END,
		'review',CASE WHEN ${alias}.review->'target'='null'::jsonb OR EXISTS(SELECT FROM person t WHERE t.id=(${alias}.review->'target'->>'id')::uuid AND t.tenant_id=${alias}.tenant_id AND t.state='live')
			THEN ${alias}.review ELSE jsonb_build_object('target',NULL,'changes','[]'::jsonb,'withheld',true) END,
		'outcome',coalesce(${alias}.outcome,(SELECT 'unknown' FROM job j WHERE j.id=${alias}.job_id AND ${alias}.state='approved'
			AND NOT ${liveJob("j")})),
		'executing',${alias}.state='approved' AND ${alias}.outcome IS NULL AND EXISTS(SELECT FROM job j WHERE j.id=${alias}.job_id
			AND ${liveJob("j")}),
		'receipt',${alias}.receipt,'now',clock_timestamp())`);

const review = z.object({
	target: z.object({ kind: z.literal("person"), id: z.uuid(), label: z.string() }).nullable(),
	changes: z.array(z.object({ field: z.string(), before: z.unknown(), after: z.unknown() })),
	withheld: z.literal(true).optional(),
});
export const proposalRow = z.object({
	id: z.uuid(),
	conversationId: z.uuid(),
	operation,
	revision: z.number().int(),
	digest: z.string(),
	expiresAt: z.coerce.date(),
	approvedAt: z.coerce.date().nullable(),
	status: z.enum(["pending", "approved", "cancelled", "expired"]),
	review,
	outcome: z.enum(["completed", "failed", "refused", "unknown"]).nullable(),
	executing: z.boolean(),
	receipt: z
		.object({ receiptId: z.uuid().optional(), revision: z.string().optional(), code: z.string().optional() })
		.nullable(),
	now: z.coerce.date(),
});
export type Proposal = z.infer<typeof proposalRow>;

/** evry.readReview: the actor's proposal with its current review status and recorded outcome. One lock-free statement. */
export async function readReview(db: Database, actor: EvryActor, id: string): Promise<Proposal> {
	const proposalId = parse(z.uuid(), id);
	const r = await db.execute(
		sql`SELECT ${projection("p")} AS proposal FROM proposal p WHERE p.id=${proposalId}::uuid AND ${readable(actor)}`,
	);
	if (!r.rows.length) throw new EvryRefusal("not_found");
	return proposalRow.parse(r.rows[0]!.proposal);
}

const proposeInput = z.strictObject({ operation, input: z.unknown() });
/**
 * evry.prepareProposal: the running turn proposes one reviewed write. The target is read again under the actor's live
 * authority and the exact review, arguments and digest are saved with a 15-minute expiry. Nothing changes in the
 * domain. Null when the target is not available or the run no longer owns the conversation. One statement.
 */
export async function prepareProposal(
	db: Database,
	actor: EvryActor,
	lease: RunLease,
	conversationId: string,
	raw: unknown,
): Promise<Proposal | null> {
	const call = parse(proposeInput, raw);
	const write = adapter(actor, call.operation);
	const input = parse(write.input, call.input);
	const r = await db.execute(sql`
		WITH r AS (${write.review(actor, input)}),
		c AS (
			SELECT c.id,c.tenant_id,c.account_id FROM conversation c
			WHERE c.id=${conversationId}::uuid AND c.account_id=${actor.accountId}::uuid AND c.tenant_id=${actor.owner.id}::uuid
				AND c.active_turn_id=${lease.turnId}::uuid AND ${fence(lease)} AND ${currentAuthority(actor)}
		), p AS (
			INSERT INTO proposal(tenant_id,account_id,conversation_id,operation,revision,input,review,digest,state,expires_at)
			SELECT c.tenant_id,c.account_id,c.id,${write.operation},1,r.args,r.review,
				encode(sha256(convert_to(jsonb_build_object('operation',${write.operation}::text,'revision',1,'args',r.args,'review',r.review)::text,'UTF8')),'hex'),
				'pending',${expiry} FROM c,r
			RETURNING *
		), audit AS (${audit("evry.proposal_prepared", "create", "p")})
		SELECT ${projection("p")} AS proposal FROM p`);
	return r.rows.length ? proposalRow.parse(r.rows[0]!.proposal) : null;
}

const reviseInput = z.strictObject({ operation, revision: z.int().min(1), input: z.unknown() });
/**
 * evry.reviseProposal: the owner changes a reviewed fact. The target is read again, the revision moves on with a new
 * digest and a fresh 15-minute expiry, any approval of the old revision is cleared and its unstarted effect is
 * superseded. A revision whose effect already ran cannot change. One statement.
 */
export async function reviseProposal(db: Database, actor: EvryActor, id: string, raw: unknown): Promise<Proposal> {
	const proposalId = parse(z.uuid(), id);
	const change = parse(reviseInput, raw);
	const write = adapter(actor, change.operation);
	const input = parse(write.input, change.input);
	const r = await db.execute(sql`
		WITH r AS (${write.review(actor, input)}),
		x AS (
			UPDATE proposal p SET revision=p.revision+1,input=r.args,review=r.review,digest=${digest(sql`p.revision+1`)},
				state='pending',approved_at=NULL,approved_session_id=NULL,job_id=NULL,expires_at=${expiry},updated_at=clock_timestamp()
			FROM r WHERE p.id=${proposalId}::uuid AND ${owned(actor)} AND p.operation=${write.operation} AND p.revision=${change.revision}
				AND p.outcome IS NULL AND p.state IN ('pending','approved','expired')
			RETURNING p.*
		), superseded AS (
			UPDATE job j SET state='superseded',finished_at=clock_timestamp(),revision=j.revision+1 FROM x
			WHERE j.kind='evry_effect' AND j.subject_record_id=x.conversation_id AND j.producer_key LIKE x.id||':%' AND j.state='ready'
		), audit AS (${audit("evry.proposal_revised", "edit", "x")})
		SELECT ${projection("x")} AS proposal FROM x`);
	if (r.rows.length) return proposalRow.parse(r.rows[0]!.proposal);
	const current = await readReview(db, actor, proposalId);
	throw new EvryRefusal(current.revision !== change.revision ? "review_changed" : "review_closed");
}

/**
 * A set-photo proposal's staged upload, while its owner may still review it: the proposal is pending or approved
 * without an outcome and its 15-minute review has not expired, the person is still live in this church, and the
 * upload is this church's ready, unexpired person photo that no person uses yet. Lock-free (C13, C27).
 */
const staged = (actor: EvryActor, proposalId: string, uploadId: SQL) =>
	sql`p.id=${proposalId}::uuid AND ${readable(actor)} AND p.operation='people.setPersonPhoto'
		AND p.state IN ('pending','approved') AND p.outcome IS NULL AND p.expires_at>clock_timestamp()
		AND (p.input->'input'->>'uploadId')::uuid=${uploadId}
		AND EXISTS(SELECT FROM person t WHERE t.id=(p.input->'input'->>'personId')::uuid AND t.tenant_id=p.tenant_id AND t.state='live')
		AND EXISTS(SELECT FROM file_object f WHERE f.id=${uploadId} AND f.tenant_id=p.tenant_id AND f.purpose='person_photo'
			AND f.state='ready' AND f.expires_at>clock_timestamp() AND NOT EXISTS(SELECT FROM person o WHERE o.photo_object_id=f.id))`;

/**
 * The exact verified bytes of a staged upload. The storage layer checks it again around the byte transfer, each time
 * in one statement with the live check, so a sign-out, an ended seat or an expired review stops delivery.
 */
async function stagedBytes(
	db: Database,
	storage: PrivateStorage | null,
	actor: EvryActor,
	proposalId: string,
	upload: string,
) {
	if (!storage) throw new EvryRefusal("not_found");
	const authorize: ResourceAuthorizer = async (tx, file, intent) => {
		if (intent !== "read") return null;
		const r = await tx.execute(
			sql`SELECT p.account_id FROM proposal p WHERE ${staged(actor, proposalId, sql`${file.id}::uuid`)}`,
		);
		const accountId = r.rows[0]?.account_id as string | undefined;
		return accountId ? { kind: "account", actorId: accountId } : null;
	};
	const bytes = await readAuthorizedObject(db, storage, authorize, upload).catch(() => {
		throw new EvryRefusal("not_found");
	});
	const mediaType = photoMediaType(bytes);
	if (!mediaType) throw new EvryRefusal("not_found");
	return { bytes, mediaType };
}

/**
 * evry.readReview for a set-photo proposal's staged upload: its exact bytes and image type, for the proposal's owner
 * while the review lasts, so they can see the image they approve. Refuses as not_found otherwise.
 */
export async function readStagedPhoto(db: Database, storage: PrivateStorage | null, actor: EvryActor, id: string) {
	const proposalId = parse(z.uuid(), id);
	const upload = sql`(p.input->'input'->>'uploadId')::uuid`;
	const r = await db.execute(
		sql`SELECT ${upload} AS upload FROM proposal p WHERE ${staged(actor, proposalId, upload)}`,
	);
	const found = r.rows[0]?.upload as string | undefined;
	if (!found) throw new EvryRefusal("not_found");
	return stagedBytes(db, storage, actor, proposalId, found);
}

const approval = z.strictObject({ revision: z.int().min(1), digest: z.string().regex(/^[0-9a-f]{64}$/) });
/**
 * evry.approveProposal: the owner's trusted approval of exactly the revision and digest they reviewed, before it
 * expires (expiresAt itself is too late). Binds the approving session and queues the effect as one evry_effect job.
 * Approving the same revision again returns it and queues nothing. One statement.
 *
 * A set-photo proposal approves only after its staged upload was read again, byte for byte, in this request: nobody
 * may approve an image they could not have seen (REQ-EVR-011). The first statement leaves it pending; the review read
 * that follows names the upload, the storage layer reads it under the live check, and the approval runs again bound to
 * that upload. An upload that is gone or unreadable refuses as photo_unavailable and changes nothing.
 */
export async function approveProposal(
	db: Database,
	actor: EvryActor,
	id: string,
	raw: unknown,
	storage: PrivateStorage | null,
) {
	const proposalId = parse(z.uuid(), id);
	const witness = parse(approval, raw);
	const approve = async (shownUpload: string | null) => {
		const job = randomUUID();
		const r = await db.execute(sql`
			WITH a AS (
				UPDATE proposal p SET state='approved',approved_at=clock_timestamp(),approved_session_id=${actor.session}::uuid,
					job_id=${job}::uuid,updated_at=clock_timestamp()
				WHERE p.id=${proposalId}::uuid AND ${owned(actor)} AND p.state='pending' AND p.revision=${witness.revision}
					AND p.digest=${witness.digest} AND p.expires_at>clock_timestamp()
					AND (p.operation<>'people.setPersonPhoto' OR p.input->'input'->>'uploadId'=${shownUpload}::text)
				RETURNING p.*
			), run AS (${effectJob(job, "a")}),
			audit AS (${audit("evry.proposal_approved", "accept", "a")})
			SELECT ${projection("a")} AS proposal FROM a`);
		return r.rows.length ? { proposal: proposalRow.parse(r.rows[0]!.proposal), replayed: false } : null;
	};
	/** Not approved now: the known state of the review, or why it cannot be approved. */
	const settled = (current: Proposal) => {
		if (current.revision !== witness.revision || current.digest !== witness.digest)
			throw new EvryRefusal("review_changed");
		if (current.status === "approved") return { proposal: current, replayed: true };
		throw new EvryRefusal(current.status === "expired" ? "review_expired" : "review_closed");
	};
	const approved = await approve(null);
	if (approved) return approved;
	const current = await readReview(db, actor, proposalId);
	if (current.operation !== "people.setPersonPhoto" || current.status !== "pending") return settled(current);
	if (current.revision !== witness.revision || current.digest !== witness.digest) return settled(current);
	const upload = z.uuid().safeParse(current.review.changes.find((c) => c.field === "photo")?.after);
	const shown = upload.success && (await stagedBytes(db, storage, actor, proposalId, upload.data).catch(() => null));
	if (!shown) throw new EvryRefusal("photo_unavailable");
	return (await approve(upload.data)) ?? settled(await readReview(db, actor, proposalId));
}

/**
 * evry.cancelProposal: withdraws a pending review or an approved effect that has not run. It waits for an effect that
 * is running and then reports its real outcome; a completed effect stays completed. One statement.
 */
export async function cancelProposal(db: Database, actor: EvryActor, id: string) {
	const proposalId = parse(z.uuid(), id);
	const r = await db.execute(sql`
		WITH x AS (
			UPDATE proposal p SET state='cancelled',approved_at=NULL,approved_session_id=NULL,updated_at=clock_timestamp()
			WHERE p.id=${proposalId}::uuid AND ${owned(actor)} AND p.state IN ('pending','approved') AND p.outcome IS NULL
			RETURNING p.*
		), run AS (
			UPDATE job j SET state='cancelled',error_code='cancelled',finished_at=clock_timestamp(),revision=j.revision+1
			FROM x WHERE j.id=x.job_id AND j.state='ready'
		), audit AS (${audit("evry.proposal_cancelled", "revoke", "x")})
		SELECT ${projection("x")} AS proposal FROM x`);
	if (r.rows.length) return { proposal: proposalRow.parse(r.rows[0]!.proposal), cancelled: true };
	return { proposal: await readReview(db, actor, proposalId), cancelled: false };
}

/**
 * evry.retryUnresolvedEffects: runs the approved revision again after a failed or unknown attempt, under the same
 * still-valid approval and the same effect key, so an effect that did commit returns its saved receipt. Unknown means
 * its job can no longer make progress (runtime/job.ts). An old job that no worker took is superseded, so the next drain
 * claims the new job first; an old job a worker already holds finds the proposal on the new job and cannot publish. A
 * completed or refused effect is never repeated, and an expired approval needs a new review. One statement.
 */
export async function retryUnresolvedEffects(db: Database, actor: EvryActor, id: string) {
	const proposalId = parse(z.uuid(), id);
	const job = randomUUID();
	const r = await db.execute(sql`
		WITH x AS (
			UPDATE proposal p SET outcome=NULL,receipt=NULL,job_id=${job}::uuid,approved_session_id=${actor.session}::uuid,updated_at=clock_timestamp()
			FROM (SELECT id,job_id FROM proposal WHERE id=${proposalId}::uuid) old
			WHERE p.id=old.id AND ${owned(actor)} AND p.state='approved' AND p.expires_at>clock_timestamp()
				AND (p.outcome='failed' OR (p.outcome IS NULL AND NOT EXISTS(SELECT FROM job j WHERE j.id=p.job_id AND ${sql.raw(liveJob("j"))})))
			RETURNING p.*,old.job_id AS old_job_id
		), run AS (${effectJob(job, "x")}),
		superseded AS (
			UPDATE job j SET state='superseded',error_code='retried',finished_at=clock_timestamp(),revision=j.revision+1
			FROM x WHERE j.id=x.old_job_id AND j.state='ready'
		),
		audit AS (${audit("evry.proposal_retried", "reopen", "x")})
		SELECT ${projection("x")} AS proposal FROM x`);
	if (r.rows.length) return { proposal: proposalRow.parse(r.rows[0]!.proposal), retried: true };
	const current = await readReview(db, actor, proposalId);
	if (current.outcome === "completed" || current.executing) return { proposal: current, retried: false };
	throw new EvryRefusal(
		current.status === "expired" || current.expiresAt <= new Date() ? "review_expired" : "review_closed",
	);
}
