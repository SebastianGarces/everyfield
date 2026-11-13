import { sql, type SQL } from "@everyfield/db/query";
import { liveRead } from "@everyfield/domain/access";
import { z } from "zod";
import type { EvryActor } from "../context/actor.ts";
import { liveJob } from "../runtime/job.ts";
import { mailReport } from "@everyfield/contracts/communication";
import { COMMUNICATION_COMMANDS } from "../adapters/communication/commands/index.ts";
import { untouchedMail } from "../adapters/communication/reads/index.ts";
import { PEOPLE_COMMANDS } from "../adapters/people/commands/index.ts";
import { ORGANIZATION_COMMANDS } from "../adapters/people-organization/commands/index.ts";
import { currentPerson, importOutcome, personOutcome, type ReviewedWrite } from "./types.ts";

// The review read (evry.readReview): one projection and one access rule, used by readReview and by the conversation
// page read, which brings every review card's review in its own statement. No conversation or run imports here, so the
// conversation store can use it without an import cycle.

/** Every installed reviewed write. A model may propose only these, and only when the actor may use them natively. */
export const REVIEWED_WRITES = { ...PEOPLE_COMMANDS, ...ORGANIZATION_COMMANDS, ...COMMUNICATION_COMMANDS } as const;
export type Operation = keyof typeof REVIEWED_WRITES;
export const operation = z.enum(Object.keys(REVIEWED_WRITES) as [Operation]);

export function allowedWrites(actor: EvryActor) {
	return (Object.values(REVIEWED_WRITES) as ReviewedWrite<unknown>[]).filter((w) => w.allowed(actor));
}

/** The actor's own proposal in this exact context, for an operation the actor may still use natively. */
export const mine = (actor: EvryActor) =>
	sql`p.account_id=${actor.accountId}::uuid AND p.tenant_id=${actor.owner.id}::uuid
		AND p.operation=ANY(${sql.param(allowedWrites(actor).map((w) => w.operation))}::text[])`;
/**
 * The review read (C32): the actor's own proposal under the lock-free live check, so a sign-out or seat change never
 * waits for it. Reviewed writes need Owner or Admin, the same floor as the native command.
 */
export const readable = (actor: EvryActor) =>
	sql`${mine(actor)} AND ${liveRead({ session: actor.session, owner: actor.owner, seatId: actor.seatId ?? undefined }, true)}`;
/**
 * A review of a message that is no longer what the review showed. An edit or a time change moves the revision. A cancel
 * or a sent email changes only its mail rows, so the review also saved how many recipients the email service held with
 * no cancel asked. It can only be reviewed again.
 */
export const staleMessage = (alias: string) =>
	`coalesce(${alias}.review->'target'->>'kind'='message' AND NOT EXISTS(SELECT FROM communication t WHERE t.id=(${alias}.review->'target'->>'id')::uuid
		AND t.plant_id=${alias}.tenant_id AND t.revision=(${alias}.input->>'expectedRevision')::bigint
		AND ${untouchedMail("t")}=(${alias}.input->>'untouched')::int),false)`;
/**
 * A proposal as its owner may see it now. The review status (pending, approved, cancelled, expired) is separate from
 * the recorded outcome of the approved revision. An approved revision without a saved outcome is executing while its
 * effect job can still make progress (runtime/job.ts) and unknown once it cannot. A review whose target is no longer
 * available withholds its fields; a saved receipt stays as it was. `now` is the database time the status was decided
 * at, so a card counts the approval down from the server's clock, never the browser's.
 */
export const projection = (alias: string) =>
	sql.raw(`jsonb_build_object('id',${alias}.id,'conversationId',${alias}.conversation_id,'operation',${alias}.operation,
		'revision',${alias}.revision,'digest',${alias}.digest,'expiresAt',${alias}.expires_at,'approvedAt',${alias}.approved_at,
		'status',CASE WHEN ${alias}.state='pending' AND ${alias}.expires_at<=clock_timestamp() THEN 'expired' ELSE ${alias}.state END,
		'review',CASE WHEN ${alias}.review->'target'='null'::jsonb
			OR (${alias}.review->'target'->>'kind'='person' AND EXISTS(SELECT FROM person t WHERE t.id=(${alias}.review->'target'->>'id')::uuid AND t.tenant_id=${alias}.tenant_id AND t.state='live'))
			OR (${alias}.review->'target'->>'kind'='message' AND EXISTS(SELECT FROM communication t WHERE t.id=(${alias}.review->'target'->>'id')::uuid AND t.plant_id=${alias}.tenant_id))
			OR (${alias}.review->'target'->>'kind'='household' AND EXISTS(SELECT FROM household t WHERE t.id=(${alias}.review->'target'->>'id')::uuid AND t.plant_id=${alias}.tenant_id))
			OR (${alias}.review->'target'->>'kind'='tag' AND EXISTS(SELECT FROM tag t WHERE t.id=(${alias}.review->'target'->>'id')::uuid AND t.plant_id=${alias}.tenant_id))
			THEN ${alias}.review ELSE jsonb_build_object('target',NULL,'changes','[]'::jsonb,'withheld',true) END,
		'outcome',coalesce(${alias}.outcome,(SELECT 'unknown' FROM job j WHERE j.id=${alias}.job_id AND ${alias}.state='approved'
			AND NOT ${liveJob("j")})),
		'executing',${alias}.state='approved' AND ${alias}.outcome IS NULL AND EXISTS(SELECT FROM job j WHERE j.id=${alias}.job_id
			AND ${liveJob("j")}),
		'stale',${alias}.state='pending' AND ${staleMessage(alias)},
		'receipt',${alias}.receipt,'now',clock_timestamp())`);

const change = z.object({ field: z.string(), before: z.unknown(), after: z.unknown() });
/** One person a change reaches beyond the target, such as each member of a household or each person tagged. */
export const reviewedPerson = z.object({
	id: z.uuid(),
	label: z.string(),
	changes: z.array(change),
	/** Why this person will not change, such as already having the tag. */
	unchanged: z.string().optional(),
});
/** One row of a reviewed import: what will happen to it, and why for a row that fails or is skipped. */
export const reviewedRow = z.object({
	row: z.int(),
	outcome: z.enum(["create", "create_and_review", "skip", "fail"]),
	label: z.string().nullable(),
	reason: z.string().nullable(),
});
const review = z.object({
	target: z
		.object({ kind: z.enum(["person", "message", "household", "tag"]), id: z.uuid(), label: z.string() })
		.nullable(),
	changes: z.array(change),
	people: z.array(reviewedPerson).optional(),
	rows: z.array(reviewedRow).optional(),
	/** A plain reason the change cannot be approved as asked (for example a send time outside the window). */
	refusal: z.string().optional(),
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
	/** A pending message review whose message changed since (staleMessage): approving it is refused. */
	stale: z.boolean(),
	receipt: z
		.object({
			receiptId: z.uuid().optional(),
			revision: z.string().optional(),
			code: z.string().optional(),
			/** What the email service confirmed, for a write that reaches it (adapters/communication). */
			report: mailReport.optional(),
			/** Each person a change reached and whether they changed (adapters/people-organization). */
			people: z.array(personOutcome).optional(),
			/** A reviewed import's saved receipt: its counts and each failed row's reason. */
			import: importOutcome.optional(),
			/** A refusal because a record changed: the records as they are now, so the card can show them. */
			current: z.array(currentPerson).optional(),
		})
		.nullable(),
	now: z.coerce.date(),
});
export type Proposal = z.infer<typeof proposalRow>;

/** The current review of proposal `id` (a uuid expression) as the actor may read it now: no row when they may not. */
export const currentReview = (actor: EvryActor, id: SQL) =>
	sql`SELECT ${projection("p")} AS proposal FROM proposal p WHERE p.id=${id} AND ${readable(actor)}`;

/**
 * Each proposal id that `ids` selects (one uuid column), keyed to its current review, or to null when the actor may no
 * longer read it. A subquery inside the caller's one statement.
 */
export const reviewsOf = (actor: EvryActor, ids: SQL) =>
	sql`coalesce((SELECT jsonb_object_agg(x.id,(${currentReview(actor, sql`x.id`)})) FROM (${ids}) x(id)),'{}'::jsonb)`;
export const reviewMap = z.record(z.uuid(), proposalRow.nullable());
