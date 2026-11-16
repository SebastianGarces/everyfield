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

async function get<T>(params: Record<string, string> | URLSearchParams): Promise<Outcome<T>> {
	try {
		const r = await fetch(`/tasks/read?${new URLSearchParams(params)}`, { cache: "no-store" });
		return r.ok ? ((await r.json()) as Outcome<T>) : { status: "lost" };
	} catch {
		return { status: "lost" };
	}
}
export type Loaded = {
	task: TaskDetail;
	history: Outcome<TaskHistory>;
	contacts: ReadOutcome<ContactHistory> | null;
	prerequisites: Pick<Prerequisites, "taskId" | "items" | "blocked"> | null;
	occurrence: Occurrence | null;
};
export const loadTask = (id: string) => get<Loaded>({ what: "task", id });
export const loadBlocking = (ids: readonly string[]) =>
	get<{ id: string; openPrerequisites: number }[]>(
		new URLSearchParams([["what", "blocking"], ...ids.map((id) => ["id", id])]),
	);
export const loadRows = (ids: readonly string[]) =>
	get<{ items: TaskItem[] }>(new URLSearchParams([["what", "rows"], ...ids.map((id) => ["id", id])]));
export const prerequisiteCandidates = (id: string, search: string) =>
	get<{ items: Candidate[] }>({ what: "candidates", id, search });
export const loadHistory = (id: string, page: number) => get<TaskHistory>({ what: "history", id, page: String(page) });
export const assigneeOptions = (purpose: "any" | "committed_follow_up" = "any") =>
	get<z.infer<typeof c.assigneeOptions>>({ what: "seats", purpose });
export const relationOptions = (kind: string, search: string) =>
	get<z.infer<typeof c.relationOptions>>({ what: "relations", kind, search });
export const loadTemplates = () => get<TemplateCatalog>({ what: "templates" });
export const loadPreview = (key: string) => get<TemplatePreview>({ what: "preview", key });
export const loadOffer = (transitionId?: string) =>
	get<PhaseOffer>(transitionId ? { what: "offer", id: transitionId } : { what: "offer" });
