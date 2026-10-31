import type { ChurchBlock } from "@everyfield/contracts/documents";
import type { RenderClass } from "../theme.ts";
import { BYLAWS_BODY, PRAYER_LETTER_BODY } from "./church-content.ts";
import {
	ACCOUNTABLE_PLAN_BODY,
	BOARD_MINUTES_BODY,
	CONFLICT_OF_INTEREST_BODY,
	FINANCIAL_CONTROLS_BODY,
} from "./policy-content.ts";
import {
	FOLLOW_UP_LETTER,
	LAUNCH_TEAM_COMMITMENT,
	MEMBER_EXPECTATIONS,
	type TextDocumentSpec,
} from "./text-content.ts";

export type SignatureSlot = { label: string; name: string; width: number };
/** The fixed frame of a Church Document: what export prints around the editable body, in the PDF and the DOCX. */
export type Frame =
	| { kind: "sign"; closing: string; slots: SignatureSlot[] }
	| { kind: "adopt"; closing: string; signers: number }
	| { kind: "letter"; signOff: string };

export type ChurchTemplate = {
	id: string;
	/** Bumped when the authored body or frame changes. A Church Document keeps the version it was made from. */
	version: number;
	name: string;
	description: string;
	documentClass: RenderClass;
	/** `document`: the headings are numbered. `letter`: the pastor writes to a reader. */
	style: "document" | "letter";
	kicker: string;
	title: string;
	subject: string;
	frame: Frame;
	/** Doctrinal slots. The body holds one slot node for each, and editing never deletes it. */
	slots: { id: string; label: string }[];
	mergeFields: { key: string; label: string; required: boolean; autoFill: string | null }[];
	/** The body with `{church_name}` and `{pastor_name}` tokens. */
	body: ChurchBlock[];
};

export const MERGE_FIELDS: ChurchTemplate["mergeFields"] = [
	{ key: "church_name", label: "Church name", required: true, autoFill: "church_name" },
	{ key: "pastor_name", label: "Pastor name", required: false, autoFill: "pastor_name" },
];

/** The visible blank an unfilled doctrinal slot prints, in the PDF and the DOCX. It is never doctrinal text. */
export const SLOT_BLANK_NOTE =
	"Not filled in yet. Your church or its sending network adds this text. It stays blank until then.";

/** How a merge value with no source reads in the text. It is never an invented name. */
const blankFor = (key: string) => `[${(MERGE_FIELDS.find((f) => f.key === key)?.label ?? key).toLowerCase()}]`;

/** Revision 1 of a Church Document: each `{key}` token replaced once, in one pass. */
export function resolveTokens(text: string, values: Record<string, string | null>) {
	return text.replace(/\{([a-z_]+)\}/g, (token, key: string) => {
		if (!MERGE_FIELDS.some((field) => field.key === key)) return token;
		return values[key] ?? blankFor(key);
	});
}
export function resolveBody(body: readonly ChurchBlock[], values: Record<string, string | null>): ChurchBlock[] {
	const fill = (text: string) => resolveTokens(text, values);
	return body.map((block): ChurchBlock => {
		if ("items" in block) return { ...block, items: block.items.map(fill) };
		return { ...block, text: fill(block.text) };
	});
}

/** The body a text-document spec has: its intro or greeting, then each section as a heading and its blocks. */
function bodyOfSpec(spec: TextDocumentSpec): ChurchBlock[] {
	const body: ChurchBlock[] = [];
	if (spec.greeting) body.push({ kind: "paragraph", text: spec.greeting });
	if (spec.intro) body.push({ kind: "paragraph", text: spec.intro });
	for (const section of spec.sections) {
		if (section.heading) body.push({ kind: "heading", text: section.heading });
		for (const block of section.blocks)
			body.push(
				block.kind === "p"
					? { kind: "paragraph", text: block.text }
					: { kind: block.ordered ? "numbered_list" : "bulleted_list", items: block.items },
			);
	}
	return body;
}

function fromSpec(
	spec: TextDocumentSpec,
	documentClass: RenderClass,
	name: string,
	description: string,
): ChurchTemplate {
	return {
		id: spec.id,
		version: 1,
		name,
		description,
		documentClass,
		style: spec.style,
		kicker: spec.kicker,
		title: spec.title,
		subject: spec.subject,
		frame:
			spec.style === "letter"
				? { kind: "letter", signOff: spec.signOff ?? "" }
				: { kind: "sign", closing: spec.closing ?? "", slots: spec.signatures },
		slots: [],
		mergeFields: MERGE_FIELDS,
		body: bodyOfSpec(spec),
	};
}

/** A formal/legal document template: numbered headings, no doctrinal slot, the shared merge fields. */
function policy(
	id: string,
	name: string,
	description: string,
	kicker: string,
	subject: string,
	frame: Frame,
	body: ChurchBlock[],
): ChurchTemplate {
	return {
		id,
		version: 1,
		name,
		description,
		documentClass: "formal/legal",
		style: "document",
		kicker,
		title: name,
		subject,
		frame,
		slots: [],
		mergeFields: MERGE_FIELDS,
		body,
	};
}

const adopt = (closing: string): Frame => ({ kind: "adopt", closing, signers: 3 });

export const CHURCH_TEMPLATES: ChurchTemplate[] = [
	fromSpec(
		MEMBER_EXPECTATIONS,
		"operational",
		"Expectations of a Core Group Member",
		"What the church plant asks of each core group member, with a place to sign.",
	),
	fromSpec(
		LAUNCH_TEAM_COMMITMENT,
		"operational",
		"Launch Team Commitment",
		"The commitment of a launch team member, with a place to sign.",
	),
	fromSpec(
		FOLLOW_UP_LETTER,
		"outward-facing",
		"Vision Meeting Follow-up Letter",
		"A thank-you letter to a guest of a vision meeting.",
	),
	{
		id: "bylaws",
		version: 1,
		name: "Bylaws",
		description:
			"How the church plant is governed. It has a statement-of-faith slot that stays blank until you fill it.",
		documentClass: "formal/legal",
		style: "document",
		kicker: "Governing document",
		title: "Bylaws",
		subject: "The bylaws of {church_name}",
		frame: {
			kind: "adopt",
			closing: "The board of {church_name} adopted these bylaws. Each board member signs and dates below.",
			signers: 3,
		},
		slots: [{ id: "statement-of-faith", label: "Statement of faith" }],
		mergeFields: MERGE_FIELDS,
		body: BYLAWS_BODY,
	},
	{
		id: "prayer-letter",
		version: 1,
		name: "Prayer Letter",
		description: "A letter from the pastor that tells supporters how to pray for the church plant.",
		documentClass: "outward-facing",
		style: "letter",
		kicker: "Prayer letter",
		title: "A Letter to Those Who Pray for Us",
		subject: "A prayer letter from {church_name}",
		frame: { kind: "letter", signOff: "With gratitude," },
		slots: [],
		mergeFields: MERGE_FIELDS,
		body: PRAYER_LETTER_BODY,
	},
	policy(
		"board-minutes",
		"Board Minutes",
		"A blank record of a board meeting: who came, what the board decided and who does what next.",
		"Board record",
		"The minutes of a board meeting of {church_name}",
		{
			kind: "sign",
			closing: "The board of {church_name} approved these minutes on [date of approval].",
			slots: [
				{ label: "Secretary", name: "secretary", width: 240 },
				{ label: "Chair", name: "chair", width: 240 },
			],
		},
		BOARD_MINUTES_BODY,
	),
	policy(
		"conflict-of-interest-policy",
		"Conflict of Interest Policy",
		"How the board handles a personal interest in a decision.",
		"Board policy",
		"The conflict of interest policy of {church_name}",
		adopt("The board of {church_name} adopted this policy. Each board member signs and dates below."),
		CONFLICT_OF_INTEREST_BODY,
	),
	policy(
		"financial-controls-policy",
		"Financial Controls Policy",
		"How the church plant counts, deposits, approves and reports its money.",
		"Board policy",
		"The financial controls policy of {church_name}",
		adopt("The board of {church_name} adopted this policy. Each board member signs and dates below."),
		FINANCIAL_CONTROLS_BODY,
	),
	policy(
		"accountable-plan-reimbursement-policy",
		"Accountable Plan Reimbursement Policy",
		"How the church plant repays business expenses so that the repayment is not taxable pay.",
		"Board policy",
		"The accountable plan reimbursement policy of {church_name}",
		adopt("The board of {church_name} adopted this plan. Each board member signs and dates below."),
		ACCOUNTABLE_PLAN_BODY,
	),
];

export const churchTemplate = (id: string) => CHURCH_TEMPLATES.find((template) => template.id === id);

/**
 * Editable catalog ids with no authored content yet (docs/catalog/document-templates.json, `editable: true`).
 * `createFromTemplate` refuses these with `template_not_authored`; a test keeps this list equal to the catalog.
 */
export const PENDING_EDITABLE = [
	"church-planting-prospectus",
	"partnership-agreement",
	"residency-plan",
	"child-protection-policy",
	"monthly-progress-report",
	"support-letter",
	"group-exemption-rev-proc-2026-8",
] as const;

/** Catalog ids that are not editable: fixed-layout, budget and email templates. Refused with `template_not_editable`. */
export const NOT_EDITABLE = [
	"commitment-card",
	"response-card",
	"guest-sign-in-sheet",
	"vision-meeting-agenda",
	"board-meeting-agenda",
	"first-year-budget",
	"budget-worksheet",
	"launch-sunday-checklists",
	"vision-meeting-invitation",
	"vision-meeting-reminder",
	"vision-meeting-follow-up-attended",
	"vision-meeting-follow-up-no-show",
	"orientation-invitation",
	"team-meeting-invitation",
	"general-announcement",
	"vision-meeting-kit-checklist",
	"vision-meeting-self-assessment",
	"follow-up-interview-questions",
	"ministry-team-checklists",
	"volunteer-application",
	"background-check-consent",
	"launch-sunday-run-sheet",
] as const;
