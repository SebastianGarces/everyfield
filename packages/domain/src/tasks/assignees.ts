import { accountId } from "@everyfield/contracts/common";
import { sql, type SQL, type SqlLiteral } from "@everyfield/db/query";
import "server-only";
import { z } from "zod";

const assigneeRow = z.object({ accountId, displayName: z.string(), seated: z.boolean() });
export const sortPeople = <T extends { accountId: string; displayName: string }>(people: readonly T[]): T[] =>
	[...people].sort((a, b) => {
		const x = a.displayName.toLowerCase(),
			y = b.displayName.toLowerCase();
		return x < y ? -1 : x > y ? 1 : a.accountId < b.accountId ? -1 : a.accountId > b.accountId ? 1 : 0;
	});
export const assigneeList = z.array(assigneeRow).transform(sortPeople);
export const idsOf = (people: readonly { accountId: string }[]) => people.map((p) => p.accountId).sort();

export const assigneesOf = <TaskName extends string>(task: SqlLiteral<TaskName>) => {
	const t = sql.raw(task);
	return sql`(SELECT coalesce(jsonb_agg(jsonb_build_object('accountId',x.account_id,'displayName',x.name,'seated',x.seated)),
		'[]'::jsonb) FROM (SELECT a.account_id,
			coalesce((SELECT i.display_name FROM seat_identity(a.account_id) i LIMIT 1),'') AS name,
			EXISTS(SELECT FROM seat s WHERE s.account_id=a.account_id AND s.plant_id=${t}.plant_id AND s.ended_at IS NULL
				AND s.accepted_at<=clock_timestamp()) AS seated
			FROM task_assignee a WHERE a.task_id=${t}.id) x)`;
};
export const assignedTo = <TaskName extends string>(task: SqlLiteral<TaskName>, account: SQL) =>
	sql`EXISTS(SELECT FROM task_assignee ta WHERE ta.task_id=${sql.raw(task)}.id AND ta.account_id=${account})`;

export function setWrites(plantId: string, taskId: string, before: readonly string[], ids: readonly string[]): SQL[] {
	const gone = before.filter((id) => !ids.includes(id)),
		joined = ids.filter((id) => !before.includes(id));
	return [
		...(gone.length
			? [
					sql`DELETE FROM task_assignee WHERE task_id=${taskId}::uuid AND plant_id=${plantId}::uuid
						AND account_id=ANY(${sql.param(gone)}::uuid[])`,
				]
			: []),
		...(joined.length
			? [
					sql`INSERT INTO task_assignee (plant_id, task_id, account_id)
						SELECT ${plantId}::uuid, ${taskId}::uuid, u FROM unnest(${sql.param(joined)}::uuid[]) u`,
				]
			: []),
	];
}
