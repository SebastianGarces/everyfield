import type { ProgramKind, ProgramRefusal, ProgramRhythm } from "@everyfield/contracts/organizations";
import { PIPELINE_PATH } from "../board/model";

// Shared by the program screens: addresses, labels, dates and refusal copy. No React and no server code.

export const PROGRAMS_PATH = `${PIPELINE_PATH}/programs`;
export const programHref = (id: string) => `${PROGRAMS_PATH}/${id}`;
export const enrollmentHref = (id: string) => `${PROGRAMS_PATH}/enrollments/${id}`;

export const KIND: Record<ProgramKind, string> = { apprenticeship: "Apprenticeship", residency: "Residency" };
export const RHYTHM: Record<ProgramRhythm, string> = {
	weekly: "Weekly",
	every_two_weeks: "Every two weeks",
	monthly: "Monthly",
};

/** A stage's month range, as "2 to 3 months". */
export function monthRange(min: number, max: number) {
	if (min === max) return `${min} ${min === 1 ? "month" : "months"}`;
	return `${min} to ${max} months`;
}

/** The status a program list or header shows: the published version, a draft, or both. */
export function programStatus(p: { publishedNumber: number | null; draft: boolean }) {
	if (p.publishedNumber === null) return "Draft";
	return p.draft
		? `Version ${p.publishedNumber} published · draft in progress`
		: `Version ${p.publishedNumber} published`;
}

/** A Wiki reading's address: the organization's own version, or the global library's. */
export function readingHref(slug: string, source: "global" | "organization", organizationId: string) {
	const path = `/wiki/${slug
		.split("/")
		.map((part) => encodeURIComponent(part))
		.join("/")}`;
	return `${path}?source=${source === "global" ? "global" : encodeURIComponent(organizationId)}`;
}

const time = new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit", timeZone: "UTC" });
/** A wall-clock time (YYYY-MM-DDTHH:MM:SS) in its own zone, as "Oct 20, 2026 at 7:00 PM". */
export function formatMeeting(at: string, day: (value: string) => string) {
	return `${day(at.slice(0, 10))} at ${time.format(new Date(`${at}Z`))}`;
}

/** What a refused or lost change tells the person. */
export function programProblem(answer: { status: "refused"; refusal: ProgramRefusal } | { status: "lost" }) {
	if (answer.status === "lost") return "We couldn’t reach Everyfield. Nothing was saved. Try again.";
	const r = answer.refusal;
	switch (r.code) {
		case "conflict":
			return "Someone changed this while you were working. Reload the page to see the latest, then try again.";
		case "not_published":
			return "Publish the program before enrolling anyone.";
		case "already_enrolled":
			return "This person is already enrolled in this program. Each person can have one active enrollment per program.";
		case "no_stages":
			return "Add at least one stage before publishing. Every enrollment starts at a stage.";
		case "linked_resident":
			return "This person has a linked account, so they mark their own milestones.";
		case "invalid_input":
			return r.field === "completedOn"
				? "The date can’t be after today."
				: r.field === "directorSeatId"
					? "That staff member no longer has a seat here. Choose someone else."
					: r.field === "readings"
						? "One of the readings is no longer available. Remove it and try again."
						: r.field?.startsWith("plan.milestones") || r.field?.startsWith("milestones")
							? "Each hands-on assignment needs a description, and milestones need a title."
							: r.field?.includes("stages")
								? "Each stage needs its own name, and its longest month count can’t be below its shortest."
								: r.field === "expectedEndOn"
									? "The expected end can’t be before the start."
									: "Check the highlighted fields and try again.";
		default:
			return "You don’t have access to make this change.";
	}
}
