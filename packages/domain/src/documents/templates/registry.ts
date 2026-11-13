import type { ReactElement } from "react";
import { ATTENDEE_CAP } from "../agenda-meeting.ts";
import { agendaDocument } from "../layouts/agenda.tsx";
import type { Ctx } from "../layouts/blocks.tsx";
import { cardDocument } from "../layouts/card.tsx";
import { checklistsDocument } from "../layouts/checklists.tsx";
import { CARD, LETTER } from "../layouts/shell.tsx";
import type { RenderClass } from "../theme.ts";
import {
	ACTION_ROWS,
	BLANK_RUN_ROWS,
	BOARD_AGENDA,
	MIN_ATTENDEE_ROWS,
	VISION_AGENDA,
	type AgendaSpec,
} from "./agenda-content.ts";
import { RESPONSE_CARD, type CardSpec } from "./card-content.ts";
import { CHECKLIST_TEAMS } from "./checklists-content.ts";
import { DOC_TEMPLATES } from "../doc-templates.ts";

// The library templates that have no everyfield.doc/1 file keep a code layout here (D-922). A library template with
// a file, `templates/<id>.json`, renders from that file alone and has no entry here.

type PageSize = { width: number; height: number };
/** What the library says about one template: its one format, class, page and outline, and the field names it holds. */
export type LibraryFacts = {
	format: "pdf" | "xlsx";
	documentClass: RenderClass;
	pageSize: PageSize | null;
	pageCount: number;
	outline: string[];
	/** Field names a render with no merge values (except the church name) holds, in no set order. */
	fields: string[];
};
type Base = LibraryFacts & { id: string };
type PdfEntry = Base & { format: "pdf"; pageSize: PageSize; build: (ctx: Ctx) => ReactElement };
type XlsxEntry = Base & { format: "xlsx"; pageSize: null; fields: [] };
type RegistryEntry = PdfEntry | XlsxEntry;

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
	// The blank sheet. A render from a meeting holds the same meta and action fields; its run of show and attendee
	// rows come from the meeting, so only the blank rows are listed.
	fields: [
		"meeting_date",
		"meeting_time",
		"meeting_place",
		"facilitator",
		...range(BLANK_RUN_ROWS).flatMap((n) => [`time_${n}`, `segment_${n}`, `lead_${n}`, `notes_${n}`]),
		...range(MIN_ATTENDEE_ROWS).flatMap((n) => [`attendee_${n}_name`, `attendee_${n}_role`, `present_${n}`]),
		...range(ACTION_ROWS).flatMap((n) => [`action_${n}`, `owner_${n}`, `due_${n}`, `done_${n}`]),
	],
	build: (ctx) => agendaDocument(ctx, spec),
});

export const REGISTRY: RegistryEntry[] = [
	cardEntry("response-card", RESPONSE_CARD),
	agendaEntry("vision-meeting-agenda", VISION_AGENDA),
	agendaEntry("board-meeting-agenda", BOARD_AGENDA),
	{
		id: "first-year-budget",
		format: "xlsx",
		documentClass: "operational",
		pageSize: null,
		pageCount: 2,
		outline: ["Monthly budget", "Annual summary"],
		fields: [],
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
		cards: [RESPONSE_CARD].map((c) => ({ ...c })),
		agendas: {
			blankRunRows: BLANK_RUN_ROWS,
			minAttendeeRows: MIN_ATTENDEE_ROWS,
			actionRows: ACTION_ROWS,
			attendeeCap: ATTENDEE_CAP,
			specs: [VISION_AGENDA, BOARD_AGENDA].map((a) => ({ ...a, purpose: a.purpose("{church}") })),
		},
		checklists: CHECKLIST_TEAMS,
		docTemplates: DOC_TEMPLATES,
	};
}
