import type { Clock } from "@everyfield/contracts/common";
import * as c from "@everyfield/contracts/intelligence";
import type { Database, Transaction } from "@everyfield/db/client";
import { sql, type SQL } from "@everyfield/db/query";
import { randomUUID } from "node:crypto";
import "server-only";
import { z } from "zod";
import { liveRead, type RequestActor } from "../access/session.ts";
import { plantViewer } from "../documents/access.ts";

// Private weekly check-ins (WP-039, REQ-PI-038 to REQ-PI-041). A check-in belongs to its original author account and
// church for good: every statement reads and writes only rows whose author is the request's own account, behind the
// live Owner or Admin check of that request's seat (C13). Another author's week, a guessed id and a week that does not
// exist give the same not_found. Nothing here writes a shared audit row, job, notice, log line or trace attribute: the
// week's own revisions are its history (audit.md, private-care boundary).
//
// The author's calendar keeps the zone and instant where its next Monday week starts. A save or zone change first adds
// the weeks that are due, unanswered, so ordinals never skip; reads show due weeks the same way without writing them.

type Code = c.CareError["code"];
class Refusal extends Error {
	constructor(readonly code: Code) {
		super(code);
	}
}
function deny(code: Code): never {
	throw new Refusal(code);
}
async function settle<T>(body: () => Promise<T>): Promise<c.CareReply<T>> {
	try {
		return { status: "ok", value: await body() };
	} catch (error) {
		if (!(error instanceof Refusal)) throw error;
		return {
			status: "refused",
			error: c.careError.parse({
				code: error.code,
				details: {},
				correlationId: randomUUID(),
				retry: error.code === "revision_conflict" ? "refresh" : "never",
			}),
		};
	}
}
function parse<S extends z.ZodType>(schema: S, raw: unknown): z.output<S> {
	const found = schema.safeParse(raw);
	if (!found.success) deny("invalid_input");
	return found.data;
}

/** The author (the request's own account), its church, the live Owner or Admin condition and the clock. */
type Scope = { me: string; plant: string; ok: SQL; at: SQL };
function scopeOf(authority: RequestActor, clock?: Clock): Scope {
	const viewer = plantViewer(authority);
	if (!viewer || viewer.access.role === "member") deny("access_denied");
	return {
		me: viewer!.accountId,
		plant: viewer!.plantId,
		ok: liveRead(viewer!.access, true),
		at: clock ? sql`${new Date(clock.now()).toISOString()}::timestamptz` : sql`statement_timestamp()`,
	};
}

const iso = (value: SQL) => sql`to_char(${value} AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;
const answersJson = (r: SQL) =>
	sql`jsonb_build_object('spiritual',${r}.spiritual,'family',${r}.family,'financial',${r}.financial,'pace',${r}.pace)`;
const revisionJson = (r: SQL, recordedAt: SQL = sql`${r}.recorded_at`) =>
	sql`jsonb_build_object('revision',${r}.revision,'kind',${r}.kind,'answers',${answersJson(r)},'note',${r}.note,
 'recordedAt',${iso(recordedAt)})`;
/** The revisions of week `w` up to `upTo`, oldest first. */
const revisionsOf = (w: SQL, upTo: SQL) =>
	sql`coalesce((SELECT jsonb_agg(${revisionJson(sql`rv`)} ORDER BY rv.revision) FROM private_week_revision rv
 WHERE rv.week_id=${w}.id AND rv.revision<=${upTo}),'[]'::jsonb)`;
/** Week `w` as the contract writes it; `current` is an SQL boolean. Its answer and revisions are the row's own. */
const weekJson = (w: SQL, current: SQL, revisions: SQL) =>
	sql`jsonb_build_object('id',${w}.id,'ordinal',${w}.ordinal,'zone',${w}.zone,'startsOn',${w}.starts_on,
 'endsOn',${w}.ends_on,'current',${current},'answer',CASE WHEN ${w}.answer_revision>0 THEN jsonb_build_object(
 'answers',${answersJson(w)},'note',${w}.note,'revision',${w}.answer_revision,'answeredAt',${iso(sql`${w}.answered_at`)}) END,
 'revisions',${revisions})`;
/** Monday 00:00 of the week that holds `at` in `zone`, as an instant. */
const mondayOf = (at: SQL, zone: SQL) => sql`(date_trunc('week', ${at} AT TIME ZONE ${zone}) AT TIME ZONE ${zone})`;
/** Monday 00:00 in `zone` of the LocalDate `day` + 7. */
const weekAfter = (day: SQL, zone: SQL) => sql`((${day}+7)::timestamp AT TIME ZONE ${zone})`;

/** The request's account zone, read only behind the live check: null until the author confirms one in Settings. */
const accountZone = (s: Scope, extra: SQL = sql``) =>
	sql`acct AS (SELECT a.personal_timezone AS zone FROM account a WHERE a.id=${s.me}::uuid AND (SELECT ok FROM gate) ${extra})`;
/** An earlier save or correction of this author with this request key, as it was answered. */
const priorKey = (s: Scope, key: string) =>
	sql`prior AS (SELECT r.kind,r.week_id,${answersJson(sql`r`)} AS answers,r.note,
 jsonb_build_object('outcome','saved','revision',r.calendar_revision::text,'week',${weekJson(
		sql`w`,
		sql`w.ordinal=(SELECT max(x.ordinal) FROM private_week x WHERE x.author_id=w.author_id AND x.plant_id=w.plant_id)`,
		revisionsOf(sql`w`, sql`r.revision`),
 )}||jsonb_build_object('answer',jsonb_build_object('answers',${answersJson(sql`r`)},'note',r.note,'revision',r.revision,
 'answeredAt',${iso(sql`r.recorded_at`)}))) AS result
 FROM private_week_revision r JOIN private_week w ON w.id=r.week_id
 WHERE r.author_id=${s.me}::uuid AND r.request_key=${key} AND w.plant_id=${s.plant}::uuid AND (SELECT ok FROM gate))`;
const priorRow = z
	.object({
		kind: z.enum(["save", "correction"]),
		week_id: z.uuid(),
		answers: z.unknown(),
		note: z.string().nullable(),
		result: z.unknown(),
	})
	.nullable();

/** A stored answer for this key: the same request replays it; another request with the key is refused. */
function replay(
	prior: NonNullable<z.infer<typeof priorRow>>,
	kind: "save" | "correction",
	input: Written,
	weekId?: string,
) {
	const same =
		prior.kind === kind &&
		(weekId === undefined || prior.week_id === weekId) &&
		JSON.stringify(c.careAnswers.parse(prior.answers)) === JSON.stringify(c.careAnswers.parse(input.answers)) &&
		prior.note === input.note;
	if (!same) deny("idempotency_conflict");
	return c.careWriteResult.parse(prior.result);
}
type Written = { answers: c.CareAnswers; note: string | null };
const values = (v: Written) =>
	sql`(VALUES(${v.answers.spiritual},${v.answers.family},${v.answers.financial},${v.answers.pace},${v.note}::text))
 v(spiritual,family,financial,pace,note)`;
const differs = (w: SQL) =>
	sql`(${w}.spiritual,${w}.family,${w}.financial,${w}.pace,${w}.note) IS DISTINCT FROM (v.spiritual,v.family,v.financial,v.pace,v.note)`;

const pageRow = z.object({
	ok: z.boolean().nullable(),
	zone: z.string().nullable(),
	revision: z.string(),
	total: z.coerce.number(),
	weeks: z.array(z.unknown()),
});
/**
 * One page of weeks, newest first, in one statement: the stored weeks and the due ones after them. A new author's
 * first week is the one that holds now in the personal zone.
 */
async function readWeeks(db: Pick<Database, "execute">, s: Scope, size: number, page: number) {
	const { rows } = await db.execute(sql`WITH gate AS (SELECT ${s.ok} AS ok), ${accountZone(s)},
 cal AS (SELECT k.* FROM private_calendar k WHERE k.author_id=${s.me}::uuid AND k.plant_id=${s.plant}::uuid
  AND EXISTS(SELECT FROM acct WHERE zone IS NOT NULL)),
 stored AS (SELECT w.* FROM private_week w WHERE w.author_id=${s.me}::uuid AND w.plant_id=${s.plant}::uuid AND EXISTS(SELECT FROM cal)),
 base AS (SELECT k.zone,k.next_at,coalesce((SELECT max(ordinal) FROM stored),0) AS top FROM cal k
  UNION ALL SELECT a.zone,${mondayOf(s.at, sql`a.zone`)},0 FROM acct a WHERE a.zone IS NOT NULL AND NOT EXISTS(SELECT FROM cal)),
 due AS (SELECT NULL::uuid AS id,b.top+d.n AS ordinal,b.zone,d.starts_on,d.starts_on+6 AS ends_on,NULL::text AS spiritual,
  NULL::text AS family,NULL::text AS financial,NULL::text AS pace,NULL::text AS note,0 AS answer_revision,
  NULL::timestamptz AS answered_at FROM base b, private_due_weeks(b.zone,b.next_at,${s.at}) d),
 weeks AS (SELECT id,ordinal,zone,starts_on,ends_on,spiritual,family,financial,pace,note,answer_revision,answered_at FROM stored
  UNION ALL SELECT * FROM due),
 shown AS (SELECT * FROM weeks ORDER BY ordinal DESC LIMIT ${size} OFFSET ${(page - 1) * size})
 SELECT (SELECT ok FROM gate) AS ok,(SELECT zone FROM acct) AS zone,coalesce((SELECT revision::text FROM cal),'0') AS revision,
 (SELECT count(*) FROM weeks) AS total,
 coalesce((SELECT jsonb_agg(${weekJson(
		sql`p`,
		sql`p.ordinal=(SELECT max(ordinal) FROM weeks)`,
		revisionsOf(sql`p`, sql`p.answer_revision`),
 )} ORDER BY p.ordinal DESC) FROM shown p),'[]'::jsonb) AS weeks`);
	const r = pageRow.parse(rows[0]);
	if (!r.ok) deny("access_denied");
	if (!r.zone) deny("personal_timezone_confirmation_required");
	return { zone: r.zone!, revision: r.revision, total: r.total, weeks: r.weeks.map((w) => c.careWeek.parse(w)) };
}

/** One history page of twelve weeks; the first page is the strip. */
async function readPage(db: Pick<Database, "execute">, s: Scope, page: number) {
	const r = await readWeeks(db, s, c.HISTORY_PAGE, page);
	const pageCount = Math.max(1, Math.ceil(r.total / c.HISTORY_PAGE));
	return c.carePage.parse({ zone: r.zone, revision: r.revision, page, pageCount, weeks: r.weeks });
}

const writeRow = z.object({
	ok: z.boolean().nullable(),
	zone: z.string().nullable(),
	prior: priorRow,
	fit: z.boolean(),
	found: z.boolean().optional(),
	changed: z.unknown().nullable(),
	unchanged: z.unknown().nullable(),
});
type WriteRow = z.infer<typeof writeRow>;

/** A unique request key that a concurrent request of the same author took first. */
const keyTaken = (error: unknown) =>
	(error as { code?: string; constraint?: string })?.code === "23505" &&
	(error as { constraint?: string }).constraint === "private_week_revision_uq_0";

export function createPrivateCare(config: { clock?: Clock } = {}) {
	/** Runs a write statement; a key a concurrent request took first reads that request's answer instead. */
	async function write(db: Pick<Database, "execute">, s: Scope, key: string, statement: SQL): Promise<WriteRow> {
		try {
			return writeRow.parse((await db.execute(statement)).rows[0]);
		} catch (error) {
			if (!keyTaken(error)) throw error;
			const { rows } = await db.execute(sql`WITH gate AS (SELECT ${s.ok} AS ok), ${priorKey(s, key)}
 SELECT (SELECT ok FROM gate) AS ok,(SELECT personal_timezone FROM account WHERE id=${s.me}::uuid) AS zone,
 (SELECT to_jsonb(prior) FROM prior) AS prior,false AS fit,
 NULL AS changed,NULL AS unchanged`);
			return writeRow.parse(rows[0]);
		}
	}
	/** The common refusals of a write that changed nothing, in the order a caller can act on them. */
	function refuse(r: WriteRow): never {
		if (!r.ok) deny("access_denied");
		if (!r.zone) deny("personal_timezone_confirmation_required");
		return deny("revision_conflict");
	}

	return {
		/** privateCare.readCurrent (PI-038): the open week, answered or not, and the revision a save names. */
		async readCurrent(db: Pick<Database, "execute">, authority: RequestActor, raw: unknown = {}) {
			return settle(async () => {
				const s = scopeOf(authority, config.clock);
				parse(c.readCurrentRequest, raw);
				const r = await readWeeks(db, s, 1, 1);
				return c.careCurrent.parse({ zone: r.zone, revision: r.revision, week: r.weeks[0] });
			});
		},
		/** privateCare.readHistory (PI-040): every week, twelve to a page, newest first; unanswered weeks included. */
		async readHistory(db: Pick<Database, "execute">, authority: RequestActor, raw: unknown) {
			return settle(async () => {
				const s = scopeOf(authority, config.clock);
				return readPage(db, s, parse(c.readHistoryRequest, raw).page);
			});
		},
		/** privateCare.readTrends (PI-039): the twelve-week strip, the first history page. It reads; it raises nothing. */
		async readTrends(db: Pick<Database, "execute">, authority: RequestActor, raw: unknown = {}) {
			return settle(async () => {
				const s = scopeOf(authority, config.clock);
				parse(c.readTrendsRequest, raw);
				return readPage(db, s, 1);
			});
		},

		/**
		 * privateCare.save (PI-038): this week's four answers and note. One statement, no transaction: the live check, the
		 * locked calendar at the reviewed revision (or a new one when there is none), the due weeks, the answer on the open
		 * week and its revision. The same answer adds nothing; a request key replays its first answer.
		 */
		async save(db: Pick<Database, "execute">, authority: RequestActor, raw: unknown) {
			return settle(async () => {
				const s = scopeOf(authority, config.clock);
				const q = parse(c.saveRequest, raw);
				const v: Written = { answers: q.input.answers, note: c.noteOf(q.input.note) };
				const expected = q.expectedRevision;
				const r = await write(
					db,
					s,
					q.requestKey,
					sql`WITH gate AS (SELECT ${s.ok} AS ok), ${priorKey(s, q.requestKey)},
 ${accountZone(s, sql`AND NOT EXISTS(SELECT FROM prior)`)},
 cur AS (SELECT k.* FROM private_calendar k WHERE k.author_id=${s.me}::uuid AND k.plant_id=${s.plant}::uuid
  AND EXISTS(SELECT FROM acct WHERE zone IS NOT NULL) FOR UPDATE),
 fresh AS (SELECT a.zone,${mondayOf(s.at, sql`a.zone`)} AS next_at FROM acct a
  WHERE a.zone IS NOT NULL AND NOT EXISTS(SELECT FROM cur) AND ${expected}::bigint=0),
 fit AS (SELECT k.zone,k.next_at FROM cur k WHERE k.revision=${expected}::bigint UNION ALL SELECT zone,next_at FROM fresh),
 top AS (SELECT w.* FROM private_week w WHERE w.author_id=${s.me}::uuid AND w.plant_id=${s.plant}::uuid
  AND EXISTS(SELECT FROM cur WHERE revision=${expected}::bigint) ORDER BY w.ordinal DESC LIMIT 1),
 due AS (SELECT d.* FROM fit f, private_due_weeks(f.zone,f.next_at,${s.at}) d),
 made AS (INSERT INTO private_calendar(author_id,plant_id,revision,zone,next_at)
  SELECT ${s.me}::uuid,${s.plant}::uuid,1,f.zone,${weekAfter(sql`(SELECT max(starts_on) FROM due)`, sql`f.zone`)} FROM fresh f
  ON CONFLICT DO NOTHING RETURNING 1),
 born AS (INSERT INTO private_week(author_id,plant_id,ordinal,zone,starts_on,ends_on,starts_at,spiritual,family,financial,
  pace,note,answer_revision,answered_at)
  SELECT ${s.me}::uuid,${s.plant}::uuid,coalesce((SELECT ordinal FROM top),0)+d.n,f.zone,d.starts_on,d.starts_on+6,d.starts_at,
  CASE WHEN last THEN v.spiritual END,CASE WHEN last THEN v.family END,CASE WHEN last THEN v.financial END,
  CASE WHEN last THEN v.pace END,CASE WHEN last THEN v.note END,CASE WHEN last THEN 1 ELSE 0 END,CASE WHEN last THEN ${s.at} END
  FROM fit f, ${values(v)}, LATERAL (SELECT d.*,d.n=(SELECT max(n) FROM due) AS last FROM due d) d
  WHERE EXISTS(SELECT FROM cur WHERE revision=${expected}::bigint) OR EXISTS(SELECT FROM made) RETURNING *),
 edited AS (UPDATE private_week w SET spiritual=v.spiritual,family=v.family,financial=v.financial,pace=v.pace,note=v.note,
  answer_revision=w.answer_revision+1,answered_at=${s.at} FROM top t, ${values(v)}
  WHERE w.id=t.id AND NOT EXISTS(SELECT FROM due) AND ${differs(sql`t`)} RETURNING w.*),
 changed AS (SELECT * FROM born WHERE answer_revision=1 UNION ALL SELECT * FROM edited),
 bumped AS (UPDATE private_calendar k SET revision=k.revision+1,
  next_at=CASE WHEN EXISTS(SELECT FROM due) THEN ${weekAfter(sql`(SELECT max(starts_on) FROM due)`, sql`k.zone`)} ELSE k.next_at END
  WHERE k.author_id=${s.me}::uuid AND k.plant_id=${s.plant}::uuid AND k.revision=${expected}::bigint
  AND EXISTS(SELECT FROM changed) RETURNING 1),
 rev AS (INSERT INTO private_week_revision(week_id,author_id,revision,kind,spiritual,family,financial,pace,note,
  calendar_revision,request_key,recorded_at)
  SELECT x.id,${s.me}::uuid,x.answer_revision,'save',x.spiritual,x.family,x.financial,x.pace,x.note,${expected}::bigint+1,
  ${q.requestKey},${s.at} FROM changed x RETURNING 1)
 SELECT (SELECT ok FROM gate) AS ok,(SELECT zone FROM acct) AS zone,(SELECT to_jsonb(prior) FROM prior) AS prior,
 EXISTS(SELECT FROM fit) AS fit,
 (SELECT ${weekJson(
		sql`x`,
		sql`true`,
		sql`${revisionsOf(sql`x`, sql`x.answer_revision-1`)}||jsonb_build_array(jsonb_build_object('revision',x.answer_revision,
 'kind','save','answers',${answersJson(sql`x`)},'note',x.note,'recordedAt',${iso(s.at)}))`,
 )} FROM changed x) AS changed,
 (SELECT ${weekJson(sql`t`, sql`true`, revisionsOf(sql`t`, sql`t.answer_revision`))} FROM top t
  WHERE NOT EXISTS(SELECT FROM due) AND NOT EXISTS(SELECT FROM changed)) AS unchanged`,
				);
				if (r.prior) return replay(r.prior, "save", v);
				if (r.changed)
					return c.careWriteResult.parse({
						outcome: "saved",
						revision: String(BigInt(expected) + 1n),
						week: r.changed,
					});
				if (r.fit && r.unchanged)
					return c.careWriteResult.parse({ outcome: "unchanged", revision: expected, week: r.unchanged });
				return refuse(r);
			});
		},

		/**
		 * privateCare.correct (PI-041): a new answer for one answered week of the author's own calendar. The week, its zone
		 * and its author stay; the earlier answer stays in its revisions. The same answer adds nothing. One statement.
		 */
		async correct(db: Pick<Database, "execute">, authority: RequestActor, raw: unknown) {
			return settle(async () => {
				const s = scopeOf(authority, config.clock);
				const q = parse(c.correctRequest, raw);
				const v: Written = { answers: q.input.answers, note: c.noteOf(q.input.note) };
				const expected = q.expectedRevision;
				const r = await write(
					db,
					s,
					q.requestKey,
					sql`WITH gate AS (SELECT ${s.ok} AS ok), ${priorKey(s, q.requestKey)},
 ${accountZone(s, sql`AND NOT EXISTS(SELECT FROM prior)`)},
 cur AS (SELECT k.* FROM private_calendar k WHERE k.author_id=${s.me}::uuid AND k.plant_id=${s.plant}::uuid
  AND EXISTS(SELECT FROM acct WHERE zone IS NOT NULL) FOR UPDATE),
 target AS (SELECT w.* FROM private_week w WHERE w.id=${q.input.weekId}::uuid AND w.author_id=${s.me}::uuid
  AND w.plant_id=${s.plant}::uuid AND w.answer_revision>0 AND EXISTS(SELECT FROM cur)),
 fit AS (SELECT 1 FROM cur WHERE revision=${expected}::bigint),
 edited AS (UPDATE private_week w SET spiritual=v.spiritual,family=v.family,financial=v.financial,pace=v.pace,note=v.note,
  answer_revision=w.answer_revision+1,answered_at=${s.at} FROM target t, ${values(v)}
  WHERE w.id=t.id AND EXISTS(SELECT FROM fit) AND ${differs(sql`t`)} RETURNING w.*),
 bumped AS (UPDATE private_calendar k SET revision=k.revision+1 WHERE k.author_id=${s.me}::uuid AND k.plant_id=${s.plant}::uuid
  AND EXISTS(SELECT FROM edited) RETURNING 1),
 rev AS (INSERT INTO private_week_revision(week_id,author_id,revision,kind,spiritual,family,financial,pace,note,
  calendar_revision,request_key,recorded_at)
  SELECT x.id,${s.me}::uuid,x.answer_revision,'correction',x.spiritual,x.family,x.financial,x.pace,x.note,${expected}::bigint+1,
  ${q.requestKey},${s.at} FROM edited x RETURNING 1),
 latest AS (SELECT max(w.ordinal) AS ordinal FROM private_week w WHERE w.author_id=${s.me}::uuid AND w.plant_id=${s.plant}::uuid
  AND EXISTS(SELECT FROM target))
 SELECT (SELECT ok FROM gate) AS ok,(SELECT zone FROM acct) AS zone,(SELECT to_jsonb(prior) FROM prior) AS prior,
 EXISTS(SELECT FROM fit) AS fit,EXISTS(SELECT FROM target) AS found,
 (SELECT ${weekJson(
		sql`x`,
		sql`x.ordinal=(SELECT ordinal FROM latest)`,
		sql`${revisionsOf(sql`x`, sql`x.answer_revision-1`)}||jsonb_build_array(jsonb_build_object('revision',x.answer_revision,
 'kind','correction','answers',${answersJson(sql`x`)},'note',x.note,'recordedAt',${iso(s.at)}))`,
 )} FROM edited x) AS changed,
 (SELECT ${weekJson(sql`t`, sql`t.ordinal=(SELECT ordinal FROM latest)`, revisionsOf(sql`t`, sql`t.answer_revision`))}
  FROM target t WHERE NOT EXISTS(SELECT FROM edited)) AS unchanged`,
				);
				if (r.prior) return replay(r.prior, "correction", v, q.input.weekId);
				if (r.changed)
					return c.careWriteResult.parse({
						outcome: "saved",
						revision: String(BigInt(expected) + 1n),
						week: r.changed,
					});
				if (r.ok && r.zone && !r.found) deny("not_found");
				if (r.fit && r.unchanged)
					return c.careWriteResult.parse({ outcome: "unchanged", revision: expected, week: r.unchanged });
				return refuse(r);
			});
		},
	};
}
export type PrivateCare = ReturnType<typeof createPrivateCare>;

/**
 * The PersonalTimezoneCalendar of Settings (REQ-IDN-033, packages/contracts/src/settings/server.ts). Settings calls it
 * inside its personal timezone transaction, only for a current Owner or Admin author. `preview` binds each of the
 * author's calendars to the preview at its current revision, here and nowhere else. `apply` keeps every open week: it
 * adds the weeks that are due in the old zone, then starts the next week at the first Monday strictly after `at` in the
 * new zone. A save or another zone change since the preview leaves a calendar unbound, and apply then changes nothing
 * and answers false, so Settings refuses the whole change. One statement each.
 */
export const personalCalendar = {
	async preview(tx: Transaction, input: { account: string; previewId: string }) {
		await tx.execute(sql`UPDATE private_calendar SET preview_handle=${input.previewId}::uuid,preview_revision=revision
 WHERE author_id=${input.account}::uuid`);
	},
	async apply(tx: Transaction, input: { account: string; previewId: string; zone: string; at: string }) {
		const at = sql`${input.at}::timestamptz`;
		const { rows } = await tx.execute(sql`WITH cals AS (SELECT k.* FROM private_calendar k
  WHERE k.author_id=${input.account}::uuid FOR UPDATE),
 fit AS (SELECT * FROM cals WHERE preview_handle=${input.previewId}::uuid AND preview_revision=revision),
 bound AS (SELECT (SELECT count(*) FROM fit)=(SELECT count(*) FROM cals) AS ok),
 due AS (SELECT f.plant_id,f.zone,d.*,(SELECT coalesce(max(w.ordinal),0) FROM private_week w
  WHERE w.author_id=f.author_id AND w.plant_id=f.plant_id) AS top FROM fit f, private_due_weeks(f.zone,f.next_at,${at}) d
  WHERE (SELECT ok FROM bound)),
 born AS (INSERT INTO private_week(author_id,plant_id,ordinal,zone,starts_on,ends_on,starts_at)
  SELECT ${input.account}::uuid,d.plant_id,d.top+d.n,d.zone,d.starts_on,d.starts_on+6,d.starts_at FROM due d RETURNING 1),
 moved AS (UPDATE private_calendar k SET zone=${input.zone},
  next_at=${weekAfter(sql`(date_trunc('week', ${at} AT TIME ZONE ${input.zone}))::date`, sql`${input.zone}`)},
  revision=k.revision+1,preview_handle=NULL,preview_revision=NULL
  FROM fit f WHERE k.author_id=f.author_id AND k.plant_id=f.plant_id AND (SELECT ok FROM bound) RETURNING 1)
 SELECT (SELECT ok FROM bound) AS ok`);
		return z.object({ ok: z.boolean() }).parse(rows[0]).ok;
	},
};
