import {
	canonicalAddress,
	DESCRIPTION_MAX,
	descriptionProblem,
	type FeedbackCategory,
	type FeedbackStatus,
	type HeldReason,
	type OperatorMailState,
	type PublicationState,
} from "@everyfield/contracts/feedback";

export const CATEGORIES: { value: FeedbackCategory; label: string }[] = [
	{ value: "bug", label: "Something broke" },
	{ value: "suggestion", label: "Idea" },
	{ value: "question", label: "Question" },
	{ value: "other", label: "Other" },
];
export const PROMPT: Record<FeedbackCategory, string> = {
	bug: "What happened, and what did you expect?",
	suggestion: "What would make this better?",
	question: "What would you like to know?",
	other: "What is on your mind?",
};
export const CATEGORY_NAME: Record<FeedbackCategory, string> = {
	bug: "Bug",
	suggestion: "Idea",
	question: "Question",
	other: "Other",
};
export const STATUS_NAME: Record<FeedbackStatus, string> = {
	new: "New",
	reviewed: "Reviewed",
	resolved: "Resolved",
	dismissed: "Dismissed",
};
export const STATUS_TONE = { new: "blue", reviewed: "amber", resolved: "green", dismissed: "ink" } as const;

export type PublicationSetup = { publication: boolean; mail: boolean };
type Shown = { text: string; tone: "blue" | "amber" | "green" | "magenta" | "ink" };

export function publicationShown(state: PublicationState, setup: PublicationSetup): Shown {
	if (state === "pending" && !setup.publication) return { text: "Not configured", tone: "ink" };
	return {
		pending: { text: "Pending", tone: "blue" },
		publishing: { text: "Publishing", tone: "blue" },
		unknown: { text: "Unknown", tone: "amber" },
		published: { text: "Published", tone: "green" },
		held: { text: "Held", tone: "magenta" },
	}[state] as Shown;
}
export const HELD_REASON: Record<HeldReason, string> = {
	unsafe_fields: "Its type or page is not on the approved public list, so nothing was published.",
	github_refused: "GitHub refused the issue, so nothing was published.",
	search_failed: "GitHub's answer was lost, and the search for its reference did not answer. Check the repository.",
	ambiguous: "More than one issue carries its reference. Check the repository.",
	unresolved: "GitHub never answered clearly. Check the repository for its reference.",
};
export function operatorMailShown(state: OperatorMailState | null, setup: PublicationSetup): Shown {
	if (state === null) return setup.mail ? { text: "Waiting", tone: "blue" } : { text: "Not configured", tone: "ink" };
	return {
		sending: { text: "Sending", tone: "blue" },
		sent: { text: "Sent", tone: "green" },
		failed: { text: "Failed", tone: "magenta" },
		unknown: { text: "Unknown", tone: "amber" },
	}[state] as Shown;
}

export function counter(text: string): { text: string; problem: string | null } {
	const length = text.trim().length;
	const count = `${length.toLocaleString("en-US")} / ${DESCRIPTION_MAX.toLocaleString("en-US")}`;
	const problem = descriptionProblem(text);
	if (problem === "too_long")
		return { text: count, problem: `${(length - DESCRIPTION_MAX).toLocaleString("en-US")} characters over the limit` };
	return { text: count, problem: problem === "empty" ? "Write a few words to send" : null };
}

export function browserName(agent: string): string | null {
	const found = agent.match(/(Edg|Firefox|Chrome|Version)\/(\d+)/);
	if (!found) return null;
	const name = found[1] === "Edg" ? "Edge" : found[1] === "Version" ? "Safari" : found[1];
	const system = /iPhone|iPad/.test(agent)
		? "iOS"
		: /Android/.test(agent)
			? "Android"
			: /Mac OS X/.test(agent)
				? "macOS"
				: /Windows/.test(agent)
					? "Windows"
					: /Linux/.test(agent)
						? "Linux"
						: null;
	return system ? `${name} ${found[2]} · ${system}` : `${name} ${found[2]}`;
}

export type PageDetails = {
	page: string | null;
	address: string | null;
	browser: string | null;
	screenWidth: number | null;
	screenHeight: number | null;
	theme: "light" | "dark" | null;
	openedAt: Date;
};

export function readPageDetails(): PageDetails {
	const heading = document.querySelector("#main h1")?.textContent?.trim() || null;
	const theme = document.querySelector("[data-product-root]")?.getAttribute("data-theme");
	const size = (n: number) => (Number.isInteger(n) && n > 0 ? n : null);
	return {
		page: heading,
		address: canonicalAddress(window.location.pathname),
		browser: browserName(navigator.userAgent),
		screenWidth: size(window.innerWidth),
		screenHeight: size(window.innerHeight),
		theme: theme === "light" || theme === "dark" ? theme : null,
		openedAt: new Date(),
	};
}

export const dateLabel = (iso: string) =>
	new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
export const timeLabel = (iso: string | Date) =>
	new Date(iso).toLocaleString("en-US", {
		month: "short",
		day: "numeric",
		year: "numeric",
		hour: "numeric",
		minute: "2-digit",
	});
