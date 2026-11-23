import type { LaunchNotices } from "@everyfield/domain/launch";
import "server-only";
import type { createNotificationService } from "@everyfield/domain/jobs";

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
