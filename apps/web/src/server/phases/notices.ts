import type { PhaseNotices } from "@everyfield/domain/phases";
import "server-only";
import type { createNotificationService } from "../jobs/notifications.ts";

type Service = ReturnType<typeof createNotificationService>;
type Eligible = Parameters<typeof createNotificationService>[0]["eligible"];

export function phaseNotices(service: (eligible: Eligible) => Service): PhaseNotices {
	return (tx, advance) => {
		const addresses = new Map(advance.recipients.map((r) => [r.accountId, r.address]));
		const notifications = service(async (_tx, inputs) =>
			inputs.map((i) => {
				const address = addresses.get(i.recipient);
				return address ? { address } : null;
			}),
		);
		const name = advance.plantName || "A church you support";
		return notifications.enqueueMany(
			tx,
			advance.recipients.map((r) => ({
				owner: { kind: "organization" as const, id: r.organizationId, organizationKind: r.organizationKind },
				source: { kind: "phase_transition" as const, id: advance.transitionId, revision: "1" },
				recipient: r.accountId,
				category: "phase_milestone" as const,
				occurrence: "advance/" + r.organizationId,
				eligibleAt: new Date().toISOString(),
				title: `${name} moved to Phase ${advance.toPhase}`.slice(0, 500),
				text: `${name} moved from Phase ${advance.fromPhase} to Phase ${advance.toPhase} in Everyfield.`,
				operation: null,
			})),
		);
	};
}
