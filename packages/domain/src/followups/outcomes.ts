import { instant, revision, type Instant } from "@everyfield/contracts/common";
import * as c from "@everyfield/contracts/followups";
import { sql } from "@everyfield/db/query";
import { randomUUID } from "node:crypto";
import "server-only";
import { z } from "zod";
import {
	administers,
	command,
	deny,
	hash,
	parse,
	type AuditCommand,
	type TaskContext,
	type Tx,
} from "../tasks/core.ts";
import { loadTask, lockTasks, type LockedTask } from "../tasks/queries.ts";
import { mutation, setStatus, syncAll, type TaskReminders } from "../tasks/writes.ts";
import { answer, followUpTask, OPEN, originJson, originOf, refuse } from "./core.ts";

const OPEN_STATUS = ["not_started", "in_progress", "blocked"] as const;
const isCompleting = (o: c.Outcome) => (c.completing as readonly string[]).includes(o);
const at = (d: Date | string) => instant.parse(new Date(d).toISOString());
type Stored = {
	id: string;
	revision: string;
	person_id: string;
	task_id: string | null;
	obligation_id: string | null;
	meeting_id: string | null;
	outcome: c.Outcome;
	occurred_at: Date;
	recorded_at: Date;
	contact_channel: z.infer<typeof c.channel> | null;
	notes: string | null;
	supersedes_id: string | null;
	voided_at: Date | null;
	completes_task: boolean;
	also_task_ids: string[];
};
type Who = { accountId: string; displayName: string | null };
/** One contact-log entry as the contract shows it. */
function itemOf(
	r: Stored,
	actor: Who | null,
	extra: {
		/** The other follow-ups this one contact finished, named by where they came from. */
		also?: Record<string, c.FollowUpOrigin>;
		corrected?: boolean;
		corrects?: { id: string; reason: string | null } | null;
		voided?: Who & { reason: string };
	},
) {
	const state = r.voided_at ? (extra.corrected ? "corrected" : "voided") : "effective";
	const who = (w: Who | null) =>
		w
			? { kind: "account" as const, accountId: w.accountId, displayName: w.displayName }
			: { kind: "former_account" as const };
	return c.outcomeItem.parse({
		id: r.id,
		revision: r.revision,
		personId: r.person_id,
		outcome: r.outcome,
		occurredAt: at(r.occurred_at),
		recordedAt: at(r.recorded_at),
		channel: r.contact_channel,
		notes: r.notes,
		completedTask: r.completes_task,
		taskId: r.task_id,
		alsoFinished: r.also_task_ids.map((taskId) => ({
			taskId,
			origin: extra.also?.[taskId] ?? ({ kind: "added", by: null } as const),
		})),
		obligationId: r.obligation_id,
		meetingId: r.meeting_id,
		actor: who(actor),
		state,
		corrects: extra.corrects ?? null,
		voided:
			r.voided_at && extra.voided
				? { at: at(r.voided_at), actor: who(extra.voided), reason: extra.voided.reason }
				: null,
		contact: state === "effective" && r.outcome === "contacted",
	});
}
/** The outcome audit row. The command's first row carries the request key and stored answer (D70). */
function auditOutcome(
	cmd: AuditCommand,
	e: {
		subjectId: string;
		action: "followup.recorded" | "followup.corrected";
		kind: "outcome" | "correct" | "supersede" | "remove";
		before: Record<string, unknown> | null;
		after: Record<string, unknown> | null;
		reason?: string | null;
	},
) {
	const first = !cmd.events.some((x) => x.id === cmd.id);
	cmd.events.push({
		id: first ? cmd.id : randomUUID(),
		tenant_id: cmd.actor.plantId,
		actor_id: cmd.actor.accountId,
		actor_token: hash([cmd.actor.plantId, cmd.actor.accountId]),
		action: e.action,
		kind: e.kind,
		subject_type: "contact_outcome",
		subject_id: e.subjectId,
		before_value: e.before,
		after_value: e.after,
		reason: e.reason ?? null,
		metadata: {},
	});
}
const audited = (r: Stored) => ({
	outcome: r.outcome,
	occurred_at: at(r.occurred_at),
	completes_task: r.completes_task,
	also_task_ids: r.also_task_ids,
	task_id: r.task_id,
	person_id: r.person_id,
});
const insertOutcome = (plantId: string, r: Stored) =>
	sql`INSERT INTO contact_outcome (id, plant_id, person_id, task_id, obligation_id, meeting_id, outcome, occurred_at,
		recorded_at, contact_channel, notes, supersedes_id, completes_task, also_task_ids)
	VALUES (${r.id}::uuid, ${plantId}::uuid, ${r.person_id}::uuid, ${r.task_id}::uuid, ${r.obligation_id}::uuid,
		${r.meeting_id}::uuid, ${r.outcome}, ${r.occurred_at.toISOString()}::timestamptz,
		${r.recorded_at.toISOString()}::timestamptz, ${r.contact_channel}, ${r.notes}, ${r.supersedes_id}::uuid,
		${r.completes_task}, ${sql.param(r.also_task_ids)}::uuid[])`;
// Contact freshness changes: affected assessments are out of date (REQ-MTG-022).
const staleAssessments = (plantId: string) =>
	sql`UPDATE plant SET material_revision=material_revision+1 WHERE id=${plantId}::uuid`;
const latest = (...dates: (Date | string | null)[]) => {
	const known = dates.filter((d) => d !== null).map((d) => Date.parse(new Date(d).toISOString()));
	return known.length ? at(new Date(Math.max(...known))) : null;
};
/** The actual instant must not be after the server's clock; truthful late entry keeps its past instant. */
function occurrence(value: Instant | undefined, fallback: Date, clock: Date) {
	const d = value ? new Date(value) : fallback;
	if (d > clock) refuse("future_occurrence");
	return d;
}

const personFacts = z.object({
	live: z.boolean().nullable(),
	last_contact: z.coerce.date().nullable(),
	actor_name: z.string().nullable(),
	meeting_id: z.uuid().nullable(),
	// Where each of the Person's open follow-ups came from, by task: names what one contact finishes.
	origins: z.record(z.string(), z.unknown()),
});
async function factsOf(tx: Tx, plantId: string, accountId: string, personId: string, obligationId: string | null) {
	const r = await tx.execute(sql`SELECT (SELECT state='live' AND plant_id IS NOT NULL FROM person
			WHERE id=${personId}::uuid AND tenant_id=${plantId}::uuid FOR SHARE) AS live,
		(SELECT max(x.occurred_at) FROM contact_outcome x WHERE x.plant_id=${plantId}::uuid AND x.person_id=${personId}::uuid
			AND x.voided_at IS NULL AND x.outcome='contacted') AS last_contact,
		(SELECT display_name FROM seat_identity(${accountId}::uuid)) AS actor_name,
		(SELECT meeting_id FROM obligation WHERE id=${obligationId}::uuid AND plant_id=${plantId}::uuid) AS meeting_id,
		(SELECT coalesce(jsonb_object_agg(k.id, ${originJson(sql`k`)}),'{}') FROM task k WHERE k.plant_id=${plantId}::uuid
			AND k.person_id=${personId}::uuid AND ${followUpTask(sql`k`)} AND k.status IN ${OPEN}) AS origins`);
	return personFacts.parse(r.rows[0]);
}

const correctionFacts = z.object({
	row: z.object({
		id: z.uuid(),
		revision,
		person_id: z.uuid(),
		task_id: z.uuid().nullable(),
		obligation_id: z.uuid().nullable(),
		meeting_id: z.uuid().nullable(),
		outcome: c.outcome,
		occurred_at: z.coerce.date(),
		recorded_at: z.coerce.date(),
		contact_channel: c.channel.nullable(),
		notes: z.string().nullable(),
		supersedes_id: z.uuid().nullable(),
		voided_at: z.coerce.date().nullable(),
		completes_task: z.boolean(),
		also_task_ids: z.array(z.uuid()),
	}),
	author_id: z.uuid().nullable(),
	author_name: z.string().nullable(),
	corrects_reason: z.string().nullable(),
	origins: z.record(z.string(), z.unknown()),
	task_assignee: z.uuid().nullable(),
	task_live: z.boolean().nullable(),
	person_live: z.boolean().nullable(),
	others_contact: z.coerce.date().nullable(),
	actor_name: z.string().nullable(),
});

/** Record and correct typed follow-up outcomes. The web mount supplies WP-031's reminder sync, as tasks does. */
export function outcomeWriter(reminders: TaskReminders) {
	return {
		/**
		 * Record what happened on a follow-up (REQ-MTG-022): on a task the person holds, or for an Owner or Admin as a
		 * standalone contact with a Person. Completing the task is a separate choice. no_longer_needed closes the task
		 * without credit and keeps a generated duty waived. Only contacted changes the Person's contact date.
		 */
		async recordOutcome(tx: Tx, context: TaskContext, raw: unknown) {
			return answer(tx, async () => {
				const input = parse(c.recordOutcomeRequest, raw);
				return command(tx, context, "followups.recordOutcome", input, async (cmd) => {
					const v = input.input,
						plant = cmd.actor.plantId,
						clock = new Date();
					let task: LockedTask | null = null;
					if (v.target.kind === "task") {
						task = await loadTask(tx, plant, v.target.taskId, true);
						// A checklist row or a task with no Person has no follow-up outcome.
						if (!task || task.deleted_at || task.parent_id || !task.person_id) deny();
						if (!administers(cmd.actor) && task.assignee_id !== cmd.actor.accountId) deny();
						if (task.revision !== v.target.expectedRevision) deny("conflict");
						// A closed follow-up takes no new outcome: its completing record is already the answer.
						if (!(OPEN_STATUS as readonly string[]).includes(task.status)) deny("conflict");
					} else if (!administers(cmd.actor)) deny();
					const personId = task?.person_id ?? (v.target.kind === "person" ? v.target.personId : "");
					const facts = await factsOf(tx, plant, cmd.actor.accountId, personId, task?.obligation_id ?? null);
					// Every new reference names a current live Person of this church (REQ-PPL-024).
					if (!facts.live) deny("invalid_subject");
					// One contact is one outreach (D-c): it also finishes the Person's other open follow-ups the recorder may
					// record on. All of them for an Owner or Admin, their own for a Member. One locked read, one write.
					const others =
						task && v.outcome === "contacted" && v.completeTask
							? await lockTasks(
									tx,
									plant,
									sql`t.person_id=${personId}::uuid AND ${followUpTask(sql`t`)} AND t.status IN ${OPEN}
									AND t.id<>${task.id}::uuid ${administers(cmd.actor) ? sql`` : sql`AND t.assignee_id=${cmd.actor.accountId}::uuid`}`,
								)
							: [];
					const row: Stored = {
						id: randomUUID(),
						revision: revision.parse("1"),
						person_id: personId,
						task_id: task?.id ?? null,
						obligation_id: task?.obligation_id ?? null,
						meeting_id: facts.meeting_id ?? task?.meeting_id ?? null,
						outcome: v.outcome,
						occurred_at: occurrence(v.occurredAt, clock, clock),
						recorded_at: clock,
						contact_channel: v.channel,
						notes: v.notes,
						supersedes_id: null,
						voided_at: null,
						completes_task: v.completeTask && isCompleting(v.outcome),
						also_task_ids: others.map((o) => o.id),
					};
					cmd.writes.push(insertOutcome(plant, row));
					if (row.outcome === "contacted") cmd.writes.push(staleAssessments(plant));
					auditOutcome(cmd, {
						subjectId: row.id,
						action: "followup.recorded",
						kind: "outcome",
						before: null,
						after: audited(row),
					});
					let changed = task;
					let changes: Parameters<typeof syncAll>[2] = [];
					const status = v.outcome === "no_longer_needed" ? "no_longer_needed" : row.completes_task ? "complete" : null;
					if (task && status && task.status !== status) {
						const r = setStatus(tx, cmd, task, { status });
						changed = r.row;
						changes = r.changes;
					}
					for (const other of others)
						changes = [...changes, ...setStatus(tx, cmd, other, { status: "complete" }).changes];
					return {
						value: c.outcomeMutation.parse({
							receiptId: cmd.id,
							record: itemOf(
								row,
								{ accountId: cmd.actor.accountId, displayName: facts.actor_name },
								{ also: Object.fromEntries(row.also_task_ids.map((id) => [id, originOf(facts.origins[id])])) },
							),
							previous: null,
							task: changed ? mutation(cmd, changed, "changed").task : null,
							lastConfirmedContactAt: latest(facts.last_contact, row.outcome === "contacted" ? row.occurred_at : null),
						}),
						after: syncAll(reminders, tx, changes),
					};
				});
			});
		},
		/**
		 * Correct or withdraw a recorded outcome with a reason (REQ-MTG-022). The old entry stays in the log; a correction
		 * is a new entry that names it. The contact date is recomputed from the effective entries, so withdrawing a wrong
		 * latest contact shows the earlier one. The task's status and any sent mail stay as they are. An Owner or Admin
		 * corrects any entry; a Member only their own entry on a task they still hold.
		 */
		async correctOutcome(tx: Tx, context: TaskContext, raw: unknown) {
			return answer(tx, async () => {
				const input = parse(c.correctOutcomeRequest, raw);
				return command(tx, context, "followups.correctOutcome", input, async (cmd) => {
					const v = input.input,
						plant = cmd.actor.plantId,
						clock = new Date();
					const r = await tx.execute(sql`SELECT to_jsonb(o) || jsonb_build_object('revision', o.revision::text) AS row,
						(SELECT a.actor_id FROM audit_event a WHERE a.tenant_id=o.plant_id AND a.subject_id=o.id
							ORDER BY a.occurred_at, a.id LIMIT 1) AS author_id,
						(SELECT i.display_name FROM audit_event a CROSS JOIN LATERAL seat_identity(a.actor_id) i
							WHERE a.tenant_id=o.plant_id AND a.subject_id=o.id ORDER BY a.occurred_at, a.id LIMIT 1) AS author_name,
						(SELECT a.reason FROM audit_event a WHERE a.tenant_id=o.plant_id AND a.subject_id=o.id
							ORDER BY a.occurred_at, a.id LIMIT 1) AS corrects_reason,
						(SELECT coalesce(jsonb_object_agg(k.id, ${originJson(sql`k`)}),'{}') FROM task k
							WHERE k.plant_id=o.plant_id AND k.id=ANY(o.also_task_ids)) AS origins,
						t.assignee_id AS task_assignee, t.deleted_at IS NULL AND t.parent_id IS NULL AS task_live,
						p.state='live' AS person_live,
						(SELECT max(x.occurred_at) FROM contact_outcome x WHERE x.plant_id=o.plant_id AND x.person_id=o.person_id
							AND x.voided_at IS NULL AND x.outcome='contacted' AND x.id<>o.id) AS others_contact,
						(SELECT display_name FROM seat_identity(${cmd.actor.accountId}::uuid)) AS actor_name
					FROM contact_outcome o
					LEFT JOIN task t ON t.id=o.task_id AND t.plant_id=o.plant_id
					LEFT JOIN person p ON p.id=o.person_id AND p.tenant_id=o.plant_id
					WHERE o.id=${v.outcomeId}::uuid AND o.plant_id=${plant}::uuid
					FOR UPDATE OF o`);
					if (!r.rows[0]) deny();
					const f = correctionFacts.parse(r.rows[0]);
					const old: Stored = { ...f.row, revision: f.row.revision };
					// A Member corrects only an entry they recorded, on a task they still hold (REQ-MTG-022).
					const own =
						old.task_id !== null &&
						f.task_live === true &&
						f.task_assignee === cmd.actor.accountId &&
						f.author_id === cmd.actor.accountId;
					if (!administers(cmd.actor) && !own) deny();
					if (old.voided_at || old.revision !== input.expectedRevision) deny("conflict");
					const me = { accountId: cmd.actor.accountId, displayName: f.actor_name };
					const author = f.author_id ? { accountId: f.author_id, displayName: f.author_name } : null;
					const corrects = old.supersedes_id ? { id: old.supersedes_id, reason: f.corrects_reason } : null;
					const voided: Stored = {
						...old,
						voided_at: clock,
						revision: revision.parse(String(BigInt(old.revision) + 1n)),
					};
					cmd.writes.push(
						sql`UPDATE contact_outcome SET voided_at=${clock.toISOString()}::timestamptz, revision=revision+1
						WHERE id=${old.id}::uuid AND plant_id=${plant}::uuid AND revision=${old.revision}::bigint`,
					);
					const k = v.correction;
					let next: Stored | null = null;
					if (k.kind === "replace") {
						if (!f.person_live) deny("invalid_subject");
						next = {
							...old,
							id: randomUUID(),
							revision: revision.parse("1"),
							outcome: k.outcome,
							occurred_at: occurrence(k.occurredAt, old.occurred_at, clock),
							recorded_at: clock,
							contact_channel: k.channel === undefined ? old.contact_channel : k.channel,
							notes: k.notes === undefined ? old.notes : k.notes,
							supersedes_id: old.id,
							voided_at: null,
							completes_task: old.completes_task && isCompleting(k.outcome),
						};
						cmd.writes.push(insertOutcome(plant, next));
						auditOutcome(cmd, {
							subjectId: next.id,
							action: "followup.corrected",
							kind: "correct",
							before: audited(old),
							after: audited(next),
							reason: v.reason,
						});
					}
					auditOutcome(cmd, {
						subjectId: old.id,
						action: "followup.corrected",
						kind: next ? "supersede" : "remove",
						before: { voided_at: null },
						after: { voided_at: at(clock) },
						reason: v.reason,
					});
					if (old.outcome === "contacted" || next?.outcome === "contacted") cmd.writes.push(staleAssessments(plant));
					const also = Object.fromEntries(old.also_task_ids.map((id) => [id, originOf(f.origins[id])]));
					const withdrawn = itemOf(voided, author, {
						also,
						corrected: next !== null,
						corrects,
						voided: { ...me, reason: v.reason },
					});
					return {
						value: c.outcomeMutation.parse({
							receiptId: cmd.id,
							record: next ? itemOf(next, me, { also, corrects: { id: old.id, reason: v.reason } }) : withdrawn,
							previous: next ? withdrawn : null,
							task: null,
							lastConfirmedContactAt: latest(f.others_contact, next?.outcome === "contacted" ? next.occurred_at : null),
						}),
					};
				});
			});
		},
	};
}
