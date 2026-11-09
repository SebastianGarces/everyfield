import * as c from "@everyfield/contracts/documents";
import type { Database } from "@everyfield/db/client";
import { sql } from "@everyfield/db/query";
import { readAuthorizedObject, type PrivateStorage, type ResourceAuthorizer } from "@everyfield/db/schema";
import { createHash, randomUUID } from "node:crypto";
import "server-only";
import type { RequestActor } from "../access/session.ts";
import { dataFromRow } from "../branding/kit.ts";
import { deny, parse, plantViewer, readPlant, rejectInput, settle } from "./access.ts";
import { documentBrand, exportTheme, type ImageSource } from "./church-theme.ts";
import { docFormats, renderDocFile, type DocFormat } from "./doc-render.ts";
import { docTemplateById, sheetOf } from "./doc-templates.ts";
import { fieldValues, frozenData, type MergeSources } from "./doc-values.ts";
import { cleanOverrides } from "./merge.ts";
import { RenderFailed, digestOf, renderEngineVersion } from "./render.ts";
import {
	MEDIA,
	PAGE,
	gateSql,
	generatedFrom,
	historyRows,
	iso,
	plantScope,
	postgresCode,
	rowsOf,
	storeBytes,
	type Scope,
} from "./scope.ts";

const hashOf = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");

/** A UUID from the plant and the request key, so a retry or a race reaches the same row and cannot make a second one. */
function stableId(...parts: string[]) {
	const h = createHash("sha256").update(parts.join("\0")).digest();
	h[6] = (h[6]! & 0x0f) | 0x50;
	h[8] = (h[8]! & 0x3f) | 0x80;
	const x = h.subarray(0, 16).toString("hex");
	return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20, 32)}`;
}

/** An Owner or Admin of the church plant. A Member and an account with no seat get `access_denied`. */
function adminScope(authority: RequestActor) {
	const viewer = plantViewer(authority);
	if (!viewer || viewer.access.role === "member") deny("access_denied");
	return plantScope(viewer);
}
function readerScope(authority: RequestActor) {
	const viewer = plantViewer(authority);
	if (!viewer) deny("access_denied");
	return plantScope(viewer);
}

type Provenance = { key: string; value: string | null; source: string }[];

/**
 * The name of the church template a Church Document `d` was made from, or null for a built-in template. A deleted
 * template keeps its row, so a document made from it still names it.
 */
const TEMPLATE_NAME = sql`(SELECT t.title FROM document t WHERE t.tenant_id = d.tenant_id AND t.kind = 'church_template'
	AND 'church-' || t.id::text = d.template_id)`;
type ChurchRow = {
	id: string;
	template_id: string;
	template_version: number;
	document_class: "formal/legal" | "outward-facing" | "operational";
	use_church_branding: boolean;
	title: string;
	template_name: string | null;
	revision: string;
	revision_id: string;
	body: string;
	content_hash: string;
	input_provenance: Provenance;
};

/** A stored body that is not a valid everyfield.doc/1 document cannot render; it is not a crash. */
function storedDoc(text: string | null) {
	const parsed = c.docDocument.safeParse(safeJson(text ?? ""));
	return parsed.success ? parsed.data : null;
}

/** One Church Document as the writers return it. The formats follow from the body; a stored row is never deleted here. */
function churchResult(
	tenantId: string,
	d: {
		id: string;
		templateId: string;
		templateVersion: number;
		documentClass: ChurchRow["document_class"];
		templateName: string | null;
		useChurchBranding: boolean | null;
		title: string;
		revision: string;
		revisionId: string;
		body: c.DocDocument;
		contentHash: string;
		provenance: Provenance;
	},
) {
	const templateVersion = followedVersion(d.templateId, d.templateVersion, d.body.origin);
	return c.churchDocument.parse({ ...d, templateVersion, tenantId, formats: docFormats(d.body), archived: false });
}

/**
 * The template version a document follows is the one its current revision records: the version it was made from, or
 * the one it last accepted changes from. The row keeps the version it was made from (frozen source evidence), so every
 * reader derives the version here.
 */
function followedVersion(
	templateId: string | null,
	madeFrom: number | null,
	origin: { template?: string; version?: number } | null | undefined,
) {
	return origin?.template === templateId && typeof origin?.version === "number" ? origin.version : Number(madeFrom);
}

/**
 * The current state of one Church Document, as a reader sees it, with the plant's brand kit for the editor. One
 * statement: the kit joins the same read.
 */
async function readChurchWithKit(db: Database, scope: Scope, documentId: string, admin = false) {
	const found = await rowsOf<ChurchRow & { ok: boolean; kit: Record<string, unknown> | null }>(
		db,
		sql`SELECT g.ok, d.id, d.template_id, d.template_version, d.document_class, d.use_church_branding, d.title,
			d.revision::text AS revision, r.id AS revision_id, r.body, r.content_hash,
			d.input_provenance, to_jsonb(k) AS kit, ${TEMPLATE_NAME} AS template_name
		FROM (SELECT ${gateSql(scope, admin)} AS ok) g
		LEFT JOIN document d ON g.ok AND d.id = ${documentId}::uuid AND d.tenant_id = ${scope.tenantId}::uuid
			AND d.kind = 'church_document' AND d.current_revision_id IS NOT NULL AND d.archived_at IS NULL
		LEFT JOIN document_revision r ON r.id = d.current_revision_id AND r.tenant_id = d.tenant_id
		LEFT JOIN church_brand_kit k ON g.ok AND k.tenant_id = ${scope.tenantId}::uuid`,
	);
	if (found[0]?.ok !== true) deny("access_denied");
	const row = found[0];
	if (!row.id) return null;
	const doc = churchResult(scope.tenantId, {
		id: row.id,
		templateId: row.template_id,
		templateVersion: Number(row.template_version),
		documentClass: row.document_class,
		templateName: row.template_name,
		useChurchBranding: row.use_church_branding,
		title: row.title,
		revision: String(row.revision),
		revisionId: row.revision_id,
		body: storedDoc(row.body) ?? deny("render_failed"),
		contentHash: row.content_hash,
		provenance: row.input_provenance,
	});
	return { doc, kit: row.kit ? dataFromRow(row.kit) : null };
}

/** The current state of one Church Document, as a reader sees it. One statement. */
async function readChurch(db: Database, scope: Scope, documentId: string, admin = false) {
	return (await readChurchWithKit(db, scope, documentId, admin))?.doc ?? null;
}

function safeJson(text: string): unknown {
	try {
		return JSON.parse(text);
	} catch {
		return null;
	}
}

/** The contact line a card prints: the website without its scheme, the phone and the email. */
const contactLine = (kit: ReturnType<typeof dataFromRow> | null) =>
	[kit?.website?.replace(/^https?:\/\//, "").replace(/\/$/, ""), kit?.phone, kit?.email]
		.filter(Boolean)
		.join("  ·  ") || null;

/** A merge value for a field the template does not declare is refused. */
function knownFields(template: c.DocTemplate, values: Record<string, string>) {
	const known = new Set(template.fields.filter((f) => f.type !== "list").map((field) => field.key));
	const foreign = Object.keys(values).find((key) => !known.has(key));
	if (foreign) rejectInput(`mergeFields.${foreign}`, "Unknown merge field.");
}

/** The body of one live church template of the scope's church plant, as a scalar subquery. */
const churchTemplateBody = (scope: Scope, recordId: string) =>
	sql`(SELECT r.body FROM document t
		JOIN document_revision r ON r.id = t.current_revision_id AND r.tenant_id = t.tenant_id
		WHERE t.id = ${recordId}::uuid AND t.tenant_id = ${scope.tenantId}::uuid AND t.kind = 'church_template'
			AND t.archived_at IS NULL)`;

/** A stored church template body that is not a valid everyfield.doc/1 template is not offered. */
function storedTemplate(text: string | null) {
	const parsed = c.docTemplate.safeParse(safeJson(text ?? ""));
	return parsed.success ? parsed.data : null;
}

/** One church template as "New from template" shows it. */
type TemplateRow = {
	id: string;
	title: string;
	body: string;
	source_document_id: string;
	source_revision_id: string;
	source_revision: number;
};
function templateSummary(row: TemplateRow) {
	const template = storedTemplate(row.body);
	if (!template) return null;
	return c.churchTemplateSummary.parse({
		id: row.id,
		templateId: template.id,
		title: row.title,
		description: template.description ?? null,
		version: template.version,
		documentClass: template.class,
		formats: docFormats(template),
		page: sheetOf(template.page),
		source: {
			documentId: row.source_document_id,
			revisionId: row.source_revision_id,
			revision: Number(row.source_revision),
		},
	});
}

type Kit = ReturnType<typeof dataFromRow> | null;

/** Where merge values come from now: the church plant (read by `readPlant`) and its brand kit. */
function mergeSources(plant: Awaited<ReturnType<typeof readPlant>>, kit: Kit): MergeSources {
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

/** Finds the current version of a built-in template. A test passes its own to compare with a template version 2. */
type TemplateLookup = (id: string) => c.DocTemplate | undefined;

/**
 * Where a document stands against its template: "behind" when the template hash it records is not the current
 * template's, "current" when it is, and null when there is nothing to compare with (a blank document, or a template
 * that no longer exists).
 */
export async function templateStatus(body: c.DocDocument, templates: TemplateLookup = docTemplateById) {
	const template = body.origin ? templates(body.origin.template) : undefined;
	if (!body.origin || !template) return null;
	return (await c.templateHash(template)) === body.origin.hash ? ("current" as const) : ("behind" as const);
}

/**
 * The values a document freezes for the template fields it lacks: the church plant and brand kit now, else the
 * template's fallback. A document that lacks none reads nothing more.
 */
async function addedValues(db: Database, scope: Scope, body: c.DocDocument, template: c.DocTemplate, kit: Kit) {
	const missing = c.missingFields(body, template);
	const data: Record<string, string> = {};
	if (!missing.length) return data;
	const plant = await readPlant(
		db,
		{ ...scope, plantId: scope.tenantId },
		{ personId: null, meetingId: null, teamId: null },
	);
	const frozen = frozenData(template.fields, mergeSources(plant, kit)).data;
	for (const field of missing) if (frozen[field.key] !== undefined) data[field.key] = frozen[field.key]!;
	return data;
}

/** The document and its template for a compare or an accept: an Owner or Admin, a fork of a template that exists. */
async function compareSubject(db: Database, scope: Scope, documentId: string, templates: TemplateLookup) {
	const found = await readChurchWithKit(db, scope, documentId, true);
	if (!found) deny("unavailable");
	const { body } = found.doc;
	const template = body.origin ? templates(body.origin.template) : undefined;
	if (!body.origin || !template) deny("unavailable");
	return { ...found, body, origin: body.origin, template, hash: await c.templateHash(template) };
}

export const churchWriter = {
	/** CASE-DOC-022: revision 1 holds the template body with the merge values resolved once. It makes no file. */
	async createFromTemplate(db: Database, authority: RequestActor, raw: unknown) {
		return settle(async () => {
			const input = parse(c.createFromTemplateRequest, raw);
			const scope = adminScope(authority);
			const cleaned = cleanOverrides(input.mergeFields);
			if (!cleaned.ok) rejectInput(cleaned.path, cleaned.problem);
			// A built-in template, or one of the church's own templates ("church-" and its record id), read below.
			const churchTemplate = c.churchTemplateRecord(input.templateId);
			const builtIn = churchTemplate ? null : (docTemplateById(input.templateId) ?? deny("unavailable"));
			if (builtIn) knownFields(builtIn, cleaned.values);
			const plant = await readPlant(
				db,
				{ ...scope, plantId: scope.tenantId },
				{ personId: null, meetingId: null, teamId: null },
			);
			// The brand kit and, for a church template, its body: one statement. Another church's template reads as none.
			const kitRows = await rowsOf<{ kit: Record<string, unknown> | null; template_body: string | null }>(
				db,
				sql`SELECT (SELECT to_jsonb(k) FROM church_brand_kit k WHERE k.tenant_id = ${scope.tenantId}::uuid) AS kit,
					${churchTemplate ? churchTemplateBody(scope, churchTemplate) : sql`NULL::text`} AS template_body
				FROM (SELECT ${gateSql(scope, true)} AS ok) g WHERE g.ok`,
			);
			const sources = mergeSources(plant, kitRows[0]?.kit ? dataFromRow(kitRows[0].kit) : null);
			const template = builtIn ?? storedTemplate(kitRows[0]?.template_body ?? null) ?? deny("unavailable");
			if (!builtIn) knownFields(template, cleaned.values);
			// The values are frozen now (input provenance): an override wins over the church and the brand kit.
			const frozen = frozenData(template.fields, sources);
			const data: Record<string, string> = { ...frozen.data, ...cleaned.values };
			const required = template.fields.find((f) => f.required && !data[f.key]?.trim());
			if (required) deny("unavailable");
			const provenance: Provenance = template.fields
				.filter((field) => field.type !== "list")
				.map((field) => ({
					key: field.key,
					value: data[field.key] ?? null,
					source: cleaned.values[field.key] ? "override" : (frozen.from[field.key] ?? "absent").slice(0, 40),
				}));
			const docId = stableId(scope.tenantId, "church-document", input.requestKey);
			const forked = await c.forkTemplate(template, { id: `doc-${docId}`, data });
			const checked = c.docDocument.safeParse(forked);
			if (!checked.success) rejectInput("mergeFields", "The merge values make the document too large.");
			const body = JSON.stringify(checked.data);
			const hash = hashOf(body);
			const requestHash = hashOf(JSON.stringify([template.id, cleaned.values]));
			const revId = stableId(scope.tenantId, "church-document-revision", input.requestKey);
			let found: { ok: boolean; id: string | null; prior_id: string | null; prior_hash: string | null }[];
			try {
				found = await rowsOf(
					db,
					sql`WITH gate AS (SELECT ${gateSql(scope, true)} AS ok),
					prior AS (
						SELECT a.subject_id AS id, a.after_value->>'hash' AS hash FROM audit_event a JOIN gate ON gate.ok
						WHERE a.tenant_id = ${scope.tenantId}::uuid AND a.request_key = ${input.requestKey}
							AND a.action = 'documents.created_from_template'
					),
					ins AS (
						INSERT INTO document (
							id, tenant_id, kind, title, current_revision_id, revision, template_id, template_version,
							document_class, use_church_branding, input_provenance
						)
						SELECT ${docId}::uuid, ${scope.tenantId}::uuid, 'church_document', ${template.title}, ${revId}::uuid, 1,
							${template.id}, ${template.version}, ${template.class}, true, ${JSON.stringify(provenance)}::jsonb
						FROM gate WHERE ok AND NOT EXISTS (SELECT FROM prior)
						RETURNING id, tenant_id
					),
					added AS (
						INSERT INTO document_revision (
							id, tenant_id, document_id, version_number, body, content_hash, published_at, recorded_at, author_account_id
						)
						SELECT ${revId}::uuid, ins.tenant_id, ins.id, 1, ${body}, ${hash}, clock_timestamp(), clock_timestamp(),
							${scope.accountId}::uuid
						FROM ins
						RETURNING id
					),
					aud AS (
						INSERT INTO audit_event (
							tenant_id, actor_id, action, kind, subject_id, occurred_at, recorded_at, event_key, request_key,
							after_value, after_revision, metadata
						)
						SELECT ${scope.tenantId}::uuid, ${scope.accountId}::uuid, 'documents.created_from_template', 'create', ins.id,
							clock_timestamp(), clock_timestamp(), 'church-document:' || ins.id::text || ':1', ${input.requestKey},
							jsonb_build_object('hash', ${requestHash}::text), 1, '{}'::jsonb
						FROM ins
						RETURNING id
					)
					SELECT (SELECT ok FROM gate) AS ok, (SELECT id FROM ins) AS id, (SELECT id FROM prior) AS prior_id,
						(SELECT hash FROM prior) AS prior_hash, (SELECT count(*) FROM added) AS written, (SELECT count(*) FROM aud) AS audited`,
				);
			} catch (error) {
				// A race on the same request key reached the same stable id: read what the winner wrote.
				if (postgresCode(error) !== "23505") throw error;
				const raced = await readChurch(db, scope, docId, true);
				if (!raced) deny("conflict");
				const priorHash = await rowsOf<{ hash: string | null }>(
					db,
					sql`SELECT after_value->>'hash' AS hash FROM audit_event
					WHERE tenant_id = ${scope.tenantId}::uuid AND request_key = ${input.requestKey} AND action = 'documents.created_from_template'`,
				);
				if (priorHash[0]?.hash !== requestHash) deny("conflict");
				return raced;
			}
			const row = found[0];
			if (!row?.ok) deny("access_denied");
			if (row.prior_id) {
				if (row.prior_hash !== requestHash) deny("conflict");
				const same = await readChurch(db, scope, row.prior_id, true);
				if (!same) deny("conflict");
				return same;
			}
			if (!row.id) deny("unavailable");
			return churchResult(scope.tenantId, {
				id: row.id,
				templateId: template.id,
				templateVersion: template.version,
				documentClass: template.class,
				templateName: churchTemplate ? template.title : null,
				useChurchBranding: true,
				title: template.title,
				revision: "1",
				revisionId: revId,
				body: checked.data,
				contentHash: hash,
				provenance,
			});
		});
	},

	/**
	 * `documents.saveNative` on a Church Document: one attributed revision, or a refusal that writes nothing. The body
	 * is an everyfield.doc/1 document (the request parser refused any other shape). One statement checks the seat and
	 * the expected revision, writes the revision, moves the title and class with the body, and writes its audit row.
	 */
	async saveChurch(
		db: Database,
		authority: RequestActor,
		input: c.ChurchSave,
		/** True when the revision accepts changes from the current template; its audit row says so. */
		accepted = false,
	) {
		const scope = adminScope(authority);
		const body = JSON.stringify(input.body);
		const hash = hashOf(body);
		const revId = randomUUID();
		const found = await rowsOf<{
			ok: boolean;
			found: string | null;
			archived: boolean | null;
			prior_revision: string | null;
			stored: string | null;
			next_revision: string | null;
			template_id: string | null;
			template_version: number | null;
			use_church_branding: boolean | null;
			input_provenance: Provenance | null;
			template_name: string | null;
		}>(
			db,
			sql`WITH gate AS (SELECT ${gateSql(scope, true)} AS ok),
			existing AS (
				SELECT d.id, d.tenant_id, d.revision, d.archived_at, d.template_id, d.template_version, d.use_church_branding,
					d.input_provenance, ${TEMPLATE_NAME} AS template_name
				FROM document d JOIN gate ON gate.ok
				WHERE d.id = ${input.documentId}::uuid AND d.tenant_id = ${scope.tenantId}::uuid AND d.kind = 'church_document'
			),
			added AS (
				INSERT INTO document_revision (
					id, tenant_id, document_id, version_number, body, content_hash, published_at, recorded_at, author_account_id
				)
				SELECT ${revId}::uuid, existing.tenant_id, existing.id, (existing.revision + 1)::int, ${body}, ${hash},
					clock_timestamp(), clock_timestamp(), ${scope.accountId}::uuid
				FROM existing
				WHERE existing.archived_at IS NULL AND existing.revision = ${input.expectedRevision}::bigint
				RETURNING id, document_id
			),
			updated AS (
				UPDATE document SET current_revision_id = added.id, revision = document.revision + 1,
					title = ${input.body.title}, document_class = ${input.body.class}
				FROM added WHERE document.id = added.document_id
				RETURNING document.id, document.revision::text AS revision
			),
			aud AS (
				INSERT INTO audit_event (
					tenant_id, actor_id, action, kind, subject_id, occurred_at, recorded_at, event_key, after_revision, metadata
				)
				SELECT ${scope.tenantId}::uuid, ${scope.accountId}::uuid, 'documents.saved', 'edit', updated.id,
					clock_timestamp(), clock_timestamp(), 'church-document:' || updated.id::text || ':' || updated.revision,
					updated.revision::bigint, ${JSON.stringify(accepted ? { template: "accepted" } : {})}::jsonb
				FROM updated
				RETURNING id
			)
			SELECT (SELECT ok FROM gate) AS ok, (SELECT id FROM existing) AS found, (SELECT archived_at IS NOT NULL FROM existing) AS archived,
				(SELECT revision::text FROM existing) AS prior_revision, (SELECT id FROM updated) AS stored,
				(SELECT revision FROM updated) AS next_revision, (SELECT template_id FROM existing) AS template_id,
				(SELECT template_version FROM existing) AS template_version,
				(SELECT use_church_branding FROM existing) AS use_church_branding,
				(SELECT input_provenance FROM existing) AS input_provenance, (SELECT template_name FROM existing) AS template_name,
				(SELECT count(*) FROM aud) AS audited`,
		).catch((error: unknown) => {
			// Two saves from the same revision: the second meets the unique version number.
			if (postgresCode(error) === "23505") return deny("conflict");
			throw error;
		});
		const row = found[0];
		if (!row?.ok) deny("access_denied");
		if (!row.found || row.archived) deny("unavailable");
		if (row.prior_revision === null || BigInt(row.prior_revision) !== BigInt(input.expectedRevision)) deny("conflict");
		if (!row.stored || !row.next_revision || !row.template_id || !row.input_provenance) deny("conflict");
		return churchResult(scope.tenantId, {
			id: row.stored,
			templateId: row.template_id,
			templateVersion: Number(row.template_version),
			documentClass: input.body.class,
			templateName: row.template_name,
			useChurchBranding: row.use_church_branding,
			title: input.body.title,
			revision: row.next_revision,
			revisionId: revId,
			body: input.body,
			contentHash: hash,
			provenance: row.input_provenance,
		});
	},

	/**
	 * "Compare with template": every difference between the current revision and the current version of its template,
	 * and the text each merge field prints on both sides. An Owner or Admin only. One statement reads the document and
	 * the brand kit; a document that lacks some template fields reads the church plant too, for what they would print.
	 */
	async readTemplateCompare(
		db: Database,
		authority: RequestActor,
		raw: unknown,
		templates: TemplateLookup = docTemplateById,
	) {
		return settle(async () => {
			const input = parse(c.churchCompareRequest, raw);
			const scope = adminScope(authority);
			const { doc, body, origin, template, hash, kit } = await compareSubject(db, scope, input.documentId, templates);
			const added = await addedValues(db, scope, body, template, kit);
			const missing = c.missingFields(body, template);
			return c.churchCompare.parse({
				documentId: doc.id,
				revision: doc.revision,
				templateTitle: template.title,
				templateVersion: template.version,
				templateHash: hash,
				behind: hash !== origin.hash,
				values: fieldValues({ ...body, fields: [...body.fields, ...missing], data: { ...body.data, ...added } }),
				differences: c.compareWithTemplate(body, template),
			});
		});
	},

	/**
	 * Accept differences from the current template: one new revision through the expected-revision save, recording the
	 * current template version and hash. A template field the document lacked freezes the church's value now, else the
	 * template's fallback. A newer revision or template than the compare named is a conflict and writes nothing.
	 */
	async acceptTemplateChanges(
		db: Database,
		authority: RequestActor,
		raw: unknown,
		templates: TemplateLookup = docTemplateById,
	) {
		return settle(async () => {
			const input = parse(c.acceptTemplateRequest, raw);
			const scope = adminScope(authority);
			const { doc, body, template, hash, kit } = await compareSubject(db, scope, input.documentId, templates);
			if (BigInt(doc.revision) !== BigInt(input.expectedRevision) || hash !== input.templateHash) deny("conflict");
			const count = c.compareWithTemplate(body, template).length;
			if (input.accept !== "all" && input.accept.some((id) => id >= count))
				rejectInput("accept", "That change is not in the compare.");
			const added = await addedValues(db, scope, body, template, kit);
			const next = c.docDocument.safeParse(
				c.acceptDifferences(body, template, input.accept, {
					origin: { template: template.id, version: template.version, hash },
					values: added,
				}),
			);
			if (!next.success) rejectInput("accept", (next.error.issues[0]?.message ?? "invalid").slice(0, 200));
			return churchWriter.saveChurch(
				db,
				authority,
				{ documentId: input.documentId, expectedRevision: input.expectedRevision, body: next.data },
				true,
			);
		});
	},

	/** One audited write. The toggle makes no revision and changes only later exports. */
	async setBranding(db: Database, authority: RequestActor, raw: unknown) {
		return settle(async () => {
			const input = parse(c.setBrandingRequest, raw);
			const scope = adminScope(authority);
			const found = await rowsOf<{ ok: boolean; id: string | null; use_church_branding: boolean | null }>(
				db,
				sql`WITH gate AS (SELECT ${gateSql(scope, true)} AS ok),
				upd AS (
					UPDATE document SET use_church_branding = ${input.useChurchBranding}
					FROM gate
					WHERE gate.ok AND document.id = ${input.documentId}::uuid AND document.tenant_id = ${scope.tenantId}::uuid
						AND document.kind = 'church_document' AND document.archived_at IS NULL
					RETURNING document.id, document.use_church_branding
				),
				aud AS (
					INSERT INTO audit_event (
						tenant_id, actor_id, action, kind, subject_id, occurred_at, recorded_at, event_key, after_value, metadata
					)
					SELECT ${scope.tenantId}::uuid, ${scope.accountId}::uuid, 'documents.branding_changed', 'edit', upd.id,
						clock_timestamp(), clock_timestamp(), 'church-branding:' || upd.id::text || ':' || ${randomUUID()}::text,
						jsonb_build_object('useChurchBranding', upd.use_church_branding), '{}'::jsonb
					FROM upd
					RETURNING id
				)
				SELECT (SELECT ok FROM gate) AS ok, (SELECT id FROM upd) AS id,
					(SELECT use_church_branding FROM upd) AS use_church_branding, (SELECT count(*) FROM aud) AS audited`,
			);
			const row = found[0];
			if (!row?.ok) deny("access_denied");
			if (!row.id) deny("unavailable");
			return c.brandingResult.parse({ documentId: row.id, useChurchBranding: input.useChurchBranding });
		});
	},

	/** CASE-DOC-023: one saved export of one named revision. The theme is chosen now; the bytes are frozen. */
	async exportNative(db: Database, authority: RequestActor, raw: unknown, storage: PrivateStorage | null) {
		return settle(async () => {
			const input = parse(c.exportNativeRequest, raw);
			const scope = readerScope(authority);
			const found = await rowsOf<{
				ok: boolean;
				id: string | null;
				template_id: string | null;
				template_version: number | null;
				document_class: ChurchRow["document_class"] | null;
				use_church_branding: boolean | null;
				input_provenance: Provenance | null;
				revision_id: string | null;
				body: string | null;
				recorded_at: Date | string | null;
				kit: Record<string, unknown> | null;
				prior_id: string | null;
				prior_same: boolean | null;
			}>(
				db,
				sql`SELECT g.ok, d.id, d.template_id, d.template_version, d.document_class, d.use_church_branding,
					d.input_provenance, r.id AS revision_id, r.body, r.recorded_at,
					to_jsonb(k) AS kit, gd.id AS prior_id,
					(gd.source_document_id = ${input.documentId}::uuid AND gd.source_revision_id = r.id AND gd.format = ${input.format}) AS prior_same
				FROM (SELECT ${gateSql(scope, false)} AS ok) g
				LEFT JOIN document d ON g.ok AND d.id = ${input.documentId}::uuid AND d.tenant_id = ${scope.tenantId}::uuid
					AND d.kind = 'church_document'
				LEFT JOIN document_revision r ON r.document_id = d.id AND r.tenant_id = d.tenant_id
					AND r.version_number = ${input.revision}
				LEFT JOIN church_brand_kit k ON g.ok AND k.tenant_id = ${scope.tenantId}::uuid
				LEFT JOIN generated_document gd ON g.ok AND gd.tenant_id = ${scope.tenantId}::uuid AND gd.request_key = ${input.requestKey}`,
			);
			const row = found[0];
			if (!row?.ok) deny("access_denied");
			if (row.prior_id) {
				if (row.prior_same !== true) deny("conflict");
				return exportRecord(db, scope, row.prior_id);
			}
			if (
				!row.id ||
				!row.template_id ||
				!row.revision_id ||
				row.body === null ||
				!row.input_provenance ||
				!row.document_class
			)
				deny("unavailable");
			const body = storedDoc(row.body);
			if (!body) deny("render_failed");
			const { bytes, theme } = await renderRevision(db, storage, authority, body, row, input.format);
			const file = await storeBytes(
				db,
				storage,
				scope,
				"generated",
				MEDIA[input.format],
				bytes,
				`generated:${scope.tenantId}:${input.requestKey}`,
			);
			const id = randomUUID();
			const name = `${row.template_id}-revision-${input.revision}.${input.format}`;
			try {
				const inserted = await rowsOf<{
					ok: boolean;
					id: string | null;
					generated_at: Date | string | null;
					revision: string | null;
				}>(
					db,
					sql`WITH gate AS (SELECT ${gateSql(scope, false)} AS ok),
					ins AS (
						INSERT INTO generated_document (
							id, tenant_id, creator_account_id, template_id, template_version, saved_template_name, renderer_version,
							format, object_id, inputs, download_name, generated_at, request_key,
							source_document_id, source_revision_id, theme_kind, theme_primary
						)
						SELECT ${id}::uuid, ${scope.tenantId}::uuid, ${scope.accountId}::uuid, ${row.template_id}, ${String(row.template_version)},
							${body.title}, ${renderEngineVersion()}, ${input.format}, ${file.id}::uuid, '[]'::jsonb, ${name},
							clock_timestamp(), ${input.requestKey}, ${row.id}::uuid, ${row.revision_id}::uuid, ${theme.kind}, ${theme.primary}
						FROM gate
						WHERE ok AND NOT EXISTS (
							SELECT FROM generated_document WHERE tenant_id = ${scope.tenantId}::uuid AND request_key = ${input.requestKey}
						)
						RETURNING id, generated_at, revision::text AS revision
					),
					aud AS (
						INSERT INTO audit_event (
							tenant_id, actor_id, action, kind, subject_id, occurred_at, recorded_at, event_key, request_key, metadata
						)
						SELECT ${scope.tenantId}::uuid, ${scope.accountId}::uuid, 'documents.exported', 'create', ins.id,
							clock_timestamp(), clock_timestamp(), 'exported:' || ins.id::text, ${input.requestKey}, '{}'::jsonb
						FROM ins
						RETURNING id
					)
					SELECT (SELECT ok FROM gate) AS ok, (SELECT id FROM ins) AS id, (SELECT generated_at FROM ins) AS generated_at,
						(SELECT revision FROM ins) AS revision, (SELECT count(*) FROM aud) AS audited`,
				);
				const done = inserted[0];
				if (!done?.ok) deny("access_denied");
				if (done.id && done.generated_at && done.revision)
					return c.generatedDocument.parse({
						id: done.id,
						plantId: scope.tenantId,
						templateId: row.template_id,
						templateVersion: String(row.template_version),
						savedTemplateName: body.title,
						format: input.format,
						digest: digestOf(bytes),
						byteCount: bytes.length,
						downloadName: name,
						generatedAt: iso(done.generated_at),
						creatorAccountId: scope.accountId,
						revision: done.revision,
						source: { documentId: row.id, revisionId: row.revision_id, revision: input.revision },
						theme: { kind: theme.kind, primary: theme.primary },
					});
			} catch (error) {
				if (postgresCode(error) !== "23505") {
					if (postgresCode(error) === "42501" || postgresCode(error) === "23514") deny();
					throw error;
				}
			}
			// The same request key finished first: answer with its record when it is the same export.
			const raced = await rowsOf<{ id: string; same: boolean }>(
				db,
				sql`SELECT gd.id, (gd.source_document_id = ${row.id}::uuid AND gd.source_revision_id = ${row.revision_id}::uuid
					AND gd.format = ${input.format}) AS same
				FROM generated_document gd WHERE gd.tenant_id = ${scope.tenantId}::uuid AND gd.request_key = ${input.requestKey}`,
			);
			if (raced[0]?.same) return exportRecord(db, scope, raced[0].id);
			deny("conflict");
		});
	},

	/**
	 * The saved exports of one Church Document, the latest 100 newest first (DOC-003). Any seat reads them. One statement.
	 * A creator's name shows while that person holds a seat in the church plant.
	 */
	async listExports(db: Database, authority: RequestActor, raw: unknown) {
		return settle(async () => {
			const input = parse(c.listExportsRequest, raw);
			const scope = readerScope(authority);
			const found = await rowsOf<{
				ok: boolean;
				document_id: string | null;
				id: string | null;
				revision: number | null;
				format: string | null;
				generated_at: Date | string | null;
				creator_name: string | null;
				sha256: string | null;
				byte_count: string | number | null;
				download_name: string | null;
			}>(
				db,
				sql`SELECT g.ok, d.id AS document_id, x.id, x.version_number AS revision, x.format, x.generated_at,
					x.creator_name, x.sha256, x.byte_count, x.download_name
				FROM (SELECT ${gateSql(scope, false)} AS ok) g
				LEFT JOIN document d ON g.ok AND d.id = ${input.documentId}::uuid AND d.tenant_id = ${scope.tenantId}::uuid
					AND d.kind = 'church_document' AND d.archived_at IS NULL
				LEFT JOIN LATERAL (
					SELECT gd.id, sr.version_number, gd.format, gd.generated_at, f.sha256, f.byte_count, gd.download_name,
						(SELECT i.display_name FROM seat_identity(gd.creator_account_id) i
							WHERE EXISTS (SELECT FROM seat s WHERE s.account_id = gd.creator_account_id AND s.plant_id = d.tenant_id
								AND s.ended_at IS NULL)) AS creator_name
					FROM generated_document gd
					JOIN file_object f ON f.id = gd.object_id AND f.tenant_id = gd.tenant_id AND f.state = 'ready'
					JOIN document_revision sr ON sr.id = gd.source_revision_id AND sr.tenant_id = gd.tenant_id
					WHERE gd.tenant_id = d.tenant_id AND gd.source_document_id = d.id
					ORDER BY gd.generated_at DESC, gd.id DESC
					LIMIT ${PAGE}
				) x ON true`,
			);
			if (found[0]?.ok !== true) deny("access_denied");
			if (!found[0].document_id) deny("unavailable");
			return c.savedExportList.parse({
				documentId: input.documentId,
				exports: found
					.filter((row) => row.id)
					.map((row) => ({
						id: row.id,
						documentId: input.documentId,
						revision: Number(row.revision),
						format: row.format,
						generatedAt: iso(row.generated_at),
						creatorName: row.creator_name || null,
						digest: row.sha256,
						byteCount: Number(row.byte_count),
						downloadName: row.download_name,
					})),
			});
		});
	},

	/**
	 * The stored bytes of one saved export (DOC-003): read from private storage, checked against the saved digest, never
	 * rendered again. The seat is checked before and after the bytes are read. Any seat reads it.
	 */
	async readExportFile(db: Database, authority: RequestActor, raw: unknown, storage: PrivateStorage | null) {
		return settle(async () => {
			const input = parse(c.exportRequest, raw);
			const scope = readerScope(authority);
			if (!storage) deny("unavailable");
			const found = await rowsOf<{
				ok: boolean;
				id: string | null;
				object_id: string | null;
				format: c.SavedExport["format"] | null;
				download_name: string | null;
				revision: number | null;
			}>(
				db,
				sql`SELECT g.ok, gd.id, gd.object_id, gd.format, gd.download_name, sr.version_number AS revision
				FROM (SELECT ${gateSql(scope, false)} AS ok) g
				LEFT JOIN generated_document gd ON g.ok AND gd.id = ${input.exportId}::uuid AND gd.tenant_id = ${scope.tenantId}::uuid
					AND gd.source_document_id = ${input.documentId}::uuid
				LEFT JOIN document_revision sr ON sr.id = gd.source_revision_id AND sr.tenant_id = gd.tenant_id`,
			);
			const row = found[0];
			if (!row?.ok) deny("access_denied");
			if (!row.id || !row.object_id || !row.format || !row.download_name || row.revision === null) deny("unavailable");
			const authorize: ResourceAuthorizer = async (tx, file, intent) => {
				if (intent !== "read") return null;
				const allowed = await rowsOf<{ ok: boolean }>(
					tx,
					sql`SELECT ${gateSql(scope, false)} AS ok FROM generated_document gd
					WHERE gd.id = ${input.exportId}::uuid AND gd.tenant_id = ${scope.tenantId}::uuid
						AND gd.source_document_id = ${input.documentId}::uuid AND gd.object_id = ${file.id}::uuid`,
				);
				return allowed[0]?.ok === true ? { kind: "account", actorId: scope.accountId } : null;
			};
			const bytes = await readAuthorizedObject(db, storage, authorize, row.object_id).catch((error: unknown) =>
				error instanceof Error && error.message === "unavailable" ? deny("unavailable") : Promise.reject(error),
			);
			return c.churchFile.parse({
				documentId: input.documentId,
				revision: Number(row.revision),
				format: row.format,
				mediaType: MEDIA[row.format],
				downloadName: row.download_name,
				digest: digestOf(Buffer.from(bytes)),
				bytes: Buffer.from(bytes).toString("base64"),
			});
		});
	},

	/**
	 * An Owner or Admin deletes one saved export (D-79). One statement checks the seat, removes the record and writes one
	 * audit row; its download stops working. A Member is refused before any statement.
	 */
	async deleteExport(db: Database, authority: RequestActor, raw: unknown) {
		return settle(async () => {
			const input = parse(c.exportRequest, raw);
			const scope = adminScope(authority);
			const found = await rowsOf<{ ok: boolean; deleted: string | null }>(
				db,
				sql`WITH gate AS (SELECT ${gateSql(scope, true)} AS ok),
				del AS (
					DELETE FROM generated_document gd USING gate
					WHERE gate.ok AND gd.id = ${input.exportId}::uuid AND gd.tenant_id = ${scope.tenantId}::uuid
						AND gd.source_document_id = ${input.documentId}::uuid
					RETURNING gd.id, gd.object_id
				),
				rel AS (
					INSERT INTO job (tenant_id, kind, subject_record_id, producer_key, state, eligible_at, attempt_count, max_attempts, claim_generation)
					SELECT ${scope.tenantId}::uuid, 'object_cleanup', del.object_id, 'export-deleted/' || del.id::text, 'ready', clock_timestamp(), 0, 4, 0
					FROM del
					ON CONFLICT DO NOTHING
				),
				aud AS (
					INSERT INTO audit_event (
						tenant_id, actor_id, action, kind, subject_id, occurred_at, recorded_at, event_key, metadata
					)
					SELECT ${scope.tenantId}::uuid, ${scope.accountId}::uuid, 'documents.export_deleted', 'remove', del.id,
						clock_timestamp(), clock_timestamp(), 'export-deleted:' || del.id::text, '{}'::jsonb
					FROM del
					RETURNING id
				)
				SELECT (SELECT ok FROM gate) AS ok, (SELECT id FROM del) AS deleted, (SELECT count(*) FROM aud) AS audited`,
			);
			const row = found[0];
			if (!row?.ok) deny("access_denied");
			if (!row.deleted) deny("unavailable");
			return c.deletedExport.parse({ exportId: row.deleted, deleted: true });
		});
	},

	/** One Church Document with its current revision. Any seat of the church plant reads it. One statement. */
	async readChurch(db: Database, authority: RequestActor, raw: unknown) {
		return settle(async () => {
			const input = parse(c.readChurchRequest, raw);
			const found = await readChurch(db, readerScope(authority), input.documentId);
			return found ?? deny("unavailable");
		});
	},

	/**
	 * One Church Document for the editor: the document and both looks the PDF can paint for it (the palette and the
	 * brand-kit images), church and plain. An Owner or Admin only. One statement, the same one a read makes.
	 */
	async readChurchForEdit(db: Database, authority: RequestActor, raw: unknown) {
		return settle(async () => {
			const input = parse(c.readChurchRequest, raw);
			const found = await readChurchWithKit(db, adminScope(authority), input.documentId);
			if (!found) return deny("unavailable");
			const church = documentBrand(found.kit, true);
			return c.churchDocumentView.parse({
				...found.doc,
				brands: { church: church.palette.themed ? church : null, plain: documentBrand(null, false) },
			});
		});
	},

	/**
	 * The library: every Church Document of the church plant that is not deleted, newest first, and for an Owner or
	 * Admin the church's own templates for "New from template", newest first. One statement.
	 */
	async listChurch(db: Database, authority: RequestActor, raw: unknown) {
		return settle(async () => {
			parse(c.listChurchRequest, raw);
			const scope = readerScope(authority);
			const found = await rowsOf<{
				ok: boolean;
				documents: {
					id: string;
					title: string;
					template_id: string;
					template_version: number;
					template_name: string | null;
					origin: { template?: string; version?: number } | null;
					document_class: ChurchRow["document_class"];
					revision: string;
					updated_at: string;
				}[];
				templates: TemplateRow[];
			}>(
				db,
				sql`SELECT g.ok,
					(SELECT coalesce(json_agg(x ORDER BY x.updated_at DESC NULLS LAST, x.id), '[]'::json) FROM (
						SELECT d.id, d.title, d.template_id, d.template_version, ${TEMPLATE_NAME} AS template_name,
							r.body::jsonb->'origin' AS origin, d.document_class, d.revision::text AS revision, r.recorded_at AS updated_at
						FROM document d
						JOIN document_revision r ON r.id = d.current_revision_id AND r.tenant_id = d.tenant_id
						WHERE g.ok AND d.tenant_id = ${scope.tenantId}::uuid AND d.kind = 'church_document' AND d.archived_at IS NULL
						ORDER BY r.recorded_at DESC NULLS LAST, d.id
						LIMIT 200
					) x) AS documents,
					(SELECT coalesce(json_agg(y ORDER BY y.created_at DESC, y.id), '[]'::json) FROM (
						SELECT t.id, t.title, r.body, r.recorded_at AS created_at, s.document_id AS source_document_id,
							s.id AS source_revision_id, s.version_number AS source_revision
						FROM document t
						JOIN document_revision r ON r.id = t.current_revision_id AND r.tenant_id = t.tenant_id
						JOIN document_revision s ON s.id = t.copied_from_revision_id AND s.tenant_id = t.tenant_id
						WHERE g.admin AND t.tenant_id = ${scope.tenantId}::uuid AND t.kind = 'church_template' AND t.archived_at IS NULL
						ORDER BY r.recorded_at DESC, t.id
						LIMIT 200
					) y) AS templates
				FROM (SELECT ${gateSql(scope, false)} AS ok, ${gateSql(scope, true)} AS admin) g`,
			);
			if (found[0]?.ok !== true) deny("access_denied");
			return c.churchLibrary.parse({
				documents: found[0].documents.map((row) => ({
					id: row.id,
					title: row.title,
					templateId: row.template_id,
					templateVersion: followedVersion(row.template_id, row.template_version, row.origin),
					templateName: row.template_name,
					documentClass: row.document_class,
					revision: row.revision,
					updatedAt: iso(row.updated_at),
				})),
				templates: found[0].templates.map(templateSummary).filter((t) => t !== null),
			});
		});
	},

	/**
	 * Save as template (Approach A): one saved revision of a Church Document becomes the church's own template, a full
	 * copy without `origin` and the frozen merge values. The source revision is read, then one statement checks the
	 * seat and the source again, writes the template and its revision and one audit row naming the source. The same
	 * request key returns the same template; a race on it meets the stable id and reads what the winner wrote.
	 */
	async saveTemplate(db: Database, authority: RequestActor, raw: unknown) {
		return settle(async () => {
			const input = parse(c.saveChurchTemplateRequest, raw);
			const scope = adminScope(authority);
			const id = stableId(scope.tenantId, "church-template", input.requestKey);
			const revId = stableId(scope.tenantId, "church-template-revision", input.requestKey);
			const requestHash = hashOf(
				JSON.stringify([input.documentId, input.revision, input.name, input.description ?? ""]),
			);
			const source = await rowsOf<{
				ok: boolean;
				revision_id: string | null;
				body: string | null;
				hash: string | null;
			}>(
				db,
				sql`SELECT g.ok, r.id AS revision_id, r.body, r.content_hash AS hash
				FROM (SELECT ${gateSql(scope, true)} AS ok) g
				LEFT JOIN document d ON g.ok AND d.id = ${input.documentId}::uuid AND d.tenant_id = ${scope.tenantId}::uuid
					AND d.kind = 'church_document' AND d.archived_at IS NULL
				LEFT JOIN document_revision r ON r.document_id = d.id AND r.tenant_id = d.tenant_id
					AND r.version_number = ${input.revision}`,
			);
			const src = source[0];
			if (!src?.ok) deny("access_denied");
			if (!src.revision_id || !src.hash) deny("unavailable");
			const doc = storedDoc(src.body) ?? deny("render_failed");
			const made = c.templateFromDocument(doc, {
				id: c.churchTemplateKey(id),
				title: input.name,
				...(input.description ? { description: input.description } : {}),
				version: 1,
			});
			const checked = c.docTemplate.safeParse(made);
			if (!checked.success) deny("render_failed");
			const body = JSON.stringify(checked.data);
			const hash = hashOf(body);
			let found: {
				ok: boolean;
				id: string | null;
				prior_id: string | null;
				prior_hash: string | null;
			}[];
			try {
				found = await rowsOf(
					db,
					sql`WITH gate AS (SELECT ${gateSql(scope, true)} AS ok),
					prior AS (
						SELECT a.subject_id AS id, a.after_value->>'hash' AS hash FROM audit_event a JOIN gate ON gate.ok
						WHERE a.tenant_id = ${scope.tenantId}::uuid AND a.request_key = ${input.requestKey}
							AND a.action = 'documents.template_saved'
					),
					src AS (
						SELECT d.id AS document_id, r.id AS revision_id
						FROM document d JOIN gate ON gate.ok
						JOIN document_revision r ON r.id = ${src.revision_id}::uuid AND r.document_id = d.id AND r.tenant_id = d.tenant_id
						WHERE d.id = ${input.documentId}::uuid AND d.tenant_id = ${scope.tenantId}::uuid
							AND d.kind = 'church_document' AND d.archived_at IS NULL
					),
					ins AS (
						INSERT INTO document (id, tenant_id, kind, title, current_revision_id, revision, copied_from_revision_id, copied_from_hash)
						SELECT ${id}::uuid, ${scope.tenantId}::uuid, 'church_template', ${input.name}, ${revId}::uuid, 1, src.revision_id,
							${src.hash}
						FROM src WHERE NOT EXISTS (SELECT FROM prior)
						RETURNING id, tenant_id
					),
					added AS (
						INSERT INTO document_revision (
							id, tenant_id, document_id, version_number, body, content_hash, published_at, recorded_at, author_account_id
						)
						SELECT ${revId}::uuid, ins.tenant_id, ins.id, 1, ${body}, ${hash}, clock_timestamp(), clock_timestamp(),
							${scope.accountId}::uuid
						FROM ins
						RETURNING id
					),
					aud AS (
						INSERT INTO audit_event (
							tenant_id, actor_id, action, kind, subject_id, occurred_at, recorded_at, event_key, request_key,
							after_value, after_revision, metadata
						)
						SELECT ${scope.tenantId}::uuid, ${scope.accountId}::uuid, 'documents.template_saved', 'create', ins.id,
							clock_timestamp(), clock_timestamp(), 'church-template:' || ins.id::text, ${input.requestKey},
							jsonb_build_object('hash', ${requestHash}::text, 'sourceDocumentId', src.document_id,
								'sourceRevisionId', src.revision_id, 'sourceRevision', ${input.revision}::int, 'contentHash', ${hash}::text),
							1, '{}'::jsonb
						FROM ins, src
						RETURNING id
					)
					SELECT (SELECT ok FROM gate) AS ok, (SELECT id FROM ins) AS id, (SELECT id FROM prior) AS prior_id,
						(SELECT hash FROM prior) AS prior_hash, (SELECT count(*) FROM aud) AS audited`,
				);
			} catch (error) {
				// A race on the same request key reached the same stable id: answer with what the winner wrote.
				if (postgresCode(error) !== "23505") throw error;
				return sameTemplate(db, scope, input.requestKey, requestHash);
			}
			const row = found[0];
			if (!row?.ok) deny("access_denied");
			if (row.prior_id) {
				if (row.prior_hash !== requestHash) deny("conflict");
				return sameTemplate(db, scope, input.requestKey, requestHash);
			}
			if (!row.id) deny("unavailable");
			return (
				templateSummary({
					id: row.id,
					title: input.name,
					body,
					source_document_id: input.documentId,
					source_revision_id: src.revision_id,
					source_revision: input.revision,
				}) ?? deny("render_failed")
			);
		});
	},

	/**
	 * Update a church template: one saved revision of a Church Document becomes the template's next version, revision
	 * n+1 of the same row with body version n+1. The template keeps its name and description; earlier revisions are never
	 * written, so documents made from them keep what they recorded. One read finds the seat, the source revision, the
	 * template and an earlier request on the key; one statement writes the revision, moves the row to it and writes one
	 * audit row. A template no longer at the named version is a conflict. The same request key returns the version it
	 * made; a race on it, or on the version number, meets a unique key and reads what the winner wrote.
	 */
	async updateTemplate(db: Database, authority: RequestActor, raw: unknown) {
		return settle(async () => {
			const input = parse(c.updateChurchTemplateRequest, raw);
			const scope = adminScope(authority);
			const version = input.expectedVersion + 1;
			const revId = stableId(scope.tenantId, "church-template-update", input.requestKey);
			const requestHash = hashOf(
				JSON.stringify([input.templateId, input.expectedVersion, input.documentId, input.revision]),
			);
			const read = await rowsOf<{
				ok: boolean;
				revision_id: string | null;
				body: string | null;
				hash: string | null;
				template_id: string | null;
				title: string | null;
				version: string | null;
				template_body: string | null;
				prior_hash: string | null;
			}>(
				db,
				sql`SELECT g.ok, r.id AS revision_id, r.body, r.content_hash AS hash, t.id AS template_id, t.title,
					t.revision::text AS version, tr.body AS template_body, p.after_value->>'hash' AS prior_hash
				FROM (SELECT ${gateSql(scope, true)} AS ok) g
				LEFT JOIN document d ON g.ok AND d.id = ${input.documentId}::uuid AND d.tenant_id = ${scope.tenantId}::uuid
					AND d.kind = 'church_document' AND d.archived_at IS NULL
				LEFT JOIN document_revision r ON r.document_id = d.id AND r.tenant_id = d.tenant_id
					AND r.version_number = ${input.revision}
				LEFT JOIN document t ON g.ok AND t.id = ${input.templateId}::uuid AND t.tenant_id = ${scope.tenantId}::uuid
					AND t.kind = 'church_template' AND t.archived_at IS NULL
				LEFT JOIN document_revision tr ON tr.id = t.current_revision_id AND tr.tenant_id = t.tenant_id
				LEFT JOIN audit_event p ON g.ok AND p.tenant_id = ${scope.tenantId}::uuid AND p.request_key = ${input.requestKey}
					AND p.action = 'documents.template_updated'`,
			);
			const src = read[0];
			if (!src?.ok) deny("access_denied");
			if (src.prior_hash !== null) {
				if (src.prior_hash !== requestHash) deny("conflict");
				return sameUpdate(db, scope, input.requestKey, requestHash);
			}
			if (!src.revision_id || !src.hash || !src.template_id || !src.title || src.version === null) deny("unavailable");
			if (Number(src.version) !== input.expectedVersion) deny("conflict");
			const doc = storedDoc(src.body) ?? deny("render_failed");
			const description = storedTemplate(src.template_body)?.description;
			const checked = c.docTemplate.safeParse(
				c.templateFromDocument(doc, {
					id: c.churchTemplateKey(src.template_id),
					title: src.title,
					...(description ? { description } : {}),
					version,
				}),
			);
			if (!checked.success) deny("render_failed");
			const body = JSON.stringify(checked.data);
			const hash = hashOf(body);
			let found: { ok: boolean; id: string | null }[];
			try {
				found = await rowsOf(
					db,
					sql`WITH gate AS (SELECT ${gateSql(scope, true)} AS ok),
					src AS (
						SELECT d.id AS document_id, r.id AS revision_id
						FROM document d JOIN gate ON gate.ok
						JOIN document_revision r ON r.id = ${src.revision_id}::uuid AND r.document_id = d.id AND r.tenant_id = d.tenant_id
						WHERE d.id = ${input.documentId}::uuid AND d.tenant_id = ${scope.tenantId}::uuid
							AND d.kind = 'church_document' AND d.archived_at IS NULL
					),
					tpl AS (
						SELECT t.id, t.tenant_id FROM document t JOIN gate ON gate.ok
						WHERE t.id = ${input.templateId}::uuid AND t.tenant_id = ${scope.tenantId}::uuid AND t.kind = 'church_template'
							AND t.archived_at IS NULL AND t.revision = ${input.expectedVersion}::bigint
					),
					added AS (
						INSERT INTO document_revision (
							id, tenant_id, document_id, version_number, body, content_hash, published_at, recorded_at, author_account_id
						)
						SELECT ${revId}::uuid, tpl.tenant_id, tpl.id, ${version}::int, ${body}, ${hash}, clock_timestamp(),
							clock_timestamp(), ${scope.accountId}::uuid
						FROM tpl, src
						RETURNING id, document_id
					),
					updated AS (
						UPDATE document SET current_revision_id = added.id, revision = ${version}::bigint,
							copied_from_revision_id = src.revision_id, copied_from_hash = ${src.hash}
						FROM added, src
						WHERE document.id = added.document_id AND document.revision = ${input.expectedVersion}::bigint
						RETURNING document.id
					),
					aud AS (
						INSERT INTO audit_event (
							tenant_id, actor_id, action, kind, subject_id, occurred_at, recorded_at, event_key, request_key,
							before_value, after_value, before_revision, after_revision, metadata
						)
						SELECT ${scope.tenantId}::uuid, ${scope.accountId}::uuid, 'documents.template_updated', 'edit', updated.id,
							clock_timestamp(), clock_timestamp(), 'church-template:' || updated.id::text || ':' || ${version}::text,
							${input.requestKey}, jsonb_build_object('version', ${input.expectedVersion}::int),
							jsonb_build_object('hash', ${requestHash}::text, 'version', ${version}::int, 'sourceDocumentId', src.document_id,
								'sourceRevisionId', src.revision_id, 'sourceRevision', ${input.revision}::int, 'contentHash', ${hash}::text),
							${input.expectedVersion}::bigint, ${version}::bigint, '{}'::jsonb
						FROM updated, src
						RETURNING id
					)
					SELECT (SELECT ok FROM gate) AS ok, (SELECT id FROM updated) AS id, (SELECT count(*) FROM aud) AS audited`,
				);
			} catch (error) {
				// A race on the same request key meets the stable revision id; another update from the same version meets the
				// unique version number. The first gets what the winner wrote, the second has no request of its own: a conflict.
				if (postgresCode(error) !== "23505") throw error;
				return sameUpdate(db, scope, input.requestKey, requestHash);
			}
			const row = found[0];
			if (!row?.ok) deny("access_denied");
			// Nothing written: the template or the source changed after the read. When it was this request on the same key
			// that landed first, answer with what it made; anything else is a conflict.
			if (!row.id) return sameUpdate(db, scope, input.requestKey, requestHash);
			return c.updatedChurchTemplate.parse({
				template:
					templateSummary({
						id: row.id,
						title: src.title,
						body,
						source_document_id: input.documentId,
						source_revision_id: src.revision_id,
						source_revision: input.revision,
					}) ?? deny("render_failed"),
				replacedVersion: input.expectedVersion,
			});
		});
	},

	/**
	 * Delete a church template: it leaves "New from template". Its row and revision stay, so documents made from it
	 * keep naming it, and they keep their own full copy. One statement checks the seat and writes one audit row naming
	 * the source document and revision.
	 */
	async deleteTemplate(db: Database, authority: RequestActor, raw: unknown) {
		return settle(async () => {
			const input = parse(c.deleteChurchTemplateRequest, raw);
			const scope = adminScope(authority);
			const found = await rowsOf<{ ok: boolean; deleted: string | null }>(
				db,
				sql`WITH gate AS (SELECT ${gateSql(scope, true)} AS ok),
				upd AS (
					UPDATE document SET archived_at = clock_timestamp()
					FROM gate
					WHERE gate.ok AND document.id = ${input.templateId}::uuid AND document.tenant_id = ${scope.tenantId}::uuid
						AND document.kind = 'church_template' AND document.archived_at IS NULL
					RETURNING document.id, document.tenant_id, document.copied_from_revision_id
				),
				aud AS (
					INSERT INTO audit_event (
						tenant_id, actor_id, action, kind, subject_id, occurred_at, recorded_at, event_key, after_value, metadata
					)
					SELECT ${scope.tenantId}::uuid, ${scope.accountId}::uuid, 'documents.template_deleted', 'archive', upd.id,
						clock_timestamp(), clock_timestamp(), 'church-template-deleted:' || upd.id::text,
						jsonb_build_object('sourceDocumentId', s.document_id, 'sourceRevisionId', s.id, 'sourceRevision', s.version_number),
						'{}'::jsonb
					FROM upd JOIN document_revision s ON s.id = upd.copied_from_revision_id AND s.tenant_id = upd.tenant_id
					RETURNING id
				)
				SELECT (SELECT ok FROM gate) AS ok, (SELECT id FROM upd) AS deleted, (SELECT count(*) FROM aud) AS audited`,
			);
			const row = found[0];
			if (!row?.ok) deny("access_denied");
			if (!row.deleted) deny("unavailable");
			return c.deletedChurchTemplate.parse({ templateId: row.deleted, deleted: true });
		});
	},

	/**
	 * The bytes of one revision in one format: the preview and every download read this, so the preview is the PDF that
	 * Download gives. Any seat reads it. It stores nothing.
	 */
	async readChurchFile(db: Database, authority: RequestActor, raw: unknown, storage: PrivateStorage | null) {
		return settle(async () => {
			const input = parse(c.churchFileRequest, raw);
			const scope = readerScope(authority);
			const found = await rowsOf<{
				ok: boolean;
				id: string | null;
				template_id: string | null;
				use_church_branding: boolean | null;
				version_number: number | null;
				body: string | null;
				recorded_at: Date | string | null;
				kit: Record<string, unknown> | null;
			}>(
				db,
				sql`SELECT g.ok, d.id, d.template_id, d.use_church_branding, r.version_number, r.body, r.recorded_at,
					to_jsonb(k) AS kit
				FROM (SELECT ${gateSql(scope, false)} AS ok) g
				LEFT JOIN document d ON g.ok AND d.id = ${input.documentId}::uuid AND d.tenant_id = ${scope.tenantId}::uuid
					AND d.kind = 'church_document' AND d.archived_at IS NULL
				LEFT JOIN document_revision r ON r.document_id = d.id AND r.tenant_id = d.tenant_id
					AND ${input.revision === undefined ? sql`r.id = d.current_revision_id` : sql`r.version_number = ${input.revision}`}
				LEFT JOIN church_brand_kit k ON g.ok AND k.tenant_id = ${scope.tenantId}::uuid`,
			);
			const row = found[0];
			if (!row?.ok) deny("access_denied");
			if (!row.id || !row.template_id || row.body === null || row.version_number === null) deny("unavailable");
			const body = storedDoc(row.body);
			if (!body) deny("render_failed");
			const { bytes } = await renderRevision(db, storage, authority, body, row, input.format);
			return c.churchFile.parse({
				documentId: row.id,
				revision: Number(row.version_number),
				format: input.format,
				mediaType: MEDIA[input.format],
				downloadName: `${row.template_id}-revision-${row.version_number}.${input.format}`,
				digest: digestOf(bytes),
				bytes: bytes.toString("base64"),
			});
		});
	},

	/**
	 * An Owner or Admin deletes a Church Document from the library: the document is marked deleted and its revisions
	 * stay for the audit trail. One statement checks the seat and the expected revision and writes one audit row.
	 */
	async deleteChurch(db: Database, authority: RequestActor, raw: unknown) {
		return settle(async () => {
			const input = parse(c.deleteChurchRequest, raw);
			const scope = adminScope(authority);
			const found = await rowsOf<{
				ok: boolean;
				found: string | null;
				revision: string | null;
				deleted: string | null;
			}>(
				db,
				sql`WITH gate AS (SELECT ${gateSql(scope, true)} AS ok),
				existing AS (
					SELECT d.id, d.revision FROM document d JOIN gate ON gate.ok
					WHERE d.id = ${input.documentId}::uuid AND d.tenant_id = ${scope.tenantId}::uuid AND d.kind = 'church_document'
						AND d.archived_at IS NULL
				),
				upd AS (
					UPDATE document SET archived_at = clock_timestamp()
					FROM existing
					WHERE document.id = existing.id AND existing.revision = ${input.expectedRevision}::bigint
					RETURNING document.id, document.revision
				),
				aud AS (
					INSERT INTO audit_event (
						tenant_id, actor_id, action, kind, subject_id, occurred_at, recorded_at, event_key, after_revision, metadata
					)
					SELECT ${scope.tenantId}::uuid, ${scope.accountId}::uuid, 'documents.archived', 'archive', upd.id,
						clock_timestamp(), clock_timestamp(), 'church-document-deleted:' || upd.id::text, upd.revision, '{}'::jsonb
					FROM upd
					RETURNING id
				)
				SELECT (SELECT ok FROM gate) AS ok, (SELECT id FROM existing) AS found, (SELECT revision::text FROM existing) AS revision,
					(SELECT id FROM upd) AS deleted, (SELECT count(*) FROM aud) AS audited`,
			);
			const row = found[0];
			if (!row?.ok) deny("access_denied");
			if (!row.found) deny("unavailable");
			if (!row.deleted) deny("conflict");
			return c.deletedChurch.parse({ documentId: row.deleted, deleted: true });
		});
	},

	async "history.list.church"(db: Database, authority: RequestActor, raw: unknown) {
		return settle(async () => {
			const input = parse(c.churchHistoryRequest, raw);
			const scope = readerScope(authority);
			const found = await rowsOf<{
				ok: boolean;
				document_id: string | null;
				id: string | null;
				version_number: number | null;
				author_account_id: string | null;
				recorded_at: Date | string | null;
				content_hash: string | null;
			}>(
				db,
				sql`SELECT g.ok, d.id AS document_id, r.id, r.version_number, r.author_account_id, r.recorded_at, r.content_hash
				FROM (SELECT ${gateSql(scope, false)} AS ok) g
				LEFT JOIN document d ON g.ok AND d.id = ${input.documentId}::uuid AND d.tenant_id = ${scope.tenantId}::uuid
					AND d.kind = 'church_document'
				LEFT JOIN document_revision r ON r.document_id = d.id AND r.tenant_id = d.tenant_id
				ORDER BY r.version_number`,
			);
			if (found[0]?.ok !== true) deny("access_denied");
			if (!found[0].document_id) deny("unavailable");
			return c.churchRevisionList.parse({
				documentId: input.documentId,
				revisions: found
					.filter((row) => row.id)
					.map((row) => ({
						id: row.id,
						number: row.version_number,
						authorAccountId: row.author_account_id,
						recordedAt: iso(row.recorded_at),
						contentHash: row.content_hash,
					})),
			});
		});
	},

	async "history.get.church"(db: Database, authority: RequestActor, raw: unknown) {
		return settle(async () => {
			const input = parse(c.churchRevisionRequest, raw);
			const scope = readerScope(authority);
			const found = await rowsOf<{
				ok: boolean;
				id: string | null;
				version_number: number | null;
				author_account_id: string | null;
				recorded_at: Date | string | null;
				content_hash: string | null;
				body: string | null;
			}>(
				db,
				sql`SELECT g.ok, r.id, r.version_number, r.author_account_id, r.recorded_at, r.content_hash, r.body
				FROM (SELECT ${gateSql(scope, false)} AS ok) g
				LEFT JOIN document d ON g.ok AND d.id = ${input.documentId}::uuid AND d.tenant_id = ${scope.tenantId}::uuid
					AND d.kind = 'church_document'
				LEFT JOIN document_revision r ON r.document_id = d.id AND r.tenant_id = d.tenant_id
					AND r.version_number = ${input.revision}`,
			);
			if (found[0]?.ok !== true) deny("access_denied");
			const row = found[0];
			if (!row.id || row.body === null) deny("unavailable");
			return c.churchRevision.parse({
				id: row.id,
				number: row.version_number,
				authorAccountId: row.author_account_id,
				recordedAt: iso(row.recorded_at),
				contentHash: row.content_hash,
				documentId: input.documentId,
				body: storedDoc(row.body) ?? deny("render_failed"),
			});
		});
	},
};

/** The image sources a body uses, so the render reads only those brand assets. */
function imageSources(node: unknown, found = new Set<ImageSource>()) {
	if (node && typeof node === "object") {
		const n = node as { type?: string; attrs?: { source?: ImageSource }; content?: unknown[] };
		if (n.type === "image") found.add(n.attrs?.source ?? "logo");
		for (const child of n.content ?? []) imageSources(child, found);
	}
	return found;
}

/**
 * The bytes of one stored revision in one format, with the theme chosen now: the church theme when the document uses
 * church branding and the plant has a brand kit, else the Everyfield-neutral theme. One render path for the preview,
 * every download and the saved export.
 */
async function renderRevision(
	db: Database,
	storage: PrivateStorage | null,
	authority: RequestActor,
	body: c.DocDocument,
	row: { kit: Record<string, unknown> | null; use_church_branding: boolean | null; recorded_at: Date | string | null },
	format: DocFormat,
) {
	const church = fieldValues(body).church_name ?? body.title;
	const theme = await exportTheme(
		db,
		storage,
		authority,
		{ name: church, kit: row.kit ? dataFromRow(row.kit) : null },
		body.class,
		row.use_church_branding === true,
		imageSources(body.body),
	);
	try {
		const bytes = await renderDocFile(body, format, theme, new Date(row.recorded_at ?? 0));
		return { bytes, theme };
	} catch (error) {
		if (error instanceof RenderFailed) deny(docFormats(body).includes(format) ? "render_failed" : "unavailable");
		throw error;
	}
}

/** The template one request key made, when the same request made it; another request on that key is a conflict. */
async function sameTemplate(db: Database, scope: Scope, requestKey: string, requestHash: string) {
	const found = await rowsOf<TemplateRow & { hash: string | null }>(
		db,
		sql`SELECT a.after_value->>'hash' AS hash, t.id, t.title, r.body, r.recorded_at AS created_at,
			s.document_id AS source_document_id, s.id AS source_revision_id, s.version_number AS source_revision
		FROM audit_event a
		JOIN document t ON t.id = a.subject_id AND t.tenant_id = a.tenant_id AND t.kind = 'church_template'
		JOIN document_revision r ON r.id = t.current_revision_id AND r.tenant_id = t.tenant_id
		JOIN document_revision s ON s.id = t.copied_from_revision_id AND s.tenant_id = t.tenant_id
		WHERE a.tenant_id = ${scope.tenantId}::uuid AND a.request_key = ${requestKey} AND a.action = 'documents.template_saved'
			AND ${gateSql(scope, true)}`,
	);
	const row = found[0];
	if (!row || row.hash !== requestHash) deny("conflict");
	return templateSummary(row) ?? deny("conflict");
}

/** The version one request key made, when the same request made it; another request on that key is a conflict. */
async function sameUpdate(db: Database, scope: Scope, requestKey: string, requestHash: string) {
	const found = await rowsOf<TemplateRow & { hash: string | null; replaced: string }>(
		db,
		sql`SELECT a.after_value->>'hash' AS hash, a.before_revision::text AS replaced, t.id, t.title, r.body,
			s.document_id AS source_document_id, s.id AS source_revision_id, s.version_number AS source_revision
		FROM audit_event a
		JOIN document t ON t.id = a.subject_id AND t.tenant_id = a.tenant_id AND t.kind = 'church_template'
		JOIN document_revision r ON r.document_id = t.id AND r.tenant_id = t.tenant_id AND r.version_number = a.after_revision
		JOIN document_revision s ON s.id = (a.after_value->>'sourceRevisionId')::uuid AND s.tenant_id = a.tenant_id
		WHERE a.tenant_id = ${scope.tenantId}::uuid AND a.request_key = ${requestKey} AND a.action = 'documents.template_updated'
			AND ${gateSql(scope, true)}`,
	);
	const row = found[0];
	if (!row || row.hash !== requestHash) deny("conflict");
	const template = templateSummary(row) ?? deny("conflict");
	return c.updatedChurchTemplate.parse({ template, replacedVersion: Number(row.replaced) });
}

/** One saved export, as the history lists it. */
async function exportRecord(db: Database, scope: Scope, id: string) {
	const [row] = await historyRows(db, scope, id);
	if (!row) deny("unavailable");
	return generatedFrom(row, scope.tenantId, row.template_id);
}
