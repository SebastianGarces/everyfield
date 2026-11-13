import type { Transaction } from "@everyfield/db/client";
import { sql } from "@everyfield/db/query";
import { liveRead } from "@everyfield/domain/access";
import { docTemplateSummaries } from "@everyfield/domain/documents/fill";
import { docDocument, LEGAL_NOTICE, nativeText, readNative } from "@everyfield/contracts/documents";
import { z } from "zod";
import type { EvryActor } from "../../../context/actor.ts";
import type { ReadAdapter, SourceResult, SourceRow } from "../../../catalog/types.ts";
import { documentText } from "./text.ts";

// The Documents reads (WP-079). The app keeps two stores and Evry reads both as the app does: written documents (plain,
// core values and imported ones) and Church Documents made from a template. Every read is one statement in the actor's
// own church under the lock-free live check, so another church's document never comes back. Any seat in the church may
// read; only an Owner or Admin may change a document (commands/index.ts). A read never returns stored JSON: a document's
// text is its plain reading-order text, cut at a bound, so Evry can quote what a document actually says.

const inPlant = (actor: EvryActor) => actor.owner.kind === "plant" && actor.role !== null;
const live = (actor: EvryActor) =>
	liveRead({ session: actor.session, owner: actor.owner, seatId: actor.seatId ?? undefined });

/** Where a document opens in the app. */
const documentLink = (store: "written" | "church", id: string) =>
	store === "church" ? `/documents/church/${id}` : `/documents/written/${id}`;
/** The two lists in the app: written documents on Documents, Church Documents in their own library. */
const LISTS = { written: "/documents", church: "/documents/church" } as const;

/** The most text one document read returns to the model. A longer document says it was cut. */
const TEXT_CHARS = 6_000;
const LIST_LIMIT = 50;

/**
 * The documents a person sees in the app now: each live written document and each Church Document that is neither
 * archived nor deleted. `store` says which list it is on, `type` what it is.
 */
const listed = (actor: EvryActor) => sql`
	SELECT d.id, d.title, d.kind, d.template_id, d.template_version, r.recorded_at,
		CASE WHEN d.kind='church_document' THEN 'church' ELSE 'written' END AS store
	FROM document d JOIN document_revision r ON r.id=d.current_revision_id AND r.tenant_id=d.tenant_id
	WHERE d.tenant_id=${actor.owner.id}::uuid AND d.archived_at IS NULL
		AND (d.kind IN ('native','core_values') OR (d.kind='church_document' AND d.church_archived_at IS NULL))`;

const listedRow = z.object({
	id: z.uuid(),
	title: z.string(),
	kind: z.enum(["native", "core_values", "church_document"]),
	template_id: z.string().nullable(),
	template_version: z.number().int().nullable(),
	recorded_at: z.coerce.date(),
	store: z.enum(["written", "church"]),
});
const TYPE = { native: "Written document", core_values: "Core values", church_document: "Church Document" } as const;

function documentRow(row: z.infer<typeof listedRow>, extra: Record<string, string | boolean | null> = {}): SourceRow {
	return {
		kind: "document",
		id: row.id,
		label: row.title,
		fields: {
			store: row.store,
			type: TYPE[row.kind],
			template: row.template_id,
			updatedOn: row.recorded_at.toISOString().slice(0, 10),
			link: documentLink(row.store, row.id),
			...extra,
		},
	};
}

const listInput = z.strictObject({
	title: z.string().trim().min(1).max(200).optional().describe("Words from the document's title"),
	store: z.enum(["written", "church"]).optional().describe("written: Documents; church: Church Documents"),
});
export const listOwned: ReadAdapter<z.infer<typeof listInput>> = {
	operation: "documents.listOwned",
	description:
		"List the documents this church saved in Everyfield, as Documents and Church Documents show them: each title, its type (written document, core values or Church Document), its template, when it last changed and its link in the app. It reads titles only; read a document with documents.read before saying what it says. These are the church's own documents, not the Everyfield Wiki. Evry sees only documents saved in Everyfield, never files on a computer, phone, drive, email or the web: when asked about such files, say Evry can only see documents in Everyfield and offer these. Any seat may read documents; only an Owner or Admin can make, export, archive or mark one, so tell anyone else that an Owner or Admin has to do it.",
	input: listInput,
	allowed: inPlant,
	async invoke(tx: Transaction, actor: EvryActor, input): Promise<SourceResult> {
		// Every word of the request appears in the title, in any order: "September vision agenda" finds
		// "Vision Meeting Agenda - September 14".
		const words = (input.title?.split(/\s+/).filter(Boolean) ?? []).map((w) => `%${w.replace(/[\\%_]/g, "\\$&")}%`);
		const r = await tx.execute(sql`
			SELECT x.*, count(*) OVER () AS total FROM (${listed(actor)}) x
			WHERE ${live(actor)} AND NOT EXISTS(SELECT FROM unnest(${sql.param(words)}::text[]) w WHERE x.title NOT ILIKE w ESCAPE '\\')
				AND (${input.store ?? null}::text IS NULL OR x.store=${input.store ?? null})
			ORDER BY x.recorded_at DESC, x.id LIMIT ${LIST_LIMIT}`);
		const rows = r.rows.map((raw) => listedRow.parse(raw));
		const total = Number((r.rows[0] as { total?: unknown } | undefined)?.total ?? 0);
		return {
			operation: "documents.listOwned",
			status: rows.length ? "available" : "not_found",
			rows: rows.map((row) => documentRow(row)),
			total,
			page: 1,
			next: null,
			completeness: total > rows.length ? "partial" : "complete",
			exclusions: [
				"document text (read one with documents.read)",
				"archived and deleted documents",
				"files outside Everyfield",
			],
		};
	},
};

const readInput = z.strictObject({ documentId: z.uuid().describe("A document id from documents.listOwned") });
const readRow = listedRow.extend({ body: z.string(), archived: z.boolean() });
export const read: ReadAdapter<z.infer<typeof readInput>> = {
	operation: "documents.read",
	description: `Read one of this church's documents: its title, type, link and its actual text in reading order (at most ${TEXT_CHARS.toLocaleString("en-US")} characters). When you say what a document says, quote its words in quotation marks; never describe a document from its title.`,
	input: readInput,
	allowed: inPlant,
	async invoke(tx: Transaction, actor: EvryActor, input): Promise<SourceResult> {
		// An archived document stays readable, as it does in the app; a deleted Church Document does not.
		const r = await tx.execute(sql`
			SELECT d.id, d.title, d.kind, d.template_id, d.template_version, r.recorded_at, r.body,
				CASE WHEN d.kind='church_document' THEN 'church' ELSE 'written' END AS store,
				(d.kind<>'church_document' AND d.archived_at IS NOT NULL) OR d.church_archived_at IS NOT NULL AS archived
			FROM document d JOIN document_revision r ON r.id=d.current_revision_id AND r.tenant_id=d.tenant_id
			WHERE d.id=${input.documentId}::uuid AND d.tenant_id=${actor.owner.id}::uuid AND ${live(actor)}
				AND (d.kind IN ('native','core_values') OR (d.kind='church_document' AND d.archived_at IS NULL))
				AND (r.import_state IS NULL OR r.import_state='ready')`);
		const found = r.rows[0] ? readRow.parse(r.rows[0]) : null;
		if (!found)
			return {
				operation: "documents.read",
				status: "not_found",
				rows: [],
				total: 0,
				page: 1,
				next: null,
				completeness: "complete",
				exclusions: [],
			};
		const full = found.store === "church" ? churchText(found.body) : nativeText(readNative(found.body).body);
		const cut = full.length > TEXT_CHARS;
		return {
			operation: "documents.read",
			status: "available",
			rows: [
				documentRow(found, {
					archived: found.archived,
					text: cut ? full.slice(0, TEXT_CHARS) : full,
					textCut: cut,
				}),
			],
			total: 1,
			page: 1,
			next: null,
			completeness: cut ? "partial" : "complete",
			exclusions: cut
				? [`text after the first ${TEXT_CHARS.toLocaleString("en-US")} characters`, "images"]
				: ["images"],
		};
	},
};

/** A Church Document's text with its frozen merge values filled in; a body the parser refuses reads as empty. */
function churchText(stored: string) {
	try {
		const doc = docDocument.safeParse(JSON.parse(stored));
		return doc.success ? documentText(doc.data) : "";
	} catch {
		return "";
	}
}

export const coreValues: ReadAdapter<Record<string, never>> = {
	operation: "documents.readCoreValuesEvidence",
	description: `Find the written document this church marked as its core values, with its link. Not found means the church has marked none: say so and offer the documents lists (${LISTS.written} for written documents, ${LISTS.church} for Church Documents). Never write core values for the church.`,
	input: z.strictObject({}),
	allowed: inPlant,
	async invoke(tx: Transaction, actor: EvryActor): Promise<SourceResult> {
		// The app's evidence rule (documentsWriter.readCoreValuesEvidence): the latest live core-values document with text.
		const r = await tx.execute(sql`
			SELECT d.id, d.title, d.kind, d.template_id, d.template_version, r.recorded_at, 'written' AS store
			FROM document d JOIN document_revision r ON r.id=d.current_revision_id AND r.tenant_id=d.tenant_id
			WHERE d.tenant_id=${actor.owner.id}::uuid AND d.kind='core_values' AND d.archived_at IS NULL AND ${live(actor)}
				AND (r.import_state IS NULL OR r.import_state='ready') AND length(btrim(r.body))>0
			ORDER BY r.recorded_at DESC LIMIT 1`);
		const found = r.rows[0] ? listedRow.parse(r.rows[0]) : null;
		return {
			operation: "documents.readCoreValuesEvidence",
			status: found ? "available" : "not_found",
			rows: found ? [documentRow(found)] : [],
			total: found ? 1 : 0,
			page: 1,
			next: null,
			completeness: "complete",
			exclusions: found ? ["document text (read it with documents.read)"] : [],
		};
	},
};

const templatesInput = z.strictObject({
	title: z.string().trim().min(1).max(200).optional().describe("Words from the template's title, like policy"),
});
export const templatesList: ReadAdapter<z.infer<typeof templatesInput>> = {
	operation: "documents.templates.list",
	description:
		"List the built-in templates a new Church Document can be made from: each id, title, version, what it is for and whether it is a formal or legal template. A template is starting text the church edits; it is not legal advice. A policy or legal document always comes from a template, never from text Evry writes.",
	input: templatesInput,
	allowed: inPlant,
	async invoke(tx: Transaction, actor: EvryActor, input): Promise<SourceResult> {
		const r = await tx.execute(sql`SELECT ${live(actor)} AS ok`);
		const open = (r.rows[0] as { ok?: unknown } | undefined)?.ok === true;
		const words = input.title?.toLowerCase().split(/\s+/) ?? [];
		const rows = open
			? docTemplateSummaries().filter((t) =>
					words.every((w) => `${t.title} ${t.description ?? ""}`.toLowerCase().includes(w)),
				)
			: [];
		return {
			operation: "documents.templates.list",
			status: rows.length ? "available" : "not_found",
			rows: rows.map((t) => ({
				kind: "template",
				id: t.id,
				label: t.title,
				fields: {
					version: String(t.version),
					about: t.description,
					class: t.documentClass,
					notice: t.documentClass === "formal/legal" ? LEGAL_NOTICE : null,
				},
			})),
			total: rows.length,
			page: 1,
			next: null,
			completeness: "complete",
			exclusions: ["the church's own saved templates"],
		};
	},
};

/** The installed Documents read tools, in catalog order. */
export const DOCUMENTS_READS = [listOwned, read, coreValues, templatesList] as const;
