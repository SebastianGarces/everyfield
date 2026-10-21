import type * as c from "@everyfield/contracts/tasks";
import type { z } from "zod";
import type { Outcome, TaskDetail, TaskHistory } from "./model.ts";

// The browser side of read.ts. A network failure or a server error reads as lost, so the screen can offer a retry.
async function get<T>(params: Record<string, string>): Promise<Outcome<T>> {
	try {
		const r = await fetch(`/tasks/read?${new URLSearchParams(params)}`, { cache: "no-store" });
		return r.ok ? ((await r.json()) as Outcome<T>) : { status: "lost" };
	} catch {
		return { status: "lost" };
	}
}
export const loadTask = (id: string) => get<{ task: TaskDetail; history: TaskHistory | null }>({ what: "task", id });
export const loadHistory = (id: string, page: number) => get<TaskHistory>({ what: "history", id, page: String(page) });
export const assigneeOptions = () => get<z.infer<typeof c.assigneeOptions>>({ what: "seats" });
export const relationOptions = (kind: string, search: string) =>
	get<z.infer<typeof c.relationOptions>>({ what: "relations", kind, search });
