import type { GetSectionRequest, NotificationChoice, SectionKey, SettingsError, SettingsViewer } from "./port";

const SECTION_ORDER: readonly SectionKey[] = [
	"church",
	"brand",
	"organization",
	"seats",
	"notifications",
	"sharing",
	"wiki",
	"account",
];

export const SECTION_LABEL: Record<SectionKey, string> = {
	church: "Church profile",
	brand: "Brand kit",
	organization: "Organization profile",
	seats: "Seats and invitations",
	notifications: "Notifications",
	sharing: "Sharing and privacy",
	wiki: "Wiki sources",
	account: "Your account",
};

const DIALOG_SECTIONS = [
	"church",
	"brand",
	"organization",
	"notifications",
	"wiki",
	"account",
] as const satisfies SectionKey[];
export type DialogSection = (typeof DIALOG_SECTIONS)[number];

export function dialogSection(value: string | undefined): DialogSection | null {
	return (DIALOG_SECTIONS as readonly string[]).includes(value ?? "") ? (value as DialogSection) : null;
}

export function parseSectionKey(value: string | undefined): SectionKey | null {
	return (SECTION_ORDER as readonly string[]).includes(value ?? "") ? (value as SectionKey) : null;
}

export function offeredSections(viewer: SettingsViewer, slots: readonly SectionKey[]): SectionKey[] {
	const admin = viewer.context !== "account" && (viewer.role === "owner" || viewer.role === "admin");
	return SECTION_ORDER.filter((key) => {
		switch (key) {
			case "church":
			case "brand":
			case "wiki":
				return viewer.context === "plant" && admin;
			case "organization":
				return viewer.context === "organization";
			case "sharing":
				return viewer.context === "plant" && slots.includes("sharing");
			case "seats":
				return viewer.context !== "account" && slots.includes("seats");
			case "notifications":
			case "account":
				return true;
		}
	});
}

export function firstSection(viewer: SettingsViewer | null): DialogSection {
	return (viewer && dialogSection(offeredSections(viewer, [])[0])) ?? "account";
}

export function sectionAt(pathname: string, viewer: SettingsViewer | null): DialogSection | null {
	if (pathname === "/settings") return viewer ? firstSection(viewer) : null;
	return dialogSection(/^\/settings\/([a-z]+)$/.exec(pathname)?.[1]);
}

export function sectionRequest(viewer: SettingsViewer, section: DialogSection): GetSectionRequest | null {
	switch (section) {
		case "church":
			return viewer.context === "plant" ? { section: "plant", plant: viewer.plant } : null;
		case "organization":
			return viewer.context === "organization" ? { section: "organization", organization: viewer.organization } : null;
		case "brand":
		case "wiki":
			return null;
		case "notifications":
		case "account":
			return { section };
	}
}

export function canDeleteWorkspace(viewer: SettingsViewer): boolean {
	return viewer.context === "plant" && viewer.role === "owner";
}

const ERROR_TEXT: Record<SettingsError["code"], string> = {
	invalid_input: "Some values are not valid. Check the fields marked in red.",
	access_denied: "You no longer have access to this. Ask an Owner or Admin of your church.",
	unavailable: "This is not available right now.",
	invalid_subject: "This cannot be changed now.",
	conflict: "Someone changed this after you opened it. Load the latest version, then make your change again.",
	temporary: "Everyfield could not save just now. Try again.",
	unknown: "We could not confirm that this saved. Load the latest version to check before you try again.",
	stale_preview: "The preview is out of date. Preview the change again.",
	proof_invalid: "This link is no longer valid. Ask for a new one.",
	deadline_passed: "The 30 days to cancel have ended, so this can no longer be cancelled.",
	manual_owner_exception_required:
		"You are the Owner of a church that keeps running. Write to support so the church keeps an Owner before you delete your account.",
};

export function errorText(error: SettingsError): string {
	return ERROR_TEXT[error.code];
}

export function errorReference(error: { correlationId: string }): string {
	return `EF-${error.correlationId.slice(0, 8).toUpperCase()}`;
}

type Category = NotificationChoice["category"];
export const CATEGORY_TEXT: Record<Category, { label: string; description: string }> = {
	task_due: { label: "Tasks due", description: "Your own tasks on the day they are due" },
	task_overdue: { label: "Overdue tasks", description: "The morning after a task was due" },
	meeting_announcement: { label: "Meeting announcements", description: "A meeting is scheduled or changed" },
	meeting_reminder: { label: "Meeting reminders", description: "Before meetings you are part of" },
	planter_digest: { label: "Church digest", description: "Open items for your church" },
	oversight_digest: { label: "Oversight digest", description: "The plants you support" },
	relationship_milestone: { label: "Connections", description: "A connection is approved or ends" },
	sharing_milestone: { label: "Sharing changes", description: "A church changes what it shares" },
	phase_milestone: { label: "Phase milestones", description: "A plant moves to its next phase" },
	launch_milestone: { label: "Launch milestones", description: "Completed or reopened" },
	wiki_upstream_review: { label: "Wiki review requests", description: "Changes waiting for your review" },
	scheduled_email_unsubscribe: {
		label: "Unsubscribes from scheduled email",
		description: "Someone on an email you scheduled unsubscribes",
	},
	residency_confirmation: {
		label: "Milestone confirmations",
		description: "Your director confirms a milestone you marked done",
	},
	residency_feedback: { label: "Feedback", description: "Your director writes feedback on one of your milestones" },
	answer_review: { label: "Answers to review", description: "Someone sends you a person's answers to review" },
};

const SENT: ReadonlySet<Category> = new Set([
	"task_due",
	"task_overdue",
	"meeting_announcement",
	"meeting_reminder",
	"planter_digest",
	"oversight_digest",
	"relationship_milestone",
	"sharing_milestone",
	"phase_milestone",
	"wiki_upstream_review",
	"scheduled_email_unsubscribe",
	"residency_confirmation",
	"residency_feedback",
	"answer_review",
]);

export function preferenceRows(choices: readonly NotificationChoice[]) {
	return (Object.keys(CATEGORY_TEXT) as Category[])
		.filter((category) => SENT.has(category))
		.flatMap((category) => {
			const inApp = choices.find((c) => c.category === category && c.channel === "in_app");
			const email = choices.find((c) => c.category === category && c.channel === "email");
			return inApp || email ? [{ category, inApp, email, ...CATEGORY_TEXT[category] }] : [];
		});
}

export { same } from "./drafts.ts";
