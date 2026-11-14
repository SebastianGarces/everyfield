import { sql, type SQL } from "@everyfield/db/query";
import { liveRead } from "@everyfield/domain/access";
import { z } from "zod";
import type { EvryActor } from "../context/actor.ts";
import { liveJob } from "../runtime/job.ts";
import { mailReport } from "@everyfield/contracts/communication";
import { COMMUNICATION_COMMANDS } from "../adapters/communication/commands/index.ts";
import { untouchedMail } from "../adapters/communication/reads/index.ts";
import { PEOPLE_COMMANDS } from "../adapters/people/commands/index.ts";
import { SETTINGS_COMMANDS } from "../adapters/settings/index.ts";
import { TEAMS_COMMANDS } from "../adapters/teams/commands/index.ts";
import type { ReviewedWrite } from "./types.ts";

// The review read (evry.readReview): one projection and one access rule, used by readReview and by the conversation
// page read, which brings every review card's review in its own statement. No conversation or run imports here, so the
// conversation store can use it without an import cycle.

/** Every installed reviewed write. A model may propose only these, and only when the actor may use them natively. */
export const REVIEWED_WRITES = {
	...PEOPLE_COMMANDS,
	...COMMUNICATION_COMMANDS,
	...TEAMS_COMMANDS,
	...SETTINGS_COMMANDS,
} as const;
export type Operation = keyof typeof REVIEWED_WRITES;
export const operation = z.enum(Object.keys(REVIEWED_WRITES) as [Operation]);

/**
 * Which operations a caller offers the model. The turn offers every one; a recorded eval offers only the operations it
 * was recorded with, so its provider calls stay the recorded ones.
 */
export type Offered = (operation: string) => boolean;
export const everyOperation: Offered = () => true;

export function allowedWrites(actor: EvryActor, offered: Offered = everyOperation) {
	return (Object.values(REVIEWED_WRITES) as ReviewedWrite<unknown>[]).filter(
		(w) => offered(w.operation) && w.allowed(actor),
	);
}

/** The actor's own proposal in this exact context, for an operation the actor may still use natively. */
export const mine = (actor: EvryActor) =>
	sql`p.account_id=${actor.accountId}::uuid AND p.tenant_id=${actor.owner.id}::uuid
		AND p.operation=ANY(${sql.param(allowedWrites(actor).map((w) => w.operation))}::text[])`;
/**
 * The review read (C32): the actor's own proposal under the lock-free live check, so a sign-out or seat change never
 * waits for it. Each operation keeps its native command's role floor (or higher) through `mine`: church changes need an
 * Owner or Admin, while anyone with a seat may review a change to their own account.
 */
export const readable = (actor: EvryActor) =>
	sql`${mine(actor)} AND ${liveRead({ session: actor.session, owner: actor.owner, seatId: actor.seatId ?? undefined })}`;
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
			OR ${alias}.review->'target'->>'kind' NOT IN ('person','message','team','role','training','responsibility')
			OR (${alias}.review->'target'->>'kind'='person' AND EXISTS(SELECT FROM person t WHERE t.id=(${alias}.review->'target'->>'id')::uuid AND t.tenant_id=${alias}.tenant_id AND t.state='live'))
			OR (${alias}.review->'target'->>'kind'='message' AND EXISTS(SELECT FROM communication t WHERE t.id=(${alias}.review->'target'->>'id')::uuid AND t.plant_id=${alias}.tenant_id))
			OR (${alias}.review->'target'->>'kind'='team' AND EXISTS(SELECT FROM team t WHERE t.id=(${alias}.review->'target'->>'id')::uuid AND t.plant_id=${alias}.tenant_id))
			OR (${alias}.review->'target'->>'kind'='role' AND EXISTS(SELECT FROM team_role t WHERE t.id=(${alias}.review->'target'->>'id')::uuid AND t.plant_id=${alias}.tenant_id))
			OR (${alias}.review->'target'->>'kind'='training' AND EXISTS(SELECT FROM training_program t WHERE t.id=(${alias}.review->'target'->>'id')::uuid AND t.plant_id=${alias}.tenant_id))
			OR (${alias}.review->'target'->>'kind'='responsibility' AND EXISTS(SELECT FROM responsibility t WHERE t.id=(${alias}.review->'target'->>'id')::uuid AND t.plant_id=${alias}.tenant_id AND t.removed_at IS NULL))
			THEN ${alias}.review ELSE jsonb_build_object('target',NULL,'changes','[]'::jsonb,'withheld',true) END,
		'outcome',coalesce(${alias}.outcome,(SELECT 'unknown' FROM job j WHERE j.id=${alias}.job_id AND ${alias}.state='approved'
			AND NOT ${liveJob("j")})),
		'executing',${alias}.state='approved' AND ${alias}.outcome IS NULL AND EXISTS(SELECT FROM job j WHERE j.id=${alias}.job_id
			AND ${liveJob("j")}),
		'stale',${alias}.state='pending' AND ${staleMessage(alias)},
		'receipt',${alias}.receipt,'now',clock_timestamp())`);

/**
 * What a review is about. A person, message, team, role, training or responsibility is withheld once it is no longer
 * available; a church, seat, invitation, connection, organization or account review is checked again by its native
 * command on approval.
 */
const targetKind = z.enum([
	"person",
	"message",
	"team",
	"role",
	"training",
	"responsibility",
	"church",
	"seat",
	"invitation",
	"connection",
	"organization",
	"account",
]);
const review = z.object({
	target: z.object({ kind: targetKind, id: z.uuid(), label: z.string() }).nullable(),
	changes: z.array(z.object({ field: z.string(), before: z.unknown(), after: z.unknown() })),
	/** Plain facts the person should know before approving, such as what a time zone change moves. */
	notes: z.array(z.string()).optional(),
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
