import type { TaskReminders } from "@everyfield/domain/tasks";
import "server-only";
import type { createNotificationService } from "../jobs/notifications.ts";

/**
 * Task writes reach WP-031's reminder sync through this port (REQ-TSK-014), all tasks of one write in one call. An
 * open, dated, assigned task gets its due and overdue notices for the current assignee and revision; any other task
 * loses its owed notices. Delivered slots stay delivered, and a past slot is never planned again.
 */
export function taskReminders(notifications: ReturnType<typeof createNotificationService>): TaskReminders {
	return (tx, sources) => {
		const asOf = new Date().toISOString();
		return notifications.syncTaskReminders(
			tx,
			sources.map((s) => ({
				base: {
					owner: { kind: "plant" as const, id: s.plantId },
					source: { kind: "task" as const, id: s.taskId, revision: s.revision },
					recipient: s.assigneeId,
					title: `Task due: ${s.title}`.slice(0, 500),
					text: `"${s.title}" is assigned to you in EveryField.`,
					operation: null,
				},
				due: s.due,
				open: s.open && s.assigneeId !== null,
				created: s.created,
				asOf,
			})),
		);
	};
}
