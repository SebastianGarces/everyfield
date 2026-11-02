import type { DocTemplateSummary } from "@everyfield/domain/documents";

// 60 invented templates for the "New from template" design preview: enough to page and search. No database.

const NAMES: [title: string, description: string, documentClass: DocTemplateSummary["documentClass"]][] = [
	[
		"Budget Worksheet",
		"Monthly amounts by category. The annual amount and the totals add up on their own.",
		"operational",
	],
	["Core Group Commitment Card", "Four commitment cards on one Letter sheet. Cut on the marks.", "outward-facing"],
	["Conflict of Interest Policy", "How the board handles a personal interest in a decision.", "formal/legal"],
	["Guest Sign-in Sheet", "A sign-in sheet for a vision meeting, with rows to write in.", "operational"],
	["Bylaws", "How the church plant governs itself: members, board, officers and meetings.", "formal/legal"],
	["Child Safety Policy", "Screening, two-adult rule and check-in for every children's room.", "formal/legal"],
	["Volunteer Application", "Contact details, references and the roles a volunteer wants.", "operational"],
	["Welcome Letter", "A letter from the pastor to a first-time guest.", "outward-facing"],
	["Vision Meeting Agenda", "Times, speakers and the order of a vision meeting.", "operational"],
	["Statement of Faith", "The beliefs the church plant holds, one article each.", "formal/legal"],
	["Launch Team Covenant", "What each launch team member commits to before the first service.", "outward-facing"],
	["Expense Reimbursement Form", "Receipts, amounts and the approver's signature.", "operational"],
];

export const PREVIEW_TEMPLATES: DocTemplateSummary[] = Array.from({ length: 60 }, (_, i) => {
	const [title, description, documentClass] = NAMES[i % NAMES.length]!;
	const round = Math.floor(i / NAMES.length);
	return {
		id: `preview-${i + 1}`,
		version: 1,
		title: round ? `${title} ${round + 1}` : title,
		description,
		documentClass,
		formats: documentClass === "operational" && i % 3 === 0 ? ["pdf", "docx", "xlsx"] : ["pdf", "docx"],
		page: { width: 612, height: 792, perSheet: title.includes("Card") ? 4 : 1 },
	};
});
