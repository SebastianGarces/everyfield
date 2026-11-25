import type { WriteTx } from "@everyfield/domain/access";
import { sql, type SQL } from "@everyfield/db/query";
import { privateStorage } from "@everyfield/db/schema";
import { liveRead, RequestActor } from "@everyfield/domain/access";
import { docTemplateSummaries, templateFill, type TemplateFill } from "@everyfield/domain/documents/fill";
import {
	docDocument,
	LEGAL_NOTICE,
	nativeBody,
	nativeText,
	readNative,
	TEMPLATE_NAME_MAX,
	type DocumentsReply,
} from "@everyfield/contracts/documents";
import { createHash } from "node:crypto";
import { parseImport } from "@everyfield/domain/documents/import";
import type { PeopleContext } from "@everyfield/contracts/people";
import { z } from "zod";
import type { EvryActor } from "../../../context/actor.ts";
import { EvryRefusal } from "../../../context/errors.ts";
import { attachedFile, extensionOf, stagedBytes } from "../../../attachments/store.ts";
import type { EffectResult, ReviewedWrite } from "../../../proposals/types.ts";
import { accountContext, plantSeat, rowId } from "../../native.ts";
import { applyEdits, draftBody, fieldText, plainField, shownText, type Passage } from "../draft.ts";
import { FIELD_SOURCE, FILE_FORMAT, fillInput, fillRefusal, fillRequest, type FillInput } from "../fill.ts";

const ownerOrAdmin = (actor: EvryActor) =>
	actor.owner.kind === "plant" && (actor.role === "owner" || actor.role === "admin");

const privateReview = (actor: EvryActor) => (accountContext(actor) ? sql`||'{"private":true}'::jsonb` : sql``);
const ownDocuments = (actor: EvryActor) => ownerOrAdmin(actor) || accountContext(actor);

const target = sql`jsonb_build_object('kind','document','id',d.id,'label',d.title)`;
const change = (field: string, before: SQL | null, after: SQL) =>
	sql`jsonb_build_object('field',${field}::text,'before',${before ?? sql`NULL::jsonb`},'after',${after})`;
const text = (value: string | number) => sql`to_jsonb(${String(value)}::text)`;
const documentId = z.uuid().describe("A document id from documents.listOwned");

async function authorityIn(tx: WriteTx, context: PeopleContext) {
	const claimed = await RequestActor.claimWrite(tx, context.session, context.selected);
	return claimed?.authority ?? null;
}
const writer = async () => (await import("@everyfield/domain/documents")).documentsWriter;
const done = <T>(reply: DocumentsReply<T>, receipt: (value: T) => { id: string; revision: string }): EffectResult => {
	if (reply.status !== "ok") return { refused: reply.error.code };
	const r = receipt(reply.value);
	return { receiptId: r.id, revision: r.revision };
};

const TEMPLATE_IDS = docTemplateSummaries().map((t) => t.id) as [string, ...string[]];
const createInput = z.strictObject({
	templateId: z.enum(TEMPLATE_IDS).describe("A template id from documents.templates.list"),
});
type Fill = TemplateFill["fields"][number];
const fillArgs = z.strictObject({
	input: z.strictObject({ templateId: z.string() }),
	fill: z.array(z.strictObject({ key: z.string(), value: z.string().nullable() })),
});
const SOURCE: Record<string, string> = {
	"church.name": "church name",
	"church.pastor": "senior pastor",
	"brand.legalName": "brand kit",
	"brand.tagline": "brand kit",
	"brand.contactLine": "brand kit",
	fallback: "church name",
};

export const createFromTemplate: ReviewedWrite<z.infer<typeof createInput>> = {
	operation: "documents.createFromTemplate",
	description:
		"Propose making a new Church Document from one built-in template, with this church's details filled in. The review names the template, its version and each detail it fills; the church then edits the document in Church Documents. When someone asks Evry to draft, write or make a policy or document that a built-in template covers (a finance policy is the Financial Controls Policy), propose this at once with that template instead of writing the text or asking first: the review card is the offer. Say the template is not legal advice. Nothing changes until the user approves the exact review.",
	input: createInput,
	allowed: ownerOrAdmin,
	async review(actor, value, context) {
		const reply = await templateFill(context.db, actor.authority, value);
		if (reply.status !== "ok") return null;
		const t = reply.value;
		const filled = t.fields.map((f: Fill) => ({
			field: f.label,
			before: null,
			after: f.value === null ? null : `${f.value} (from ${SOURCE[f.source] ?? f.source.replace(/^\w+\./, "")})`,
		}));
		const changes = [
			{ field: "template", before: null, after: t.title },
			{ field: "templateVersion", before: null, after: `Version ${t.version}` },
			...filled,
			...(t.documentClass === "formal/legal" ? [{ field: "notice", before: null, after: LEGAL_NOTICE }] : []),
		];
		const args = {
			input: { templateId: t.templateId },
			fill: t.fields.map((f: Fill) => ({ key: f.key, value: f.value })),
		};
		return sql`SELECT jsonb_build_object('target',jsonb_build_object('kind','template','id',${t.templateId}::text,'label',${t.title}::text),
				'changes',${JSON.stringify(changes)}::jsonb) AS review, ${JSON.stringify(args)}::jsonb AS args`;
	},
	async recheck(tx, context, args) {
		const saved = fillArgs.parse(args);
		const authority = await authorityIn(tx, context);
		if (!authority) return "access_denied";
		const now = await templateFill(tx, authority, saved.input);
		if (now.status !== "ok") return now.error.code;
		const same =
			JSON.stringify(now.value.fields.map((f: Fill) => ({ key: f.key, value: f.value }))) ===
			JSON.stringify(saved.fill);
		return same ? null : "revision_conflict";
	},
	async execute(tx, context, args, effectKey) {
		const saved = fillArgs.parse(args);
		const authority = await authorityIn(tx, context);
		if (!authority) return { refused: "access_denied" };
		const reply = await (
			await writer()
		).createFromTemplate(tx, authority, {
			templateId: saved.input.templateId,
			requestKey: effectKey,
		});
		return done(reply, (doc) => ({ id: doc.id, revision: doc.revision }));
	},
};

const FORMAT_LABEL = { pdf: "PDF", docx: "Word" } as const;
const exportInput = z.strictObject({
	documentId,
	format: z.enum(["pdf", "docx"]).describe("pdf or docx (Word)"),
});
const exportArgs = z.strictObject({
	input: z.strictObject({ documentId: z.uuid(), revision: z.int(), format: z.enum(["pdf", "docx"]) }),
});
export const exportNative: ReviewedWrite<z.infer<typeof exportInput>> = {
	operation: "documents.exportNative",
	description:
		"Propose saving a PDF or Word file of one Church Document's current version. The file is saved with the document in Church Documents, where it downloads. Nothing changes until the user approves the exact review.",
	input: exportInput,
	allowed: ownerOrAdmin,
	review(actor, value) {
		return sql`SELECT jsonb_build_object('target',${target},'changes',jsonb_build_array(
				${change("format", null, text(FORMAT_LABEL[value.format]))},${change("version", null, sql`to_jsonb('Version '||r.version_number)`)})) AS review,
			jsonb_build_object('input',jsonb_build_object('documentId',d.id,'revision',r.version_number,'format',${value.format}::text)) AS args
			FROM document d JOIN document_revision r ON r.id=d.current_revision_id AND r.tenant_id=d.tenant_id
			WHERE d.id=${value.documentId}::uuid AND d.tenant_id=${actor.owner.id}::uuid AND d.kind='church_document'
				AND d.archived_at IS NULL AND d.church_archived_at IS NULL AND (r.body::jsonb->'exports') ? ${value.format}::text`;
	},
	async execute(tx, context, args, effectKey) {
		const saved = exportArgs.parse(args);
		const authority = await authorityIn(tx, context);
		if (!authority) return { refused: "access_denied" };
		const reply = await (
			await writer()
		).exportNative(tx, authority, { ...saved.input, requestKey: effectKey }, privateStorage());
		return done(reply, (file) => ({ id: file.id, revision: file.revision }));
	},
};

const archiveArgs = z.strictObject({
	store: z.enum(["written", "church"]),
	input: z.strictObject({ documentId: z.uuid(), expectedRevision: z.string() }),
});
export const archive: ReviewedWrite<{ documentId: string }> = {
	operation: "documents.archive",
	description:
		"Propose archiving one of this church's documents, a written document or a Church Document. It leaves its list and stays readable. Nothing changes until the user approves the exact review.",
	account: {
		description:
			"Propose archiving one of the user's own documents. It leaves their list and stays readable. Nothing changes until the user approves the exact review.",
	},
	input: z.strictObject({ documentId }),
	allowed: ownDocuments,
	review(actor, value) {
		return sql`SELECT jsonb_build_object('target',${target},'changes',jsonb_build_array(
				${change("status", text("Live"), text("Archived"))},
				${change("list", null, sql`to_jsonb(CASE WHEN d.kind='church_document' THEN 'Church Documents' ELSE 'Documents' END)`)}))${privateReview(actor)} AS review,
			jsonb_build_object('store',CASE WHEN d.kind='church_document' THEN 'church' ELSE 'written' END,
				'input',jsonb_build_object('documentId',d.id,'expectedRevision',d.revision::text)) AS args
			FROM document d WHERE d.id=${value.documentId}::uuid AND d.tenant_id=${actor.owner.id}::uuid AND d.archived_at IS NULL
				AND (d.kind IN ('native','core_values') OR (d.kind='church_document' AND d.church_archived_at IS NULL))`;
	},
	async execute(tx, context, args) {
		const saved = archiveArgs.parse(args);
		const authority = await authorityIn(tx, context);
		if (!authority) return { refused: "access_denied" };
		if (saved.store === "church") {
			const reply = await (await writer()).archiveChurch(tx, authority, saved.input);
			return done(reply, (doc) => ({ id: doc.documentId, revision: saved.input.expectedRevision }));
		}
		const reply = await (await writer()).archive(tx, authority, saved.input);
		return done(reply, (doc) => ({ id: doc.id, revision: doc.revision }));
	},
};

const designateRow = z.strictObject({
	id: z.uuid(),
	kind: z.enum(["native", "core_values"]),
	revision: z.string(),
	body: z.string(),
});
const designateArgs = z.strictObject({ input: z.strictObject({ documentId: z.uuid(), expectedRevision: z.string() }) });
export const designateCoreValues: ReviewedWrite<{ documentId: string }> = {
	operation: "documents.designateCoreValues",
	description:
		"Propose marking one written document with text as this church's core values document. Evry marks the church's own document; it never writes core values. Nothing changes until the user approves the exact review.",
	input: z.strictObject({ documentId }),
	allowed: ownerOrAdmin,
	async review(actor, value, context) {
		const found = await context.db.execute(sql`SELECT d.id, d.kind, d.revision::text AS revision, r.body
			FROM document d JOIN document_revision r ON r.id=d.current_revision_id AND r.tenant_id=d.tenant_id
			WHERE d.id=${value.documentId}::uuid AND d.tenant_id=${actor.owner.id}::uuid AND d.archived_at IS NULL
				AND d.kind IN ('native','core_values') AND (r.import_state IS NULL OR r.import_state='ready')
				AND ${liveRead({ session: actor.session, owner: actor.owner, seatId: actor.seatId ?? undefined })}`);
		const doc = found.rows[0] ? designateRow.parse(found.rows[0]) : null;
		if (!doc) return null;
		const refusal =
			doc.kind === "core_values"
				? "This document is already marked as your core values."
				: !nativeText(readNative(doc.body).body)
					? "This document has no text yet, so it can't be marked as your core values."
					: null;
		return sql`SELECT jsonb_build_object('target',${target},'changes',jsonb_build_array(
				${change("documentType", text(doc.kind === "core_values" ? "Core values" : "Written document"), text("Core values"))}))
				|| CASE WHEN ${refusal}::text IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('refusal',${refusal}::text) END AS review,
			jsonb_build_object('input',jsonb_build_object('documentId',d.id,'expectedRevision',d.revision::text)) AS args
			FROM document d WHERE d.id=${doc.id}::uuid AND d.tenant_id=${actor.owner.id}::uuid AND d.revision=${doc.revision}::bigint
				AND d.archived_at IS NULL`;
	},
	async execute(tx, context, args) {
		const saved = designateArgs.parse(args);
		const authority = await authorityIn(tx, context);
		if (!authority) return { refused: "access_denied" };
		const reply = await (await writer()).designateCoreValues(tx, authority, saved.input);
		return done(reply, (doc) => ({ id: doc.id, revision: doc.revision }));
	},
};

const parseJson = (stored: string): unknown => {
	try {
		return JSON.parse(stored);
	} catch {
		return null;
	}
};

const EXCERPT = 280;
const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const importInput = z.strictObject({
	attachmentId: z
		.uuid()
		.describe("The attachmentId of a Word (.docx) or text (.txt) file attached in this conversation"),
	title: z
		.string()
		.trim()
		.min(1)
		.max(TEMPLATE_NAME_MAX)
		.optional()
		.describe("The new document's title, only when the user names one; otherwise the file's name is used"),
});
const importArgs = z.strictObject({
	input: z.strictObject({
		conversationId: z.uuid(),
		attachmentId: z.uuid(),
		title: z.string(),
		format: z.enum(["text", "docx"]),
		sha256: z.string(),
	}),
});
export const importTextOrWord: ReviewedWrite<z.infer<typeof importInput>> = {
	operation: "documents.importTextOrWord",
	description:
		"Propose making a new written document in Documents from a Word (.docx) or text (.txt) file attached in this conversation, the same import as the Documents page. The review names the file and the title and shows the start of the imported text. When the app refuses the file, the result carries its problem: tell the user that sentence as written, and prepare nothing else. Nothing changes until the user approves the exact review.",
	account: {
		description:
			"Propose making a new private document of the user's own from a Word (.docx) or text (.txt) file attached in this conversation, the same import as their Documents page. The review names the file and the title and shows the start of the imported text. When the app refuses the file, the result carries its problem: tell the user that sentence as written, and prepare nothing else. Nothing changes until the user approves the exact review.",
	},
	input: importInput,
	allowed: ownDocuments,
	async review(actor, value, context) {
		if (!context.files) throw new EvryRefusal("attachment_elsewhere");
		const file = await attachedFile(context.db, actor, context.conversationId, value.attachmentId);
		const format = ["docx", "doc"].includes(extensionOf(file.name)) ? "docx" : "text";
		const bytes = await context.files.read(file.id);
		const read = parseImport(bytes, format);
		if ("problem" in read) throw new EvryRefusal("invalid_input", read.problem);
		const words = nativeText(read.body)
			.split("\n")
			.map((line) => line.replace(/\s+/g, " ").trim())
			.filter(Boolean)
			.join(" · ");
		const excerpt = words.length > EXCERPT ? `${words.slice(0, EXCERPT).trimEnd()}…` : words;
		const title = value.title ?? (file.name.replace(/\.[^.]+$/, "").trim() || file.name);
		const changes = [
			{ field: "file", before: null, after: file.name },
			{ field: "title", before: null, after: title },
			{ field: "text", before: null, after: excerpt },
		];
		const args = {
			input: { conversationId: context.conversationId, attachmentId: file.id, title, format, sha256: sha256(bytes) },
		};
		return sql`SELECT jsonb_build_object('target',NULL,'changes',${JSON.stringify(changes)}::jsonb)${privateReview(actor)} AS review,
			${JSON.stringify(args)}::jsonb AS args`;
	},
	async execute(tx, context, args, effectKey) {
		const saved = importArgs.parse(args).input;
		const authority = await authorityIn(tx, context);
		if (!authority) return { refused: "access_denied" };
		const storage = privateStorage();
		const bytes = await stagedBytes(tx, storage, context.selected.id, saved.conversationId, saved.attachmentId);
		if (!bytes) return { refused: "attachment_gone" };
		if (sha256(bytes) !== saved.sha256) return { refused: "file_changed" };
		const reply = await (
			await writer()
		).importTextOrWord(
			tx,
			authority,
			{ title: saved.title, format: saved.format, bytes, expectedRevision: "0", requestKey: effectKey },
			storage,
		);
		return done(reply, (doc) => ({ id: doc.id, revision: doc.revision }));
	},
};

const DRAFT_CHARS = 20_000;
const title = z.string().trim().min(1).max(TEMPLATE_NAME_MAX);
const saveInput = z.discriminatedUnion("kind", [
	z.strictObject({
		kind: z.literal("new"),
		title,
		text: z
			.string()
			.trim()
			.min(1)
			.max(DRAFT_CHARS)
			.describe("The whole text. A line starting with # is a heading, with - a bullet, with 1. a numbered item"),
	}),
	z.strictObject({
		kind: z.literal("edit"),
		documentId: rowId,
		title: title.optional().describe("A new title, only when the user asked for one"),
		edits: z
			.array(
				z.strictObject({
					find: z
						.string()
						.min(1)
						.max(4_000)
						.describe("Exact words from documents.read, within one paragraph, that appear once"),
					replace: z
						.string()
						.max(8_000)
						.describe("What those words become. A new line starts a new paragraph; empty removes them"),
				}),
			)
			.max(20),
	}),
]);
const saveArgs = z.strictObject({
	input: z.union([
		z.strictObject({
			title: z.string(),
			body: z.string(),
			documentId: z.uuid().optional(),
			expectedRevision: z.string(),
		}),
		z.strictObject({ body: z.string(), documentId: z.uuid(), expectedRevision: z.string() }),
	]),
});
const editRow = z.strictObject({
	id: z.uuid(),
	kind: z.enum(["native", "core_values", "church_document"]),
	title: z.string(),
	revision: z.string(),
	body: z.string(),
});
const passageRows = (passages: readonly Passage[]) => passages.map((p) => ({ field: "text", ...p }));

function reviewed(actor: EvryActor, target: SQL, changes: unknown, args: unknown, lines: readonly string[]) {
	return sql`SELECT jsonb_build_object('target',${target},'changes',${JSON.stringify(changes)}::jsonb,
		'notes',${JSON.stringify(lines)}::jsonb)${privateReview(actor)} AS review, ${JSON.stringify(args)}::jsonb AS args`;
}

export const saveNative: ReviewedWrite<z.infer<typeof saveInput>> = {
	operation: "documents.saveNative",
	description:
		"Propose saving a document's text. kind new: a document you drafted at the user's request, such as a welcome letter, put whole in text; it saves as a written document the church can edit. kind edit: change a written document or Church Document the church has, found with documents.listOwned and read with documents.read first; give only the words that change and leave the rest alone. A policy or legal document always starts from a template (documents.createFromTemplate), never from text you write. Never write core values: change a core values document only with the user's own words. When the result carries a problem, tell the user or fix the quoted words. Nothing changes until the user approves the exact review.",
	account: {
		description:
			"Propose saving the text of one of the user's own documents. kind new: a document you drafted at the user's request, put whole in text; it saves as a private document only they can open. kind edit: change a document they have, found with documents.listOwned and read with documents.read first; give only the words that change and leave the rest alone. Never write a policy, a legal document or core values yourself: save only the user's own words for those. When the result carries a problem, tell the user or fix the quoted words. Nothing changes until the user approves the exact review.",
	},
	input: saveInput,
	allowed: ownDocuments,
	async review(actor, value, context) {
		if (value.kind === "new") {
			const body = nativeBody.safeParse(draftBody(value.text));
			if (!body.success || !nativeText(body.data))
				throw new EvryRefusal(
					"invalid_input",
					"This text can't be saved as a document. Use plain paragraphs, headings and lists.",
				);
			return reviewed(
				actor,
				sql`NULL`,
				[
					{ field: "title", before: null, after: value.title },
					{ field: "text", before: null, after: shownText(body.data) },
				],
				{ input: { title: value.title, body: JSON.stringify(body.data), expectedRevision: "0" } },
				[],
			);
		}
		const found = await context.db.execute(sql`SELECT d.id, d.kind, d.title, d.revision::text AS revision, r.body
			FROM document d JOIN document_revision r ON r.id=d.current_revision_id AND r.tenant_id=d.tenant_id
			WHERE d.id=${value.documentId}::uuid AND d.tenant_id=${actor.owner.id}::uuid AND d.archived_at IS NULL
				AND (d.kind IN ('native','core_values') OR (d.kind='church_document' AND d.church_archived_at IS NULL))
				AND (r.import_state IS NULL OR r.import_state='ready')
				AND ${liveRead({ session: actor.session, owner: actor.owner, seatId: actor.seatId ?? undefined })}`);
		const doc = found.rows[0] ? editRow.parse(found.rows[0]) : null;
		if (!doc) return null;
		const retitled = value.title !== undefined && value.title !== doc.title ? value.title : null;
		if (!value.edits.length && retitled === null) throw new EvryRefusal("invalid_input", "This edit changes nothing.");
		const changes = (passages: readonly Passage[]) => [
			...(retitled === null ? [] : [{ field: "title", before: doc.title, after: retitled }]),
			...passageRows(passages),
		];
		const lines = ["Everything else in the document stays as it is."];
		const href = `/documents/${doc.kind === "church_document" ? "church" : "written"}/${doc.id}`;
		const at = sql`jsonb_build_object('kind','document','id',${doc.id}::text,'label',${doc.title}::text,'href',${href}::text)`;
		if (doc.kind === "church_document") {
			const stored = docDocument.safeParse(parseJson(doc.body));
			if (!stored.success) return null;
			const edited = applyEdits(stored.data.body, value.edits, fieldText(stored.data));
			const next = docDocument.safeParse({
				...stored.data,
				body: edited.body,
				...(retitled !== null && { title: retitled }),
			});
			if (!next.success) throw new EvryRefusal("invalid_input", "That change doesn't fit this document's layout.");
			const input = { body: JSON.stringify(next.data), documentId: doc.id, expectedRevision: doc.revision };
			return reviewed(actor, at, changes(edited.passages), { input }, lines);
		}
		const edited = applyEdits(readNative(doc.body).body, value.edits, plainField);
		const next = nativeBody.safeParse(edited.body);
		if (!next.success || !nativeText(next.data))
			throw new EvryRefusal("invalid_input", "That change would leave the document without text.");
		const input = {
			title: retitled ?? doc.title,
			body: JSON.stringify(next.data),
			documentId: doc.id,
			expectedRevision: doc.revision,
		};
		return reviewed(actor, at, changes(edited.passages), { input }, lines);
	},
	async execute(tx, context, args) {
		const saved = saveArgs.parse(args).input;
		const authority = await authorityIn(tx, context);
		if (!authority) return { refused: "access_denied" };
		const raw: unknown = { ...saved, body: parseJson(saved.body) };
		const reply = await (await writer()).saveNative(tx, authority, raw);
		return done(reply, (doc) => ({ id: doc.id, revision: doc.revision }));
	},
};

const generateArgs = z.strictObject({
	input: z.strictObject({
		templateId: z.string(),
		format: z.enum(["pdf", "docx", "xlsx"]),
		overrides: z.record(z.string(), z.string()),
		meetingId: z.uuid().optional(),
	}),
	templateVersion: z.string(),
	fields: z.array(z.strictObject({ key: z.string(), value: z.string().nullable() })),
});
const reader = async () => (await import("@everyfield/domain/documents")).documentsReader;
const reviewedValues = (fields: readonly { key: string; value: string | null }[]) =>
	fields.map((f) => ({ key: f.key, value: f.value }));

export const generate: ReviewedWrite<FillInput> = {
	operation: "documents.generate",
	description:
		"Propose making a file from a library template, filled in with exactly the values just shown by documents.preview: preview first, then propose with the same template, format and values. The saved file is listed by documents.history.list. Missing required fields are asked for, never made up. Nothing is made until the user approves the exact review.",
	input: fillInput,
	allowed: plantSeat,
	async review(actor, value, context) {
		const read = await reader();
		const template = await read["templates.get"](context.db, actor.authority, { templateId: value.templateId });
		if (template.status !== "ok") return null;
		const input = fillRequest(value, template.value.formats);
		const reply = await read.resolveContext(context.db, actor.authority, input);
		if (reply.status !== "ok") throw fillRefusal(reply.error);
		const { fields, missing, templateVersion } = reply.value;
		const changes = [
			{ field: "template", before: null, after: template.value.name },
			{ field: "format", before: null, after: FILE_FORMAT[input.format] },
			...fields.map((f) => ({
				field: f.label,
				before: null,
				after: f.value === null ? null : `${f.value} (${FIELD_SOURCE[f.source]})`,
			})),
		];
		const needed = fields.filter((f) => missing.includes(f.key)).map((f) => f.label);
		const refusal = needed.length ? `Still needed before a file can be made: ${needed.join(", ")}.` : null;
		const args = { input, templateVersion, fields: reviewedValues(fields) };
		return sql`SELECT jsonb_build_object('target',jsonb_build_object('kind','template','id',${value.templateId}::text,'label',${template.value.name}::text),
				'changes',${JSON.stringify(changes)}::jsonb)
				||CASE WHEN ${refusal}::text IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('refusal',${refusal}::text) END AS review,
			${JSON.stringify(args)}::jsonb AS args`;
	},
	async recheck(tx, context, args) {
		const saved = generateArgs.parse(args);
		const authority = await authorityIn(tx, context);
		if (!authority) return "access_denied";
		const now = await (await reader()).resolveContext(tx, authority, saved.input);
		if (now.status !== "ok") return now.error.code;
		const same =
			now.value.templateVersion === saved.templateVersion &&
			JSON.stringify(reviewedValues(now.value.fields)) === JSON.stringify(saved.fields);
		return same ? null : "revision_conflict";
	},
	async execute(tx, context, args, effectKey) {
		const saved = generateArgs.parse(args);
		const authority = await authorityIn(tx, context);
		if (!authority) return { refused: "access_denied" };
		const reply = await (
			await writer()
		).generate(tx, authority, { ...saved.input, requestKey: effectKey }, privateStorage());
		return done(reply, (file) => ({ id: file.id, revision: file.revision }));
	},
};

export const DOCUMENTS_COMMANDS = {
	"documents.saveNative": saveNative,
	"documents.generate": generate,
	"documents.createFromTemplate": createFromTemplate,
	"documents.exportNative": exportNative,
	"documents.archive": archive,
	"documents.designateCoreValues": designateCoreValues,
	"documents.importTextOrWord": importTextOrWord,
} as const;
