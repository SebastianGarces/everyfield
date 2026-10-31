import { localDate, localDateTime, resolveCalendar, revision, type TimeZone } from "@everyfield/contracts/common";
import * as c from "@everyfield/contracts/tasks";
import { randomUUID } from "node:crypto";
import "server-only";
import type { LockedTask, TaskRow } from "./queries.ts";
import { newTask } from "./writes.ts";

const localDateOf = (at: Date, zone: TimeZone) =>
	localDate.parse(new Intl.DateTimeFormat("en-CA", { timeZone: zone }).format(at));

/**
 * The next occurrence of a recurring task completed at `at` (REQ-TSK-007), or null when the series has stopped, already
 * has a successor, or the next date falls after the inclusive end date. The successor is due one interval after the
 * current due date, or after the completion date when undated, so a late completion may yield an overdue successor.
 * A rule time or a timed predecessor gives a timed successor, resolved automatically: earlier fold, forward over a gap.
 * The successor keeps the task's fields, keeps each assignee only while that account still holds a seat, and gets fresh
 * copies of the live checklist rows: not started, no completion facts, no due date, no prerequisites.
 */
export function successorOf(row: LockedTask, at: Date): TaskRow[] | null {
	const rule = row.rule;
	if (!rule || rule.stopped || row.has_successor || row.parent_id) return null;
	const zone = row.plant_zone;
	const base = row.due_kind === "undated" ? localDateOf(at, zone) : localDate.parse(row.due_date);
	const date = c.nextOccurrenceDate(base, rule.frequency);
	if (rule.until && date > rule.until) return null;
	const time = rule.local_time ? `${rule.local_time}:00` : row.due_kind === "timed" ? row.due_time!.slice(0, 8) : null;
	let due: Pick<TaskRow, "due_kind" | "due_date" | "due_time" | "timezone" | "due_at">;
	if (time) {
		const r = resolveCalendar(localDateTime.parse(`${date}T${time}`), zone, "automatic");
		if (r.kind !== "resolved") throw new RangeError("automatic resolution always resolves");
		// Store the wall time that actually occurs: 02:30 in a spring gap is kept as 03:30.
		const at = Date.parse(r.occurrence.instant);
		const wall = new Date(at + r.occurrence.offsetSeconds * 1000).toISOString();
		due = {
			due_kind: "timed",
			due_date: wall.slice(0, 10),
			due_time: wall.slice(11, 19),
			timezone: zone,
			due_at: new Date(at),
		};
	} else due = { due_kind: "date_only", due_date: date, due_time: null, timezone: null, due_at: null };
	const id = randomUUID();
	const keep = row.relation_live;
	const fresh = {
		revision: revision.parse("1"),
		status: "not_started" as const,
		created_at: at,
		completed_at: null,
		deleted_at: null,
		obligation_id: null,
		obligation_kind: null,
		prerequisite_ids: [],
		open_prerequisites: 0,
		child_total: 0,
		child_complete: 0,
		open_successor: null,
		plant_zone: zone,
	};
	const children = row.checklist.map((k) =>
		newTask(zone, {
			title: k.title,
			category: row.category,
			priority: row.priority,
			status: "not_started",
			created_at: at,
			assignees: k.assignees.filter((a) => a.seated),
			parent_id: id,
		}),
	);
	const successor: TaskRow = {
		...row,
		...fresh,
		...due,
		id,
		assignees: row.assignees.filter((a) => a.seated),
		...(keep ? {} : { person_id: null, meeting_id: null, team_id: null, relation_label: null }),
		occurrence_key: String(Number(row.occurrence_key ?? "1") + 1),
		predecessor_id: row.id,
		child_total: children.length,
		checklist: children.map((k) => ({
			id: k.id,
			revision: k.revision,
			title: k.title,
			status: k.status,
			assignees: k.assignees,
		})),
	};
	return [successor, ...children];
}
