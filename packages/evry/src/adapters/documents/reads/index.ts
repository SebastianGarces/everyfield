import type { Transaction } from "@everyfield/db/client";
import { privateStorage } from "@everyfield/db/schema";
import { sql } from "@everyfield/db/query";
import { liveRead, type WriteTx } from "@everyfield/domain/access";
import { docTemplateSummaries } from "@everyfield/domain/documents/fill";
import {
	docDocument,
	LEGAL_NOTICE,
	nativeText,
	readNative,
	type contextResult,
	type generatedDocument,
	type templateView,
} from "@everyfield/contracts/documents";
import { z } from "zod";
import type { EvryActor } from "../../../context/actor.ts";
import type { ReadAdapter, SourceResult, SourceRow } from "../../../catalog/types.ts";
import { FIELD_SOURCE, FILE_FORMAT, fillInput, fillRefusal, fillRequest, type FillInput } from "../fill.ts";
import { accountContext, rowId } from "../../native.ts";
import { documentText } from "./text.ts";

const inPlant = (actor: EvryActor) => actor.owner.kind === "plant" && actor.role !== null;
const reader = (actor: EvryActor) => inPlant(actor) || accountContext(actor);
const ownFacts = (actor: EvryActor) => (accountContext(actor) ? { facts: { own: true } } : {});
const live = (actor: EvryActor) =>
	liveRead({ session: actor.session, owner: actor.owner, seatId: actor.seatId ?? undefined });

const documentLink = (store: "written" | "church", id: string) =>
	store === "church" ? `/documents/church/${id}` : `/documents/written/${id}`;
const LISTS = { written: "/documents", church: "/documents/church" } as const;

const TEXT_CHARS = 6_000;
const LIST_LIMIT = 50;

const listed = (actor: EvryActor) => sql`
	SELECT d.id, d.title, d.kind, d.template_id, d.template_version, r.recorded_at,
		CASE WHEN d.kind='church_document' THEN 'church' ELSE 'written' END AS store
	FROM document d JOIN document_revision r ON r.id=d.current_revision_id AND r.tenant_id=d.tenant_id
	WHERE d.tenant_id=${actor.owner.id}::uuid AND d.archived_at IS NULL
		AND (d.kind IN ('native','core_values') OR (d.kind='church_document' AND d.church_archived_at IS NULL))`;

const listedRow = z.strictObject({
	id: z.uuid(),
	title: z.string(),
	kind: z.enum(["native", "core_values", "church_document"]),
	template_id: z.string().nullable(),
	template_version: z.number().int().nullable(),
	recorded_at: z.coerce.date(),
	store: z.enum(["written", "church"]),
});
const listedPage = listedRow.extend({ total: z.coerce.number() });
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

const listTitle = z.string().trim().min(1).max(200).optional().describe("Words from the document's title");
const listInput = z.strictObject({
	title: listTitle,
	store: z.enum(["written", "church"]).optional().describe("written: Documents; church: Church Documents"),
});
export const listOwned: ReadAdapter<z.infer<typeof listInput>> = {
	operation: "documents.listOwned",
	description:
		"List the documents this church saved in Everyfield, as Documents and Church Documents show them: each title, its type (written document, core values or Church Document), its template, when it last changed and its link in the app. It reads titles only; read a document with documents.read before saying what it says. These are the church's own documents, not the Everyfield Wiki. Evry sees only documents saved in Everyfield, never files on a computer, phone, drive, email or the web: when asked about such files, say Evry can only see documents in Everyfield and offer these. Any seat may read documents; only an Owner or Admin can make, export, archive or mark one, so tell anyone else that an Owner or Admin has to do it.",
	account: {
		description:
			"List the user's own documents in Everyfield, as their Documents page shows them: each title, its type, when it last changed and its link in the app. It reads titles only; read a document with documents.read before saying what it says. These are the user's own private documents, not the Everyfield Wiki. Evry sees only documents saved in Everyfield, never files on a computer, phone, drive, email or the web: when asked about such files, say Evry can only see documents in Everyfield and offer these.",
		input: z.strictObject({ title: listTitle }),
	},
	input: listInput,
	allowed: reader,
	async invoke(tx: Transaction, actor: EvryActor, input): Promise<SourceResult> {
		const words = (input.title?.split(/\s+/).filter(Boolean) ?? []).map((w) => `%${w.replace(/[\\%_]/g, "\\$&")}%`);
		const r = await tx.execute(sql`
			SELECT x.*, count(*) OVER () AS total FROM (${listed(actor)}) x
			WHERE ${live(actor)} AND NOT EXISTS(SELECT FROM unnest(${sql.param(words)}::text[]) w WHERE x.title NOT ILIKE w ESCAPE '\\')
				AND (${input.store ?? null}::text IS NULL OR x.store=${input.store ?? null})
			ORDER BY x.recorded_at DESC, x.id LIMIT ${LIST_LIMIT}`);
		const rows = r.rows.map((raw) => listedPage.parse(raw));
		const total = rows[0]?.total ?? 0;
		return {
			operation: "documents.listOwned",
			status: rows.length ? "available" : "not_found",
			rows: rows.map((row) => documentRow(row)),
			total,
			page: 1,
			next: null,
			completeness: total > rows.length ? "partial" : "complete",
			exclusions: [
				"document text (ask me to open one to read it)",
				"archived and deleted documents",
				"files outside Everyfield",
			],
			...ownFacts(actor),
		};
	},
};

const readInput = z.strictObject({ documentId: z.uuid().describe("A document id from documents.listOwned") });
const readRow = listedRow.extend({ body: z.string(), archived: z.boolean() });
export const read: ReadAdapter<z.infer<typeof readInput>> = {
	operation: "documents.read",
	description: `Read one of this church's documents: its title, type, link and its actual text in reading order (at most ${TEXT_CHARS.toLocaleString("en-US")} characters). When you say what a document says, quote its words in quotation marks; never describe a document from its title.`,
	account: {
		description: `Read one of the user's own documents: its title, type, link and its actual text in reading order (at most ${TEXT_CHARS.toLocaleString("en-US")} characters). When you say what a document says, quote its words in quotation marks; never describe a document from its title.`,
	},
	input: readInput,
	allowed: reader,
	async invoke(tx: Transaction, actor: EvryActor, input): Promise<SourceResult> {
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
				...ownFacts(actor),
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
			...ownFacts(actor),
		};
	},
};

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
			exclusions: found ? ["document text (ask me to open it to read it)"] : [],
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

const library = async () => (await import("@everyfield/domain/documents")).documentsReader;
const files = async () => (await import("@everyfield/domain/documents")).documentsWriter;
type Template = z.infer<typeof templateView>;
type Result = Pick<SourceResult, "rows"> & Partial<SourceResult>;
const reply = (operation: string, found: Result): SourceResult => ({
	operation,
	status: found.rows.length ? "available" : "not_found",
	total: found.rows.length,
	page: 1,
	next: null,
	completeness: "complete",
	exclusions: [],
	...found,
});
const templateRow = (t: Template, extra: SourceRow["fields"] = {}): SourceRow => ({
	kind: "template",
	id: t.id,
	label: t.name,
	fields: {
		about: t.description,
		category: t.category,
		phase: t.phase,
		formats: t.formats.map((f) => FILE_FORMAT[f]).join(", "),
		class: t.documentClass,
		notice: t.documentClass === "formal/legal" ? LEGAL_NOTICE : null,
		...extra,
	},
});

const contextualInput = z.strictObject({
	phase: z.int().min(0).max(6).optional().describe("A phase number, 0 to 6"),
	wikiSlug: z.string().trim().min(1).max(200).optional().describe("A Wiki article's slug"),
	category: z.enum(["commitment", "vision_meeting", "administrative", "operational"]).optional(),
	meetingId: rowId.optional().describe("For its agenda template"),
});
export const templatesContextual: ReadAdapter<z.infer<typeof contextualInput>> = {
	operation: "documents.templates.contextual",
	description:
		"List the library templates that fit what the user is doing: the phase, the Wiki article, the category or the meeting they name. These make a finished file (documents.preview, then documents.generate). Not found means none fits: say so and never name a template it did not return.",
	input: contextualInput,
	allowed: inPlant,
	async invoke(tx, actor, input): Promise<SourceResult> {
		actor.authority.observe(tx);
		const found = await (await library())["templates.contextual"](tx, actor.authority, input);
		if (found.status !== "ok") throw fillRefusal(found.error);
		return reply("documents.templates.contextual", { rows: found.value.templates.map((t) => templateRow(t)) });
	},
};

const templateInput = z.strictObject({
	templateId: z.string().trim().min(1).max(80).describe("From documents.templates.contextual"),
});
export const templatesGet: ReadAdapter<z.infer<typeof templateInput>> = {
	operation: "documents.templates.get",
	description:
		"Show one library template: what it is for, its formats, its outline and each field it fills, with which are required and which the church's details fill",
	input: templateInput,
	allowed: inPlant,
	async invoke(tx, actor, input): Promise<SourceResult> {
		actor.authority.observe(tx);
		const found = await (await library())["templates.get"](tx, actor.authority, input);
		if (found.status !== "ok") return reply("documents.templates.get", { rows: [] });
		const t = found.value;
		return reply("documents.templates.get", {
			rows: [
				templateRow(t, { pages: t.pageCount, outline: t.outline.join(" · ") }),
				...t.mergeFields.map((f): SourceRow => ({
					kind: "item",
					id: f.key,
					label: f.label,
					fields: { key: f.key, required: f.required, filledFrom: f.autoFill ? "church details" : "the user" },
				})),
			],
			total: 1,
		});
	},
};

async function fillOf(tx: WriteTx, actor: EvryActor, input: FillInput) {
	actor.authority.observe(tx);
	const read = await library();
	const template = await read["templates.get"](tx, actor.authority, { templateId: input.templateId });
	if (template.status !== "ok") return null;
	return { read, template: template.value, request: fillRequest(input, template.value.formats) };
}
const fieldRows = (fields: readonly z.infer<typeof contextResult>["fields"][number][]): SourceRow[] =>
	fields.map((f) => ({
		kind: "item",
		id: f.key,
		label: f.label,
		fields: { key: f.key, value: f.value, from: FIELD_SOURCE[f.source], required: f.required },
	}));
const missingFacts = (value: Pick<z.infer<typeof contextResult>, "fields" | "missing" | "complete">) => ({
	complete: value.complete,
	missing:
		value.fields
			.filter((f) => value.missing.includes(f.key))
			.map((f) => f.label)
			.join(", ") || null,
});

export const resolveContext: ReadAdapter<FillInput> = {
	operation: "documents.resolveContext",
	description:
		"Fill a library template from the church's details and the user's values without making anything: each field's value and where it came from, and which required fields are missing. Ask the user for a missing value; never make one up.",
	input: fillInput,
	allowed: inPlant,
	async invoke(tx, actor, input): Promise<SourceResult> {
		const fill = await fillOf(tx, actor, input);
		const found = fill && (await fill.read.resolveContext(tx, actor.authority, fill.request));
		if (!fill || !found) return reply("documents.resolveContext", { rows: [] });
		if (found.status !== "ok") throw fillRefusal(found.error);
		return reply("documents.resolveContext", {
			rows: [
				templateRow(fill.template, { format: FILE_FORMAT[fill.request.format] }),
				...fieldRows(found.value.fields),
			],
			total: 1,
			facts: missingFacts(found.value),
		});
	},
};

export const preview: ReadAdapter<FillInput> = {
	operation: "documents.preview",
	description:
		"Show the user a preview of a filled library template before a file is made; the app draws it under this result. Nothing is saved. When rendered is false, say the preview failed, or name the missing fields, and propose nothing.",
	input: fillInput,
	allowed: inPlant,
	async invoke(tx, actor, input): Promise<SourceResult> {
		const fill = await fillOf(tx, actor, input);
		const found = fill && (await fill.read.preview(tx, actor.authority, fill.request, privateStorage()));
		if (!fill || !found) return reply("documents.preview", { rows: [] });
		const { template, request } = fill;
		const shown = (rendered: boolean, rest: SourceRow[], facts: SourceResult["facts"]) =>
			reply("documents.preview", {
				rows: [
					templateRow(template, {
						format: request.format,
						rendered,
						overrides: JSON.stringify(request.overrides),
						meetingId: request.meetingId ?? null,
						pageWidth: template.pageSize?.width ?? null,
						pageHeight: template.pageSize?.height ?? null,
					}),
					...rest,
				],
				total: 1,
				facts: { rendered, ...facts },
			});
		if (found.status !== "ok") {
			if (found.error.code === "render_failed") return shown(false, [], { failure: "The preview could not be made." });
			throw fillRefusal(found.error);
		}
		return shown(found.value.artifact !== null, fieldRows(found.value.fields), missingFacts(found.value));
	},
};

const fileRow = (f: z.infer<typeof generatedDocument>, extra: SourceRow["fields"] = {}): SourceRow => ({
	kind: "file",
	id: f.id,
	label: f.savedTemplateName,
	fields: { format: FILE_FORMAT[f.format], madeAt: f.generatedAt, state: "Ready", ...extra },
});
const HISTORY_LIMIT = 100;
const historyInput = z.strictObject({
	title: z.string().trim().min(1).max(200).optional().describe("Words from the file's title"),
});
export const historyList: ReadAdapter<z.infer<typeof historyInput>> = {
	operation: "documents.history.list",
	description:
		"List the files made before from templates and documents, by Evry or by hand, newest first: each title, format, date and state. Only files that are ready are listed. Documents with text to edit are documents.listOwned.",
	input: historyInput,
	allowed: inPlant,
	async invoke(tx, actor, input): Promise<SourceResult> {
		actor.authority.observe(tx);
		const raw: unknown = {};
		const found = await (await files())["history.list"](tx, actor.authority, raw);
		const all = found.status === "ok" ? found.value.entries : [];
		const words = input.title?.toLowerCase().split(/\s+/) ?? [];
		const rows = all
			.filter((f) => words.every((w) => f.savedTemplateName.toLowerCase().includes(w)))
			.map((f) => fileRow(f));
		const partial = all.length >= HISTORY_LIMIT;
		return reply("documents.history.list", {
			rows,
			total: partial ? null : rows.length,
			completeness: partial ? "partial" : "complete",
		});
	},
};

const fileInput = z.strictObject({ fileId: rowId.describe("From documents.history.list") });
async function readyFile(tx: WriteTx, actor: EvryActor, fileId: string) {
	actor.authority.observe(tx);
	const raw: unknown = { documentId: fileId };
	const found = await (await files())["history.get"](tx, actor.authority, raw);
	return found.status === "ok" ? found.value : null;
}
export const historyGet: ReadAdapter<z.infer<typeof fileInput>> = {
	operation: "documents.history.get",
	description:
		"Show one file made before: its title, format, size, when it was made and, when it came from a Church Document, which version",
	input: fileInput,
	allowed: inPlant,
	async invoke(tx, actor, input): Promise<SourceResult> {
		const file = await readyFile(tx, actor, input.fileId);
		return reply("documents.history.get", {
			rows: file
				? [
						fileRow(file, {
							size: file.byteCount,
							name: file.downloadName,
							fromDocument: file.source ? `Version ${file.source.revision}` : null,
							documentLink: file.source ? documentLink("church", file.source.documentId) : null,
						}),
					]
				: [],
		});
	},
};

export const download: ReadAdapter<z.infer<typeof fileInput>> = {
	operation: "documents.download",
	description:
		"Give a download link for one ready file. The link checks the user's seat each time it is followed. Not found means the file is not ready, was deleted or is not this church's: say so and give no link.",
	input: fileInput,
	allowed: inPlant,
	async invoke(tx, actor, input): Promise<SourceResult> {
		const file = await readyFile(tx, actor, input.fileId);
		return reply("documents.download", {
			rows: file ? [fileRow(file, { href: `/documents/files/${file.id}` })] : [],
		});
	},
};

export const DOCUMENTS_READS = [
	listOwned,
	read,
	coreValues,
	templatesList,
	templatesContextual,
	templatesGet,
	resolveContext,
	preview,
	historyList,
	historyGet,
	download,
] as const;
