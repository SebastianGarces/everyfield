import { requestIdentity, type Clock, type RequestIdentity } from "@everyfield/contracts/common";
import * as c from "@everyfield/contracts/launch";
import type { Database, Transaction } from "@everyfield/db/client";
import { sql, type SQL } from "@everyfield/db/query";
import { randomUUID } from "node:crypto";
import "server-only";
import { z } from "zod";
import type { RequestActor } from "../access/session.ts";
import { hash } from "../operations/canonical.ts";
import { auditTransaction } from "../operations/writes.ts";
import { SEED } from "./catalog.ts";
import { deny, parse, scopeOf, settle, type Scope } from "./core.ts";
import { heldPractices, milestoneJson, milestoneOf, planColumns, planOf, systemClock } from "./reads.ts";

/** A milestone a person just completed, and the church's other current Owners and Admins to tell (NTF-009). */
export type MilestoneCompleted = {
	plantId: string;
	plantName: string;
	milestoneId: string;
	milestoneTitle: string;
	revision: string;
	actorName: string;
	operationId: string;
	recipients: string[];
};
/** Queues the Launch notifications in the completion's transaction: the notification service's port. */
export type LaunchNotices = (tx: Transaction, completed: MilestoneCompleted) => Promise<unknown>;

type Operation = "launch.schedule" | "launch.postpone" | "launch.completeMilestone" | "launch.reopenMilestone";
const priorRow = z.object({ request_identity: z.unknown(), result: z.unknown() }).nullable();
/** The stored answer of an earlier request with this key, as a CTE named `prior`. */
const priorKey = (scope: Scope, key: string) =>
	sql`prior AS (SELECT a.request_identity,a.result FROM audit_event a WHERE a.tenant_id=${scope.plantId}::uuid AND a.request_key=${key})`;
function identityOf(
	scope: Scope,
	operation: Operation,
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
/** The same request replays its stored answer; another request with the key is refused. */
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
/** The command's own audit columns: the request key, its identity and the stored answer. */
const keyed = (identity: RequestIdentity, result: unknown) =>
	sql`${identity.requestKey},${JSON.stringify(identity)}::jsonb,${JSON.stringify(result)}::jsonb`;

const SEED_ROWS = JSON.stringify(
	SEED.map((m) => ({ key: m.key, area: m.area, title: m.title, description: m.description, position: m.position })),
);
const SEED_TASKS = JSON.stringify(
	SEED.flatMap((m) =>
		m.taskKeys.map((t) => ({
			key: t.key,
			title: t.title,
			description: `Launch readiness: part of the "${m.title}" milestone on the Launch plan.`,
		})),
	),
);
/**
 * LCH-003/009: every fixed milestone and prep task the church does not have yet, as CTEs `ms` and `tk`, with their
 * history rows in `seeded`. Seed identity is the unique (plant, template key) of a milestone and (plant, launch task
 * key) of a task. A task a person deleted keeps its key, and one they renamed keeps it too, so a later repair inserts
 * neither again. Prep tasks are ordinary undated, unassigned Launch prep tasks; Tasks owns every later change.
 */
const seedCtes = (
	scope: Scope,
	op: string,
) => sql`ms AS (INSERT INTO launch_milestone(plant_id,template_key,title,description,area,position)
	SELECT ${scope.plantId}::uuid,r.key,r.title,r.description,r.area,r.position
	FROM jsonb_to_recordset(${SEED_ROWS}::jsonb) r(key text,area text,title text,description text,position int)
	ON CONFLICT (plant_id,template_key) DO NOTHING RETURNING id,template_key,title,revision),
 tk AS (INSERT INTO task(plant_id,title,description,category,priority,status,creator_id,created_at,due_kind,launch_task_key)
	SELECT ${scope.plantId}::uuid,r.title,r.description,'launch_prep','medium','not_started',${scope.accountId}::uuid,
	clock_timestamp(),'undated',r.key FROM jsonb_to_recordset(${SEED_TASKS}::jsonb) r(key text,title text,description text)
	ON CONFLICT (plant_id,launch_task_key) WHERE launch_task_key IS NOT NULL DO NOTHING
	RETURNING id,title,description,launch_task_key,revision),
 seeded AS (INSERT INTO audit_event(tenant_id,actor_id,action,kind,subject_type,subject_id,after_value,after_revision,command_id,metadata)
	SELECT ${scope.plantId}::uuid,${scope.accountId}::uuid,'launch.changed','create','launch_milestone',m.id,
		jsonb_build_object('templateKey',m.template_key,'title',m.title),m.revision,${op}::uuid,'{"source":"generated"}'::jsonb FROM ms m
	UNION ALL
	SELECT ${scope.plantId}::uuid,${scope.accountId}::uuid,'tasks.changed','create','task',k.id,
		jsonb_build_object('title',k.title,'description',k.description,'status','not_started','priority','medium',
		'category','launch_prep','due_kind','undated','assigneeIds','[]'::jsonb,'launchTaskKey',k.launch_task_key),
		k.revision,${op}::uuid,'{"source":"generated"}'::jsonb FROM tk k)`;

const launchRow = z.object({ status: c.launchStatus, target_date: z.string().nullable(), revision: z.string() });
const lockRow = z.object({
	ok: z.boolean(),
	prior: priorRow,
	launch: launchRow.nullable(),
	name: z.string().nullable(),
});
/** The command's first statement: its gate, its stored answer if any, and the church's launch row locked. */
async function lockLaunch(tx: Transaction, scope: Scope, key: string, create: boolean) {
	const { rows } = await tx.execute(sql`WITH gate AS (SELECT ${scope.admin} AS ok), ${priorKey(scope, key)},
 cur AS (${
		create
			? sql`INSERT INTO launch(plant_id,status) SELECT ${scope.plantId}::uuid,'planning'
	WHERE (SELECT ok FROM gate) AND NOT EXISTS(SELECT FROM prior)
	ON CONFLICT (plant_id) DO UPDATE SET status=launch.status RETURNING status,target_date::text,revision::text`
			: sql`SELECT status,target_date::text,revision::text FROM launch WHERE plant_id=${scope.plantId}::uuid
	AND (SELECT ok FROM gate) AND NOT EXISTS(SELECT FROM prior) FOR UPDATE`
 })
 SELECT (SELECT ok FROM gate) AS ok,(SELECT to_jsonb(prior) FROM prior) AS prior,(SELECT to_jsonb(cur) FROM cur) AS launch,
	(SELECT name FROM plant WHERE id=${scope.plantId}::uuid) AS name`);
	return lockRow.parse(rows[0]);
}
/** The plan after a write, in the write's transaction. */
async function planAfter(tx: Transaction, scope: Scope, clock: Clock) {
	const { rows } = await tx.execute(sql`SELECT ${planColumns(sql`${scope.plantId}::uuid`)}`);
	return planOf(rows[0], clock).plan;
}

const dateAnswer = z.object({ outcome: z.enum(["changed", "noop"]) });
const storedMilestone = z.object({ outcome: z.enum(["changed", "noop"]), milestone: z.unknown(), practices: z.int() });
const milestoneLock = z.object({
	ok: z.boolean(),
	prior: priorRow,
	milestone: z.unknown().nullable(),
	practices: z.int(),
	name: z.string().nullable(),
	actor: z.string().nullable(),
	recipients: z.array(z.uuid()),
});

export function createLaunchWriter(config: { notices: LaunchNotices; clock?: Clock }) {
	const clock = config.clock ?? systemClock;

	/**
	 * One date command: the locked launch row, the decided change, then one write statement with the launch row, any
	 * missing readiness and the history row, then the plan. A refusal rolls everything back.
	 */
	async function dateCommand(
		db: Database,
		authority: RequestActor,
		operation: "launch.schedule" | "launch.postpone",
		q: { requestKey: string; expectedRevision: string; input: unknown },
		decide: (
			current: z.infer<typeof launchRow>,
		) =>
			| { change: null }
			| {
					change: { status: c.LaunchStatus; date: string | null; event: string; reason: string | null; seed: boolean };
			  },
	) {
		const scope = scopeOf(authority);
		const identity = identityOf(scope, operation, q);
		return auditTransaction(db, async (tx) => {
			const locked = await lockLaunch(tx, scope, q.requestKey, true);
			if (locked.prior) {
				const stored = dateAnswer.parse(replay(locked.prior, identity));
				return c.scheduleResult.parse({ outcome: stored.outcome, plan: await planAfter(tx, scope, clock) });
			}
			if (!locked.ok || !locked.launch) deny("access_denied");
			const current = locked.launch;
			if (current.revision !== q.expectedRevision) deny("conflict");
			const { change } = decide(current);
			if (!change) return c.scheduleResult.parse({ outcome: "noop", plan: await planAfter(tx, scope, clock) });
			const op = randomUUID();
			await tx.execute(sql`WITH up AS (UPDATE launch SET status=${change.status},target_date=${change.date}::date,
	revision=revision+1 WHERE plant_id=${scope.plantId}::uuid RETURNING revision),
 ${change.seed ? sql`${seedCtes(scope, op)},` : sql``}
 aud AS (INSERT INTO audit_event(id,tenant_id,actor_id,action,kind,subject_type,subject_id,before_value,after_value,
	before_revision,after_revision,reason,request_key,request_identity,result,command_id,metadata)
	SELECT ${op}::uuid,${scope.plantId}::uuid,${scope.accountId}::uuid,'launch.changed',
	${current.status === "planning" ? "create" : "edit"},'launch',${scope.plantId}::uuid,
	jsonb_build_object('status',${current.status}::text,'targetDate',${current.target_date}::text),
	jsonb_build_object('status',${change.status}::text,'targetDate',${change.date}::text),
	${current.revision}::bigint,(SELECT revision FROM up),${change.reason},${keyed(identity, { outcome: "changed" })},
	${op}::uuid,jsonb_build_object('event',${change.event}::text${
		change.seed ? sql`,'milestonesSeeded',(SELECT count(*) FROM ms),'tasksSeeded',(SELECT count(*) FROM tk)` : sql``
	}))
 SELECT 1`);
			return c.scheduleResult.parse({ outcome: "changed", plan: await planAfter(tx, scope, clock) });
		});
	}

	/**
	 * One milestone command on the locked milestone, with its live linked tasks, the held-practice count, the actor's
	 * name and the other current Owners and Admins.
	 */
	async function milestoneCommand(
		db: Database,
		authority: RequestActor,
		operation: "launch.completeMilestone" | "launch.reopenMilestone",
		q: { requestKey: string; expectedRevision: string; input: { milestoneId: string } },
		decide: (
			tx: Transaction,
			scope: Scope,
			m: c.Milestone,
			lock: z.infer<typeof milestoneLock>,
			identity: RequestIdentity,
		) => Promise<{ outcome: "changed" | "noop"; milestone: c.Milestone }>,
	) {
		const scope = scopeOf(authority);
		const identity = identityOf(scope, operation, q);
		return auditTransaction(db, async (tx) => {
			const { rows } =
				await tx.execute(sql`WITH gate AS (SELECT ${scope.admin} AS ok), ${priorKey(scope, q.requestKey)},
 m AS (SELECT * FROM launch_milestone WHERE id=${q.input.milestoneId}::uuid AND plant_id=${scope.plantId}::uuid
	AND removed_at IS NULL AND (SELECT ok FROM gate) AND NOT EXISTS(SELECT FROM prior) FOR UPDATE)
 SELECT (SELECT ok FROM gate) AS ok,(SELECT to_jsonb(prior) FROM prior) AS prior,
	(SELECT ${milestoneJson("m")} FROM m) AS milestone,
	${heldPractices(sql`${scope.plantId}::uuid`)} AS practices,
	(SELECT name FROM plant WHERE id=${scope.plantId}::uuid) AS name,
	(SELECT i.display_name FROM seat_identity(${scope.accountId}::uuid) i LIMIT 1) AS actor,
	(SELECT coalesce(jsonb_agg(DISTINCT s.account_id),'[]') FROM seat s WHERE s.plant_id=${scope.plantId}::uuid
		AND s.role IN ('owner','admin') AND s.ended_at IS NULL AND s.accepted_at<=clock_timestamp()
		AND s.account_id<>${scope.accountId}::uuid AND EXISTS(SELECT FROM m)) AS recipients`);
			const lock = milestoneLock.parse(rows[0]);
			if (lock.prior) {
				const stored = storedMilestone.parse(replay(lock.prior, identity));
				return c.milestoneResult.parse({
					outcome: stored.outcome,
					milestone: milestoneOf(stored.milestone, stored.practices),
				});
			}
			if (!lock.ok || !lock.milestone) deny("access_denied");
			const m = milestoneOf(lock.milestone, lock.practices);
			if (m.revision !== q.expectedRevision) deny("conflict");
			return c.milestoneResult.parse(await decide(tx, scope, m, lock, identity));
		});
	}
	/**
	 * Changes the locked milestone and writes its history row with the stored answer, in one statement. The answer keeps
	 * the milestone as saved, so a replay returns it unchanged.
	 */
	async function saveMilestone(
		tx: Transaction,
		scope: Scope,
		m: c.Milestone,
		identity: RequestIdentity,
		change: { kind: "complete" | "reopen"; set: SQL; after: object },
	) {
		const op = randomUUID();
		const before = { completedAt: m.completion?.at ?? null, completedBy: m.completion?.by?.accountId ?? null };
		const { rows } = await tx.execute(sql`WITH u AS (UPDATE launch_milestone SET ${change.set},revision=revision+1
	WHERE id=${m.id}::uuid AND plant_id=${scope.plantId}::uuid RETURNING *),
 j AS (SELECT ${milestoneJson("u")} AS milestone,${heldPractices(sql`${scope.plantId}::uuid`)} AS practices,u.revision FROM u),
 aud AS (INSERT INTO audit_event(id,tenant_id,actor_id,action,kind,subject_type,subject_id,before_value,after_value,
	before_revision,after_revision,request_key,request_identity,result,command_id,metadata)
	SELECT ${op}::uuid,${scope.plantId}::uuid,${scope.accountId}::uuid,'launch.changed',${change.kind},'launch_milestone',
	${m.id}::uuid,${JSON.stringify(before)}::jsonb,${JSON.stringify(change.after)}::jsonb,${m.revision}::bigint,j.revision,
	${identity.requestKey},${JSON.stringify(identity)}::jsonb,
	jsonb_build_object('outcome','changed','milestone',j.milestone,'practices',j.practices),${op}::uuid,
	${JSON.stringify({ templateKey: m.templateKey, needsReview: m.needsReview })}::jsonb FROM j)
 SELECT milestone,practices FROM j`);
		const saved = milestoneOf(rows[0]?.milestone, z.int().parse(rows[0]?.practices));
		return { op, result: { outcome: "changed" as const, milestone: saved } };
	}

	return {
		/**
		 * launch.schedule (LCH-001, LCH-003): set, move or recommit Launch Sunday. The first date, and any date while
		 * readiness is incomplete, also creates the missing milestones and prep tasks in the same change. The same date
		 * again changes nothing and records nothing. A move keeps every task's assignee, due date and status, and never
		 * moves the phase.
		 */
		async schedule(db: Database, authority: RequestActor, raw: unknown) {
			return settle(async () => {
				const q = parse(c.scheduleRequest, raw);
				return dateCommand(db, authority, "launch.schedule", q, (current) => {
					if (current.status === "completed") deny("conflict");
					if (current.status === "scheduled" && current.target_date === q.input.date) return { change: null };
					const moving = current.status === "scheduled";
					const note = c.checkNote(q.input.reason, moving);
					if (!note.ok) deny("invalid_reason", { problem: note.problem });
					return {
						change: {
							status: "scheduled",
							date: q.input.date,
							event: current.status === "planning" ? "scheduled" : moving ? "moved" : "rescheduled",
							reason: note.note,
							seed: true,
						},
					};
				});
			});
		},
		/** launch.postpone (LCH-001): clears the active date with a reason. History keeps the former date. */
		async postpone(db: Database, authority: RequestActor, raw: unknown) {
			return settle(async () => {
				const q = parse(c.postponeRequest, raw);
				return dateCommand(db, authority, "launch.postpone", q, (current) => {
					if (current.status === "postponed") return { change: null };
					if (current.status !== "scheduled") deny("conflict");
					const note = c.checkNote(q.input.reason, true);
					if (!note.ok) deny("invalid_reason", { problem: note.problem });
					return { change: { status: "postponed", date: null, event: "postponed", reason: note.note, seed: false } };
				});
			});
		},
		/**
		 * launch.ensureReadiness (LCH-009): when an Owner or Admin opens a dated plan whose readiness is incomplete (a date
		 * saved in onboarding, or an interrupted seed), create only the missing milestones and prep tasks. The locked
		 * launch row serializes two tabs; the seed identities make a repeat create nothing. Never resets, deletes or
		 * completes anything. Returns how many it created.
		 */
		async ensureReadiness(db: Database, authority: RequestActor) {
			return settle(async () => {
				const scope = scopeOf(authority);
				return db.transaction(async (tx) => {
					const locked = await lockLaunch(tx, scope, randomUUID(), false);
					if (!locked.ok) deny("access_denied");
					if (!locked.launch || locked.launch.status === "planning") return { milestones: 0, tasks: 0 };
					const op = randomUUID();
					const { rows } = await tx.execute(sql`WITH ${seedCtes(scope, op)},
 aud AS (INSERT INTO audit_event(id,tenant_id,actor_id,action,kind,subject_type,subject_id,after_value,command_id,metadata)
	SELECT ${op}::uuid,${scope.plantId}::uuid,${scope.accountId}::uuid,'launch.changed','create','launch',${scope.plantId}::uuid,
	jsonb_build_object('milestonesSeeded',(SELECT count(*) FROM ms),'tasksSeeded',(SELECT count(*) FROM tk)),${op}::uuid,
	'{"event":"readiness_repaired"}'::jsonb WHERE EXISTS(SELECT FROM ms) OR EXISTS(SELECT FROM tk))
 SELECT (SELECT count(*)::int FROM ms) AS milestones,(SELECT count(*)::int FROM tk) AS tasks`);
					return z.object({ milestones: z.int(), tasks: z.int() }).parse(rows[0]);
				});
			});
		},
		/**
		 * launch.completeMilestone (LCH-004, NTF-009): a person marks the milestone complete, open tasks allowed. The page's
		 * linked-task digest must still match: if someone changed the tasks since, nothing saves and the refusal carries
		 * the current milestone to review. Completing a completed milestone that needs no review changes nothing and
		 * tells no one; otherwise each other current Owner and Admin gets one Launch notification.
		 */
		async completeMilestone(db: Database, authority: RequestActor, raw: unknown) {
			return settle(async () => {
				const q = parse(c.completeMilestoneRequest, raw);
				return milestoneCommand(db, authority, "launch.completeMilestone", q, async (tx, scope, m, lock, identity) => {
					if (c.reviewedOf(m.tasks) !== q.input.reviewed) deny("stale_review", { milestone: m });
					if (m.completion && !m.needsReview) return { outcome: "noop", milestone: m };
					const done = m.tasks.filter((t) => t.status === "complete").map((t) => t.id);
					const { op, result } = await saveMilestone(tx, scope, m, identity, {
						kind: "complete",
						set: sql`completed_at=clock_timestamp(),completed_by=${scope.accountId}::uuid,
							completed_task_ids=${sql.param(done)}::uuid[]`,
						after: { completedBy: scope.accountId, completedTaskIds: done },
					});
					if (lock.recipients.length)
						await config.notices(tx, {
							plantId: scope.plantId,
							plantName: lock.name ?? "",
							milestoneId: m.id,
							milestoneTitle: m.title,
							revision: result.milestone.revision,
							actorName: lock.actor ?? "",
							operationId: op,
							recipients: lock.recipients,
						});
					return result;
				});
			});
		},
		/** launch.reopenMilestone (LCH-004): a person reopens a completed milestone; its tasks stay as they are. */
		async reopenMilestone(db: Database, authority: RequestActor, raw: unknown) {
			return settle(async () => {
				const q = parse(c.reopenMilestoneRequest, raw);
				return milestoneCommand(db, authority, "launch.reopenMilestone", q, async (tx, scope, m, _lock, identity) => {
					if (!m.completion) return { outcome: "noop", milestone: m };
					const { result } = await saveMilestone(tx, scope, m, identity, {
						kind: "reopen",
						set: sql`completed_at=NULL,completed_by=NULL,completed_task_ids='{}'::uuid[]`,
						after: { completedAt: null, completedBy: null },
					});
					return result;
				});
			});
		},
	};
}
export type LaunchWriter = ReturnType<typeof createLaunchWriter>;
