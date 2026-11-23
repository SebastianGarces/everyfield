import type * as c from "@everyfield/contracts/tasks";
import type { z } from "zod";
import { readsFrom, type ReadFailure } from "../../components/get-reads.ts";
import type { Outcome as ReadOutcome } from "@everyfield/contracts/common";
import type { ContactHistory } from "../followups/model.ts";
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
import type { GET } from "./read.ts";

const get = readsFrom<typeof GET>("/tasks/read");

export type Loaded = {
	task: TaskDetail;
	history: Outcome<TaskHistory>;
	contacts: ReadOutcome<ContactHistory> | null;
	prerequisites: Pick<Prerequisites, "taskId" | "items" | "blocked"> | null;
	occurrence: Occurrence | null;
};
export const loadTask = (taskId: string): Promise<Outcome<Loaded> | ReadFailure> => get("task", { taskId });
export const loadRows = (taskIds: readonly string[]): Promise<Outcome<{ items: TaskItem[] }> | ReadFailure> =>
	get("rows", { taskIds: [...taskIds] });
export const prerequisiteCandidates = (
	taskId: string,
	search: string,
): Promise<Outcome<{ items: Candidate[] }> | ReadFailure> => get("candidates", { taskId, search });
export const loadHistory = (taskId: string, page: number): Promise<Outcome<TaskHistory> | ReadFailure> =>
	get("history", { taskId, page });
export const assigneeOptions = (
	purpose: "any" | "committed_follow_up" = "any",
): Promise<Outcome<z.infer<typeof c.assigneeOptions>> | ReadFailure> => get("seats", { purpose });
export const relationOptions = (
	kind: z.input<typeof c.relationOptionsRequest>["kind"],
	search: string,
): Promise<Outcome<z.infer<typeof c.relationOptions>> | ReadFailure> => get("relations", { kind, search });
export const loadTemplates = (): Promise<Outcome<TemplateCatalog> | ReadFailure> => get("templates");
export const loadPreview = (checklistKey: string): Promise<Outcome<TemplatePreview> | ReadFailure> =>
	get("preview", { checklistKey });
export const loadOffer = (transitionId?: string): Promise<Outcome<PhaseOffer> | ReadFailure> =>
	get("offer", transitionId ? { transitionId } : {});
