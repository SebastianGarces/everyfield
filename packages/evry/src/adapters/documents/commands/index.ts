import type { Database, Transaction } from "@everyfield/db/client";
import { sql, type SQL } from "@everyfield/db/query";
import { privateStorage } from "@everyfield/db/schema";
import { liveRead, RequestActor } from "@everyfield/domain/access";
import { docTemplateSummaries, templateFill, type TemplateFill } from "@everyfield/domain/documents/fill";
import { LEGAL_NOTICE, nativeText, readNative, type DocumentsReply } from "@everyfield/contracts/documents";
import type { PeopleContext } from "@everyfield/contracts/people";
import { z } from "zod";
import type { EvryActor } from "../../../context/actor.ts";
import type { EffectResult, ReviewedWrite } from "../../../proposals/types.ts";

// The Documents reviewed writes (WP-080). Each review reads the document live in the actor's church and saves the
// native command's exact arguments, including the revision the review showed. On approval the executor runs the same
// native Documents command the app runs, for the approving session, inside its transaction, with the effect key as the
// request key, so the change and its audit row commit with the saved outcome; anything that changed since the review
// refuses. Each tool works on the store the app uses for that action: a new document from a template and its export
// are Church Documents; marking core values is a written document; archive is either, as each list archives it.
// Only an Owner or Admin may change a document, as in the app.

const ownerOrAdmin = (actor: EvryActor) =>
	actor.owner.kind === "plant" && (actor.role === "owner" || actor.role === "admin");

const target = sql`jsonb_build_object('kind','document','id',d.id,'label',d.title)`;
const change = (field: string, before: SQL | null, after: SQL) =>
	sql`jsonb_build_object('field',${field}::text,'before',${before ?? sql`NULL::jsonb`},'after',${after})`;
const text = (value: string | number) => sql`to_jsonb(${String(value)}::text)`;
const documentId = z.uuid().describe("A document id from documents.listOwned");

/**
 * The approving session's authority inside the executor's transaction. The executor has already locked and checked it
 * (claimWrite); this takes the same locks again and returns the actor the native Documents commands take.
 */
async function authorityIn(tx: Transaction, context: PeopleContext) {
	const claimed = await RequestActor.claimWrite(tx, context.session, context.selected);
	return claimed?.authority ?? null;
}
/**
 * The native Documents commands take the request's database; inside the effect they run on the executor's
 * transaction, so their statements commit or roll back with the saved outcome.
 */
const asDatabase = (tx: Transaction) => tx as unknown as Database;
/**
 * The native Documents commands, loaded when an approved effect runs. Their module brings the document renderer, which
 * a review or a read never needs.
 */
const writer = async () => (await import("@everyfield/domain/documents")).documentsWriter;
const done = <T>(reply: DocumentsReply<T>, receipt: (value: T) => { id: string; revision: string }): EffectResult => {
	if (reply.status !== "ok") return { refused: reply.error.code };
	const r = receipt(reply.value);
	return { receiptId: r.id, revision: r.revision };
};

// --- documents.createFromTemplate ---------------------------------------------------------------------------------

const TEMPLATE_IDS = docTemplateSummaries().map((t) => t.id) as [string, ...string[]];
const createInput = z.strictObject({
	templateId: z.enum(TEMPLATE_IDS).describe("A template id from documents.templates.list"),
});
type Fill = TemplateFill["fields"][number];
const fillArgs = z.object({
	input: z.object({ templateId: z.string() }),
	fill: z.array(z.object({ key: z.string(), value: z.string().nullable() })),
});
/** Where a filled-in value comes from, in the words the review card shows. */
const SOURCE: Record<string, string> = {
	"church.name": "church name",
	"church.pastor": "senior pastor",
	"brand.legalName": "brand kit",
	"brand.tagline": "brand kit",
	"brand.contactLine": "brand kit",
	fallback: "church name",
};

const createFromTemplate: ReviewedWrite<z.infer<typeof createInput>> = {
	operation: "documents.createFromTemplate",
	description:
		"Propose making a new Church Document from one built-in template, with this church's details filled in. The review names the template, its version and each detail it fills; the church then edits the document in Church Documents. A template is not legal advice, and Evry never writes the policy itself. Nothing changes until the user approves the exact review.",
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
	// The church's details the review showed are the ones the document freezes: a church name or brand kit that changed
	// since asks for a new review instead of filling in values nobody saw.
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
		).createFromTemplate(asDatabase(tx), authority, {
			templateId: saved.input.templateId,
			requestKey: effectKey,
		});
		return done(reply, (doc) => ({ id: doc.id, revision: doc.revision }));
	},
};

// --- documents.exportNative -----------------------------------------------------------------------------------------

const FORMAT_LABEL = { pdf: "PDF", docx: "Word" } as const;
const exportInput = z.strictObject({
	documentId,
	format: z.enum(["pdf", "docx"]).describe("pdf or docx (Word)"),
});
const exportArgs = z.object({
	input: z.object({ documentId: z.uuid(), revision: z.int(), format: z.enum(["pdf", "docx"]) }),
});
const exportNative: ReviewedWrite<z.infer<typeof exportInput>> = {
	operation: "documents.exportNative",
	description:
		"Propose saving a PDF or Word file of one Church Document's current version. The file is saved with the document in Church Documents, where it downloads. Nothing changes until the user approves the exact review.",
	input: exportInput,
	allowed: ownerOrAdmin,
	review(actor, value) {
		// Only a live Church Document of this church whose template offers the format, at its current version.
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
		// The file goes to the private bucket inside the effect; a rollback leaves an unreferenced object that the
		// scheduled cleanup (documents.reconcileOrphans) removes.
		const reply = await (
			await writer()
		).exportNative(asDatabase(tx), authority, { ...saved.input, requestKey: effectKey }, privateStorage());
		return done(reply, (file) => ({ id: file.id, revision: file.revision }));
	},
};

// --- documents.archive ------------------------------------------------------------------------------------------------

const archiveArgs = z.object({
	store: z.enum(["written", "church"]),
	input: z.object({ documentId: z.uuid(), expectedRevision: z.string() }),
});
const archive: ReviewedWrite<{ documentId: string }> = {
	operation: "documents.archive",
	description:
		"Propose archiving one of this church's documents, a written document or a Church Document. It leaves its list and stays readable. Nothing changes until the user approves the exact review.",
	input: z.strictObject({ documentId }),
	allowed: ownerOrAdmin,
	review(actor, value) {
		return sql`SELECT jsonb_build_object('target',${target},'changes',jsonb_build_array(
				${change("status", text("Live"), text("Archived"))},
				${change("list", null, sql`to_jsonb(CASE WHEN d.kind='church_document' THEN 'Church Documents' ELSE 'Documents' END)`)})) AS review,
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
			const reply = await (await writer()).archiveChurch(asDatabase(tx), authority, saved.input);
			return done(reply, (doc) => ({ id: doc.documentId, revision: saved.input.expectedRevision }));
		}
		const reply = await (await writer()).archive(asDatabase(tx), authority, saved.input);
		return done(reply, (doc) => ({ id: doc.id, revision: doc.revision }));
	},
};

// --- documents.designateCoreValues -------------------------------------------------------------------------------------

const designateRow = z.object({
	id: z.uuid(),
	kind: z.enum(["native", "core_values"]),
	revision: z.string(),
	body: z.string(),
});
const designateArgs = z.object({ input: z.object({ documentId: z.uuid(), expectedRevision: z.string() }) });
const designateCoreValues: ReviewedWrite<{ documentId: string }> = {
	operation: "documents.designateCoreValues",
	description:
		"Propose marking one written document with text as this church's core values document. Evry marks the church's own document; it never writes core values. Nothing changes until the user approves the exact review.",
	input: z.strictObject({ documentId }),
	allowed: ownerOrAdmin,
	async review(actor, value, context) {
		// The app marks only a live plain written document with text; the review says why any other cannot be marked.
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
		const reply = await (await writer()).designateCoreValues(asDatabase(tx), authority, saved.input);
		return done(reply, (doc) => ({ id: doc.id, revision: doc.revision }));
	},
};

/** The installed Documents reviewed writes, keyed by operation. */
export const DOCUMENTS_COMMANDS = {
	"documents.createFromTemplate": createFromTemplate,
	"documents.exportNative": exportNative,
	"documents.archive": archive,
	"documents.designateCoreValues": designateCoreValues,
} as const;
