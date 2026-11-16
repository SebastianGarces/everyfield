import { createHash } from "node:crypto";
import { feedbackCategory } from "@everyfield/contracts/feedback";

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

const WORDING = {
	bug: { title: "Bug report", sentence: "A product bug report was submitted for" },
	suggestion: { title: "Suggestion", sentence: "A product suggestion was submitted for" },
	question: { title: "Question", sentence: "A product question was submitted for" },
	other: { title: "Other feedback", sentence: "Other product feedback was submitted for" },
} as const;

const REFERENCE = /^FB-[0-9A-F]{12}$/;

function publicArea(address: string | null): string | null {
	if (address === null) return APPLICATION;
	const named = PUBLIC_AREAS[address];
	if (named) return named;
	const section = address.split("/")[1] ?? "";
	return address.startsWith("/") && SECTIONS.has(section) ? APPLICATION : null;
}

export type PublicIssue = { title: string; body: string };
export function publicIssue(input: {
	category: unknown;
	address: string | null;
	reference: unknown;
}): PublicIssue | null {
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

export const issueHash = (issue: PublicIssue) =>
	createHash("sha256")
		.update(JSON.stringify([issue.title, issue.body]))
		.digest("hex");
