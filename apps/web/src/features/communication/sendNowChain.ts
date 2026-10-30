import type { DeliveryReport, Outcome, SendNowResult } from "./model.ts";

// The Send now chain, apart from the server action so a test can run it with its own steps. The action in
// actions.ts passes the real commands. Nothing here reads the request or the database.

/** The earliest send time the scheduling window accepts, from now. */
export const EARLIEST_SEND_MS = 60_000;

/**
 * The send time of the schedule step: the next whole minute at least one minute away. A retry with the same request
 * keys inside that minute asks for the same time, so the saved request replays instead of conflicting.
 */
export const earliestSendAt = (now: number): string =>
	new Date(Math.ceil((now + EARLIEST_SEND_MS) / 60_000) * 60_000).toISOString();

type Scheduled = { communicationId: string; revision: string; scheduledAt: string };

export type SendNowSteps = {
	/** Save and schedule a draft in one transaction, or schedule a reviewed message. */
	schedule: (at: string) => Promise<Outcome<Scheduled>>;
	/** Hand the new revision to the provider. */
	send: (revision: string, communicationId: string) => Promise<Outcome<DeliveryReport>>;
};

/**
 * Schedule at the earliest accepted time, then send the new revision. A send step that fails or returns no result
 * leaves the message Scheduled; the result says so with `sendIssue` and nothing is sent twice.
 */
export async function chainSendNow(steps: SendNowSteps, now = Date.now()): Promise<Outcome<SendNowResult>> {
	const scheduled = await steps.schedule(earliestSendAt(now));
	if (scheduled.status !== "ok") return scheduled;
	const { communicationId, revision, scheduledAt } = scheduled.value;
	const sent = await steps.send(revision, communicationId);
	if (sent.status !== "ok") {
		const issue = sent.status === "lost" ? "lost" : sent.code;
		return { status: "ok", value: { communicationId, revision, scheduledAt, report: null, sendIssue: issue } };
	}
	return { status: "ok", value: { communicationId, revision, scheduledAt, report: sent.value, sendIssue: null } };
}
