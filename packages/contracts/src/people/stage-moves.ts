import type { z } from "zod";
import { counted } from "../common/index.ts";
import type { statusWarningsResult } from "./results.ts";
import { stage } from "./values.ts";

type Stage = z.infer<typeof stage>;
type Found = Pick<z.infer<typeof statusWarningsResult>, "warnings" | "openDuties">;

export const STAGE_LABEL: Record<Stage, string> = {
	prospect: "Prospect",
	attendee: "Attendee",
	following_up: "Following up",
	interviewed: "Interviewed",
	core_group: "Core group",
	launch_team: "Launch team",
	leader: "Leader",
};

function skippedStages(from: Stage, to: Stage): Stage[] {
	const all = stage.options;
	const a = all.indexOf(from),
		b = all.indexOf(to);
	return b > a + 1 ? all.slice(a + 1, b) : [];
}
const COMMITTED: readonly Stage[] = ["core_group", "launch_team", "leader"];
const leavesCommitted = (from: Stage, to: Stage) => COMMITTED.includes(from) && !COMMITTED.includes(to);

const NOT_RECORDED: Record<Exclude<Found["warnings"][number], "open_duties">, string> = {
	assessment_not_recorded: "No 4 C's assessment is recorded for this person.",
	interview_not_recorded: "No interview is recorded for this person.",
	commitment_not_recorded: "No current commitment is recorded for this person.",
};

export function moveWarnings(from: Stage, to: Stage | null, found: Found) {
	const skipped = to ? skippedStages(from, to) : [];
	return {
		skipped: skipped.length
			? {
					count: `Skips ${skipped.length === 1 ? "a stage" : `${skipped.length} stages`}`,
					stages: skipped.map((s) => STAGE_LABEL[s]).join(", "),
				}
			: null,
		notRecorded: found.warnings.flatMap((w) => (w === "open_duties" ? [] : [NOT_RECORDED[w]])),
		duties: to && leavesCommitted(from, to) ? found.openDuties : [],
	};
}
export type MoveWarnings = ReturnType<typeof moveWarnings>;

export const dutiesNeedOwner = (duties: MoveWarnings["duties"]) =>
	`${counted(duties.length, "open duty needs", "open duties need")} an owner`;
export const MOVE_REMINDER = "These are reminders from the records. You can still move the person.";

export function moveWarningLines(w: MoveWarnings): string[] {
	const lines = [
		...(w.skipped ? [`${w.skipped.count}: ${w.skipped.stages}`] : []),
		...w.notRecorded,
		...(w.duties.length ? [dutiesNeedOwner(w.duties)] : []),
	];
	return lines.length ? [...lines, MOVE_REMINDER] : [];
}
