import type { Database } from "@everyfield/db/client";
import { sql } from "@everyfield/db/query";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { EvryActor } from "../context/actor.ts";
import { currentAuthority, liveAuthority } from "../context/authority.ts";
import { retainedEvents } from "./retained.ts";
import { EvryRefusal, projectError } from "../context/errors.ts";
import { liveJob } from "../runtime/job.ts";

// Conversation commands are one statement each (D70): the current-authority check, the change, the run's job row and
// one audit row commit together, and zero changed rows means refused or not found. Message bodies never enter audit.

export const PAGE_SIZE = 24;
export const EVENT_PAGE = 200;
const TERMINAL_JOB = sql`('succeeded','failed','cancelled','superseded')`;
/** The conversation's active run can still make progress (runtime/job.ts). */
const liveRun = (alias: string) =>
	sql`EXISTS(SELECT FROM job j WHERE j.id=${sql.raw(alias)}.active_turn_id AND ${sql.raw(liveJob("j"))})`;

const uuid = z.uuid();
const text = z.string().trim().min(1).max(8_000);
const requestKey = z.string().min(8).max(200);
export const reference = z.strictObject({ kind: z.literal("person"), id: z.uuid() });
export const submitInput = z.strictObject({
	requestKey,
	text,
	/** Visible page context: presentation hints only. Each is re-read under current authority before model use. */
	references: z.array(reference).max(64).default([]),
});
export const createInput = z.strictObject({ requestKey, title: z.string().trim().min(1).max(120).optional() });
export const listInput = z.strictObject({
	search: z.string().trim().min(1).max(200).optional(),
	page: z.int().min(1).max(100_000).default(1),
});

function parse<S extends z.ZodType>(schema: S, raw: unknown): z.output<S> {
	const r = schema.safeParse(raw);
	if (!r.success) throw new EvryRefusal("invalid_input");
	return r.data;
}

const owned = (actor: EvryActor, alias: string) =>
	sql`${sql.raw(alias)}.account_id=${actor.accountId}::uuid AND ${sql.raw(alias)}.tenant_id=${actor.owner.id}::uuid`;

const conversationRow = z.object({
	id: z.uuid(),
	title: z.string(),
	context: z.enum(["account", "plant", "sending_church", "sending_network"]),
	lastSequence: z.coerce.number(),
	activeTurnId: z.uuid().nullable(),
	updatedAt: z.coerce.date(),
});
export type Conversation = z.infer<typeof conversationRow>;
const conversationJson = (alias: string) =>
	sql.raw(
		`jsonb_build_object('id',${alias}.id,'title',${alias}.title,'context',${alias}.context_kind,'lastSequence',${alias}.last_sequence,'activeTurnId',${alias}.active_turn_id,'updatedAt',${alias}.updated_at)`,
	);

export const eventRow = z.object({
	sequence: z.coerce.number(),
	turnId: z.uuid().nullable(),
	kind: z.enum(["user_message", "assistant_text", "tool_result", "status"]),
	body: z.record(z.string(), z.unknown()),
	createdAt: z.coerce.date(),
});
export type ConversationEvent = z.infer<typeof eventRow>;

const titleOf = (value: string) => {
	const line = value.replace(/\s+/g, " ").trim();
	return line.length > 80 ? line.slice(0, 79) + "…" : line;
};

/** evry.createConversation: a new private conversation in the actor's exact context. A repeated request key returns it. */
export async function createConversation(db: Database, actor: EvryActor, raw: unknown): Promise<Conversation> {
	const input = parse(createInput, raw);
	const r = await db.execute(sql`
		WITH known AS (
			SELECT a.subject_id FROM audit_event a
			WHERE a.tenant_id=${actor.owner.id}::uuid AND a.request_key=${input.requestKey} AND a.actor_id=${actor.accountId}::uuid AND a.action='evry.conversation_created'
		), c AS (
			INSERT INTO conversation(tenant_id,account_id,context_kind,title)
			SELECT ${actor.owner.id}::uuid,${actor.accountId}::uuid,${actor.contextKind},${input.title ?? "New conversation"}
			WHERE NOT EXISTS(SELECT FROM known) AND ${currentAuthority(actor)}
			RETURNING *
		), audit AS (
			INSERT INTO audit_event(tenant_id,actor_id,action,kind,subject_type,subject_id,request_key)
			SELECT tenant_id,account_id,'evry.conversation_created','create','conversation',id,${input.requestKey} FROM c
		)
		SELECT coalesce((SELECT ${conversationJson("c")} FROM c),
			(SELECT ${conversationJson("k")} FROM conversation k JOIN known ON known.subject_id=k.id WHERE ${owned(actor, "k")})) AS conversation`);
	const row = r.rows[0]?.conversation;
	if (!row) throw new EvryRefusal("access_denied");
	return conversationRow.parse(row);
}

/** evry.listConversations: the actor's own conversations in this exact context, newest first, searchable, by page number. */
export async function listConversations(db: Database, actor: EvryActor, raw: unknown) {
	const input = parse(listInput, raw);
	const pattern = input.search ? "%" + input.search.replace(/[\\%_]/g, (c) => "\\" + c) + "%" : null;
	const r = await db.execute(sql`
		WITH matched AS (
			SELECT c.* FROM conversation c
			WHERE ${owned(actor, "c")} AND ${liveAuthority(actor)} AND (${pattern}::text IS NULL OR c.title ILIKE ${pattern} OR EXISTS(
				SELECT FROM conversation_event e WHERE e.conversation_id=c.id AND e.kind='user_message' AND e.body->>'text' ILIKE ${pattern}))
		)
		SELECT (SELECT count(*)::int FROM matched) AS total,
			coalesce((SELECT jsonb_agg(${conversationJson("p")} ORDER BY p.updated_at DESC, p.id DESC) FROM (
				SELECT * FROM matched ORDER BY updated_at DESC, id DESC LIMIT ${PAGE_SIZE} OFFSET ${(input.page - 1) * PAGE_SIZE}
			) p), '[]'::jsonb) AS items`);
	const row = z.object({ total: z.number(), items: z.array(conversationRow) }).parse(r.rows[0]);
	return {
		items: row.items,
		total: row.total,
		page: input.page,
		next: input.page * PAGE_SIZE < row.total ? input.page + 1 : null,
	};
}

/**
 * evry.readConversation and evry.openConversation: the conversation and its saved events after a cursor, with the
 * active run: running while its job can still make progress, lost once its worker or claim is gone and its end is not
 * saved yet (closeLostRun saves it). A foreign or missing conversation is not_found, with no metadata. One statement.
 */
export async function readConversation(db: Database, actor: EvryActor, id: string, after = 0) {
	const conversationId = parse(uuid, id);
	const cursor = parse(z.int().min(0), after);
	const r = await db.execute(sql`
		SELECT ${conversationJson("c")} AS conversation,
			${liveRun("c")} AS run_live,
			coalesce((SELECT jsonb_agg(jsonb_build_object('sequence',e.sequence,'turnId',e.turn_id,'kind',e.kind,'body',e.body,'createdAt',e.created_at) ORDER BY e.sequence)
				FROM (${retainedEvents(sql`SELECT * FROM conversation_event WHERE conversation_id=c.id AND sequence>${cursor} ORDER BY sequence LIMIT ${EVENT_PAGE}`)}) e), '[]'::jsonb) AS events
		FROM conversation c WHERE c.id=${conversationId}::uuid AND ${owned(actor, "c")} AND ${liveAuthority(actor)}`);
	if (!r.rows.length) throw new EvryRefusal("not_found");
	const row = z
		.object({ conversation: conversationRow, run_live: z.boolean(), events: z.array(eventRow) })
		.parse(r.rows[0]);
	return {
		conversation: row.conversation,
		run: row.conversation.activeTurnId
			? { turnId: row.conversation.activeTurnId, state: row.run_live ? ("running" as const) : ("lost" as const) }
			: null,
		events: row.events,
		more: row.events.length === EVENT_PAGE,
	};
}

/** The actor's most recent conversation in this exact context, so the launcher and the panel reopen the same one. */
export async function latestConversation(db: Database, actor: EvryActor): Promise<Conversation | null> {
	const r = await db.execute(sql`
		SELECT ${conversationJson("c")} AS conversation FROM conversation c
		WHERE ${owned(actor, "c")} AND ${liveAuthority(actor)} ORDER BY c.updated_at DESC, c.id DESC LIMIT 1`);
	return r.rows.length ? conversationRow.parse(r.rows[0]!.conversation) : null;
}

const submitted = z.object({ turnId: z.uuid(), sequence: z.coerce.number() });
export type Submitted = z.infer<typeof submitted> & { replayed: boolean };

/**
 * evry.submitTurn: saves the message, starts the conversation's one run as an assistant_turn job and audits it, in one
 * statement. A repeated request key returns the saved turn and starts nothing. Only a live run blocks a new turn.
 */
export async function submitTurn(
	db: Database,
	actor: EvryActor,
	conversationId: string,
	raw: unknown,
	retryOf?: number,
): Promise<Submitted> {
	const id = parse(uuid, conversationId);
	const input = parse(submitInput, raw);
	const turnId = randomUUID();
	const body = { text: input.text, references: input.references, ...(retryOf ? { retryOf } : {}) };
	const r = await db.execute(sql`
		WITH known AS (
			SELECT e.turn_id AS "turnId", e.sequence FROM conversation_event e JOIN conversation c ON c.id=e.conversation_id
			WHERE e.conversation_id=${id}::uuid AND e.request_key=${input.requestKey} AND ${owned(actor, "c")}
		), conv AS (
			UPDATE conversation c SET last_sequence=c.last_sequence+1,active_turn_id=${turnId}::uuid,active_session_id=${actor.session}::uuid,
				updated_at=clock_timestamp(),title=CASE WHEN c.last_sequence=0 THEN ${titleOf(input.text)} ELSE c.title END
			WHERE c.id=${id}::uuid AND ${owned(actor, "c")} AND NOT EXISTS(SELECT FROM known)
				AND NOT ${liveRun("c")}
				AND ${currentAuthority(actor)}
			RETURNING c.id,c.tenant_id,c.account_id,c.last_sequence
		), run AS (
			INSERT INTO job(id,tenant_id,kind,subject_record_id,producer_key,state,eligible_at,attempt_count,max_attempts,claim_generation)
			SELECT ${turnId}::uuid,tenant_id,'assistant_turn',id,${turnId},'ready',clock_timestamp(),0,1,0 FROM conv
		), message AS (
			INSERT INTO conversation_event(conversation_id,sequence,turn_id,kind,body,request_key)
			SELECT id,last_sequence,${turnId}::uuid,'user_message',${JSON.stringify(body)}::jsonb,${input.requestKey} FROM conv
		), audit AS (
			INSERT INTO audit_event(tenant_id,actor_id,action,kind,subject_type,subject_id,metadata)
			SELECT tenant_id,account_id,${retryOf ? "evry.turn_retried" : "evry.turn_submitted"},${retryOf ? "reopen" : "progress"},'conversation',id,
				jsonb_build_object('turnId',${turnId}::uuid,'sequence',last_sequence) FROM conv
		)
		SELECT (SELECT jsonb_build_object('turnId',${turnId}::uuid,'sequence',last_sequence) FROM conv) AS submitted,
			(SELECT to_jsonb(known) FROM known) AS known,
			(SELECT ${liveRun("c")} FROM conversation c WHERE c.id=${id}::uuid AND ${owned(actor, "c")}) AS active`);
	const row = r.rows[0] as { submitted: unknown; known: unknown; active: boolean | null };
	if (row.submitted) return { ...submitted.parse(row.submitted), replayed: false };
	if (row.known) return { ...submitted.parse(row.known), replayed: true };
	if (row.active === null) throw new EvryRefusal("not_found");
	throw new EvryRefusal(row.active ? "run_active" : "access_denied");
}

const interrupted = () => ({
	state: "failed",
	reason: "failed",
	text: "",
	error: projectError(new EvryRefusal("interrupted")),
});

/**
 * Saves the end of a lost run once: the conversation still points at the turn and its job can no longer make progress
 * (runtime/job.ts). The job ends as failed with a new claim generation, so a late worker cannot pass the run fence; the
 * turn ends as interrupted, which may be tried again. The job update re-checks the live rule on the row a concurrent
 * claim locked, so a claim and a close never both win. Nothing about access is read or changed. One statement.
 */
export async function closeLostRun(db: Database, actor: EvryActor, conversationId: string, turnId: string) {
	const r = await db.execute(sql`
		WITH ended AS (
			UPDATE job j SET state='failed',error_code='interrupted',lease_owner=NULL,lease_until=NULL,finished_at=clock_timestamp(),
				claim_generation=j.claim_generation+1,revision=j.revision+1
			WHERE j.id=${turnId}::uuid AND j.state IN ('ready','claimed') AND NOT ${sql.raw(liveJob("j"))}
				AND EXISTS(SELECT FROM conversation c WHERE c.id=${conversationId}::uuid AND c.active_turn_id=j.id AND ${owned(actor, "c")})
			RETURNING j.id
		), conv AS (
			UPDATE conversation c SET active_turn_id=NULL,active_session_id=NULL,last_sequence=c.last_sequence+1,updated_at=clock_timestamp()
			WHERE c.id=${conversationId}::uuid AND c.active_turn_id=${turnId}::uuid AND ${owned(actor, "c")}
				AND (EXISTS(SELECT FROM ended) OR EXISTS(SELECT FROM job j WHERE j.id=${turnId}::uuid AND j.state IN ${TERMINAL_JOB}))
			RETURNING c.id,c.last_sequence
		)
		INSERT INTO conversation_event(conversation_id,sequence,turn_id,kind,body)
		SELECT id,last_sequence,${turnId}::uuid,'status',${JSON.stringify(interrupted())}::jsonb FROM conv RETURNING sequence`);
	return r.rows.length > 0;
}

/**
 * evry.cancelTurn: stops the active run. Model work and new tool scheduling end at the worker's next fenced save; saved
 * messages, results and receipts stay as they are. Cancelling an idle conversation changes nothing.
 */
export async function cancelTurn(db: Database, actor: EvryActor, conversationId: string) {
	const id = parse(uuid, conversationId);
	const r = await db.execute(sql`
		WITH conv AS (
			SELECT c.id,c.active_turn_id FROM conversation c
			WHERE c.id=${id}::uuid AND ${owned(actor, "c")} AND c.active_turn_id IS NOT NULL AND ${currentAuthority(actor)} FOR UPDATE
		), run AS (
			UPDATE job j SET state='cancelled',lease_owner=NULL,lease_until=NULL,error_code='cancelled',finished_at=clock_timestamp(),revision=j.revision+1
			FROM conv WHERE j.id=conv.active_turn_id AND j.state NOT IN ${TERMINAL_JOB}
		), updated AS (
			UPDATE conversation c SET active_turn_id=NULL,active_session_id=NULL,last_sequence=c.last_sequence+1,updated_at=clock_timestamp()
			FROM conv WHERE c.id=conv.id RETURNING c.id,c.tenant_id,c.account_id,c.last_sequence,conv.active_turn_id AS turn_id
		), status AS (
			INSERT INTO conversation_event(conversation_id,sequence,turn_id,kind,body)
			SELECT id,last_sequence,turn_id,'status',jsonb_build_object('state','stopped','reason','cancelled') FROM updated
		), audit AS (
			INSERT INTO audit_event(tenant_id,actor_id,action,kind,subject_type,subject_id,metadata)
			SELECT tenant_id,account_id,'evry.turn_cancelled','supersede','conversation',id,jsonb_build_object('turnId',turn_id) FROM updated
		)
		SELECT (SELECT turn_id FROM updated) AS cancelled,
			EXISTS(SELECT FROM conversation c WHERE c.id=${id}::uuid AND ${owned(actor, "c")}) AS owned`);
	const row = r.rows[0] as { cancelled: string | null; owned: boolean };
	if (!row.owned) throw new EvryRefusal("not_found");
	return { cancelled: row.cancelled !== null, turnId: row.cancelled };
}

/**
 * evry.retryTurn: an explicit new turn with the text of the last message whose run did not complete. The earlier
 * turn's saved results stay; the new turn reads again under the actor's current authority.
 */
export async function retryTurn(db: Database, actor: EvryActor, conversationId: string, raw: unknown) {
	const id = parse(uuid, conversationId);
	const { requestKey: key } = parse(z.strictObject({ requestKey }), raw);
	const r = await db.execute(sql`
		SELECT m.sequence,m.body,
			EXISTS(SELECT FROM conversation_event s WHERE s.conversation_id=c.id AND s.turn_id=m.turn_id AND s.kind='status' AND s.body->>'state'='completed') AS completed,
			(SELECT jsonb_build_object('turnId',k.turn_id,'sequence',k.sequence) FROM conversation_event k WHERE k.conversation_id=c.id AND k.request_key=${key}) AS known
		FROM conversation c
		JOIN LATERAL (SELECT * FROM conversation_event e WHERE e.conversation_id=c.id AND e.kind='user_message' ORDER BY e.sequence DESC LIMIT 1) m ON true
		WHERE c.id=${id}::uuid AND ${owned(actor, "c")} AND ${liveAuthority(actor)}`);
	if (!r.rows.length) throw new EvryRefusal("not_found");
	const last = z
		.object({
			sequence: z.coerce.number(),
			body: z.object({ text: z.string(), references: z.array(reference).default([]) }),
			completed: z.boolean(),
			known: submitted.nullable(),
		})
		.parse(r.rows[0]);
	if (last.known) return { ...last.known, replayed: true };
	// Only a turn that did not complete can be retried; a completed answer stays as it is.
	if (last.completed) throw new EvryRefusal("invalid_input");
	return submitTurn(
		db,
		actor,
		id,
		{ requestKey: key, text: last.body.text, references: last.body.references },
		last.sequence,
	);
}
