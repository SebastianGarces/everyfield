import type * as c from "@everyfield/contracts/tasks";
import type { z } from "zod";
import type { Candidate, Occurrence, Outcome, Prerequisites, TaskDetail, TaskHistory } from "./model.ts";

// The browser side of read.ts. A network failure or a server error reads as lost, so the screen can offer a retry.
async function get<T>(params: Record<string, string> | URLSearchParams): Promise<Outcome<T>> {
	try {
		const r = await fetch(`/tasks/read?${new URLSearchParams(params)}`, { cache: "no-store" });
		return r.ok ? ((await r.json()) as Outcome<T>) : { status: "lost" };
	} catch {
		return { status: "lost" };
	}
}
/** The task panel's read: the task, its first history page, what it waits for and its series' open occurrence. */
export type Loaded = {
	task: TaskDetail;
	/** The first history page, or why it is missing: no recorded status change, or a failed read. */
	history: Outcome<TaskHistory>;
	prerequisites: Pick<Prerequisites, "taskId" | "items" | "blocked"> | null;
	occurrence: Occurrence | null;
};
export const loadTask = (id: string) => get<Loaded>({ what: "task", id });
/** The derived "Blocked by" count of each task on the page the query names (the address's own search). */
export function loadBlocking(search: string) {
	const params = new URLSearchParams(search);
	params.set("what", "blocking");
	return get<{ id: string; openPrerequisites: number }[]>(params);
}
export const prerequisiteCandidates = (id: string, search: string) =>
	get<{ items: Candidate[] }>({ what: "candidates", id, search });
export const loadHistory = (id: string, page: number) => get<TaskHistory>({ what: "history", id, page: String(page) });
export const assigneeOptions = () => get<z.infer<typeof c.assigneeOptions>>({ what: "seats" });
export const relationOptions = (kind: string, search: string) =>
	get<z.infer<typeof c.relationOptions>>({ what: "relations", kind, search });
