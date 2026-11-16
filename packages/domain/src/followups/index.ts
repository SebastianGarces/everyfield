import "server-only";
import type { TaskReminders } from "../tasks/writes.ts";
import { assignmentWriter } from "./assignments.ts";
import { outcomeWriter } from "./outcomes.ts";

export { withFollowUpWrite, type FollowUpReply } from "./core.ts";
export { followUpReader } from "./queries.ts";

export function createFollowUpWriter(deps: { reminders: TaskReminders }) {
	return { ...outcomeWriter(deps.reminders), ...assignmentWriter(deps.reminders) };
}
export type FollowUpWriter = ReturnType<typeof createFollowUpWriter>;
