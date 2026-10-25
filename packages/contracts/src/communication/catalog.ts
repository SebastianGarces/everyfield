export const templateCategories = ["meeting_invitation", "meeting_reminder", "follow_up", "announcement"] as const;
export const meetingTemplateTypes = ["vision_meeting", "orientation", "team_meeting"] as const;
export type TemplateCategory = (typeof templateCategories)[number];
export type MeetingTemplateType = (typeof meetingTemplateTypes)[number];

export type SystemTemplate = {
	sourceKey: string;
	name: string;
	description: string | null;
	category: TemplateCategory;
	meetingType: MeetingTemplateType | null;
	subject: string;
	bodyHtml: string;
};

/** The seven approved system messages. They live in code. A plant fork never changes these bytes. */
export const systemTemplates: readonly SystemTemplate[] = [
	{
		sourceKey: "vision-meeting-invitation",
		name: "Vision meeting invitation",
		description: null,
		category: "meeting_invitation",
		meetingType: "vision_meeting",
		subject: "You are invited to a vision meeting",
		bodyHtml: "<p>Hello {{name}}. Join us for a vision meeting.</p>",
	},
	{
		sourceKey: "vision-meeting-reminder",
		name: "Vision meeting reminder",
		description: null,
		category: "meeting_reminder",
		meetingType: null,
		subject: "Vision meeting reminder",
		bodyHtml: "<p>Hello {{name}}. This is a reminder for the vision meeting.</p>",
	},
	{
		sourceKey: "vision-meeting-follow-up-attended",
		name: "Vision meeting follow-up",
		description: null,
		category: "follow_up",
		meetingType: null,
		subject: "Thank you for coming",
		bodyHtml: "<p>Hello {{name}}. Thank you for attending.</p>",
	},
	{
		sourceKey: "vision-meeting-follow-up-no-show",
		name: "Vision meeting follow-up for a missed guest",
		description: null,
		category: "follow_up",
		meetingType: null,
		subject: "We missed you",
		bodyHtml: "<p>Hello {{name}}. We missed you at the vision meeting.</p>",
	},
	{
		sourceKey: "orientation-invitation",
		name: "Orientation invitation",
		description: null,
		category: "meeting_invitation",
		meetingType: "orientation",
		subject: "You are invited to orientation",
		bodyHtml: "<p>Hello {{name}}. Join us for orientation.</p>",
	},
	{
		sourceKey: "team-meeting-invitation",
		name: "Team meeting invitation",
		description: null,
		category: "meeting_invitation",
		meetingType: "team_meeting",
		subject: "You are invited to a team meeting",
		bodyHtml: "<p>Hello {{name}}. Join us for a team meeting.</p>",
	},
	{
		sourceKey: "general-announcement",
		name: "General announcement",
		description: null,
		category: "announcement",
		meetingType: null,
		subject: "Announcement",
		bodyHtml: "<p>Hello {{name}}.</p>",
	},
];

export function systemTemplate(sourceKey: string): SystemTemplate | undefined {
	return systemTemplates.find((template) => template.sourceKey === sourceKey);
}

export function systemInvitation(meetingType: MeetingTemplateType): SystemTemplate | undefined {
	return systemTemplates.find(
		(template) => template.category === "meeting_invitation" && template.meetingType === meetingType,
	);
}
