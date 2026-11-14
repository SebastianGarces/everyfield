import { createHash } from "node:crypto";
import { feedbackCategory } from "@everyfield/contracts/feedback";

// The closed public serializer for feedback issues (REQ-ADM-003, REQ-ADM-008). The public title and body come from three
// things only: the category, an area from the fixed route allowlist below, and the opaque reference. The author's
// words, page label, address, church, role, device details and identity are never read here, so they can never be
// published. Pure, so the worker and the tests share it.

/** Product list pages that name their area publicly. Every other page in the app is "Application". */
const PUBLIC_AREAS: Readonly<Record<string, string>> = {
	"/home": "Home",
	"/people": "People",
	"/people/duplicates": "People",
	"/people/import": "People",
	"/meetings": "Meetings",
	"/tasks": "Tasks",
	"/tasks/follow-ups": "Tasks",
	"/communication": "Messages",
	"/ministries": "Ministries",
	"/wiki": "Wiki",
	"/documents": "Documents",
	"/documents/church": "Documents",
	"/documents/church/archived": "Documents",
	"/intelligence": "Plant Intelligence",
	"/notifications": "Notifications",
	"/settings": "Settings",
	"/feedback": "Feedback",
};
/**
 * The app's sections. A deeper page under one of them (one person, one document, a token link) can show private
 * records, so it is published only as "Application". An address outside every section is not on the approved list.
 */
const SECTIONS = new Set([
	"home",
	"people",
	"meetings",
	"tasks",
	"follow-ups",
	"communication",
	"ministries",
	"wiki",
	"documents",
	"intelligence",
	"notifications",
	"settings",
	"feedback",
	"me",
]);
const APPLICATION = "Application";

/** The fixed wording for each category: the title's kind and the body's opening. */
const WORDING = {
	bug: { title: "Bug report", sentence: "A product bug report was submitted for" },
	suggestion: { title: "Suggestion", sentence: "A product suggestion was submitted for" },
	question: { title: "Question", sentence: "A product question was submitted for" },
	other: { title: "Other feedback", sentence: "Other product feedback was submitted for" },
} as const;

const REFERENCE = /^FB-[0-9A-F]{12}$/;

/** The approved public area for a stored address, or null when the address is outside the approved list. */
function publicArea(address: string | null): string | null {
	if (address === null) return APPLICATION;
	const named = PUBLIC_AREAS[address];
	if (named) return named;
	const section = address.split("/")[1] ?? "";
	return address.startsWith("/") && SECTIONS.has(section) ? APPLICATION : null;
}

export type PublicIssue = { title: string; body: string };
/**
 * The exact public issue for one feedback, or null when any part is outside the approved list: the feedback is then
 * held, and nothing is published in its place.
 */
export function publicIssue(input: { category: unknown; address: string | null; reference: unknown }): PublicIssue | null {
	const category = feedbackCategory.safeParse(input.category);
	const area = publicArea(input.address);
	if (!category.success || area === null) return null;
	if (typeof input.reference !== "string" || !REFERENCE.test(input.reference)) return null;
	const words = WORDING[category.data];
	return {
		title: `${words.title} — ${area}`,
		body: `${words.sentence} ${area}. Private details are retained for authorized triage. Reference: ${input.reference}.`,
	};
}

/** The frozen payload's hash, saved with it before the first call. */
export const issueHash = (issue: PublicIssue) =>
	createHash("sha256").update(JSON.stringify([issue.title, issue.body])).digest("hex");
