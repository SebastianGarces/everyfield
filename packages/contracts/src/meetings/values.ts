import { z } from "zod";
import { localDate } from "../common/time.ts";
import { recordId } from "../common/values.ts";

export const meetingId = recordId;
export const venueId = recordId;
export const meetingType = z.enum(["vision_meeting", "orientation", "team_meeting", "prelaunch_practice"]);
// Team meetings and their roster arrive with teams (WP-017); until then a new meeting cannot be one.
export const schedulableType = meetingType.exclude(["team_meeting"]);
export const meetingStatus = z.enum(["planning", "ready", "in_progress", "completed", "cancelled"]);
export const meetingWindow = z.enum(["upcoming", "past", "all"]);
export const preparation = z.enum(["complete", "incomplete", "any"]);
export const rsvp = z.enum(["pending", "confirmed", "declined"]);
export const rsvpAnswer = z.enum(["confirmed", "declined"]);
export const rsvpSource = z.enum(["invitation", "token", "own", "admin"]);
export const presence = z.enum(["attended", "absent", "excused"]);
export const cardResponse = z.enum(["ready_commit", "interested", "prayer_request", "stay_informed", "not_interested"]);
export const kitCategory = z.enum(["essential", "materials", "setup", "av", "organization"]);
export const reminderSlot = z.enum(["announcement", "day_7", "day_3", "day_1"]);
export const reason = z.string().trim().min(1).max(2000);

/** Explicit status changes. Completing a practice goes through completePractice, which records when it was held. */
export const statusTransitions: Readonly<
	Record<z.infer<typeof meetingStatus>, readonly z.infer<typeof meetingStatus>[]>
> = {
	planning: ["ready", "in_progress", "cancelled"],
	ready: ["planning", "in_progress", "cancelled"],
	in_progress: ["ready", "completed", "cancelled"],
	completed: ["in_progress"],
	cancelled: ["planning"],
};

/** A wall-clock entry in the church's zone. A fold needs the chosen offset; a gap is refused. */
export const enteredTime = {
	date: localDate,
	time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
	offsetSeconds: z.int().min(-86_400).max(86_400).optional(),
};

const shortText = (max: number) => z.string().trim().max(max);
/** Venue facts as an edit names them: only the fields sent change. */
export const venuePatchFields = {
	name: z.string().trim().min(1).max(120),
	address: z.string().trim().min(1).max(500),
	contactName: shortText(120).nullable(),
	phone: shortText(40).nullable(),
	email: z.string().trim().pipe(z.email().max(320)).nullable(),
	costDescription: shortText(500).nullable(),
	capacity: z.int().min(1).max(100_000).nullable(),
	notes: shortText(2000).nullable(),
};
/** Venue facts for a new venue: optional facts start empty. */
export const venueFields = {
	...venuePatchFields,
	contactName: venuePatchFields.contactName.default(null),
	phone: venuePatchFields.phone.default(null),
	email: venuePatchFields.email.default(null),
	costDescription: venuePatchFields.costDescription.default(null),
	capacity: venuePatchFields.capacity.default(null),
	notes: venuePatchFields.notes.default(null),
};

export const agendaSection = z.strictObject({
	id: z.string().trim().min(1).max(64),
	title: z.string().trim().min(1).max(120),
	minutes: z.int().min(0).max(600),
});
export const agenda = z
	.array(agendaSection)
	.max(40)
	.refine((sections) => new Set(sections.map((s) => s.id)).size === sections.length, "duplicate_section_id");

/** The reviewed Vision agenda, copied with fresh section IDs into each new Vision meeting. */
export const visionAgenda = {
	version: 1,
	sections: [
		{ title: "Welcome", minutes: 10 },
		{ title: "Worship", minutes: 15 },
		{ title: "Vision", minutes: 25 },
		{ title: "Q&A", minutes: 15 },
		{ title: "Response", minutes: 10 },
		{ title: "Fellowship", minutes: 15 },
	],
} as const;

/** The reviewed Vision kit (Wiki article "The Vision Meeting Kit", checklist section), seeded once per Vision meeting. */
export const visionKit = {
	version: 1,
	items: [
		["essential", "sign_in_sheets", "Sign-in sheets (3-5)"],
		["essential", "name_tags", "Name tags (50+)"],
		["essential", "welcome_brochures", "Welcome brochures (50+)"],
		["essential", "constitution_brochures", "Constitution brochures (25+)"],
		["essential", "response_cards", "Response cards (50+)"],
		["essential", "business_cards", "Business cards (100+)"],
		["materials", "pillars_banner", "4 Pillars banner with stand"],
		["materials", "ministry_banner", "Worship/Walk/Work banner with stand"],
		["materials", "mission_banner", "Mission Statement banner with stand"],
		["materials", "yard_signs", "Yard signs with stakes"],
		["av", "flash_drive", "Flash drive (loaded)"],
		["av", "speakers", "Laptop speakers"],
		["av", "extension_cord", "Extension cord (25+ ft)"],
		["av", "hdmi_cables", "HDMI/adapter cables"],
		["av", "clicker", "Presentation clicker (with batteries)"],
		["setup", "pens", "Pens (20+)"],
		["setup", "clipboards", "Clipboards (5-10)"],
		["setup", "markers", "Black markers (5+)"],
		["setup", "tape", "Tape (masking and clear)"],
		["setup", "scissors", "Scissors"],
		["organization", "rolling_case", "Everything in suitcase/case"],
		["organization", "labeled_boxes", "Content boxes labeled"],
		["organization", "checklist", "This checklist (laminated)"],
	] as const satisfies readonly (readonly [z.infer<typeof kitCategory>, string, string])[],
} as const;

export const pageInput = {
	page: z.int().min(1).max(100_000).default(1),
	limit: z.int().min(1).max(100).default(24),
};
