import type { TaskReminders } from "@everyfield/domain/tasks";
import "server-only";
import type { createNotificationService } from "@everyfield/domain/jobs";

export function taskReminders(notifications: ReturnType<typeof createNotificationService>): TaskReminders {
	return (tx, sources) => {
		const asOf = new Date().toISOString();
		return notifications.syncTaskReminders(
			tx,
			sources.map((s) => ({
				base: {
					owner: { kind: "plant" as const, id: s.plantId },
					source: { kind: "task" as const, id: s.taskId, revision: s.revision },
					text: `"${s.title}" is assigned to you in Everyfield.`,
					operation: null,
				},
				titles: {
					due: `Task due: ${s.title}`.slice(0, 500),
					overdue: `Task overdue: ${s.title}`.slice(0, 500),
				},
				recipients: s.assigneeIds,
				due: s.due,
				open: s.open && s.assigneeIds.length > 0,
				created: s.created,
				asOf,
			})),
		);
	};
}
