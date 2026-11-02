import { requestIdentity, type RequestIdentity } from "@everyfield/contracts/common";
import * as c from "@everyfield/contracts/phases";
import type { Database, Transaction } from "@everyfield/db/client";
import { sql } from "@everyfield/db/query";
import { randomUUID } from "node:crypto";
import "server-only";
import { z } from "zod";
import type { RequestActor } from "../access/session.ts";
import { hash } from "../operations/canonical.ts";
import { auditTransaction } from "../operations/writes.ts";
import { declarable, deny, entryJson, entryOf, parse, scopeOf, settle, type Scope } from "./core.ts";
import { declaration } from "./declaration.ts";

/** A committed forward move and the current Owners and Admins of each connected sending church or network. */
export type PhaseAdvance = {
	plant: { id: string; name: string };
	transitionId: string;
	fromPhase: c.PhaseNumber;
	toPhase: c.PhaseNumber;
	recipients: {
		organizationId: string;
		organizationKind: "sending_church" | "sending_network";
		accountId: string;
		address: string;
	}[];
};
/** Queues the phase-advance notices in the move's transaction (NTF-009): the notification service's port. */
export type PhaseNotices = (tx: Transaction, advance: PhaseAdvance) => Promise<unknown>;

/** The stored answer of an earlier request with this key, read in the write statement. */
const priorKey = (scope: Scope, requestKey: string) =>
	sql`prior AS (SELECT a.request_identity,a.result FROM audit_event a WHERE a.tenant_id=${scope.plantId}::uuid AND a.request_key=${requestKey})`;
/** The plant row locked for the change, unless the key already has an answer or the seat no longer may change it. */
const locked = (scope: Scope) =>
	sql`cur AS (SELECT p.id,p.name,p.phase,p.revision FROM plant p WHERE p.id=${scope.plantId}::uuid AND (SELECT ok FROM gate)
 AND NOT EXISTS(SELECT FROM prior) FOR UPDATE)`;
const priorRow = z.object({ request_identity: z.unknown(), result: z.unknown() }).nullable();
const outcomeRow = z.object({ ok: z.boolean().nullable(), result: z.unknown().nullable(), prior: priorRow });

/** The request's identity, kept on its audit row: a retry with the same key and the same request replays it. */
function identityOf(
	scope: Scope,
	operation: "phases.declare" | "phases.transition",
	q: { requestKey: string; expectedRevision: string; input: unknown },
) {
	return requestIdentity.parse({
		owner: { kind: "plant", id: scope.plantId },
		actorId: scope.accountId,
		operation,
		requestKey: q.requestKey,
		digest: hash({ operation, expectedRevision: q.expectedRevision, input: q.input }),
	});
}
/** A stored answer for this key: the same request replays it; another request with the key is refused. */
function replay(prior: NonNullable<z.infer<typeof priorRow>>, identity: RequestIdentity) {
	const stored = requestIdentity.safeParse(prior.request_identity);
	if (
		!stored.success ||
		stored.data.actorId !== identity.actorId ||
		stored.data.operation !== identity.operation ||
		stored.data.digest !== identity.digest
	)
		deny("idempotency_conflict");
	return prior.result;
}
/**
 * Why a change wrote nothing, read once after the refusal: a stored answer for the key (a concurrent same-key request
 * won), no live Owner or Admin seat, a used declaration slot, or a newer revision than the one reviewed.
 */
async function refusal(db: Pick<Database, "execute">, scope: Scope, requestKey: string) {
	const { rows } = await db.execute(sql`WITH ${priorKey(scope, requestKey)}
 SELECT ${scope.admin} AS ok,(SELECT to_jsonb(prior) FROM prior) AS prior,p.phase,p.revision::text AS revision,
 ${declarable(sql`p.id`)} AS declarable FROM plant p WHERE p.id=${scope.plantId}::uuid`);
	const r = z
		.object({ ok: z.boolean(), prior: priorRow, phase: c.phaseNumber, revision: z.string(), declarable: z.boolean() })
		.parse(rows[0]);
	return { ...r, state: c.journeyState.parse({ phase: r.phase, revision: r.revision, declarable: r.declarable }) };
}

const declared = z.object({ phase: c.phaseNumber, revision: z.string(), entry: z.unknown() });
const moved = z.object({
	outcome: z.enum(["moved", "noop"]),
	receiptId: z.uuid(),
	phase: c.phaseNumber,
	revision: z.string(),
	declarable: z.boolean(),
	entry: z.unknown().nullable(),
});
const declareAnswer = (raw: unknown): c.DeclareResult => {
	const r = declared.parse(raw);
	return c.declareResult.parse({
		state: { phase: r.phase, revision: r.revision, declarable: false },
		entry: entryOf(r.entry),
	});
};
const transitionAnswer = (raw: unknown): c.TransitionResult => {
	const r = moved.parse(raw);
	const state = c.journeyState.parse({ phase: r.phase, revision: r.revision, declarable: r.declarable });
	return c.transitionResult.parse(
		r.outcome === "noop"
			? { outcome: "noop", receiptId: r.receiptId, state }
			: { outcome: "moved", receiptId: r.receiptId, state, entry: entryOf(r.entry) },
	);
};

/**
 * phases.appendConsequences (PHASE-005, NTF-009): what a committed move adds in its own transaction. The move's audit
 * row is its one typed phase.changed record (action phase.transitioned), written with the move. A forward move, a skip
 * included, also queues one phase-advance notice for each connected organization's current Owners and Admins. A
 * declaration, a backward move, a noop and a replay add nothing, and no move requests an assessment.
 */
async function appendConsequences(tx: Transaction, notices: PhaseNotices, advance: PhaseAdvance) {
	// The move statement reads recipients only for a forward move, so a backward move has none.
	if (advance.recipients.length) await notices(tx, advance);
}

const recipientRow = z.object({
	organizationId: z.uuid(),
	organizationKind: z.enum(["sending_church", "sending_network"]),
	accountId: z.uuid(),
	address: z.email(),
});

export function createPhaseWriter(config: { notices: PhaseNotices }) {
	return {
		/**
		 * phases.declare (PHASE-001): once per plant, where it already was when it joined. One statement, no transaction:
		 * the live Owner or Admin seat, the locked plant at the reviewed revision, the declaration row, the plant's phase
		 * and revision and the audit row that keeps the answer for the request key.
		 */
		async declare(db: Database, authority: RequestActor, raw: unknown) {
			return settle(async () => {
				const scope = scopeOf(authority);
				const q = parse(c.declareRequest, raw);
				const identity = identityOf(scope, "phases.declare", q);
				const op = randomUUID();
				const { rows } =
					await db.execute(sql`WITH gate AS (SELECT ${scope.admin} AS ok), ${priorKey(scope, q.requestKey)},
 ${locked(scope)}, fit AS (SELECT * FROM cur WHERE revision=${q.expectedRevision}::bigint),
 ${declaration(sql`fit`, q.input.phase, op)},
 bumped AS (UPDATE plant p SET phase=d.to_phase,revision=p.revision+1 FROM declared d WHERE p.id=d.plant_id RETURNING p.revision),
 answer AS (SELECT jsonb_build_object('phase',d.to_phase,'revision',(SELECT revision::text FROM bumped),
  'entry',${entryJson(sql`d`, sql`${scope.accountId}::uuid`)}) AS v FROM declared d),
 aud AS (INSERT INTO audit_event(id,tenant_id,actor_id,action,kind,subject_type,subject_id,before_value,after_value,
  before_revision,after_revision,request_key,request_identity,result,metadata)
  SELECT ${op}::uuid,${scope.plantId}::uuid,${scope.accountId}::uuid,'phase.declared','create','plant',${scope.plantId}::uuid,
  jsonb_build_object('phase',d.from_phase),jsonb_build_object('phase',d.to_phase),f.revision,(SELECT revision FROM bumped),
  ${q.requestKey},${JSON.stringify(identity)}::jsonb,(SELECT v FROM answer),jsonb_build_object('transitionId',d.id)
  FROM declared d, fit f)
 SELECT (SELECT ok FROM gate) AS ok,(SELECT v FROM answer) AS result,(SELECT to_jsonb(prior) FROM prior) AS prior`);
				const r = outcomeRow.parse(rows[0]);
				if (r.prior) return declareAnswer(replay(r.prior, identity));
				if (r.result) return declareAnswer(r.result);
				const why = await refusal(db, scope, q.requestKey);
				if (why.prior) return declareAnswer(replay(why.prior, identity));
				if (!why.ok) deny("access_denied");
				if (!why.declarable) deny("already_declared");
				deny("revision_conflict", { state: why.state });
			});
		},

		/**
		 * phases.transition (PHASE-002, PHASE-003): a reasoned move to any phase 0 to 6, from the reviewed revision. The
		 * server reads `from` from the locked plant. The same phase records a noop receipt and changes nothing else. One
		 * transaction: the move statement (transition row, plant phase and revision, audit row with the answer), then its
		 * consequences. A failed consequence rolls the move back.
		 */
		async transition(db: Database, authority: RequestActor, raw: unknown) {
			return settle(async () => {
				const scope = scopeOf(authority);
				const q = parse(c.transitionRequest, raw);
				const checked = c.checkReason(q.input.reason);
				if (!checked.ok) deny("invalid_reason", { problem: checked.problem });
				const identity = identityOf(scope, "phases.transition", q);
				const to = q.input.toPhase;
				// Two requests with one key can both reach a same-phase receipt: auditTransaction reruns the second, which then
				// meets the stored key and replays it.
				const answer = await auditTransaction(db, async (tx) => {
					const op = randomUUID();
					const { rows } =
						await tx.execute(sql`WITH gate AS (SELECT ${scope.admin} AS ok), ${priorKey(scope, q.requestKey)},
 ${locked(scope)}, fit AS (SELECT * FROM cur WHERE revision=${q.expectedRevision}::bigint),
 step AS (INSERT INTO phase_transition(plant_id,kind,from_phase,to_phase,reason,occurred_at,recorded_at,operation_id)
  SELECT f.id,CASE WHEN f.phase=${to}::int THEN 'noop' ELSE 'movement' END,f.phase,${to}::int,${checked.reason},
  clock_timestamp(),clock_timestamp(),${op}::uuid FROM fit f RETURNING *),
 bumped AS (UPDATE plant p SET phase=m.to_phase,revision=p.revision+1 FROM step m WHERE p.id=m.plant_id AND m.kind='movement'
  RETURNING p.revision),
 answer AS (SELECT jsonb_build_object('outcome',CASE m.kind WHEN 'noop' THEN 'noop' ELSE 'moved' END,'receiptId',m.id,
  'phase',m.to_phase,'revision',coalesce((SELECT revision FROM bumped),f.revision)::text,
  'declarable',m.kind='noop' AND ${declarable(sql`f.id`)},
  'entry',CASE WHEN m.kind='movement' THEN ${entryJson(sql`m`, sql`${scope.accountId}::uuid`)} END) AS v FROM step m, fit f),
 aud AS (INSERT INTO audit_event(id,tenant_id,actor_id,action,kind,subject_type,subject_id,before_value,after_value,
  before_revision,after_revision,request_key,request_identity,result,metadata)
  SELECT ${op}::uuid,${scope.plantId}::uuid,${scope.accountId}::uuid,'phase.transitioned',
  CASE m.kind WHEN 'noop' THEN 'noop' ELSE 'edit' END,'plant',${scope.plantId}::uuid,jsonb_build_object('phase',m.from_phase),
  jsonb_build_object('phase',m.to_phase),f.revision,coalesce((SELECT revision FROM bumped),f.revision),${q.requestKey},
  ${JSON.stringify(identity)}::jsonb,(SELECT v FROM answer),jsonb_build_object('transitionId',m.id,'kind',m.kind)
  FROM step m, fit f),
 recipients AS (SELECT DISTINCT o.id AS "organizationId",o.kind AS "organizationKind",s.account_id AS "accountId",
  ac.email AS address FROM step m
  JOIN affiliation a ON a.plant_id=m.plant_id AND a.ended_at IS NULL AND a.accepted_at<=clock_timestamp()
  JOIN organization o ON o.id=a.organization_id
  JOIN seat s ON s.organization_id=o.id AND s.role IN ('owner','admin') AND s.ended_at IS NULL AND s.accepted_at<=clock_timestamp()
  CROSS JOIN LATERAL access_account_contact(s.account_id) ac
  WHERE m.kind='movement' AND m.to_phase>m.from_phase)
 SELECT (SELECT ok FROM gate) AS ok,(SELECT v FROM answer) AS result,(SELECT to_jsonb(prior) FROM prior) AS prior,
  (SELECT row_to_json(m) FROM step m) AS moved,(SELECT name FROM cur) AS plant_name,
  coalesce((SELECT jsonb_agg(to_jsonb(r)) FROM recipients r),'[]') AS recipients`);
					const r = outcomeRow
						.extend({
							moved: z.unknown().nullable(),
							plant_name: z.string().nullable(),
							recipients: z.array(recipientRow),
						})
						.parse(rows[0]);
					if (r.prior) return transitionAnswer(replay(r.prior, identity));
					if (!r.result) return null;
					const answer = transitionAnswer(r.result);
					if (answer.outcome === "moved") {
						const m = z.object({ id: z.uuid(), from_phase: c.phaseNumber, to_phase: c.phaseNumber }).parse(r.moved);
						await appendConsequences(tx, config.notices, {
							plant: { id: scope.plantId, name: r.plant_name ?? "" },
							transitionId: m.id,
							fromPhase: m.from_phase,
							toPhase: m.to_phase,
							recipients: r.recipients,
						});
					}
					return answer;
				});
				if (answer) return answer;
				const why = await refusal(db, scope, q.requestKey);
				if (why.prior) return transitionAnswer(replay(why.prior, identity));
				if (!why.ok) deny("access_denied");
				deny("revision_conflict", { state: why.state });
			});
		},
	};
}
export type PhaseWriter = ReturnType<typeof createPhaseWriter>;
