import { sql, type SQL } from "@everyfield/db/query";
import { liveRead } from "@everyfield/domain/access";
import { z } from "zod";
import type { EvryActor } from "../context/actor.ts";
import { liveJob } from "../runtime/job.ts";
import { mailReport } from "@everyfield/contracts/communication";
import { COMMUNICATION_COMMANDS } from "../adapters/communication/commands/index.ts";
import { MEETINGS_COMMANDS } from "../adapters/meetings/commands/index.ts";
import { NOTIFICATION_COMMANDS } from "../adapters/notifications/commands/index.ts";
import { untouchedMail } from "../adapters/communication/reads/index.ts";
import { PEOPLE_COMMANDS } from "../adapters/people/commands/index.ts";
import { SETTINGS_COMMANDS } from "../adapters/settings/index.ts";
import { ORGANIZATION_COMMANDS } from "../adapters/people-organization/commands/index.ts";
import { TEAMS_COMMANDS } from "../adapters/teams/commands/index.ts";
import { ONBOARDING_COMMANDS } from "../adapters/onboarding/commands/index.ts";
import { FEEDBACK_COMMANDS } from "../adapters/feedback/commands/index.ts";
import { PIPELINE_COMMANDS } from "../adapters/pipeline/commands/index.ts";
import { LAUNCH_COMMANDS } from "../adapters/launch/commands/index.ts";
import { currentPerson, importOutcome, personOutcome, type ReviewedWrite } from "./types.ts";

export const refusalCode = (code: string) =>
	code === "conflict" ? "revision_conflict" : code === "unavailable" ? "access_denied" : code;

export const REVIEWED_WRITES = {
	...PEOPLE_COMMANDS,
	...ORGANIZATION_COMMANDS,
	...COMMUNICATION_COMMANDS,
	...NOTIFICATION_COMMANDS,
	...TEAMS_COMMANDS,
	...MEETINGS_COMMANDS,
	...SETTINGS_COMMANDS,
	...ONBOARDING_COMMANDS,
	...FEEDBACK_COMMANDS,
	...PIPELINE_COMMANDS,
	...LAUNCH_COMMANDS,
} as const;
export type Operation = keyof typeof REVIEWED_WRITES;
export const operation = z.enum(Object.keys(REVIEWED_WRITES) as [Operation]);

export type Offered = (operation: string) => boolean;
export const everyOperation: Offered = () => true;

export const NOW_WRITES = (Object.values(REVIEWED_WRITES) as ReviewedWrite<unknown>[]).flatMap((w) =>
	w.approveNow ? [w.operation] : [],
);
export const REASON_WRITES = (Object.values(REVIEWED_WRITES) as ReviewedWrite<unknown>[]).flatMap((w) =>
	w.approveNow?.reason ? [w.operation] : [],
);

export function allowedWrites(actor: EvryActor, offered: Offered = everyOperation) {
	return (Object.values(REVIEWED_WRITES) as ReviewedWrite<unknown>[]).filter(
		(w) => offered(w.operation) && w.allowed(actor),
	);
}

export const mine = (actor: EvryActor) =>
	sql`p.account_id=${actor.accountId}::uuid AND p.tenant_id=${actor.owner.id}::uuid
		AND p.operation=ANY(${sql.param(allowedWrites(actor).map((w) => w.operation))}::text[])`;
export const readable = (actor: EvryActor) =>
	sql`((${mine(actor)} AND ${liveRead({ session: actor.session, owner: actor.owner, seatId: actor.seatId ?? undefined })})
		OR (${ownSeating(actor)}))`;
const SEATING = ["onboarding.createPlant", "discovery.convertToPlant"];
const ownSeating = (actor: EvryActor) =>
	sql`p.account_id=${actor.accountId}::uuid AND p.tenant_id=${actor.accountId}::uuid AND p.operation=ANY(${sql.param(SEATING)}::text[])
		AND ${liveRead({ session: actor.session, owner: { kind: "account", id: actor.accountId } as never })}`;
export const staleMessage = (alias: string) =>
	`coalesce(${alias}.review->'target'->>'kind'='message' AND NOT EXISTS(SELECT FROM communication t WHERE t.id=(${alias}.review->'target'->>'id')::uuid
		AND t.plant_id=${alias}.tenant_id AND t.revision=(${alias}.input->>'expectedRevision')::bigint
		AND ${untouchedMail("t")}=(${alias}.input->>'untouched')::int),false)`;
export const projection = (alias: string) =>
	sql.raw(`jsonb_build_object('id',${alias}.id,'conversationId',${alias}.conversation_id,'operation',${alias}.operation,
		'revision',${alias}.revision,'digest',${alias}.digest,'expiresAt',${alias}.expires_at,'approvedAt',${alias}.approved_at,
		'status',CASE WHEN ${alias}.state='pending' AND ${alias}.expires_at<=clock_timestamp() THEN 'expired' ELSE ${alias}.state END,
		'review',CASE WHEN ${alias}.review->'target'='null'::jsonb
			OR ${alias}.review->'target'->>'kind' NOT IN ('person','message','team','role','training','responsibility','household','tag')
			OR (${alias}.review->'target'->>'kind'='person' AND EXISTS(SELECT FROM person t WHERE t.id=(${alias}.review->'target'->>'id')::uuid AND t.tenant_id=${alias}.tenant_id AND t.state='live'))
			OR (${alias}.review->'target'->>'kind'='message' AND EXISTS(SELECT FROM communication t WHERE t.id=(${alias}.review->'target'->>'id')::uuid AND t.plant_id=${alias}.tenant_id))
			OR (${alias}.review->'target'->>'kind'='household' AND EXISTS(SELECT FROM household t WHERE t.id=(${alias}.review->'target'->>'id')::uuid AND t.plant_id=${alias}.tenant_id))
			OR (${alias}.review->'target'->>'kind'='tag' AND EXISTS(SELECT FROM tag t WHERE t.id=(${alias}.review->'target'->>'id')::uuid AND t.plant_id=${alias}.tenant_id))
			OR (${alias}.review->'target'->>'kind'='team' AND EXISTS(SELECT FROM team t WHERE t.id=(${alias}.review->'target'->>'id')::uuid AND t.plant_id=${alias}.tenant_id))
			OR (${alias}.review->'target'->>'kind'='role' AND EXISTS(SELECT FROM team_role t WHERE t.id=(${alias}.review->'target'->>'id')::uuid AND t.plant_id=${alias}.tenant_id))
			OR (${alias}.review->'target'->>'kind'='training' AND EXISTS(SELECT FROM training_program t WHERE t.id=(${alias}.review->'target'->>'id')::uuid AND t.plant_id=${alias}.tenant_id))
			OR (${alias}.review->'target'->>'kind'='responsibility' AND EXISTS(SELECT FROM responsibility t WHERE t.id=(${alias}.review->'target'->>'id')::uuid AND t.plant_id=${alias}.tenant_id AND t.removed_at IS NULL))
			OR (${alias}.review->'target'->>'kind'='meeting' AND EXISTS(SELECT FROM meeting t WHERE t.id=(${alias}.review->'target'->>'id')::uuid AND t.plant_id=${alias}.tenant_id AND t.retired_at IS NULL))
			OR (${alias}.review->'target'->>'kind'='venue' AND EXISTS(SELECT FROM venue t WHERE t.id=(${alias}.review->'target'->>'id')::uuid AND t.plant_id=${alias}.tenant_id))
			THEN ${alias}.review ELSE jsonb_build_object('target',NULL,'changes','[]'::jsonb,'withheld',true) END,
		'outcome',coalesce(${alias}.outcome,(SELECT 'unknown' FROM job j WHERE j.id=${alias}.job_id AND ${alias}.state='approved'
			AND NOT ${liveJob("j")}),CASE WHEN ${alias}.state='approved' AND ${alias}.job_id IS NULL
			AND ${alias}.approved_at<clock_timestamp()-interval '2 minutes' THEN 'unknown' END),
		'executing',${alias}.state='approved' AND ${alias}.outcome IS NULL AND EXISTS(SELECT FROM job j WHERE j.id=${alias}.job_id
			AND ${liveJob("j")}),
		'stale',${alias}.state='pending' AND ${staleMessage(alias)},
		'receipt',${alias}.receipt,'now',clock_timestamp())`);

const targetKind = z.enum([
	"person",
	"message",
	"team",
	"role",
	"training",
	"responsibility",
	"household",
	"tag",
	"meeting",
	"venue",
	"church",
	"seat",
	"invitation",
	"connection",
	"organization",
	"account",
	"program",
]);
const change = z.object({ field: z.string(), before: z.unknown(), after: z.unknown() });
export const reviewedPerson = z.object({
	id: z.uuid(),
	label: z.string(),
	changes: z.array(change),
	unchanged: z.string().optional(),
});
export const reviewedRow = z.object({
	row: z.int(),
	outcome: z.enum(["create", "create_and_review", "skip", "fail"]),
	label: z.string().nullable(),
	reason: z.string().nullable(),
});
const review = z.object({
	target: z.object({ kind: targetKind, id: z.uuid(), label: z.string() }).nullable(),
	changes: z.array(change),
	people: z.array(reviewedPerson).optional(),
	rows: z.array(reviewedRow).optional(),
	notes: z.array(z.string()).optional(),
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
	stale: z.boolean(),
	receipt: z
		.object({
			receiptId: z.uuid().optional(),
			revision: z.string().optional(),
			code: z.string().optional(),
			report: mailReport.optional(),
			people: z.array(personOutcome).optional(),
			import: importOutcome.optional(),
			current: z.array(currentPerson).optional(),
		})
		.nullable(),
	now: z.coerce.date(),
});
export type Proposal = z.infer<typeof proposalRow>;

export const currentReview = (actor: EvryActor, id: SQL) =>
	sql`SELECT ${projection("p")} AS proposal FROM proposal p WHERE p.id=${id} AND ${readable(actor)}`;

export const reviewsOf = (actor: EvryActor, ids: SQL) =>
	sql`coalesce((SELECT jsonb_object_agg(x.id,(${currentReview(actor, sql`x.id`)})) FROM (${ids}) x(id)),'{}'::jsonb)`;
export const reviewMap = z.record(z.uuid(), proposalRow.nullable());
