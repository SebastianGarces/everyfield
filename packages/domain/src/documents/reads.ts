import { dateText } from "@everyfield/contracts/common";
import * as c from "@everyfield/contracts/documents";
import type { Database } from "@everyfield/db/client";
import type { PrivateStorage } from "@everyfield/db/schema";
import "server-only";
import type { RequestActor } from "../access/session.ts";
import {
	accountOpen,
	deny,
	parse,
	plantViewer,
	readPlant,
	rejectInput,
	settle,
	type PlantRead,
	type Reader,
} from "./access.ts";
import { library, templateView, type CatalogTemplate } from "./catalog.ts";
import { AGENDA_TEMPLATE, agendaKindOf, agendaMeetingOf, type AgendaKind } from "./agenda-meeting.ts";
import { readAgendaKind, type MeetingRead } from "./meeting-read.ts";
import { cleanOverrides, resolveMerge, type ResolvedMerge } from "./merge.ts";
import { RenderFailed, digestOf, renderEngineVersion, renderPreview } from "./render.ts";
import { templateTheme } from "./church-theme.ts";
import { entryFor } from "./templates/registry.ts";
import type { RenderTheme } from "./theme.ts";

function pageOf(version: string, templates: CatalogTemplate[]) {
	const views = templates.map(templateView);
	return c.templatePage.parse({
		version,
		templateCount: views.length,
		formatCount: views.reduce((sum, template) => sum + template.formats.length, 0),
		templates: views,
	});
}

function listed(
	templates: CatalogTemplate[],
	input: { category?: CatalogTemplate["category"]; phase?: number; format?: CatalogTemplate["formats"][number] },
) {
	return templates.filter((template) => {
		if (input.category && template.category !== input.category) return false;
		if (input.phase !== undefined && template.phase !== input.phase) return false;
		if (input.format && !template.formats.includes(input.format)) return false;
		return true;
	});
}

type Contextual = {
	wikiSlug?: string;
	category?: CatalogTemplate["category"];
	phase?: number;
	meetingId?: string;
	teamId?: string;
};

function matched(templates: CatalogTemplate[], input: Contextual, kind: AgendaKind | null) {
	// A meeting offers the one agenda that prints from it.
	if (input.meetingId && !input.teamId)
		return kind ? templates.filter((template) => template.id === AGENDA_TEMPLATE[kind]) : [];
	if (input.meetingId || input.teamId) return [];
	if (!input.wikiSlug && !input.category && input.phase === undefined) return [];
	return templates.filter((template) => {
		if (input.wikiSlug && template.relatedWikiSlug !== input.wikiSlug) return false;
		if (input.category && template.category !== input.category) return false;
		if (input.phase !== undefined && template.phase !== input.phase) return false;
		return true;
	});
}

export const documentsReader = {
	async "templates.list"(db: Reader, authority: RequestActor, raw: unknown) {
		return settle(async () => {
			const input = parse(c.listTemplatesRequest, raw);
			if (!(await accountOpen(db, authority))) deny();
			const loaded = await library();
			return pageOf(loaded.version, listed(loaded.templates, input));
		});
	},
	async "templates.get"(db: Reader, authority: RequestActor, raw: unknown) {
		return settle(async () => {
			const input = parse(c.getTemplateRequest, raw);
			if (!(await accountOpen(db, authority))) deny();
			const loaded = await library();
			const template = loaded.templates.find((item) => item.id === input.templateId);
			if (!template) deny();
			return c.templateView.parse(templateView(template));
		});
	},
	async "templates.contextual"(db: Reader, authority: RequestActor, raw: unknown) {
		return settle(async () => {
			const input = parse(c.contextualTemplatesRequest, raw);
			// With a meeting, one statement reads the account, the seat and the meeting's kind together.
			const viewer = input.meetingId && !input.teamId ? plantViewer(authority) : null;
			if (viewer && input.meetingId) {
				const found = await readAgendaKind(db, viewer, input.meetingId);
				if (!found.open) deny();
				const loaded = await library();
				return pageOf(loaded.version, matched(loaded.templates, input, found.kind));
			}
			if (!(await accountOpen(db, authority))) deny();
			const loaded = await library();
			return pageOf(loaded.version, matched(loaded.templates, input, null));
		});
	},
	async resolveContext(db: Reader, authority: RequestActor, raw: unknown) {
		return settle(() => contextOf(db, authority, raw, null));
	},
	/** The brand kit's images come from private storage; without it the church theme renders with the name in type. */
	async preview(db: Database, authority: RequestActor, raw: unknown, storage: PrivateStorage | null = null) {
		return settle(() => contextOf(db, authority, raw, { db, storage }));
	},
	async printAgenda(db: Reader, authority: RequestActor, raw: unknown) {
		return settle(() => printAgenda(db, authority, raw));
	},
};

const agendaTemplateKind = (id: string) =>
	(Object.entries(AGENDA_TEMPLATE) as [AgendaKind, string][]).find(([, template]) => template === id)?.[0];

async function contextOf(
	db: Reader,
	authority: RequestActor,
	raw: unknown,
	artifact: { db: Database; storage: PrivateStorage | null } | null,
) {
	const input = parse(artifact ? c.previewRequest : c.resolveContextRequest, raw);
	const cleaned = cleanOverrides(input.overrides);
	if (!cleaned.ok) rejectInput(cleaned.path, cleaned.problem);
	const viewer = plantViewer(authority);
	if (!viewer) deny();
	const row = await readPlant(db, viewer, {
		personId: input.personId ?? null,
		meetingId: input.meetingId ?? null,
		teamId: input.teamId ?? null,
	});
	if (!row.open) deny();
	if (!row.subjectOk) deny("invalid_subject");
	const loaded = await library();
	const template = loaded.templates.find((item) => item.id === input.templateId);
	if (!template) deny();
	if (!template.formats.includes(input.format)) rejectInput("format", "Format is not on this template.");
	const done = forSubject(loaded, template, input.format, cleaned.values, viewer.plantId, row, input.meetingId);
	if (!artifact) return c.contextResult.parse(done.value);
	const bytes = await done.render(artifact.db, artifact.storage, authority);
	return c.previewResult.parse({
		...done.value,
		brandKit: row.kit !== null,
		artifact: bytes ? bytes.toString("base64") : null,
		digest: bytes ? digestOf(bytes) : null,
		engineVersion: bytes ? renderEngineVersion() : null,
	});
}

type Loaded = Awaited<ReturnType<typeof library>>;
type OpenRead = Extract<PlantRead, { subjectOk: true }>;

/**
 * One template resolved for one subject, and its render: the merge values (a meeting's date fills meeting_date) and,
 * for an agenda, the meeting's rows. The preview and generate both call this, so a generated file holds the bytes its
 * preview showed for the same template, format, overrides and subject. An agenda prints only from a live meeting of its
 * own kind; any other meeting reads as no subject at all. The render paints the plant's brand kit as it stands now
 * (`templateTheme`), so both paths use the same theme for the same kit.
 */
export function forSubject(
	loaded: Loaded,
	template: CatalogTemplate,
	format: "pdf" | "docx" | "xlsx",
	overrides: Record<string, string>,
	plantId: string,
	row: OpenRead,
	meetingId: string | undefined,
) {
	const agendaFor = agendaTemplateKind(template.id);
	if (agendaFor && meetingId && (!row.meeting || agendaKindOf(row.meeting) !== agendaFor)) deny("invalid_subject");
	const done = resolved(loaded, template, format, overrides, plantId, row);
	return {
		...done,
		render: async (db: Database, storage: PrivateStorage | null, authority: RequestActor) => {
			const entry = entryFor(template.id);
			if (!entry) deny("render_failed");
			const theme = await templateTheme(
				db,
				storage,
				authority,
				{ name: row.churchName ?? "", kit: row.kit },
				entry.documentClass,
			);
			return rendered(template, format, done.merge, agendaFor ? row.meeting : null, row.statement, theme);
		},
	};
}

function resolved(
	loaded: Loaded,
	template: CatalogTemplate,
	format: "pdf" | "docx" | "xlsx",
	overrides: Record<string, string>,
	plantId: string,
	row: OpenRead,
) {
	// The meeting's date fills meeting_date for any template named with a live meeting.
	const meetingDate = row.meeting ? dateText(row.meeting.localDate, new Date().getUTCFullYear()) : undefined;
	const merge = resolveMerge(
		template,
		{ churchName: row.churchName, pastorName: row.pastorName, launchDate: row.launchDate, meetingDate },
		overrides,
	);
	if (!merge.ok) rejectInput(merge.path, merge.problem);
	const value = {
		templateId: template.id,
		templateVersion: loaded.version,
		plantId,
		format,
		fields: merge.fields,
		missing: merge.missing,
		sources: template.relatedWikiSlug ? [template.relatedWikiSlug] : [],
		complete: merge.complete,
	};
	return { value, merge };
}

/**
 * Bytes, or null when a required field is missing. A meeting's rows print only when `printFrom` is given. The network's
 * statement of faith fills a `statement-of-faith` slot. No theme renders the Everyfield-neutral theme.
 */
async function rendered(
	template: CatalogTemplate,
	format: "pdf" | "docx" | "xlsx",
	merge: Extract<ResolvedMerge, { ok: true }>,
	printFrom: MeetingRead | null,
	statement: string | null = null,
	theme?: RenderTheme,
) {
	try {
		const meeting = printFrom ? agendaMeetingOf(printFrom, new Date().getUTCFullYear()) : undefined;
		return await renderPreview(template, format, merge, theme, meeting, statement);
	} catch (error) {
		if (error instanceof RenderFailed) deny("render_failed");
		throw error;
	}
}

/** The agenda of one live meeting as PDF bytes. One statement reads the plant and the meeting; nothing is stored. */
async function printAgenda(db: Reader, authority: RequestActor, raw: unknown) {
	const input = parse(c.printAgendaRequest, raw);
	const viewer = plantViewer(authority);
	if (!viewer) deny();
	const row = await readPlant(db, viewer, { personId: null, meetingId: input.meetingId, teamId: null });
	if (!row.open) deny();
	if (!row.subjectOk) deny("invalid_subject");
	const kind = row.meeting ? agendaKindOf(row.meeting) : null;
	if (!row.meeting || !kind) deny("invalid_subject");
	const loaded = await library();
	const template = loaded.templates.find((item) => item.id === AGENDA_TEMPLATE[kind]);
	if (!template) deny();
	const done = resolved(loaded, template, "pdf", {}, viewer.plantId, row);
	const bytes = await rendered(template, "pdf", done.merge, row.meeting);
	if (!bytes) deny("render_failed");
	return c.agendaPrintResult.parse({
		templateId: template.id,
		localDate: row.meeting.localDate,
		artifact: bytes.toString("base64"),
	});
}
