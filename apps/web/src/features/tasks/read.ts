import * as c from "@everyfield/contracts/tasks";
import { taskReader } from "@everyfield/domain/tasks";
import "server-only";
import type { z } from "zod";
import { parseQuery, type Outcome } from "./model.ts";
import { loadTask, read, reader, taskViewer, type TaskViewer } from "./server.ts";

// GET /tasks/read: the Tasks screens' reads after the first paint (the open task, more history, the seats, the
// people, meetings or teams a task may name, the tasks one may wait for, and the list's blocked badges). A GET handler, not a server action, so a read never waits for a save or
// holds one up. Every read rechecks the live seat inside its statement (C13).

const answer = (body: Outcome<unknown>) => Response.json(body, { headers: { "cache-control": "private, no-store" } });
const invalid = { status: "refused", code: "invalid_input" } as const;

function parsed<S extends z.ZodType>(schema: S, raw: unknown, run: (v: z.output<S>) => Promise<Outcome<unknown>>) {
	const input = schema.safeParse(raw);
	return input.success ? run(input.data) : Promise.resolve(invalid);
}
const refusalOf = <T>(r: { status: "ok"; value: T } | { status: "refused"; error: c.TaskError }): Outcome<T> =>
	r.status === "ok" ? r : { status: "refused", code: r.error.code };

export async function GET(request: Request) {
	const viewer: TaskViewer | null = await taskViewer();
	if (!viewer) return answer({ status: "refused", code: "access_denied" });
	const p = new URL(request.url).searchParams;
	switch (p.get("what")) {
		case "task":
			return answer(
				await parsed(c.getTaskRequest, { taskId: p.get("id") }, (v) =>
					read(viewer, (tx) => loadTask(tx, viewer, v.taskId)),
				),
			);
		case "history":
			return answer(
				await parsed(c.statusHistoryRequest, { taskId: p.get("id"), page: Number(p.get("page")), limit: 50 }, (v) =>
					read(viewer, (tx) => reader.history(tx, viewer, v.taskId, v.page)),
				),
			);
		// The current page's derived "Blocked by" counts, after a task they may wait for settled, reopened or was deleted.
		// The same scope as the page; only the badge leaves the server.
		case "blocking": {
			const r = await read(viewer, (tx) => reader.list(tx, viewer, parseQuery(p)));
			return answer(
				r.status === "ok"
					? { status: "ok", value: r.value.items.map((t) => ({ id: t.id, openPrerequisites: t.openPrerequisites })) }
					: r,
			);
		}
		case "seats":
			return answer(
				await read(viewer, async (tx) => refusalOf(await taskReader.eligibleAssignees(tx, viewer.authority))),
			);
		case "candidates":
			return answer(
				await parsed(c.prerequisiteCandidatesRequest, { taskId: p.get("id"), search: p.get("search") ?? "" }, (v) =>
					read(viewer, async (tx) => refusalOf(await taskReader.prerequisiteCandidates(tx, viewer.authority, v))),
				),
			);
		case "relations":
			return answer(
				await parsed(c.relationOptionsRequest, { kind: p.get("kind"), search: p.get("search") ?? "" }, (v) =>
					read(viewer, async (tx) => refusalOf(await taskReader.relationOptions(tx, viewer.authority, v))),
				),
			);
		default:
			return answer(invalid);
	}
}
