import type { Clock } from "@everyfield/contracts/common";
import * as c from "@everyfield/contracts/intelligence";
import type { Database } from "@everyfield/db/client";
import { sql, type SQL } from "@everyfield/db/query";
import { createHash, randomUUID } from "node:crypto";
import "server-only";
import { z } from "zod";
import { liveRead, type RequestActor } from "../access/session.ts";
import { plantViewer } from "../documents/access.ts";

// Manual signals and leadership-candidate attestations (WP-039 slice 2, REQ-PI-014, REQ-PI-015, REQ-TEAM-017). A signal
// or candidate is one current row of `attestation` plus an append-only `attestation_revision` for every answer,
// correction, retraction and "Still true". Each write is one SQL statement: the live Owner or Admin check of the exact
// church, the reviewed revision, the new current row, its revision and one audit row. Another admin's save from the same
// revision finds the row already moved and writes nothing. A write never touches a team, role, task, phase, notice or
// assessment (REQ-TEAM-017); only a human session reaches these operations, never a model or private care.

type Code = c.SignalError["code"];
class Refusal extends Error {
	constructor(readonly code: Code) {
		super(code);
	}
}
function deny(code: Code): never {
	throw new Refusal(code);
}
const refused = (code: Code) =>
	({
		status: "refused",
		error: c.signalError.parse({
			code,
			details: {},
			correlationId: randomUUID(),
			retry: code === "revision_conflict" || code === "not_current" ? "refresh" : "never",
		}),
	}) as const;
async function settle<T>(body: () => Promise<T>): Promise<c.SignalReply<T>> {
	try {
		return { status: "ok", value: await body() };
	} catch (error) {
		if (!(error instanceof Refusal)) throw error;
		return refused(error.code);
	}
}
function parse<S extends z.ZodType>(schema: S, raw: unknown): z.output<S> {
	const found = schema.safeParse(raw);
	if (!found.success) deny("invalid_input");
	return found.data;
}

/** The author (the request's own account), the church, the live Owner or Admin condition and the clock. */
type Scope = { me: string; plant: string; ok: SQL; at: SQL };
function scopeOf(authority: RequestActor, clock?: Clock): Scope {
	const viewer = plantViewer(authority);
	if (!viewer || viewer.access.role === "member") deny("access_denied");
	return {
		me: viewer.accountId,
		plant: viewer.plantId,
		ok: liveRead(viewer.access, true),
		at: clock ? sql`${new Date(clock.now()).toISOString()}::timestamptz` : sql`statement_timestamp()`,
	};
}

const iso = (value: SQL) => sql`to_char(${value} AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;
/** The name an author shows under: their own Person in this church. Null when the account has none. */
const nameOf = (account: SQL, s: Scope) =>
	sql`(SELECT np.display_name FROM person np WHERE np.tenant_id=${s.plant}::uuid AND np.linked_account_id=${account} LIMIT 1)`;
/** One revision row `r` as a signal or candidate states it. */
const stateJson = (r: SQL, s: Scope, revision: SQL = sql`${r}.revision`) =>
	sql`jsonb_build_object('key',${r}.key,'kind',${r}.kind,'answer',${r}.answer,'asOf',${r}.as_of,'detail',${r}.detail,
 'reference',${r}.reference,'revision',(${revision})::text,'authorName',${nameOf(sql`${r}.author_id`, s)},
 'recordedAt',${iso(sql`${r}.recorded_at`)},'periodStart',${r}.period_start,'periodEnd',${r}.period_end,
 'attended',${r}.attendance_continuous,'volunteered',${r}.volunteering_continuous)`;
/** The church's own calendar day for the statement clock. */
const todayOf = (s: Scope) =>
	sql`(SELECT (${s.at} AT TIME ZONE pl.timezone)::date FROM plant pl WHERE pl.id=${s.plant}::uuid)`;
const todayText = (s: Scope) => sql`(${todayOf(s)})::text`;

const stateRow = z.object({
	key: z.string(),
	kind: z.enum(["answered", "corrected", "retracted", "reaffirmed"]),
	answer: z.boolean().nullable(),
	asOf: c.signalEntry.shape.asOf.unwrap(),
	detail: z.string().nullable(),
	reference: z.string().nullable(),
	revision: z.string(),
	authorName: z.string().nullable(),
	recordedAt: c.signalEntry.shape.recordedAt.unwrap(),
	periodStart: z.string().nullable(),
	periodEnd: z.string().nullable(),
	attended: z.boolean().nullable(),
	volunteered: z.boolean().nullable(),
});
type StateRow = z.infer<typeof stateRow>;

/** One signal from its latest revision (null when never answered) and the church's today. */
function signalFrom(key: c.SignalKey, row: StateRow | null, today: string): c.SignalEntry {
	if (!row)
		return c.signalEntry.parse({
			key,
			state: "unanswered",
			value: null,
			asOf: null,
			detail: null,
			reference: null,
			authorName: null,
			recordedAt: null,
			revision: "0",
			ageDays: null,
			renewal: { status: "unknown" },
		});
	const answered = row.kind !== "retracted";
	const age = Math.max(0, c.daysBetween(row.asOf, today));
	return c.signalEntry.parse({
		key,
		state: answered ? "answered" : "retracted",
		value: !answered ? null : row.answer ? "yes" : "not_yet",
		asOf: row.asOf,
		detail: answered ? row.detail : null,
		reference: answered ? row.reference : null,
		authorName: row.authorName,
		recordedAt: row.recordedAt,
		revision: row.revision,
		ageDays: answered ? age : null,
		renewal: c.renewalOf(key, answered ? "answered" : "retracted", answered ? age : null),
	});
}

/** A candidate from its latest revision. Established only when both behaviors are attested over 60 inclusive days. */
function candidateFrom(row: StateRow & { personId: string; personName: string }): c.CandidateEntry {
	const answered = row.kind !== "retracted";
	const days = c.daysBetween(row.periodStart!, row.periodEnd!) + 1;
	const reasons: c.CandidateReason[] = [];
	if (answered) {
		if (!row.attended) reasons.push("attendance_not_attested");
		if (!row.volunteered) reasons.push("volunteering_not_attested");
		if (days < c.CANDIDATE_DAYS) reasons.push("period_too_short");
	}
	return c.candidateEntry.parse({
		personId: row.personId,
		personName: row.personName,
		state: answered ? "answered" : "retracted",
		attended: row.attended,
		volunteered: row.volunteered,
		periodStart: row.periodStart,
		periodEnd: row.periodEnd,
		days,
		established: answered && reasons.length === 0,
		reasons,
		asOf: row.asOf,
		statement: answered ? row.detail : null,
		authorName: row.authorName,
		recordedAt: row.recordedAt,
		revision: row.revision,
	});
}

const historyJson = (r: SQL, s: Scope) =>
	sql`jsonb_build_object('id',${r}.id,'key',${r}.key,'revision',${r}.revision,'kind',${r}.kind,'answer',${r}.answer,
 'asOf',${r}.as_of,'detail',${r}.detail,'reference',${r}.reference,'personId',${r}.person_id,
 'personName',(SELECT pe.display_name FROM person pe WHERE pe.id=${r}.person_id AND pe.tenant_id=${s.plant}::uuid),
 'periodStart',${r}.period_start,'periodEnd',${r}.period_end,'attended',${r}.attendance_continuous,
 'volunteered',${r}.volunteering_continuous,'authorName',${nameOf(sql`${r}.author_id`, s)},
 'recordedAt',${iso(sql`${r}.recorded_at`)},'questionVersion',${r}.question_version)`;
const historyRow = z.object({
	id: z.uuid(),
	key: z.string(),
	revision: z.number(),
	kind: z.enum(["answered", "corrected", "retracted", "reaffirmed"]),
	answer: z.boolean().nullable(),
	asOf: z.string(),
	detail: z.string().nullable(),
	reference: z.string().nullable(),
	personId: z.uuid().nullable(),
	personName: z.string().nullable(),
	periodStart: z.string().nullable(),
	periodEnd: z.string().nullable(),
	attended: z.boolean().nullable(),
	volunteered: z.boolean().nullable(),
	authorName: z.string().nullable(),
	recordedAt: z.string(),
	questionVersion: z.string(),
});
const revisionOf = ({ answer, ...row }: z.infer<typeof historyRow>): c.HumanRevision =>
	c.humanRevision.parse({ ...row, value: answer === null ? null : answer ? "yes" : "not_yet" });

const fingerprint = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const nullable = (value: string | null | undefined) => value ?? null;

const pageRow = z.object({
	ok: z.boolean().nullable(),
	zone: z.string().nullable(),
	today: z.string().nullable(),
	signals: z.array(stateRow),
	candidates: z.array(stateRow.extend({ personId: z.uuid(), personName: z.string() })),
	people: z.array(z.object({ id: z.uuid(), displayName: z.string(), candidateRevision: z.string() })),
	history: z.array(historyRow),
});
/** How many Persons the candidate picker offers and how many revisions the page shows. */
const PEOPLE_LIMIT = 500;
const PAGE_HISTORY = 300;
const HISTORY_LIMIT = 1000;
const MANUAL = sql.join(
	c.SIGNAL_KEYS.map((k) => sql`${k}`),
	sql`,`,
);

/** The one audit row of a write, for each attestation row in `from`. */
const audit = (s: Scope, action: "recorded" | "corrected", from: SQL) =>
	sql`INSERT INTO audit_event(tenant_id,actor_id,action,kind,subject_id,occurred_at,recorded_at,event_key,after_revision,metadata)
  SELECT x.plant_id,${s.me}::uuid,${"attestation." + action},${action === "recorded" ? "create" : "correct"},x.id,${s.at},${s.at},
  'attestation:'||x.id||':'||x.revision,x.revision,jsonb_build_object('key',x.key) FROM ${from} x RETURNING 1`;
/** The revision row of a manual-signal write, for each attestation row in `from`. */
const signalRevision = (s: Scope, kind: c.HumanRevision["kind"], key: string, print: string, from: SQL) =>
	sql`INSERT INTO attestation_revision(plant_id,attestation_id,revision,key,kind,answer,as_of,detail,reference,
  question_version,author_id,request_key,request_fingerprint,recorded_at)
  SELECT x.plant_id,x.id,x.revision,x.key,${kind},x.answer,x.as_of,x.statement,x.source_description,
  ${c.SIGNAL_QUESTION_VERSION},${s.me}::uuid,${key},${print},${s.at} FROM ${from} x RETURNING *`;

const writeRow = z.object({
	ok: z.boolean().nullable(),
	today: z.string().nullable(),
	prior: z.object({ fingerprint: z.string(), state: z.unknown() }).nullable(),
	cur: z
		.object({ state: z.string(), revision: z.string(), answer: z.boolean().nullable(), same: z.boolean().nullable() })
		.nullable(),
	person: z.object({ name: z.string() }).nullable().optional(),
	written: z.unknown().nullable(),
});
type WriteRow = z.infer<typeof writeRow>;

/** A unique request key that a concurrent request took first. */
const keyTaken = (error: unknown) =>
	(error as { code?: string; constraint?: string })?.code === "23505" &&
	(error as { constraint?: string }).constraint === "attestation_revision_uq_1";

export function createSignals(config: { clock?: Clock } = {}) {
	/** Runs a write statement; a key a concurrent request took first reads that request's answer instead. */
	async function write(db: Pick<Database, "execute">, s: Scope, key: string, statement: SQL): Promise<WriteRow> {
		try {
			return writeRow.parse((await db.execute(statement)).rows[0]);
		} catch (error) {
			if (!keyTaken(error)) throw error;
			const { rows } = await db.execute(sql`WITH gate AS (SELECT ${s.ok} AS ok)
 SELECT (SELECT ok FROM gate) AS ok,${todayText(s)} AS today,
 (SELECT jsonb_build_object('fingerprint',r.request_fingerprint,'state',${stateJson(sql`r`, s)}) FROM attestation_revision r
  WHERE r.plant_id=${s.plant}::uuid AND r.request_key=${key} AND (SELECT ok FROM gate)) AS prior,NULL AS cur,
 (SELECT jsonb_build_object('name',pe.display_name) FROM person pe JOIN attestation_revision r ON r.person_id=pe.id
  WHERE r.plant_id=${s.plant}::uuid AND r.request_key=${key} AND pe.tenant_id=r.plant_id AND (SELECT ok FROM gate)) AS person,NULL AS written`);
			return writeRow.parse(rows[0]);
		}
	}
	/** The shared CTEs of every write: the gate, the church's today and an earlier write with this request key. */
	const opening = (s: Scope, key: string) => sql`gate AS (SELECT ${s.ok} AS ok),
 prior AS (SELECT r.* FROM attestation_revision r WHERE r.plant_id=${s.plant}::uuid AND r.request_key=${key}
  AND (SELECT ok FROM gate))`;
	const closing = (s: Scope) => sql`(SELECT ok FROM gate) AS ok,${todayText(s)} AS today,
 (SELECT jsonb_build_object('fingerprint',p.request_fingerprint,'state',${stateJson(sql`p`, s)}) FROM prior p) AS prior`;

	/** The tail of a signal write: the current row as it was and the revision it wrote. */
	const signalClosing = (s: Scope) => sql`${closing(s)},
 (SELECT jsonb_build_object('state',cur.state,'revision',cur.revision::text,'answer',cur.answer,'same',NULL::boolean) FROM cur) AS cur,
 (SELECT ${stateJson(sql`x`, s)} FROM rev x) AS written`;

	/** Replays an earlier write of the same request, or refuses a different request that reuses its key. */
	function replayOf(r: WriteRow, print: string) {
		if (!r.prior) return null;
		if (r.prior.fingerprint !== print) deny("idempotency_conflict");
		return { state: stateRow.parse(r.prior.state), today: r.today! };
	}

	/** The result of a signal write that saved now or earlier under the same request key; null otherwise. */
	function signalSaved(r: WriteRow, print: string, key: c.SignalKey) {
		const replay = replayOf(r, print);
		if (replay)
			return c.signalWriteResult.parse({ outcome: "saved", signal: signalFrom(key, replay.state, replay.today) });
		if (!r.ok) deny("access_denied");
		if (!r.written) return null;
		return c.signalWriteResult.parse({
			outcome: "saved",
			signal: signalFrom(key, stateRow.parse(r.written), r.today!),
		});
	}

	/** The refusal or result of a candidate write, in the order a caller can act on them. */
	function candidateOutcome(
		r: WriteRow,
		print: string,
		personId: string,
		asOf: string | undefined,
		periodEnd: string | undefined,
		expected: string,
		correcting = false,
	) {
		const replay = replayOf(r, print);
		const named = (state: StateRow, name: string) =>
			c.candidateWriteResult.parse({
				outcome: "saved",
				candidate: candidateFrom({ ...state, personId, personName: name }),
			});
		if (replay) {
			// The Person's name is not part of the first result's state: read it back from the candidate fields only.
			return named(replay.state, r.person?.name ?? "Person");
		}
		if (!r.ok) deny("access_denied");
		if (!r.person && !r.written) deny("not_found");
		if (r.written) return named(stateRow.parse(r.written), r.person!.name);
		if (asOf && asOf > r.today!) deny("invalid_input");
		if (periodEnd && periodEnd > (asOf ?? r.today!)) deny("invalid_input");
		if (!r.cur) deny(correcting ? "not_current" : "revision_conflict");
		if (r.cur.revision !== expected) deny("revision_conflict");
		if (correcting) {
			if (r.cur.state !== "answered") deny("not_current");
			if (r.cur.same) deny("no_change");
		}
		return deny("revision_conflict");
	}

	return {
		/** signals.listDefinitions (PI-015): the seven keys in their order. Static; it reads no answer or author. */
		listDefinitions(raw: unknown = {}): c.SignalReply<c.SignalDefinition[]> {
			if (!c.listDefinitionsRequest.safeParse(raw).success) return refused("invalid_input");
			return {
				status: "ok",
				value: c.SIGNAL_DEFINITIONS.map((d) =>
					c.signalDefinition.parse({
						key: d.key,
						label: d.label,
						description: d.description,
						reaffirms: d.reaffirms,
						windowDays: d.reaffirms ? c.REAFFIRM_WINDOW_DAYS : null,
					}),
				),
			};
		},

		/**
		 * The Attestations page (PI-014, PI-015): the seven signals, the counts, the live candidates, the Persons a
		 * candidate can be recorded for and the newest history. One statement, whatever the data size.
		 */
		async readAttestations(db: Pick<Database, "execute">, authority: RequestActor, raw: unknown = {}) {
			return settle(async () => {
				const s = scopeOf(authority, config.clock);
				parse(c.readAttestationsRequest, raw);
				const { rows } = await db.execute(sql`WITH gate AS (SELECT ${s.ok} AS ok),
 ctx AS (SELECT pl.timezone AS zone,(${s.at} AT TIME ZONE pl.timezone)::date AS today FROM plant pl
  WHERE pl.id=${s.plant}::uuid AND (SELECT ok FROM gate)),
 sig AS (SELECT r.*,a.revision AS cur_rev FROM attestation a
  JOIN LATERAL (SELECT x.* FROM attestation_revision x WHERE x.attestation_id=a.id ORDER BY x.revision DESC LIMIT 1) r ON true
  WHERE a.plant_id=${s.plant}::uuid AND a.person_id IS NULL AND a.key IN (${MANUAL}) AND (SELECT ok FROM gate)),
 cand AS (SELECT r.*,a.revision AS cur_rev,pe.id AS pid,pe.display_name AS pname FROM attestation a
  JOIN LATERAL (SELECT x.* FROM attestation_revision x WHERE x.attestation_id=a.id ORDER BY x.revision DESC LIMIT 1) r ON true
  JOIN person pe ON pe.id=a.person_id AND pe.tenant_id=a.plant_id AND pe.state='live'
  WHERE a.plant_id=${s.plant}::uuid AND a.key='leadership_candidate' AND (SELECT ok FROM gate)),
 ppl AS (SELECT pe.id,pe.display_name,coalesce(a.revision,0) AS rev FROM person pe
  LEFT JOIN attestation a ON a.person_id=pe.id AND a.plant_id=pe.tenant_id AND a.key='leadership_candidate'
  WHERE pe.tenant_id=${s.plant}::uuid AND pe.state='live' AND (SELECT ok FROM gate)
  ORDER BY pe.display_name,pe.id LIMIT ${PEOPLE_LIMIT}),
 hist AS (SELECT r.* FROM attestation_revision r WHERE r.plant_id=${s.plant}::uuid AND (SELECT ok FROM gate)
  ORDER BY r.recorded_at DESC,r.revision DESC,r.id LIMIT ${PAGE_HISTORY})
 SELECT (SELECT ok FROM gate) AS ok,(SELECT zone FROM ctx) AS zone,(SELECT today FROM ctx)::text AS today,
 coalesce((SELECT jsonb_agg(${stateJson(sql`x`, s, sql`x.cur_rev`)}) FROM sig x),'[]'::jsonb) AS signals,
 coalesce((SELECT jsonb_agg(${stateJson(sql`x`, s, sql`x.cur_rev`)}||jsonb_build_object('personId',x.pid,'personName',x.pname)
  ORDER BY x.recorded_at DESC) FROM cand x),'[]'::jsonb) AS candidates,
 coalesce((SELECT jsonb_agg(jsonb_build_object('id',p.id,'displayName',p.display_name,'candidateRevision',p.rev::text)
  ORDER BY p.display_name,p.id) FROM ppl p),'[]'::jsonb) AS people,
 coalesce((SELECT jsonb_agg(${historyJson(sql`h`, s)} ORDER BY h.recorded_at DESC,h.revision DESC,h.id) FROM hist h),'[]'::jsonb) AS history`);
				const r = pageRow.parse(rows[0]);
				if (!r.ok || !r.zone || !r.today) deny("access_denied");
				const byKey = new Map(r.signals.map((x) => [x.key, x]));
				const signals = c.SIGNAL_KEYS.map((k) => signalFrom(k, byKey.get(k) ?? null, r.today!));
				return c.attestationsPage.parse({
					zone: r.zone,
					today: r.today,
					signals,
					counts: c.countsOf(signals),
					candidates: r.candidates.map(candidateFrom),
					people: r.people,
					history: r.history.map(revisionOf),
				});
			});
		},

		/** signals.getHistory (PI-014): every revision of one signal, or of all human evidence, newest first. */
		async getHistory(db: Pick<Database, "execute">, authority: RequestActor, raw: unknown) {
			return settle(async () => {
				const s = scopeOf(authority, config.clock);
				const q = parse(c.getHistoryRequest, raw);
				const { rows } = await db.execute(sql`WITH gate AS (SELECT ${s.ok} AS ok),
 hist AS (SELECT r.* FROM attestation_revision r WHERE r.plant_id=${s.plant}::uuid AND (SELECT ok FROM gate)
  AND ${q.key === null ? sql`true` : sql`r.key=${q.key} AND r.person_id IS NULL`}
  ORDER BY r.recorded_at DESC,r.revision DESC,r.id LIMIT ${HISTORY_LIMIT})
 SELECT (SELECT ok FROM gate) AS ok,
 coalesce((SELECT jsonb_agg(${historyJson(sql`h`, s)} ORDER BY h.recorded_at DESC,h.revision DESC,h.id) FROM hist h),'[]'::jsonb) AS history`);
				const r = z.object({ ok: z.boolean().nullable(), history: z.array(historyRow) }).parse(rows[0]);
				if (!r.ok) deny("access_denied");
				return c.historyResult.parse({ revisions: r.history.map(revisionOf) });
			});
		},

		/**
		 * signals.attest (PI-014, PI-015): the first answer of a signal, or a new answer after a retraction. One statement.
		 * The signal is answered Yes or Not yet, true as of a date no later than today in the church's zone.
		 */
		async attest(db: Pick<Database, "execute">, authority: RequestActor, raw: unknown) {
			return settle(async () => {
				const s = scopeOf(authority, config.clock);
				const q = parse(c.attestRequest, raw);
				const i = q.input;
				const print = fingerprint([
					"attest",
					i.key,
					i.value,
					i.asOf ?? null,
					c.textOf(i.detail),
					c.textOf(i.reference),
					q.expectedRevision,
				]);
				const r = await write(
					db,
					s,
					q.requestKey,
					sql`WITH ${opening(s, q.requestKey)},
 ctx AS (SELECT ${todayOf(s)} AS today),
 cur AS (SELECT a.* FROM attestation a WHERE a.plant_id=${s.plant}::uuid AND a.key=${i.key} AND a.person_id IS NULL
  AND (SELECT ok FROM gate) FOR UPDATE),
 want AS (SELECT coalesce(${nullable(i.asOf)}::date,x.today) AS as_of FROM ctx x WHERE (SELECT ok FROM gate)
  AND NOT EXISTS(SELECT FROM prior) AND coalesce(${nullable(i.asOf)}::date,x.today)<=x.today),
 born AS (INSERT INTO attestation(plant_id,key,state,answer,as_of,attested_at,statement,source_description,revision)
  SELECT ${s.plant}::uuid,${i.key},'answered',${i.value === "yes"},w.as_of,${s.at},${c.textOf(i.detail)},${c.textOf(i.reference)},1
  FROM want w WHERE ${q.expectedRevision}::bigint=0 AND NOT EXISTS(SELECT FROM cur) ON CONFLICT DO NOTHING RETURNING *),
 again AS (UPDATE attestation a SET state='answered',answer=${i.value === "yes"},as_of=w.as_of,attested_at=${s.at},
  statement=${c.textOf(i.detail)},source_description=${c.textOf(i.reference)},revision=a.revision+1
  FROM want w, cur WHERE a.id=cur.id AND a.state='retracted' AND a.revision=${q.expectedRevision}::bigint RETURNING a.*),
 changed AS (SELECT * FROM born UNION ALL SELECT * FROM again),
 rev AS (${signalRevision(s, "answered", q.requestKey, print, sql`changed`)}),
 aud AS (${audit(s, "recorded", sql`changed`)})
 SELECT ${signalClosing(s)}`,
				);
				const saved = signalSaved(r, print, i.key);
				if (saved) return saved;
				if (i.asOf && i.asOf > r.today!) deny("invalid_input");
				return deny("revision_conflict");
			});
		},

		/**
		 * signals.correct (PI-014): change a current answer to the other value, or retract it. The earlier answer stays in
		 * the history. A correction to the same value is refused as no change and adds no revision.
		 */
		async correct(db: Pick<Database, "execute">, authority: RequestActor, raw: unknown) {
			return settle(async () => {
				const s = scopeOf(authority, config.clock);
				const q = parse(c.correctSignalRequest, raw);
				const i = q.input;
				const retract = i.action === "retract";
				const value = i.action === "correct" ? i.value === "yes" : null;
				const detail = i.action === "correct" ? c.textOf(i.detail) : null;
				const reference = i.action === "correct" ? c.textOf(i.reference) : null;
				const given = i.action === "correct" ? (i.asOf ?? null) : null;
				const print = fingerprint(["correct", i, q.expectedRevision]);
				const r = await write(
					db,
					s,
					q.requestKey,
					sql`WITH ${opening(s, q.requestKey)},
 ctx AS (SELECT ${todayOf(s)} AS today),
 cur AS (SELECT a.* FROM attestation a WHERE a.plant_id=${s.plant}::uuid AND a.key=${i.key} AND a.person_id IS NULL
  AND (SELECT ok FROM gate) FOR UPDATE),
 want AS (SELECT coalesce(${given}::date,x.today) AS as_of FROM ctx x WHERE (SELECT ok FROM gate)
  AND NOT EXISTS(SELECT FROM prior) AND coalesce(${given}::date,x.today)<=x.today),
 edited AS (UPDATE attestation a SET state=${retract ? "retracted" : "answered"},answer=${value}::boolean,as_of=w.as_of,
  attested_at=${s.at},statement=${detail},source_description=${reference},revision=a.revision+1
  FROM want w, cur WHERE a.id=cur.id AND a.state='answered' AND a.revision=${q.expectedRevision}::bigint
  ${retract ? sql`` : sql`AND a.answer IS DISTINCT FROM ${value}::boolean`} RETURNING a.*),
 rev AS (${signalRevision(s, retract ? "retracted" : "corrected", q.requestKey, print, sql`edited`)}),
 aud AS (${audit(s, "corrected", sql`edited`)})
 SELECT ${signalClosing(s)}`,
				);
				const saved = signalSaved(r, print, i.key);
				if (saved) return saved;
				if (given && given > r.today!) deny("invalid_input");
				if (!r.cur) deny("not_current");
				if (r.cur.revision !== q.expectedRevision) deny("revision_conflict");
				if (r.cur.state !== "answered") deny("not_current");
				if (!retract && r.cur.answer === value) deny("no_change");
				return deny("revision_conflict");
			});
		},

		/**
		 * signals.reaffirm (PI-014): "Still true" for one reaffirming signal. It binds the reviewed revision and answer and
		 * moves only that signal's as-of date to today. No other signal changes.
		 */
		async reaffirm(db: Pick<Database, "execute">, authority: RequestActor, raw: unknown) {
			return settle(async () => {
				const s = scopeOf(authority, config.clock);
				const q = parse(c.reaffirmRequest, raw);
				const i = q.input;
				if (!c.SIGNAL_DEFINITIONS.find((d) => d.key === i.key)!.reaffirms) deny("not_reaffirmable");
				const expectedAnswer = i.expectedValue === "yes";
				const print = fingerprint(["reaffirm", i, q.expectedRevision]);
				const r = await write(
					db,
					s,
					q.requestKey,
					sql`WITH ${opening(s, q.requestKey)},
 cur AS (SELECT a.* FROM attestation a WHERE a.plant_id=${s.plant}::uuid AND a.key=${i.key} AND a.person_id IS NULL
  AND (SELECT ok FROM gate) FOR UPDATE),
 edited AS (UPDATE attestation a SET as_of=${todayOf(s)},attested_at=${s.at},revision=a.revision+1
  FROM cur WHERE a.id=cur.id AND a.state='answered' AND a.revision=${q.expectedRevision}::bigint
  AND a.answer=${expectedAnswer} AND NOT EXISTS(SELECT FROM prior) AND (SELECT ok FROM gate) RETURNING a.*),
 rev AS (${signalRevision(s, "reaffirmed", q.requestKey, print, sql`edited`)}),
 aud AS (${audit(s, "recorded", sql`edited`)})
 SELECT ${signalClosing(s)}`,
				);
				const saved = signalSaved(r, print, i.key);
				if (saved) return saved;
				if (!r.cur) deny("not_current");
				if (r.cur.revision !== q.expectedRevision) deny("revision_conflict");
				if (r.cur.state !== "answered") deny("not_current");
				return deny("revision_conflict");
			});
		},

		/**
		 * Records that a named live Person attended and volunteered unbroken over a dated period, or records it again after
		 * a retraction (REQ-PI-014, REQ-TEAM-017). It is a typed Person attestation, not an eighth signal. It changes no
		 * team, role, task, phase or assessment.
		 */
		async attestCandidate(db: Pick<Database, "execute">, authority: RequestActor, raw: unknown) {
			return settle(async () => {
				const s = scopeOf(authority, config.clock);
				const q = parse(c.attestCandidateRequest, raw);
				const i = q.input;
				if (i.periodStart > i.periodEnd) deny("invalid_input");
				const print = fingerprint(["candidate", i, q.expectedRevision]);
				const statement = c.textOf(i.statement);
				const r = await write(
					db,
					s,
					q.requestKey,
					sql`WITH ${opening(s, q.requestKey)},
 ctx AS (SELECT ${todayOf(s)} AS today),
 who AS (SELECT pe.id,pe.display_name FROM person pe WHERE pe.id=${i.personId}::uuid AND pe.tenant_id=${s.plant}::uuid
  AND pe.state='live' AND (SELECT ok FROM gate) FOR SHARE),
 cur AS (SELECT a.* FROM attestation a WHERE a.plant_id=${s.plant}::uuid AND a.key='leadership_candidate'
  AND a.person_id=${i.personId}::uuid AND (SELECT ok FROM gate) FOR UPDATE),
 want AS (SELECT coalesce(${nullable(i.asOf)}::date,x.today) AS as_of FROM ctx x, who WHERE (SELECT ok FROM gate)
  AND NOT EXISTS(SELECT FROM prior) AND coalesce(${nullable(i.asOf)}::date,x.today)<=x.today
  AND ${i.periodEnd}::date<=coalesce(${nullable(i.asOf)}::date,x.today)),
 born AS (INSERT INTO attestation(plant_id,key,person_id,state,as_of,attested_at,period_start,period_end,
  attendance_continuous,volunteering_continuous,statement,revision)
  SELECT ${s.plant}::uuid,'leadership_candidate',${i.personId}::uuid,'answered',w.as_of,${s.at},${i.periodStart}::date,
  ${i.periodEnd}::date,${i.attended},${i.volunteered},${statement},1
  FROM want w WHERE ${q.expectedRevision}::bigint=0 AND NOT EXISTS(SELECT FROM cur) ON CONFLICT DO NOTHING RETURNING *),
 again AS (UPDATE attestation a SET state='answered',as_of=w.as_of,attested_at=${s.at},period_start=${i.periodStart}::date,
  period_end=${i.periodEnd}::date,attendance_continuous=${i.attended},volunteering_continuous=${i.volunteered},
  statement=${statement},revision=a.revision+1
  FROM want w, cur WHERE a.id=cur.id AND a.state='retracted' AND a.revision=${q.expectedRevision}::bigint RETURNING a.*),
 changed AS (SELECT * FROM born UNION ALL SELECT * FROM again),
 rev AS (INSERT INTO attestation_revision(plant_id,attestation_id,revision,key,person_id,kind,as_of,detail,period_start,period_end,
  attendance_continuous,volunteering_continuous,question_version,author_id,request_key,request_fingerprint,recorded_at)
  SELECT x.plant_id,x.id,x.revision,x.key,x.person_id,'answered',x.as_of,x.statement,x.period_start,x.period_end,
  x.attendance_continuous,x.volunteering_continuous,${c.CANDIDATE_QUESTION_VERSION},${s.me}::uuid,${q.requestKey},${print},${s.at}
  FROM changed x RETURNING *),
 aud AS (${audit(s, "recorded", sql`changed`)})
 SELECT ${closing(s)},
 (SELECT jsonb_build_object('state',cur.state,'revision',cur.revision::text,'answer',NULL::boolean,'same',NULL::boolean) FROM cur) AS cur,
 (SELECT jsonb_build_object('name',who.display_name) FROM who) AS person,
 (SELECT ${stateJson(sql`x`, s)} FROM rev x) AS written`,
				);
				return candidateOutcome(r, print, i.personId, i.asOf, i.periodEnd, q.expectedRevision);
			});
		},

		/** Corrects or retracts a candidate attestation. History keeps every earlier statement. */
		async correctCandidate(db: Pick<Database, "execute">, authority: RequestActor, raw: unknown) {
			return settle(async () => {
				const s = scopeOf(authority, config.clock);
				const q = parse(c.correctCandidateRequest, raw);
				const i = q.input;
				const retract = i.action === "retract";
				if (i.action === "correct" && i.periodStart > i.periodEnd) deny("invalid_input");
				const print = fingerprint(["candidate-correct", i, q.expectedRevision]);
				const f = i.action === "correct" ? i : null;
				const statement = f ? c.textOf(f.statement) : null;
				const r = await write(
					db,
					s,
					q.requestKey,
					sql`WITH ${opening(s, q.requestKey)},
 ctx AS (SELECT ${todayOf(s)} AS today),
 who AS (SELECT pe.id,pe.display_name FROM person pe WHERE pe.id=${i.personId}::uuid AND pe.tenant_id=${s.plant}::uuid
  AND pe.state='live' AND (SELECT ok FROM gate) FOR SHARE),
 cur AS (SELECT a.* FROM attestation a WHERE a.plant_id=${s.plant}::uuid AND a.key='leadership_candidate'
  AND a.person_id=${i.personId}::uuid AND (SELECT ok FROM gate) FOR UPDATE),
 want AS (SELECT coalesce(${nullable(f?.asOf)}::date,x.today) AS as_of FROM ctx x, who WHERE (SELECT ok FROM gate)
  AND NOT EXISTS(SELECT FROM prior) AND coalesce(${nullable(f?.asOf)}::date,x.today)<=x.today
  ${f ? sql`AND ${f.periodEnd}::date<=coalesce(${nullable(f.asOf)}::date,x.today)` : sql``}),
 edited AS (UPDATE attestation a SET state=${retract ? "retracted" : "answered"},as_of=w.as_of,attested_at=${s.at},
  ${
		f
			? sql`period_start=${f.periodStart}::date,period_end=${f.periodEnd}::date,attendance_continuous=${f.attended},
  volunteering_continuous=${f.volunteered},statement=${statement},`
			: sql`statement=NULL,`
	}revision=a.revision+1
  FROM want w, cur WHERE a.id=cur.id AND a.state='answered' AND a.revision=${q.expectedRevision}::bigint
  ${
		f
			? sql`AND (a.period_start,a.period_end,a.attendance_continuous,a.volunteering_continuous,a.statement)
  IS DISTINCT FROM (${f.periodStart}::date,${f.periodEnd}::date,${f.attended},${f.volunteered},${statement}::text)`
			: sql``
	}
  AND EXISTS(SELECT FROM who) RETURNING a.*),
 rev AS (INSERT INTO attestation_revision(plant_id,attestation_id,revision,key,person_id,kind,as_of,detail,period_start,period_end,
  attendance_continuous,volunteering_continuous,question_version,author_id,request_key,request_fingerprint,recorded_at)
  SELECT x.plant_id,x.id,x.revision,x.key,x.person_id,${retract ? "retracted" : "corrected"},x.as_of,x.statement,x.period_start,x.period_end,
  x.attendance_continuous,x.volunteering_continuous,${c.CANDIDATE_QUESTION_VERSION},${s.me}::uuid,${q.requestKey},${print},${s.at}
  FROM edited x RETURNING *),
 aud AS (${audit(s, "corrected", sql`edited`)})
 SELECT ${closing(s)},
 (SELECT jsonb_build_object('state',cur.state,'revision',cur.revision::text,'answer',NULL::boolean,
  'same',CASE WHEN ${
		f
			? sql`(cur.period_start,cur.period_end,cur.attendance_continuous,cur.volunteering_continuous,cur.statement)
  IS NOT DISTINCT FROM (${f.periodStart}::date,${f.periodEnd}::date,${f.attended},${f.volunteered},${statement}::text)`
			: sql`false`
	}
  THEN true ELSE false END) FROM cur) AS cur,
 (SELECT jsonb_build_object('name',who.display_name) FROM who) AS person,
 (SELECT ${stateJson(sql`x`, s)} FROM rev x) AS written`,
				);
				return candidateOutcome(r, print, i.personId, f?.asOf, f?.periodEnd, q.expectedRevision, true);
			});
		},
	};
}
export type Signals = ReturnType<typeof createSignals>;
