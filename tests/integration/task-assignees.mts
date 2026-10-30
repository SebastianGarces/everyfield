import { and, eq, sql } from "../../packages/db/src/query.ts";
import * as t from "../../packages/db/src/schema/tables.ts";

type Admin = { insert: (table: never) => { values: (v: never) => PromiseLike<unknown> }; select: (...a: never[]) => never };
type Row = Record<string, unknown> & { id?: string; plant_id: string; assignee_id?: string | null; assignee_ids?: string[] };

/**
 * Insert task rows the way the tests describe them: `assignee_id` names one assignee and `assignee_ids` several. The
 * set lives in task_assignee, so each row is stored without them and its members follow.
 */
export async function insertTasks(admin: any, rows: Row[]) {
	const tasks = rows.map(({ assignee_id: _one, assignee_ids: _many, ...task }) => ({ id: crypto.randomUUID(), ...task }));
	await admin.insert(t.task).values(tasks);
	const members = rows.flatMap((r, i) =>
		(r.assignee_ids ?? (r.assignee_id ? [r.assignee_id] : [])).map((account_id) => ({
			plant_id: r.plant_id,
			task_id: tasks[i]!.id,
			account_id,
		})),
	);
	if (members.length) await admin.insert(t.task_assignee).values(members);
	return tasks.map((x) => x.id);
}
/** The account IDs assigned to a task, sorted. */
export async function assigneesOf(admin: any, taskId: string): Promise<string[]> {
	const rows = await admin.select({ id: t.task_assignee.account_id }).from(t.task_assignee).where(eq(t.task_assignee.task_id, taskId));
	return rows.map((r: { id: string }) => r.id).sort();
}
/** How many tasks of `plant` the account is assigned to. */
export async function assignedCount(admin: any, account: string, plant: string): Promise<number> {
	const rows = await admin
		.select({ n: sql`count(*)::int` })
		.from(t.task_assignee)
		.where(and(eq(t.task_assignee.account_id, account), eq(t.task_assignee.plant_id, plant)));
	return Number(rows[0].n);
}
