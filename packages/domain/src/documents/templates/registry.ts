import type { ReactElement } from "react";
import { agendaDocument } from "../layouts/agenda.tsx";
import type { Ctx } from "../layouts/blocks.tsx";
import { cardDocument } from "../layouts/card.tsx";
import { checklistsDocument } from "../layouts/checklists.tsx";
import { signInDocument, SIGN_IN_ROWS } from "../layouts/sign-in.tsx";
import { CARD, LETTER } from "../layouts/shell.tsx";
import { textDocument } from "../layouts/text-doc.tsx";
import type { DocumentClass } from "../theme.ts";
import { BOARD_AGENDA, VISION_AGENDA, type AgendaSpec } from "./agenda-content.ts";
import { COMMITMENT_CARD, RESPONSE_CARD, type CardSpec } from "./card-content.ts";
import { CHECKLIST_TEAMS } from "./checklists-content.ts";
import {
	FOLLOW_UP_LETTER,
	LAUNCH_TEAM_COMMITMENT,
	MEMBER_EXPECTATIONS,
	type TextDocumentSpec,
} from "./text-content.ts";

export type PageSize = { width: number; height: number };
type Base = { id: string; documentClass: DocumentClass; pageCount: number; outline: string[] };
export type PdfEntry = Base & {
	format: "pdf";
	pageSize: PageSize;
	/** Field names a render with no merge values (except the church name) holds, in no set order. */
	fields: string[];
	build: (ctx: Ctx) => ReactElement;
};
export type XlsxEntry = Base & { format: "xlsx"; pageSize: null; fields: []; budget: "first-year" | "worksheet" };
export type RegistryEntry = PdfEntry | XlsxEntry;

const range = (n: number) => Array.from({ length: n }, (_, i) => i + 1);

const cardEntry = (id: string, spec: CardSpec): PdfEntry => ({
	id,
	format: "pdf",
	documentClass: "outward-facing",
	pageSize: CARD,
	pageCount: 1,
	outline: [spec.heading, ...spec.rows.flatMap((r) => (r.tile ? [r.tile] : []))],
	fields: [...spec.rows.map((r) => r.name), ...spec.fields.map((f) => f.name)],
	build: (ctx) => cardDocument(ctx, spec),
});

const agendaEntry = (id: string, spec: AgendaSpec): PdfEntry => ({
	id,
	format: "pdf",
	documentClass: "operational",
	pageSize: LETTER,
	pageCount: 1,
	outline: ["Run of show", "Attendees", "Follow-up actions"],
	fields: [
		"meeting_date",
		"meeting_time",
		"meeting_place",
		"facilitator",
		...range(spec.segments.length).flatMap((n) => [`time_${n}`, `lead_${n}`]),
		...range(spec.attendeeRows * 2).flatMap((n) => [`attendee_${n}_name`, `attendee_${n}_role`, `present_${n}`]),
		...range(spec.actionRows).flatMap((n) => [`action_${n}`, `owner_${n}`, `due_${n}`, `done_${n}`]),
	],
	build: (ctx) => agendaDocument(ctx, spec),
});

const textEntry = (spec: TextDocumentSpec, documentClass: DocumentClass): PdfEntry => ({
	id: spec.id,
	format: "pdf",
	documentClass,
	pageSize: LETTER,
	pageCount: 1,
	outline: spec.style === "letter" ? [spec.title] : spec.sections.map((s) => s.heading),
	fields: spec.style === "letter" ? ["letter_date", "pastor_name"] : spec.signatures.map((s) => s.name),
	build: (ctx) => textDocument(ctx, spec),
});

export const REGISTRY: RegistryEntry[] = [
	cardEntry("commitment-card", COMMITMENT_CARD),
	cardEntry("response-card", RESPONSE_CARD),
	{
		id: "guest-sign-in-sheet",
		format: "pdf",
		documentClass: "operational",
		pageSize: LETTER,
		pageCount: 1,
		outline: ["Guest sign-in"],
		fields: [
			"meeting_date",
			"meeting_number",
			...range(SIGN_IN_ROWS).flatMap((n) => [
				`guest_${n}_name`,
				`guest_${n}_email`,
				`guest_${n}_phone`,
				`guest_${n}_invited_by`,
			]),
		],
		build: signInDocument,
	},
	agendaEntry("vision-meeting-agenda", VISION_AGENDA),
	textEntry(MEMBER_EXPECTATIONS, "operational"),
	textEntry(LAUNCH_TEAM_COMMITMENT, "operational"),
	textEntry(FOLLOW_UP_LETTER, "outward-facing"),
	agendaEntry("board-meeting-agenda", BOARD_AGENDA),
	{
		id: "first-year-budget",
		format: "xlsx",
		documentClass: "operational",
		pageSize: null,
		pageCount: 2,
		outline: ["Monthly budget", "Annual summary"],
		fields: [],
		budget: "first-year",
	},
	{
		id: "budget-worksheet",
		format: "xlsx",
		documentClass: "operational",
		pageSize: null,
		pageCount: 1,
		outline: ["Budget worksheet"],
		fields: [],
		budget: "worksheet",
	},
	{
		id: "launch-sunday-checklists",
		format: "pdf",
		documentClass: "operational",
		pageSize: LETTER,
		pageCount: 2,
		outline: CHECKLIST_TEAMS.map((t) => t.name),
		fields: [
			"launch_date",
			...CHECKLIST_TEAMS.flatMap((t) => [
				`${t.id}_lead`,
				...range(t.tasks.length).flatMap((n) => [`${t.id}_${n}_done`, `${t.id}_${n}_owner`, `${t.id}_${n}_time`]),
			]),
		],
		build: checklistsDocument,
	},
];
export const entryFor = (id: string) => REGISTRY.find((entry) => entry.id === id);

/** Every string and number the templates print, as plain data. Hashed into the render engine version. */
export function contentSnapshot() {
	return {
		registry: REGISTRY.map(({ id, format, documentClass, pageSize, pageCount, outline, fields }) => ({
			id,
			format,
			documentClass,
			pageSize,
			pageCount,
			outline,
			fields,
		})),
		cards: [COMMITMENT_CARD, RESPONSE_CARD].map((c) => ({ ...c, leadIn: c.leadIn({}) })),
		agendas: [VISION_AGENDA, BOARD_AGENDA].map((a) => ({ ...a, purpose: a.purpose("{church}") })),
		checklists: CHECKLIST_TEAMS,
		texts: [MEMBER_EXPECTATIONS, LAUNCH_TEAM_COMMITMENT, FOLLOW_UP_LETTER],
	};
}
