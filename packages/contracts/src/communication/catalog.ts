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

/**
 * The seven approved system messages. They live in code. A plant fork never changes these bytes.
 *
 * Merge fields: only `{{name}}` has a producer today. Meeting details are bracket placeholders the
 * planter replaces before sending. Task 6 and Task 9 add real fields. A comment at each template
 * names the future fields: `meeting_date`, `meeting_time`, `meeting_location`.
 * Subjects hold no merge fields, because nothing merges a subject.
 */
export const systemTemplates: readonly SystemTemplate[] = [
	{
		sourceKey: "vision-meeting-invitation",
		name: "Vision meeting invitation",
		description:
			"Invites a guest to a vision meeting with the date, time, place and what to expect. Replace the bracketed details before you send.",
		category: "meeting_invitation",
		meetingType: "vision_meeting",
		subject: "You are invited to hear the vision for our new church",
		// [Day, date] = meeting_date, [Start time] and [End time] = meeting_time, [Address or meeting link] = meeting_location.
		bodyHtml:
			"<p>Hello {{name}},</p>" +
			"<p>We are starting a new church, and we would love for you to hear the vision behind it. Please join us for a vision meeting.</p>" +
			"<p><strong>When:</strong> [Day, date], [Start time] to [End time]<br><strong>Where:</strong> [Address or meeting link]</p>" +
			"<p>What to expect:</p>" +
			"<ul><li>A short talk on why we are planting this church and who it is for.</li><li>Time to ask questions.</li><li>Ways to pray for the church or take part.</li></ul>" +
			"<p>You do not need to prepare anything. Come as you are. If you plan to attend, please reply to this email so we can save you a seat. Tell us if you have any questions.</p>" +
			"<p>We hope to see you there.</p>" +
			"<p>Warmly,<br>[Your name]</p>",
	},
	{
		sourceKey: "vision-meeting-reminder",
		name: "Vision meeting reminder",
		description:
			"Reminds an invited guest of the vision meeting a day or two before it. Replace the bracketed details before you send.",
		category: "meeting_reminder",
		meetingType: null,
		subject: "Reminder: our vision meeting is coming up",
		// [Day, date] = meeting_date, [Start time] = meeting_time, [Address or meeting link] = meeting_location.
		bodyHtml:
			"<p>Hello {{name}},</p>" +
			"<p>This is a friendly reminder about our vision meeting. We are glad you plan to come.</p>" +
			"<p><strong>When:</strong> [Day, date], [Start time]<br><strong>Where:</strong> [Address or meeting link]</p>" +
			"<p>Please arrive a few minutes early so we can start on time. If your plans change, reply to this email and let us know.</p>" +
			"<p>We look forward to seeing you.</p>" +
			"<p>Warmly,<br>[Your name]</p>",
	},
	{
		sourceKey: "vision-meeting-follow-up-attended",
		name: "Vision meeting follow-up",
		description:
			"Thanks a guest who came to the vision meeting and asks them to reply with their next step.",
		category: "follow_up",
		meetingType: null,
		subject: "Thank you for coming to our vision meeting",
		bodyHtml:
			"<p>Hello {{name}},</p>" +
			"<p>Thank you for coming to our vision meeting. It meant a lot to us that you gave us your time.</p>" +
			"<p>We would like to hear what you thought. Did anything stand out to you? Do you have questions we did not answer?</p>" +
			"<p>If you would like to be part of this church, the next step is to reply to this email. Tell us how you would like to help, and we will share the next steps with you.</p>" +
			"<p>Thank you again. We are grateful for you.</p>" +
			"<p>Warmly,<br>[Your name]</p>",
	},
	{
		sourceKey: "vision-meeting-follow-up-no-show",
		name: "Vision meeting follow-up for a missed guest",
		description:
			"Writes to a guest who could not come to the vision meeting and offers a way to catch up.",
		category: "follow_up",
		meetingType: null,
		subject: "We missed you at our vision meeting",
		bodyHtml:
			"<p>Hello {{name}},</p>" +
			"<p>We missed you at our vision meeting. We know that plans change, and we hope all is well with you.</p>" +
			"<p>We would still love to share the vision with you. If you would like to catch up, reply to this email. We can send you a summary, set up a short call, or tell you about our next meeting.</p>" +
			"<p>There is no pressure. We are here when you are ready.</p>" +
			"<p>Warmly,<br>[Your name]</p>",
	},
	{
		sourceKey: "orientation-invitation",
		name: "Orientation invitation",
		description:
			"Invites a new team member to orientation with the date, time, place and what to expect. Replace the bracketed details before you send.",
		category: "meeting_invitation",
		meetingType: "orientation",
		subject: "You are invited to orientation",
		// [Day, date] = meeting_date, [Start time] and [End time] = meeting_time, [Address or meeting link] = meeting_location.
		bodyHtml:
			"<p>Hello {{name}},</p>" +
			"<p>Thank you for your interest in serving with our church plant. We invite you to an orientation, where we explain how the team works and where you can help.</p>" +
			"<p><strong>When:</strong> [Day, date], [Start time] to [End time]<br><strong>Where:</strong> [Address or meeting link]</p>" +
			"<p>What to expect:</p>" +
			"<ul><li>An overview of our mission, values and plans.</li><li>A look at the ways you can serve.</li><li>Time to meet the team and ask questions.</li></ul>" +
			"<p>You do not need to bring anything. Please reply to this email to confirm that you can come, or to tell us if you cannot.</p>" +
			"<p>We are glad you are here.</p>" +
			"<p>Warmly,<br>[Your name]</p>",
	},
	{
		sourceKey: "team-meeting-invitation",
		name: "Team meeting invitation",
		description:
			"Invites a team member to a team meeting with the date, time, place and agenda. Replace the bracketed details before you send.",
		category: "meeting_invitation",
		meetingType: "team_meeting",
		subject: "You are invited to our team meeting",
		// [Day, date] = meeting_date, [Start time] and [End time] = meeting_time, [Address or meeting link] = meeting_location.
		bodyHtml:
			"<p>Hello {{name}},</p>" +
			"<p>Our next team meeting is coming up, and we would like you to be there.</p>" +
			"<p><strong>When:</strong> [Day, date], [Start time] to [End time]<br><strong>Where:</strong> [Address or meeting link]</p>" +
			"<p>What to expect:</p>" +
			"<ul><li>A short time of prayer.</li><li>Updates on our progress and what comes next.</li><li>Time to plan together and share who will do what.</li></ul>" +
			"<p>Please reply to this email to confirm that you can come. If you cannot, tell us, and we will share the notes with you afterward.</p>" +
			"<p>Thank you for all you do.</p>" +
			"<p>Warmly,<br>[Your name]</p>",
	},
	{
		sourceKey: "general-announcement",
		name: "General announcement",
		description:
			"A starting point for an update to your list. Replace the bracketed text with your news and one clear next step.",
		category: "announcement",
		meetingType: null,
		subject: "News from our church plant",
		bodyHtml:
			"<p>Hello {{name}},</p>" +
			"<p>We have news to share with you: [Write your news in one or two sentences].</p>" +
			"<p>[Add the details your reader needs, such as what changes, when and why it matters.]</p>" +
			"<p>What we ask of you: [One clear next step, such as reply to this email, pray for us, or save a date].</p>" +
			"<p>Thank you for being part of this with us.</p>" +
			"<p>Warmly,<br>[Your name]</p>",
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
