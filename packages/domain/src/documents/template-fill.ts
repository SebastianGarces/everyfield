import * as c from "@everyfield/contracts/documents";
import type { Database } from "@everyfield/db/client";
import { sql } from "@everyfield/db/query";
import "server-only";
import type { RequestActor } from "../access/session.ts";
import { dataFromRow } from "../branding/kit.ts";
import { deny, parse, plantViewer, readPlant, settle } from "./access.ts";
import { docTemplateById } from "./doc-templates.ts";
import { frozenData, type MergeSources } from "./doc-values.ts";
import { gateSql, plantScope, rowsOf } from "./scope.ts";

// What a new Church Document fills in from the church: the merge sources createFromTemplate freezes (church-writes.ts)
// and the read Evry's review shows before anything is made. No renderer is imported here, so the Evry adapters can read
// it without loading the document layouts.

export type Kit = ReturnType<typeof dataFromRow> | null;

/** The contact line a card prints: the website without its scheme, the phone and the email. */
export const contactLine = (kit: Kit) =>
	[kit?.website?.replace(/^https?:\/\//, "").replace(/\/$/, ""), kit?.phone, kit?.email]
		.filter(Boolean)
		.join("  ·  ") || null;

/** Where merge values come from now: the church plant (read by `readPlant`) and its brand kit. */
export function mergeSources(plant: Awaited<ReturnType<typeof readPlant>>, kit: Kit): MergeSources {
	if (!plant.open) deny("access_denied");
	if (!plant.subjectOk) deny("unavailable");
	return {
		churchName: plant.churchName ?? "",
		pastorName: plant.pastorName,
		tagline: kit?.tagline ?? null,
		legalName: kit?.legalName ?? null,
		contactLine: contactLine(kit),
		meetingDate: null,
	};
}

export type TemplateFill = {
	templateId: string;
	title: string;
	version: number;
	documentClass: c.DocTemplate["class"];
	/** Each merge field the document prints, with the value createFromTemplate would freeze now and its source. */
	fields: { key: string; label: string; value: string | null; source: string }[];
};

/**
 * What "New from template" would fill in from the church for one built-in template, read now and written nowhere:
 * each merge field's value and where it came from, exactly as createFromTemplate freezes them with no overrides. An
 * Owner or Admin only, as making the document is. Two statements: the plant read and the brand kit under the seat check.
 */
export async function templateFill(db: Pick<Database, "execute">, authority: RequestActor, raw: unknown) {
	return settle(async (): Promise<TemplateFill> => {
		const input = parse(c.getTemplateRequest, raw);
		const viewer = plantViewer(authority);
		if (!viewer || viewer.access.role === "member") deny("access_denied");
		const scope = plantScope(viewer);
		const template = docTemplateById(input.templateId) ?? deny("unavailable");
		const plant = await readPlant(db, viewer, { personId: null, meetingId: null, teamId: null });
		const kit = await rowsOf<{ kit: Record<string, unknown> | null }>(
			db,
			sql`SELECT (SELECT to_jsonb(k) FROM church_brand_kit k WHERE k.tenant_id = ${scope.tenantId}::uuid) AS kit
			FROM (SELECT ${gateSql(scope, true)} AS ok) g WHERE g.ok`,
		);
		if (!kit[0]) deny("access_denied");
		const frozen = frozenData(template.fields, mergeSources(plant, kit[0].kit ? dataFromRow(kit[0].kit) : null));
		return {
			templateId: template.id,
			title: template.title,
			version: template.version,
			documentClass: template.class,
			fields: template.fields
				.filter((field) => field.type !== "list")
				.map((field) => ({
					key: field.key,
					label: field.label,
					value: frozen.data[field.key] ?? null,
					source: frozen.from[field.key] ?? "absent",
				})),
		};
	});
}

export { docTemplateSummaries } from "./doc-templates.ts";
