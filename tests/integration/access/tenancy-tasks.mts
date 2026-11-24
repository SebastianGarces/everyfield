import assert from "node:assert/strict";
import { createTaskWriter, taskReader, withTaskWrite } from "../../../packages/domain/src/tasks/index.ts";
import { planNoReminders } from "./tenancy-meetings.mts";
import type { WriteTx } from "../../../packages/domain/src/access/index.ts";
import { gatedTransaction } from "../../../packages/domain/src/operations/writes.ts";
import { casesFor, type Tenancy, type TenancyOwner } from "./tenancy-case.mts";

const tasks = createTaskWriter({ reminders: planNoReminders });

export async function seedTasks(t: Tenancy) {
	const { a, MARK, key, ok } = t;
	const write = <V,>(body: Parameters<typeof withTaskWrite<V>>[2]) => withTaskWrite(t.f.db, t.ownerA.actor, body);
	const create = async (title: string, input: object = {}) =>
		ok(
			await write((tx, c) =>
				tasks.create(tx, c, { requestKey: key(), input: { title: `${MARK} ${title}`, ...input } }),
			),
		).task;
	const prerequisite = await create("prerequisite", { description: `${MARK} first` });
	let task = await create("task", {
		description: `${MARK} task notes`,
		assigneeIds: [t.ownerA.id],
		relation: { kind: "team", id: a.ministry },
	});
	a.task = task.id;
	ok(
		await write((tx, c) =>
			tasks.createSubtask(tx, c, {
				requestKey: key(),
				expectedRevision: task.revision,
				input: { parentId: task.id, title: `${MARK} subtask` },
			}),
		),
	);
	task = ok(await gatedTransaction(t.f.db, (tx) => taskReader.get(tx, t.ownerA.actor, { taskId: task.id }))).task!;
	task = ok(
		await write((tx, c) =>
			tasks.replacePrerequisites(tx, c, {
				requestKey: key(),
				expectedRevision: task.revision,
				input: { taskId: task.id, prerequisiteIds: [prerequisite.id] },
			}),
		),
	).task;
	ok(
		await write((tx, c) =>
			tasks.changeStatus(tx, c, {
				requestKey: key(),
				expectedRevision: task.revision,
				input: { taskId: task.id, status: "in_progress" },
			}),
		),
	);
	const weekly = await create("weekly", { due: { kind: "local_date", date: t.occurredOn } });
	a.weekly = ok(
		await write((tx, c) =>
			tasks.configureRecurrence(tx, c, {
				requestKey: key(),
				expectedRevision: weekly.revision,
				input: { taskId: weekly.id, rule: { frequency: "weekly", until: null } },
			}),
		),
	).task.id;
}

export function tasksCases(t: Tenancy, who: TenancyOwner) {
	const { a, MARK } = t;
	const k = casesFor("tasks:taskReader.");
	const read = <V,>(body: (tx: WriteTx) => Promise<V>) => gatedTransaction(t.f.db, body);
	const unavailable = { refused: "unavailable" };
	const task = { taskId: a.task };
	return [
		k("list", () => read((tx) => taskReader.list(tx, who.actor, { search: MARK })), {
			value: { items: [], total: 0, page: 1, next: null, completeness: "complete" },
		}),
		k("count", () => read((tx) => taskReader.count(tx, who.actor, { search: MARK, categories: ["general"] })), {
			value: {
				topLevelTotal: 0,
				byStatus: [],
				byPriority: [],
				byCategory: [],
				childTaskTotal: 0,
				childTaskComplete: 0,
				completeness: "complete",
			},
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
		}),
		k("listRows", () => read((tx) => taskReader.listRows(tx, who.actor, { taskIds: [a.task] })), {
			value: { items: [] },
		}),
		k("get", () => read((tx) => taskReader.get(tx, who.actor, task)), { value: { status: "unavailable" } }),
		k("statusHistory", () => read((tx) => taskReader.statusHistory(tx, who.actor, task)), unavailable),
		k("eligibleAssignees", () => read((tx) => taskReader.eligibleAssignees(tx, who.actor, {})), {
			value: { items: [{ accountId: who.id, displayName: "Synthetic person", role: "owner" }] },
		}),
		k(
			"relationOptions",
			() => read((tx) => taskReader.relationOptions(tx, who.actor, { kind: "team", search: MARK })),
			{ value: { items: [] } },
		),
		k("listSubtasks", () => read((tx) => taskReader.listSubtasks(tx, who.actor, { parentId: a.task })), unavailable),
		k("listPrerequisites", () => read((tx) => taskReader.listPrerequisites(tx, who.actor, task)), unavailable),
		k(
			"prerequisiteCandidates",
			() => read((tx) => taskReader.prerequisiteCandidates(tx, who.actor, { taskId: a.task, search: MARK })),
			{ value: { items: [] } },
		),
		k(
			"findOpenOccurrence",
			() => read((tx) => taskReader.findOpenOccurrence(tx, who.actor, { taskId: a.weekly })),
			unavailable,
		),
	];
}
