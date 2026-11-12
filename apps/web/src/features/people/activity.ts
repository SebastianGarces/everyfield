import {
	Delete02Icon,
	GitMergeIcon,
	Home01Icon,
	Note01Icon,
	Route01Icon,
	TaskDone01Icon,
	UserEdit01Icon,
	UserMultiple02Icon,
} from "@hugeicons/core-free-icons";
import type * as people from "@everyfield/contracts/people";
import type { Tone } from "@everyfield/ui/display";
import type { IconSvgElement } from "@everyfield/ui/foundations";
import type { z } from "zod";
import { householdChange } from "./fields/model.ts";
import { STAGE_LABEL } from "./model.ts";

type Item = z.infer<typeof people.activitiesResult>["items"][number];

const ACTION: Record<Extract<Item, { kind: "activity" }>["action"], string> = {
	created: "Added to People",
	updated: "Details changed",
	retired: "Retired",
	restored: "Restored",
	classification_recorded: "Adult or child recorded",
	classification_corrected: "Adult or child corrected",
	assessment_recorded: "4 C's assessment recorded",
	interview_recorded: "Interview recorded",
	commitment_recorded: "Commitment recorded",
	commitment_withdrawn: "Commitment withdrawn",
	commitment_reactivated: "Commitment reactivated",
	commitment_corrected: "Commitment corrected",
	assessment_corrected: "4 C's assessment edited",
	interview_corrected: "Interview edited",
	person_merged: "A duplicate was merged into this person",
	person_unmerged: "A merge was undone",
	duplicate_dismissed: "Marked not a duplicate",
	duplicate_restored: "Restored as a possible duplicate",
};
const FOLLOW_UP: Record<Extract<Item, { kind: "follow_up" }>["outcome"], string> = {
	contacted: "Follow-up: contacted",
	attempted_no_contact: "Follow-up: tried, no contact",
	administrative_completion: "Follow-up closed by an administrator",
	no_longer_needed: "Follow-up no longer needed",
};

/** What one Activity entry says and shows: its title, icon and tone. `by` names who did it, for a deleted note. */
export function describe(item: Item, by: string): { title: string; icon: IconSvgElement; tone: Tone } {
	switch (item.kind) {
		case "note":
			return { title: "Note", icon: Note01Icon, tone: "violet" };
		case "note_removed":
			return { title: `Note deleted by ${by === "You" ? "you" : by.toLowerCase()}`, icon: Delete02Icon, tone: "ink" };
		case "stage_changed":
			return {
				title: `Stage changed from ${STAGE_LABEL[item.from].toLowerCase()} to ${STAGE_LABEL[item.to].toLowerCase()}`,
				icon: Route01Icon,
				tone: "green",
			};
		case "activity":
			// A household join, leave or role change names the household as it was then (REQ-PPL-009).
			if (item.household) return { title: householdChange(item.household), icon: Home01Icon, tone: "teal" };
			if (item.action === "person_merged" || item.action === "person_unmerged")
				return { title: ACTION[item.action], icon: GitMergeIcon, tone: "violet" };
			// A duplicate review names the other person of the pair by their current name, as plain text (D-845).
			if (item.action === "duplicate_dismissed" || item.action === "duplicate_restored")
				return {
					title: item.withPerson ? `${ACTION[item.action]} of ${item.withPerson.displayName}` : ACTION[item.action],
					icon: UserMultiple02Icon,
					tone: "violet",
				};
			return {
				// A record that advanced the stage says so in the same entry (REQ-PPL-020).
				title: item.stage
					? `${ACTION[item.action]}. Stage moved from ${STAGE_LABEL[item.stage.from].toLowerCase()} to ${STAGE_LABEL[item.stage.to].toLowerCase()}`
					: ACTION[item.action],
				icon: UserEdit01Icon,
				tone: "blue",
			};
		case "follow_up":
			return { title: FOLLOW_UP[item.outcome], icon: TaskDone01Icon, tone: "amber" };
	}
}
