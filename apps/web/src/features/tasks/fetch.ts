import type * as c from "@everyfield/contracts/tasks";
import type { z } from "zod";
import type { ContactHistory, Outcome as ReadOutcome } from "../followups/model.ts";
import type {
	Candidate,
	Occurrence,
	Outcome,
	PhaseOffer,
	Prerequisites,
	TaskDetail,
	TaskHistory,
	TaskItem,
	TemplateCatalog,
	TemplatePreview,
} from "./model.ts";

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
	/** The first history page, or why it did not load. */
	history: Outcome<TaskHistory>;
	/** A follow-up's first page of contact history, or why it did not load. Null for any other task. */
	contacts: ReadOutcome<ContactHistory> | null;
	prerequisites: Pick<Prerequisites, "taskId" | "items" | "blocked"> | null;
	occurrence: Occurrence | null;
};
export const loadTask = (id: string) => get<Loaded>({ what: "task", id });
/** The derived "Blocked by" count of each named task on the page. */
export const loadBlocking = (ids: readonly string[]) =>
	get<{ id: string; openPrerequisites: number }[]>(
		new URLSearchParams([["what", "blocking"], ...ids.map((id) => ["id", id])]),
	);
/** The list rows of the named tasks, read together in one statement. */
export const loadRows = (ids: readonly string[]) =>
	get<{ items: TaskItem[] }>(new URLSearchParams([["what", "rows"], ...ids.map((id) => ["id", id])]));
export const prerequisiteCandidates = (id: string, search: string) =>
	get<{ items: Candidate[] }>({ what: "candidates", id, search });
export const loadHistory = (id: string, page: number) => get<TaskHistory>({ what: "history", id, page: String(page) });
/** The church's seats; with `committed_follow_up`, only those who may own a follow-up (REQ-TSK-012). */
export const assigneeOptions = (purpose: "any" | "committed_follow_up" = "any") =>
	get<z.infer<typeof c.assigneeOptions>>({ what: "seats", purpose });
export const relationOptions = (kind: string, search: string) =>
	get<z.infer<typeof c.relationOptions>>({ what: "relations", kind, search });
/** The checklist catalog with the church's current phase (Owner and Admin). */
export const loadTemplates = () => get<TemplateCatalog>({ what: "templates" });
/** One checklist's tasks, due from today in the church's time zone. Creates nothing. */
export const loadPreview = (key: string) => get<TemplatePreview>({ what: "preview", key });
/** The open phase offer, or the one for this move with what its answer decided. */
export const loadOffer = (transitionId?: string) =>
	get<PhaseOffer>(transitionId ? { what: "offer", id: transitionId } : { what: "offer" });
