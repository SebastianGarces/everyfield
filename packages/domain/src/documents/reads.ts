import * as c from "@everyfield/contracts/documents";
import "server-only";
import type { RequestActor } from "../access/session.ts";
import { accountOpen, deny, parse, plantViewer, readPlant, rejectInput, settle, type Reader } from "./access.ts";
import { library, templateView, type CatalogTemplate } from "./catalog.ts";
import { cleanOverrides, resolveMerge } from "./merge.ts";
import { RenderFailed, digestOf, renderEngineVersion, renderPreview } from "./render.ts";

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

function matched(
	templates: CatalogTemplate[],
	input: {
		wikiSlug?: string;
		category?: CatalogTemplate["category"];
		phase?: number;
		meetingId?: string;
		teamId?: string;
	},
) {
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
			if (!(await accountOpen(db, authority))) deny();
			const loaded = await library();
			return pageOf(loaded.version, matched(loaded.templates, input));
		});
	},
	async resolveContext(db: Reader, authority: RequestActor, raw: unknown) {
		return settle(() => contextOf(db, authority, raw, false));
	},
	async preview(db: Reader, authority: RequestActor, raw: unknown) {
		return settle(() => contextOf(db, authority, raw, true));
	},
};

async function contextOf(db: Reader, authority: RequestActor, raw: unknown, withArtifact: boolean) {
	const input = parse(withArtifact ? c.previewRequest : c.resolveContextRequest, raw);
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
	const resolved = resolveMerge(
		template,
		{ churchName: row.churchName, pastorName: row.pastorName, launchDate: row.launchDate },
		cleaned.values,
	);
	if (!resolved.ok) rejectInput(resolved.path, resolved.problem);
	const value = {
		templateId: template.id,
		templateVersion: loaded.version,
		plantId: viewer.plantId,
		format: input.format,
		fields: resolved.fields,
		missing: resolved.missing,
		sources: template.relatedWikiSlug ? [template.relatedWikiSlug] : [],
		complete: resolved.complete,
	};
	if (!withArtifact) return c.contextResult.parse(value);
	try {
		const bytes = renderPreview(template, input.format, resolved);
		return c.previewResult.parse({
			...value,
			artifact: bytes ? bytes.toString("base64") : null,
			digest: bytes ? digestOf(bytes) : null,
			engineVersion: bytes ? renderEngineVersion() : null,
		});
	} catch (error) {
		if (error instanceof RenderFailed) deny("render_failed");
		throw error;
	}
}
