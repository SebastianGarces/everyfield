import { calendarContext, timeZone, type Clock, type RequestIdentity } from "@everyfield/contracts/common";
import type { LocalDate } from "@everyfield/contracts/common";
import * as c from "@everyfield/contracts/launch";
import type { Database, Transaction } from "@everyfield/db/client";
import { sql, type SQL, type SqlLiteral } from "@everyfield/db/query";
import { randomUUID } from "node:crypto";
import "server-only";
import { z } from "zod";
import type { RequestActor } from "../access/session.ts";
import { hash } from "../operations/canonical.ts";
import { auditTransaction } from "../operations/writes.ts";
import { personChanges } from "../people/core.ts";
import { columnsChanged, newPerson } from "../people/people.ts";
import {
	deny,
	identityOf,
	keyed,
	parse,
	priorKey,
	priorRow,
	replay,
	scopeOf,
	settle,
	type Operation,
	type Scope,
} from "./core.ts";
import { planAfter } from "./reads.ts";

const answersRow = c.debriefAnswers;
const versionRow = z.object({ id: z.uuid(), revision: z.string(), version: z.int() });
const lockRow = z.object({
	ok: z.boolean(),
	prior: priorRow,
	timezone: timeZone.nullable(),
	launch: z
		.object({
			status: c.launchStatus,
			revision: z.string(),
			actual_date: z.string().nullable(),
			attendance: z.int().nullable(),
			decisions: z.int().nullable(),
			outcome_note: z.string().nullable(),
		})
		.nullable(),
	draft: versionRow.extend({ answers: answersRow }).nullable(),
	submitted: versionRow.extend({ answers: answersRow }).nullable(),
	debrief_max: z.int(),
	summary_draft: versionRow.extend({ body: z.string() }).nullable(),
	published: versionRow.extend({ body: z.string() }).nullable(),
	summary_max: z.int(),
});
type Locked = Omit<z.infer<typeof lockRow>, "launch" | "timezone"> & {
	launch: NonNullable<z.infer<typeof lockRow>["launch"]>;
	today: LocalDate;
};
const answersJson = <DName extends string>(d: SqlLiteral<DName>) => {
	const r = sql.raw(d);
	return sql`jsonb_build_object('wentWell',${r}.went_well,'toChange',${r}.to_change,'operations',${r}.operations,
	'followUpPlan',${r}.follow_up_plan,'supportNeeded',${r}.support_needed,'missingNames',${r}.missing_names,
	'missingCount',${r}.missing_count)`;
};
const versionJson = <DName extends string>(d: SqlLiteral<DName>, extra: SQL) => {
	const r = sql.raw(d);
	return sql`jsonb_build_object('id',${r}.id,'revision',${r}.revision::text,'version',${r}.version,${extra})`;
};

async function lock(tx: Transaction, scope: Scope, key: string) {
	const p = sql`${scope.plantId}::uuid`;
	const { rows } = await tx.execute(sql`WITH gate AS (SELECT ${scope.admin} AS ok), ${priorKey(scope, key)},
 cur AS (INSERT INTO launch(plant_id,status) SELECT ${p},'planning'
	WHERE (SELECT ok FROM gate) AND NOT EXISTS(SELECT FROM prior)
	ON CONFLICT (plant_id) DO UPDATE SET status=launch.status
	RETURNING status,revision::text,actual_date::text,attendance,decisions,outcome_note)
 SELECT (SELECT ok FROM gate) AS ok,(SELECT to_jsonb(prior) FROM prior) AS prior,
	(SELECT timezone FROM plant WHERE id=${p}) AS timezone,(SELECT to_jsonb(cur) FROM cur) AS launch,
	(SELECT ${versionJson("d", sql`'answers',${answersJson("d")}`)} FROM launch_debrief d
		WHERE d.plant_id=${p} AND d.submitted_at IS NULL AND EXISTS(SELECT FROM cur)) AS draft,
	(SELECT ${versionJson("d", sql`'answers',${answersJson("d")}`)} FROM launch_debrief d
		WHERE d.plant_id=${p} AND d.submitted_at IS NOT NULL AND EXISTS(SELECT FROM cur) ORDER BY d.version DESC LIMIT 1) AS submitted,
	(SELECT coalesce(max(d.version),0) FROM launch_debrief d WHERE d.plant_id=${p} AND EXISTS(SELECT FROM cur)) AS debrief_max,
	(SELECT ${versionJson("s", sql`'body',s.body`)} FROM launch_summary s
		WHERE s.plant_id=${p} AND s.published_at IS NULL AND EXISTS(SELECT FROM cur)) AS summary_draft,
	(SELECT ${versionJson("s", sql`'body',s.body`)} FROM launch_summary s
		WHERE s.plant_id=${p} AND s.published_at IS NOT NULL AND EXISTS(SELECT FROM cur) ORDER BY s.version DESC LIMIT 1) AS published,
	(SELECT coalesce(max(s.version),0) FROM launch_summary s WHERE s.plant_id=${p} AND EXISTS(SELECT FROM cur)) AS summary_max`);
	return lockRow.parse(rows[0]);
}

const storedAnswer = z.object({ outcome: z.enum(["changed", "noop"]) });
export function auditCte<From extends string>(
	scope: Scope,
	identity: RequestIdentity,
	op: string,
	row: {
		action: string;
		kind: string;
		subjectType: string;
		subjectId: SQL;
		before?: object | null;
		after: object | SQL;
		reason?: string | null;
		metadata: object;
		from: SqlLiteral<From>;
	},
) {
	const after =
		row.after instanceof Object && "getSQL" in row.after ? row.after : sql`${JSON.stringify(row.after)}::jsonb`;
	return sql`aud AS (INSERT INTO audit_event(id,tenant_id,actor_id,actor_token,action,kind,subject_type,subject_id,
	before_value,after_value,reason,request_key,request_identity,result,command_id,metadata)
	SELECT ${op}::uuid,${scope.plantId}::uuid,${scope.accountId}::uuid,${actorToken(scope)},${row.action},${row.kind},${row.subjectType},
	${row.subjectId},${row.before ? JSON.stringify(row.before) : null}::jsonb,${after as SQL},${row.reason ?? null},
	${keyed(identity, { outcome: "changed" })},${op}::uuid,${JSON.stringify(row.metadata)}::jsonb FROM ${sql.raw(row.from)})`;
}
const actorToken = (scope: Scope) => hash([scope.plantId, scope.accountId]);
const evidenceMoved = (scope: Scope) =>
	sql`mat AS (UPDATE plant SET material_revision=material_revision+1 WHERE id=${scope.plantId}::uuid)`;

const sameAnswers = (a: c.DebriefAnswers, b: c.DebriefAnswers) =>
	c.WRITTEN_AREAS.every((k) => a[k] === b[k]) && a.missingNames === b.missingNames && a.missingCount === b.missingCount;
const answerValues = (a: c.DebriefAnswers) =>
	sql`${a.wentWell},${a.toChange},${a.operations},${a.followUpPlan},${a.supportNeeded},${a.missingNames},${a.missingCount}::int`;
const answerSet = (a: c.DebriefAnswers) =>
	sql`went_well=${a.wentWell},to_change=${a.toChange},operations=${a.operations},follow_up_plan=${a.followUpPlan},
	support_needed=${a.supportNeeded},missing_names=${a.missingNames},missing_count=${a.missingCount}::int`;

export function outcomeCommands(clock: Clock) {
	async function command(
		db: Database,
		authority: RequestActor,
		operation: Operation,
		q: { requestKey: string; input: unknown; expectedRevision?: string },
		decide: (tx: Transaction, scope: Scope, l: Locked, identity: RequestIdentity) => Promise<"changed" | "noop">,
	) {
		const scope = scopeOf(authority);
		const identity = identityOf(scope, operation, { expectedRevision: "", ...q });
		return auditTransaction(db, async (tx) => {
			const l = await lock(tx, scope, q.requestKey);
			if (l.prior) {
				const stored = storedAnswer.parse(replay(l.prior, identity));
				return c.planResult.parse({ outcome: stored.outcome, plan: await planAfter(tx, scope, clock) });
			}
			if (!l.ok || !l.launch || !l.timezone) deny("access_denied");
			const today = calendarContext(l.timezone, clock).localDate;
			const outcome = await decide(tx, scope, { ...l, launch: l.launch, today }, identity);
			return c.planResult.parse({ outcome, plan: await planAfter(tx, scope, clock) });
		});
	}

	function fenced(
		draft: { id: string; revision: string } | null,
		q: { draftId: string | null; expectedRevision: string },
	) {
		if ((draft?.id ?? null) !== q.draftId || (draft?.revision ?? "0") !== q.expectedRevision) deny("conflict");
	}

	async function debriefCommand(db: Database, authority: RequestActor, raw: unknown, submit: boolean) {
		const q = parse(c.debriefRequest, raw);
		return command(
			db,
			authority,
			submit ? "launch.submitDebrief" : "launch.saveDebriefDraft",
			q,
			async (tx, scope, l, identity) => {
				if (!l.launch.actual_date) deny("not_ready", { needs: "outcome" });
				fenced(l.draft, { draftId: q.input.draftId, expectedRevision: q.expectedRevision });
				const checked = c.checkDebrief(q.input.answers, submit);
				if (!checked.ok) deny("invalid_debrief", { problem: checked.problem });
				const a = checked.answers;
				if (!submit && l.draft && sameAnswers(l.draft.answers, a)) return "noop";
				if (submit && !l.draft && l.submitted && sameAnswers(l.submitted.answers, a)) return "noop";
				const op = randomUUID();
				const p = sql`${scope.plantId}::uuid`;
				const version = l.draft?.version ?? l.debrief_max + 1;
				const stamp = submit ? sql`submitted_at=clock_timestamp(),submitted_by=${scope.accountId}::uuid,` : sql``;
				const write = l.draft
					? sql`UPDATE launch_debrief SET ${answerSet(a)},${stamp}saved_at=clock_timestamp(),
	saved_by=${scope.accountId}::uuid,revision=revision+1 WHERE id=${l.draft.id}::uuid AND plant_id=${p} RETURNING id`
					: sql`INSERT INTO launch_debrief(plant_id,version,went_well,to_change,operations,follow_up_plan,support_needed,
	missing_names,missing_count,saved_at,saved_by,submitted_at,submitted_by)
	VALUES(${p},${version},${answerValues(a)},clock_timestamp(),${scope.accountId}::uuid,
	${submit ? sql`clock_timestamp()` : sql`NULL`},${submit ? sql`${scope.accountId}::uuid` : sql`NULL`}) RETURNING id`;
				const guest = (x: c.DebriefAnswers) => ({ missingNames: x.missingNames, missingCount: x.missingCount });
				const corrected = submit && l.submitted !== null;
				await tx.execute(sql`WITH w AS (${write}), ${submit ? sql`${evidenceMoved(scope)},` : sql``}
 ${auditCte(scope, identity, op, {
		action: !submit ? "launch.changed" : corrected ? "launch.corrected" : "launch.debrief_submitted",
		kind: !submit ? (l.draft ? "edit" : "create") : corrected ? "correct" : "create",
		subjectType: "launch_debrief",
		subjectId: sql`w.id`,
		before: corrected && l.submitted ? { version: l.submitted.version, ...guest(l.submitted.answers) } : null,
		after: { version, ...guest(a) },
		metadata: { event: submit ? "debrief_submitted" : "debrief_draft_saved" },
		from: "w",
 })}
 SELECT 1`);
				return "changed";
			},
		);
	}

	async function summaryCommand(db: Database, authority: RequestActor, raw: unknown, publish: boolean) {
		const q = parse(c.summaryRequest, raw);
		return command(
			db,
			authority,
			publish ? "launch.publishDebriefSummary" : "launch.saveDebriefSummaryDraft",
			q,
			async (tx, scope, l, identity) => {
				if (!l.submitted) deny("not_ready", { needs: "debrief" });
				fenced(l.summary_draft, { draftId: q.input.draftId, expectedRevision: q.expectedRevision });
				const checked = c.checkSummary(q.input.body);
				if (!checked.ok) deny("invalid_summary", { problem: checked.problem });
				const body = checked.body;
				if (!publish && l.summary_draft?.body === body) return "noop";
				if (publish && !l.summary_draft && l.published?.body === body) return "noop";
				const op = randomUUID();
				const p = sql`${scope.plantId}::uuid`;
				const version = l.summary_draft?.version ?? l.summary_max + 1;
				const stamp = publish ? sql`published_at=clock_timestamp(),published_by=${scope.accountId}::uuid,` : sql``;
				const write = l.summary_draft
					? sql`UPDATE launch_summary SET body=${body},${stamp}saved_at=clock_timestamp(),
	saved_by=${scope.accountId}::uuid,revision=revision+1 WHERE id=${l.summary_draft.id}::uuid AND plant_id=${p}
	RETURNING id,source_categories`
					: sql`INSERT INTO launch_summary(plant_id,version,body,saved_at,saved_by,published_at,published_by)
	VALUES(${p},${version},${body},clock_timestamp(),${scope.accountId}::uuid,
	${publish ? sql`clock_timestamp()` : sql`NULL`},${publish ? sql`${scope.accountId}::uuid` : sql`NULL`})
	RETURNING id,source_categories`;
				await tx.execute(sql`WITH w AS (${write}),
 ${auditCte(scope, identity, op, {
		action: publish ? "launch.summary_published" : "launch.changed",
		kind: publish ? "publish" : l.summary_draft ? "edit" : "create",
		subjectType: "launch_summary",
		subjectId: sql`w.id`,
		after: sql`jsonb_build_object('version',${version}::int,'sourceCategories',to_jsonb(w.source_categories))`,
		metadata: { event: publish ? "summary_published" : "summary_draft_saved" },
		from: "w",
 })}
 SELECT 1`);
				return "changed";
			},
		);
	}

	return {
		async recordOutcome(db: Database, authority: RequestActor, raw: unknown) {
			return settle(async () => {
				const q = parse(c.recordOutcomeRequest, raw);
				return command(db, authority, "launch.recordOutcome", q, async (tx, scope, l, identity) => {
					if (l.launch.revision !== q.expectedRevision) deny("conflict");
					if (l.launch.actual_date) deny("conflict");
					const checked = c.checkOutcome(q.input, l.today);
					if (!checked.ok) deny("invalid_outcome", { problem: checked.problem });
					const v = checked.value;
					const op = randomUUID();
					await tx.execute(sql`WITH up AS (UPDATE launch SET status='completed',actual_date=${v.actualDate}::date,
	attendance=${v.attendance}::int,decisions=${v.decisions}::int,outcome_note=${v.note},
	outcome_recorded_at=clock_timestamp(),outcome_recorded_by=${scope.accountId}::uuid,revision=revision+1
	WHERE plant_id=${scope.plantId}::uuid RETURNING plant_id), ${evidenceMoved(scope)},
 ${auditCte(scope, identity, op, {
		action: "launch.outcome_recorded",
		kind: "create",
		subjectType: "launch",
		subjectId: sql`up.plant_id`,
		before: { status: l.launch.status },
		after: { status: "completed", actualDate: v.actualDate, attendance: v.attendance, decisions: v.decisions },
		metadata: { event: "outcome_recorded", noteChanged: v.note !== null },
		from: "up",
 })}
 SELECT 1`);
					return "changed";
				});
			});
		},
		async correctOutcome(db: Database, authority: RequestActor, raw: unknown) {
			return settle(async () => {
				const q = parse(c.correctOutcomeRequest, raw);
				return command(db, authority, "launch.correctOutcome", q, async (tx, scope, l, identity) => {
					if (!l.launch.actual_date) deny("not_ready", { needs: "outcome" });
					if (l.launch.revision !== q.expectedRevision) deny("conflict");
					const checked = c.checkOutcome(q.input, l.today);
					if (!checked.ok) deny("invalid_outcome", { problem: checked.problem });
					const v = checked.value;
					const was = {
						actualDate: l.launch.actual_date,
						attendance: l.launch.attendance,
						decisions: l.launch.decisions,
					};
					const now = { actualDate: v.actualDate, attendance: v.attendance, decisions: v.decisions };
					const fields = (Object.keys(was) as (keyof typeof was)[]).filter((k) => was[k] !== now[k]);
					const noteChanged = (l.launch.outcome_note ?? null) !== v.note;
					if (!fields.length && !noteChanged) return "noop";
					const reason = c.checkNote(q.input.reason, true);
					if (!reason.ok) deny("invalid_reason", { problem: reason.problem });
					const pick = (o: typeof was) => Object.fromEntries(fields.map((k) => [k, o[k]]));
					const op = randomUUID();
					await tx.execute(sql`WITH up AS (UPDATE launch SET actual_date=${v.actualDate}::date,
	attendance=${v.attendance}::int,decisions=${v.decisions}::int,outcome_note=${v.note},revision=revision+1
	WHERE plant_id=${scope.plantId}::uuid RETURNING plant_id), ${evidenceMoved(scope)},
 ${auditCte(scope, identity, op, {
		action: "launch.corrected",
		kind: "correct",
		subjectType: "launch",
		subjectId: sql`up.plant_id`,
		before: pick(was),
		after: pick(now),
		reason: reason.note,
		metadata: { event: "outcome_corrected", noteChanged },
		from: "up",
 })}
 SELECT 1`);
					return "changed";
				});
			});
		},
		async addGuestAttendance(db: Database, authority: RequestActor, raw: unknown) {
			return settle(async () => {
				const q = parse(c.addGuestRequest, raw);
				return command(db, authority, "launch.addGuestAttendance", q, async (tx, scope, l, identity) => {
					if (!l.launch.actual_date) deny("not_ready", { needs: "outcome" });
					const op = randomUUID();
					const p = sql`${scope.plantId}::uuid`;
					const link = (pe: SQL, created: boolean, extra: SQL) => sql`WITH ${extra}
 pe AS (${pe}),
 g AS (INSERT INTO launch_guest(plant_id,person_id,recorded_by) SELECT ${p},pe.id,${scope.accountId}::uuid FROM pe
	ON CONFLICT (plant_id,person_id) DO NOTHING RETURNING id,person_id),
 ${auditCte(scope, identity, op, {
		action: "launch.changed",
		kind: "create",
		subjectType: "launch_guest",
		subjectId: sql`g.id`,
		after: sql`jsonb_build_object('personId',g.person_id)`,
		metadata: { event: "guest_added", createdPerson: created },
		from: "g",
 })}
 SELECT (SELECT count(*)::int FROM pe) AS found,(SELECT count(*)::int FROM g) AS added`;
					if ("personId" in q.input) {
						const { rows } = await tx.execute(
							link(
								sql`SELECT id FROM person WHERE id=${q.input.personId}::uuid AND tenant_id=${p} AND plant_id=${p}
	AND state='live'`,
								false,
								sql``,
							),
						);
						const r = z.object({ found: z.int(), added: z.int() }).parse(rows[0]);
						if (!r.found) deny("access_denied");
						return r.added ? "changed" : "noop";
					}
					const name = c.GUEST_NAME_MAX >= q.input.displayName.trim().length ? q.input.displayName.trim() : "";
					if (!name) deny("invalid_input");
					const row = newPerson(
						{ selected: authority.actor.context.owner },
						{
							displayName: name,
							stage: "attendee",
							source: "event",
							adultClassification: "unknown",
						},
					);
					const created = personChanges(undefined, row).after;
					const personOp = randomUUID();
					const { rows } = await tx.execute(
						link(
							sql`SELECT id FROM np`,
							true,
							sql`np AS (INSERT INTO person(id,tenant_id,plant_id,display_name,source,stage,adult_classification,
	commitment_state,created_at,state,revision,pipeline_position)
	VALUES(${row.id}::uuid,${p},${p},${row.display_name},${row.source},${row.stage},${row.adult_classification},
	${row.commitment_state},${row.created_at.toISOString()}::timestamptz,'live',1,${row.pipeline_position}::numeric)
	RETURNING id),
 col AS (${columnsChanged(scope.plantId, [row.stage]) as SQL}),
 ${evidenceMoved(scope)},
 pa AS (INSERT INTO audit_event(id,tenant_id,actor_id,actor_token,action,kind,subject_type,subject_id,after_value,
	after_revision,command_id,metadata) SELECT ${personOp}::uuid,${p},${scope.accountId}::uuid,
	${actorToken(scope)},'people.created','create','person',np.id,${JSON.stringify(created)}::jsonb,1,
	${op}::uuid,'{"source":"launch_guest"}'::jsonb FROM np),`,
						),
					);
					z.object({ found: z.int(), added: z.int() }).parse(rows[0]);
					return "changed";
				});
			});
		},
		async saveDebriefDraft(db: Database, authority: RequestActor, raw: unknown) {
			return settle(() => debriefCommand(db, authority, raw, false));
		},
		async submitDebrief(db: Database, authority: RequestActor, raw: unknown) {
			return settle(() => debriefCommand(db, authority, raw, true));
		},
		async saveDebriefSummaryDraft(db: Database, authority: RequestActor, raw: unknown) {
			return settle(() => summaryCommand(db, authority, raw, false));
		},
		async publishDebriefSummary(db: Database, authority: RequestActor, raw: unknown) {
			return settle(() => summaryCommand(db, authority, raw, true));
		},
	};
}
