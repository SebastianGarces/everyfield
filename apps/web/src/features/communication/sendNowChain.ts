import type { DeliveryReport, HandoffResult, Outcome } from "./model.ts";

// The Send now and Schedule chains, apart from the server actions so a test can run them with its own steps. The
// actions in actions.ts pass the real commands. Nothing here reads the request or the database.

/** The earliest send time the scheduling window accepts, from now. */
const EARLIEST_SEND_MS = 60_000;

/**
 * The send time of the Send now schedule step: the next whole minute at least one minute away. A retry with the same
 * request keys inside that minute asks for the same time, so the saved request replays instead of conflicting.
 */
const earliestSendAt = (now: number): string =>
	new Date(Math.ceil((now + EARLIEST_SEND_MS) / 60_000) * 60_000).toISOString();

type Scheduled = { communicationId: string; revision: string; scheduledAt: string };

type HandoffSteps = {
	/** Save and schedule a draft in one transaction, or schedule a reviewed message. */
	schedule: (at: string) => Promise<Outcome<Scheduled>>;
	/** Hand the new revision to the email service: at once for Send now, held until its time for Schedule. */
	handOff: (revision: string, communicationId: string) => Promise<Outcome<DeliveryReport>>;
};

/**
 * Schedule at `at`, then hand the new revision to the email service. A handoff that fails or returns no result leaves
 * the message saved; the result says so with `sendIssue` and nothing is sent twice.
 */
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

/** Send now: schedule at the earliest accepted time, then hand off for sending at once. */
export const chainSendNow = (steps: HandoffSteps, now = Date.now()) => chainHandoff(steps, earliestSendAt(now));
