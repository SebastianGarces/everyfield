import * as C from "@everyfield/contracts/oversight";
import {
	listPlants,
	readIntelligence,
	readPattern,
	requestIntelligenceRefresh,
	submitIntelligenceFeedback,
} from "@everyfield/domain/oversight";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { EvryActor } from "../../../context/actor.ts";
import { EvryRefusal } from "../../../context/errors.ts";
import type { ReviewContext } from "../../../proposals/types.ts";
import { approvedNow, organizationSeat, reviewed, rowId } from "../../native.ts";
import { LEVEL_NAME, RATING, runText } from "../reads/index.ts";

type Reply = { status: "ok"; value: object } | { status: "refused"; refusal: { code: string } };
const settled = (reply: Reply) => (reply.status === "ok" ? { revision: "1" } : { refused: reply.refusal.code });
const target = (actor: EvryActor, label: string) => ({ kind: "organization", id: actor.owner.id, label });

export const requestRefresh = approvedNow({
	operation: "organizationIntelligence.requestRefresh",
	description:
		"Propose a new Network Intelligence run from what linked plants share now, as the page's Refresh makes. Give plantId (from oversight.listPlants) when the user asked to refresh one plant's assessment: the card says this refreshes Network Intelligence and that only that plant can ask for its own assessment. Owner or Admin. Nothing runs until the user approves",
	input: z.strictObject({ plantId: rowId.optional() }),
	async review(actor, value, { db }) {
		const view = await readIntelligence(db, actor.authority, { level: "portfolio", runId: null });
		if (!view) throw new EvryRefusal("access_denied");
		const directory = value.plantId ? await listPlants(db, actor.authority) : null;
		const plant = directory?.plants.find((p) => p.plantId === value.plantId);
		if (value.plantId && !plant) throw new EvryRefusal("not_found");
		return reviewed(
			{
				target: target(actor, "Network Intelligence"),
				changes: [
					{
						field: "networkIntelligence",
						before: view.run ? `Latest run, ${runText(view.run.ranAt, view.timeZone)}` : "No run yet",
						after: "A new run, from what plants share now",
					},
				],
				notes: [
					...(plant
						? [
								`This refreshes Network Intelligence, not ${plant.name}'s own assessment. Only ${plant.name} can ask for its own assessment.`,
							]
						: []),
					"Earlier runs stay as they are.",
				],
			},
			{ runId: randomUUID() },
		);
	},
	reason: false,
	run: async (db, authority, args) => settled(await requestIntelligenceRefresh(db, authority, args)),
});

async function patternOf(
	db: ReviewContext["db"],
	authority: EvryActor["authority"],
	input: { runId: string; patternKey: string },
) {
	const found = await readPattern(db, authority, input);
	if (!found) return null;
	const place = found.level === "portfolio" ? LEVEL_NAME.portfolio : `${LEVEL_NAME[found.level]}, ${found.group}`;
	return { pattern: found.pattern, place, ranAt: found.ranAt, timeZone: found.timeZone };
}

const RATE =
	"Propose the user's own rating, useful or not useful, of one Network Intelligence pattern they can read now: its patternKey and the runId, both from organizationIntelligence.readHistory. Only their own rating changes, never the pattern.";
export const submitFeedback = approvedNow({
	operation: "organizationIntelligence.submitFeedback",
	description: `${RATE} Owner or Admin. Nothing is saved until the user approves`,
	memberDescription: `${RATE} Nothing is saved until the user approves`,
	allowed: organizationSeat,
	input: z.strictObject({
		runId: rowId,
		patternKey: C.feedbackRequest.shape.patternKey,
		rating: C.feedbackRequest.shape.rating,
	}),
	async review(actor, value, { db }) {
		const found = await patternOf(db, actor.authority, value);
		if (!found) throw new EvryRefusal("not_found");
		const { pattern } = found;
		return reviewed(
			{
				target: target(actor, C.patternText(pattern).title),
				changes: [
					{
						field: "rating",
						before: pattern.rating === null ? null : RATING[pattern.rating],
						after: RATING[value.rating],
					},
				],
				notes: [
					`Group: ${found.place}. Plants: ${pattern.plants.map((p) => p.name).join(", ")}. Your rating of this pattern in the run of ${runText(found.ranAt, found.timeZone)}. It changes nothing in Network Intelligence.`,
				],
				...(pattern.rating === value.rating && {
					refusal: "You already rated this pattern that way, so nothing would change.",
				}),
			},
			value,
		);
	},
	reason: false,
	run: async (db, authority, args) => settled(await submitIntelligenceFeedback(db, authority, args)),
});

export const OVERSIGHT_COMMANDS = {
	"organizationIntelligence.requestRefresh": requestRefresh,
	"organizationIntelligence.submitFeedback": submitFeedback,
} as const;
