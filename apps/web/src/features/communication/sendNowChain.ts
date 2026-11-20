import type { Outcome } from "@everyfield/contracts/common";
import type { DeliveryReport, HandoffResult } from "./model.ts";

const EARLIEST_SEND_MS = 60_000;

const earliestSendAt = (now: number): string =>
	new Date(Math.ceil((now + EARLIEST_SEND_MS) / 60_000) * 60_000).toISOString();

type Scheduled = { communicationId: string; revision: string; scheduledAt: string };

type HandoffSteps = {
	schedule: (at: string) => Promise<Outcome<Scheduled>>;
	handOff: (revision: string, communicationId: string) => Promise<Outcome<DeliveryReport>>;
};

export async function chainHandoff(steps: HandoffSteps, at: string): Promise<Outcome<HandoffResult>> {
	const scheduled = await steps.schedule(at);
	if (scheduled.status !== "ok") return scheduled;
	const { communicationId, revision, scheduledAt } = scheduled.value;
	const sent = await steps.handOff(revision, communicationId);
	if (sent.status !== "ok") {
		const issue = sent.status === "lost" ? "lost" : sent.code;
		return { status: "ok", value: { communicationId, revision, scheduledAt, report: null, sendIssue: issue } };
	}
	return { status: "ok", value: { communicationId, revision, scheduledAt, report: sent.value, sendIssue: null } };
}

export const chainSendNow = (steps: HandoffSteps, now = Date.now()) => chainHandoff(steps, earliestSendAt(now));
