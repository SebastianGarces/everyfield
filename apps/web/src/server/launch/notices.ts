import type { LaunchNotices } from "@everyfield/domain/launch";
import "server-only";
import type { createNotificationService } from "../jobs/notifications.ts";

/**
 * Launch notifications (NTF-009) through WP-031's notification service: one notice for each of the church's other
 * current Owners and Admins when a person completes a milestone, under each recipient's Launch notification setting.
 * The logical key names the milestone revision, so replaying the same completion adds nothing.
 */
export function launchNotices(service: ReturnType<typeof createNotificationService>): LaunchNotices {
	return (tx, done) => {
		const who = done.actorName || "Someone";
		const church = done.plantName || "your church";
		return service.enqueueMany(
			tx,
			done.recipients.map((recipient) => ({
				owner: { kind: "plant" as const, id: done.plantId },
				source: { kind: "launch_milestone" as const, id: done.milestoneId, revision: done.revision },
				recipient,
				category: "launch_milestone" as const,
				occurrence: "complete",
				eligibleAt: new Date().toISOString(),
				title: `${who} completed “${done.milestoneTitle}”`.slice(0, 500),
				text: `${who} marked the Launch plan milestone “${done.milestoneTitle}” complete for ${church}.`,
				operation: done.operationId,
			})),
		);
	};
}
