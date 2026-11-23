import { z } from "zod";
import type { ReadAdapter, SourceResult } from "../../../catalog/types.ts";
import { allowedWrites } from "../../../proposals/review.ts";
import { inPlant } from "../shared.ts";

const FOLLOW_UP = [
	["meetings.finalizeAttendance", "Mark who came and finalize attendance", "mark <names> as attended and finalize"],
	["meetings.recordEvaluation", "Score the night on the eight evaluation factors", "score last night's vision meeting"],
	["tasks.createFollowUp", "Create a follow-up with each first-time guest", "create a follow-up with <name>"],
	["followups.recordOutcome", "Log each follow-up call, text or visit", "log that I called <name>, <what happened>"],
	["communication.sendReviewed", "Email the guests a thank-you", "email the vision night guests a thank-you"],
	[
		"evry.prepareMeetingInvitation",
		"Invite guests to the next vision night",
		"invite <a family> to the next vision meeting",
	],
	["meetings.schedule", "Schedule the next vision night", "set up a vision meeting next thursday 7pm at the <venue>"],
] as const;
const HINTS = { vision_night_follow_up: { title: "Follow-up after vision night", steps: FOLLOW_UP } } as const;

const input = z.strictObject({ workflow: z.enum(Object.keys(HINTS) as [keyof typeof HINTS]) });

export const readWorkflowHint: ReadAdapter<z.infer<typeof input>> = {
	operation: "evry.readWorkflowHint",
	description:
		"Suggested steps for a common job (vision_night_follow_up: follow-up after a vision night). Each step is an app action this user's role can take, and each one goes through its own review when the user asks for it. Offer only these steps, never prayer or pastoral guidance.",
	input,
	allowed: inPlant,
	async invoke(_tx, actor, i): Promise<SourceResult> {
		const hint = HINTS[i.workflow];
		const mine = new Set(allowedWrites(actor).map((w) => w.operation));
		const steps = hint.steps.filter(([operation]) => mine.has(operation));
		return {
			operation: "evry.readWorkflowHint",
			status: "available",
			rows: steps.map(([operation, label, say], n) => ({
				kind: "step",
				id: operation,
				label,
				fields: { order: n + 1, operation, say, review: "its own review card" },
			})),
			total: steps.length,
			page: 1,
			next: null,
			completeness: "complete",
			exclusions: steps.length < hint.steps.length ? ["steps this role can't take"] : [],
			facts: { workflow: hint.title },
		};
	},
};

export const WORKFLOW_READS = [readWorkflowHint] as const;
