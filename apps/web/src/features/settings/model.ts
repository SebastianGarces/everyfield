import type { GetSectionRequest, NotificationChoice, SectionKey, SettingsError, SettingsViewer } from "./port";

// Pure settings rules: which sections exist, which a viewer is offered, and the words for each refusal.

export const SECTION_ORDER: readonly SectionKey[] = [
	"church",
	"organization",
	"seats",
	"notifications",
	"sharing",
	"account",
];

export const SECTION_LABEL: Record<SectionKey, string> = {
	church: "Church profile",
	organization: "Organization profile",
	seats: "Seats and invitations",
	notifications: "Notifications",
	sharing: "Sharing and privacy",
	account: "Your account",
};

/** The sections the product dialog shows. Seats and Sharing are pages of their own (/settings/seats, /sharing). */
export const DIALOG_SECTIONS = ["church", "organization", "notifications", "account"] as const satisfies SectionKey[];
export type DialogSection = (typeof DIALOG_SECTIONS)[number];

export function dialogSection(value: string | undefined): DialogSection | null {
	return (DIALOG_SECTIONS as readonly string[]).includes(value ?? "") ? (value as DialogSection) : null;
}

export function parseSectionKey(value: string | undefined): SectionKey | null {
	return (SECTION_ORDER as readonly string[]).includes(value ?? "") ? (value as SectionKey) : null;
}

/**
 * The sections this viewer is offered. The server checks authority again on every read and save; this only keeps a
 * section out of the nav when the viewer cannot use it. Church and organization profiles need an Owner or Admin of
 * that exact context; notifications and your account are always yours.
 */
export function offeredSections(viewer: SettingsViewer, slots: readonly SectionKey[]): SectionKey[] {
	const admin = viewer.context !== "account" && (viewer.role === "owner" || viewer.role === "admin");
	return SECTION_ORDER.filter((key) => {
		switch (key) {
			case "church":
				return viewer.context === "plant" && admin;
			case "organization":
				return viewer.context === "organization" && admin;
			case "sharing":
				return viewer.context === "plant" && slots.includes("sharing");
			case "seats":
				return slots.includes("seats");
			case "notifications":
			case "account":
				return true;
		}
	});
}

/** Where /settings and the rail's Settings open: the first dialog section this viewer is offered. */
export function firstSection(viewer: SettingsViewer | null): DialogSection {
	return (viewer && dialogSection(offeredSections(viewer, [])[0])) ?? "account";
}

/** The dialog section an address opens. /settings opens the first section this viewer is offered. */
export function sectionAt(pathname: string, viewer: SettingsViewer | null): DialogSection | null {
	if (pathname === "/settings") return viewer ? firstSection(viewer) : null;
	return dialogSection(/^\/settings\/([a-z]+)$/.exec(pathname)?.[1]);
}

/** The read a dialog section makes for this viewer; null when the viewer has no such profile. */
export function sectionRequest(viewer: SettingsViewer, section: DialogSection): GetSectionRequest | null {
	switch (section) {
		case "church":
			return viewer.context === "plant" ? { section: "plant", plant: viewer.plant } : null;
		case "organization":
			return viewer.context === "organization" ? { section: "organization", organization: viewer.organization } : null;
		case "notifications":
		case "account":
			return { section };
	}
}

/** Only the current Owner can delete the church workspace (REQ-KNOW-066). Admins and Members never see the action. */
export function canDeleteWorkspace(viewer: SettingsViewer): boolean {
	return viewer.context === "plant" && viewer.role === "owner";
}

export const ERROR_TEXT: Record<SettingsError["code"], string> = {
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

/** A short reference for support, from the server's correlation id. */
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
};

/** The rows of the preference matrix, in the order of CATEGORY_TEXT, with only the pairs this audience has. */
export function preferenceRows(choices: readonly NotificationChoice[]) {
	return (Object.keys(CATEGORY_TEXT) as Category[]).flatMap((category) => {
		const inApp = choices.find((c) => c.category === category && c.channel === "in_app");
		const email = choices.find((c) => c.category === category && c.channel === "email");
		return inApp || email ? [{ category, inApp, email, ...CATEGORY_TEXT[category] }] : [];
	});
}

/** Shallow structural equality for drafts made of plain values. */
export function sameValue(a: unknown, b: unknown): boolean {
	return JSON.stringify(a) === JSON.stringify(b);
}
