import type { PipelineRemovalReport } from "@everyfield/contracts/organizations";
import { plural } from "../board/model";

// The words of a removal report (REQ-MUL-005). No React and no server code.

/** One line per kind of thing the removal took out; a kind with nothing in it is left off. */
export function removedLines(report: PipelineRemovalReport): string[] {
	const r = report.removed;
	const lines = ["Name and contact details", "Place on the pipeline"];
	const counted: [number, string, string][] = [
		[r.stageMoves, "stage move with its reason", "stage moves with their reasons"],
		[r.notes, "staff note", "staff notes"],
		[r.conversations, "conversation", "conversations"],
		[r.enrollments, "enrollment in progress", "enrollments in progress"],
		[r.milestoneMarks, "milestone mark", "milestone marks"],
		[r.feedback, "piece of feedback", "pieces of feedback"],
		[r.mergedRecords, "duplicate record merged in earlier", "duplicate records merged in earlier"],
		[r.invitationsRevoked, "pending residency invitation, now revoked", "pending residency invitations, now revoked"],
	];
	for (const [n, one, many] of counted)
		if (n > 0) lines.push(plural(n, one, many).replace(/^./, (c) => c.toUpperCase()));
	if (r.residencyLinkEnded) lines.push("Residency link, ended at once; their own Everyfield account is untouched");
	return lines;
}

type Kept = PipelineRemovalReport["kept"][number];
/** A kept category in words: what it is and why the organization still needs it. */
export function keptText(k: Kept, attribution: string): { title: string; why: string } {
	switch (k.category) {
		case "program_completion_count":
			return {
				title: `${plural(k.count ?? 0, "finished program", "finished programs")}, as “${attribution}”`,
				why: "Program completion counts stay right. No name, contact or marks are kept with them.",
			};
		case "activity_record":
			return {
				title: "Activity record, with names, values and reasons taken out",
				why: "Shows that changes happened and when, so your records stay consistent.",
			};
		case "removal_record":
			return {
				title: "This removal: when it happened and who did it",
				why: "Proves the removal was made, so the person is never brought back by mistake.",
			};
	}
}
