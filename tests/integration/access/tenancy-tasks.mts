// The tasks reads of INV-tenancy (tenancy.test.mts): church A's tasks, written through the task writes as its owner,
// and one case per read.
import assert from "node:assert/strict";
import { createTaskWriter, taskReader, withTaskWrite } from "../../../packages/domain/src/tasks/index.ts";
import { planNoReminders } from "./tenancy-meetings.mts";

const tasks = createTaskWriter({ reminders: planNoReminders });

/** A ministry task with a subtask, a prerequisite and a status change, and a weekly task with an open occurrence. */
export async function seedTasks(t) {
	const { a, MARK, key, ok } = t;
	const write = (op, input) => withTaskWrite(t.f.db, t.ownerA.actor, (tx, c) => tasks[op](tx, c, input));
	const create = async (title, input = {}) =>
		ok(await write("create", { requestKey: key(), input: { title: `${MARK} ${title}`, ...input } })).task;
	const prerequisite = await create("prerequisite", { description: `${MARK} first` });
	let task = await create("task", {
		description: `${MARK} task notes`,
		assigneeIds: [t.ownerA.id],
		relation: { kind: "team", id: a.ministry },
	});
	a.task = task.id;
	ok(
		await write("createSubtask", {
			requestKey: key(),
			expectedRevision: task.revision,
			input: { parentId: task.id, title: `${MARK} subtask` },
		}),
	);
	task = ok(await t.f.db.transaction((tx) => taskReader.get(tx, t.ownerA.actor, { taskId: task.id }))).task;
	task = ok(
		await write("replacePrerequisites", {
			requestKey: key(),
			expectedRevision: task.revision,
			input: { taskId: task.id, prerequisiteIds: [prerequisite.id] },
		}),
	).task;
	ok(
		await write("changeStatus", {
			requestKey: key(),
			expectedRevision: task.revision,
			input: { taskId: task.id, status: "in_progress" },
		}),
	);
	const weekly = await create("weekly", { due: { kind: "local_date", date: t.occurredOn } });
	a.weekly = ok(
		await write("configureRecurrence", {
			requestKey: key(),
			expectedRevision: weekly.revision,
			input: { taskId: weekly.id, rule: { frequency: "weekly", until: null } },
		}),
	).task.id;
}

export function tasksCases(t, who) {
	const { a, MARK } = t;
	const k = (name, input, expected) => [
		`tasks:taskReader.${name}`,
		{ run: () => t.f.db.transaction((tx) => taskReader[name](tx, who.actor, input)), expected },
	];
	const unavailable = { refused: "unavailable" };
	const task = { taskId: a.task };
	return [
		k("list", { search: MARK }, { value: { items: [], total: 0, page: 1, next: null, completeness: "complete" } }),
		k(
			"count",
			// This seed's own tasks: the meetings and followups seeds' duties have other categories.
			{ search: MARK, categories: ["general"] },
			{
				value: {
					topLevelTotal: 0,
					byStatus: [],
					byPriority: [],
					byCategory: [],
					childTaskTotal: 0,
					childTaskComplete: 0,
					completeness: "complete",
				},
				// Counts only: church A's own owner counts its three tasks, one in progress, and the subtask.
				control: (value) =>
					assert.deepEqual(value, {
						topLevelTotal: 3,
						byStatus: [
							{ value: "in_progress", count: 1 },
							{ value: "not_started", count: 2 },
						],
						byPriority: [{ value: "medium", count: 3 }],
						byCategory: [{ value: "general", count: 3 }],
						childTaskTotal: 1,
						childTaskComplete: 0,
						completeness: "complete",
					}),
			},
		),
		k("get", task, { value: { status: "unavailable" } }),
		k("statusHistory", task, unavailable),
		k(
			"eligibleAssignees",
			{},
			// Church B's own seat, its owner: church A's owner reads church A's.
			{ value: { items: [{ accountId: who.id, displayName: "Synthetic person", role: "owner" }] } },
		),
		k("relationOptions", { kind: "team", search: MARK }, { value: { items: [] } }),
		k("listSubtasks", { parentId: a.task }, unavailable),
		k("listPrerequisites", task, unavailable),
		k("prerequisiteCandidates", { taskId: a.task, search: MARK }, { value: { items: [] } }),
		k("findOpenOccurrence", { taskId: a.weekly }, unavailable),
	];
}
