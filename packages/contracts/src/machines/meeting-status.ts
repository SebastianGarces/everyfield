import type { z } from "zod";
import { meetingStatus, type meetingType } from "../meetings/values.ts";
import { machine } from "./machine.ts";

const open = ["planning", "ready", "in_progress", "completed"] as const;

export const meetingStatusMachine = machine({
	id: "meeting-status",
	table: "meeting",
	column: "status",
	states: meetingStatus.options,
	events: [
		"meetings.schedule",
		"meetings.changeStatus",
		"meetings.completePractice",
		"meetings.correctPracticeOccurrence",
		"meetings.correctOccurrence",
	],
	refusal: "status_transition",
	initial: [{ event: "meetings.schedule", to: "planning" }],
	guards: { practice: (m: { readonly type: z.infer<typeof meetingType> }) => m.type === "prelaunch_practice" },
	subjects: {
		vision: { type: "vision_meeting" },
		orientation: { type: "orientation" },
		team: { type: "team_meeting" },
		practice: { type: "prelaunch_practice" },
	},
	edges: [
		{ event: "meetings.changeStatus", from: "planning", to: ["ready", "in_progress", "cancelled"] },
		{ event: "meetings.changeStatus", from: "ready", to: ["planning", "in_progress", "cancelled"] },
		{ event: "meetings.changeStatus", from: "in_progress", to: "ready" },
		{ event: "meetings.changeStatus", from: "in_progress", to: "completed", unless: "practice" },
		{ event: "meetings.changeStatus", from: "in_progress", to: "cancelled" },
		{ event: "meetings.changeStatus", from: "completed", to: "in_progress", unless: "practice" },
		{ event: "meetings.changeStatus", from: "cancelled", to: "planning" },
		{ event: "meetings.completePractice", from: open, to: "completed", when: "practice" },
		{
			event: "meetings.correctPracticeOccurrence",
			from: [...open, "cancelled"],
			to: ["completed", "planning"],
			when: "practice",
		},
	],
	stays: [{ event: "meetings.correctOccurrence", in: ["completed"] }],
	unchangedIsNoop: ["meetings.changeStatus"],
	proof: "tests/integration/meetings/status-machine.test.mts",
});
