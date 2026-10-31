import * as c from "@everyfield/contracts/documents";
import type { Database } from "@everyfield/db/client";
import { sql } from "@everyfield/db/query";
import type { PrivateStorage } from "@everyfield/db/schema";
import { createHash, randomUUID } from "node:crypto";
import "server-only";
import type { RequestActor } from "../access/session.ts";
import { dataFromRow } from "../branding/kit.ts";
import { deny, parse, plantViewer, readPlant, rejectInput, settle } from "./access.ts";
import { exportTheme } from "./church-theme.ts";
import { renderChurchDocx, renderChurchPdf } from "./church-render.ts";
import { cleanOverrides } from "./merge.ts";
import { RenderFailed, digestOf, renderEngineVersion } from "./render.ts";
import {
	ARTIFACT_MAX,
	MEDIA,
	gateSql,
	iso,
	plantScope,
	postgresCode,
	rowsOf,
	storeBytes,
	type Scope,
} from "./scope.ts";
import {
	CHURCH_TEMPLATES,
	NOT_EDITABLE,
	PENDING_EDITABLE,
	churchTemplate,
	resolveBody,
	type ChurchTemplate,
} from "./templates/church.ts";
import { entryFor } from "./templates/registry.ts";

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
type ChurchRow = {
	id: string;
	template_id: string;
	template_version: number;
	document_class: "formal/legal" | "outward-facing" | "operational";
	use_church_branding: boolean;
	title: string;
	revision: string;
	revision_id: string;
	body: string;
	content_hash: string;
	archived: boolean;
	input_provenance: Provenance;
};

function churchFrom(row: ChurchRow, tenantId: string) {
	return c.churchDocument.parse({
		id: row.id,
		tenantId,
		templateId: row.template_id,
		templateVersion: Number(row.template_version),
		documentClass: row.document_class,
		useChurchBranding: row.use_church_branding,
		title: row.title,
		revision: String(row.revision),
		revisionId: row.revision_id,
		body: JSON.parse(row.body),
		contentHash: row.content_hash,
		archived: row.archived,
		provenance: row.input_provenance,
	});
}

/** The current state of one Church Document, as a reader sees it. One statement. */
async function readChurch(db: Database, scope: Scope, documentId: string, admin = false) {
	const found = await rowsOf<ChurchRow & { ok: boolean }>(
		db,
		sql`SELECT g.ok, d.id, d.template_id, d.template_version, d.document_class, d.use_church_branding, d.title,
			d.revision::text AS revision, r.id AS revision_id, r.body, r.content_hash, d.archived_at IS NOT NULL AS archived,
			d.input_provenance
		FROM (SELECT ${gateSql(scope, admin)} AS ok) g
		LEFT JOIN document d ON g.ok AND d.id = ${documentId}::uuid AND d.tenant_id = ${scope.tenantId}::uuid
			AND d.kind = 'church_document' AND d.current_revision_id IS NOT NULL
		LEFT JOIN document_revision r ON r.id = d.current_revision_id AND r.tenant_id = d.tenant_id`,
	);
	if (found[0]?.ok !== true) deny("access_denied");
	if (!found[0].id) return null;
	return churchFrom(found[0], scope.tenantId);
}

function safeJson(text: string): unknown {
	try {
		return JSON.parse(text);
	} catch {
		return null;
	}
}

function templateFor(id: string): ChurchTemplate {
	const template = churchTemplate(id);
	if (template) return template;
	if ((PENDING_EDITABLE as readonly string[]).includes(id)) deny("template_not_authored");
	if ((NOT_EDITABLE as readonly string[]).includes(id) || entryFor(id)) deny("template_not_editable");
	deny("unavailable");
}

export const churchWriter = {
	/** CASE-DOC-022: revision 1 holds the template body with the merge values resolved once. It makes no file. */
	async createFromTemplate(db: Database, authority: RequestActor, raw: unknown) {
		return settle(async () => {
			const input = parse(c.createFromTemplateRequest, raw);
			const scope = adminScope(authority);
			const cleaned = cleanOverrides(input.mergeFields);
			if (!cleaned.ok) rejectInput(cleaned.path, cleaned.problem);
			const template = templateFor(input.templateId);
			const known = new Set(template.mergeFields.map((field) => field.key));
			const foreign = Object.keys(cleaned.values).find((key) => !known.has(key));
			if (foreign) rejectInput(`mergeFields.${foreign}`, "Unknown merge field.");
			const plant = await readPlant(
				db,
				{ ...scope, plantId: scope.tenantId },
				{ personId: null, meetingId: null, teamId: null },
			);
			if (!plant.open) deny("access_denied");
			if (!plant.subjectOk) deny("unavailable");
			const sources: Record<string, { value: string | null; source: string }> = {
				church_name: cleaned.values.church_name
					? { value: cleaned.values.church_name, source: "override" }
					: { value: plant.churchName, source: plant.churchName ? "church_name" : "absent" },
				pastor_name: cleaned.values.pastor_name
					? { value: cleaned.values.pastor_name, source: "override" }
					: { value: plant.pastorName, source: plant.pastorName ? "pastor_name" : "absent" },
			};
			if (!sources.church_name?.value) deny("unavailable");
			const provenance: Provenance = template.mergeFields.map((field) => ({
				key: field.key,
				value: sources[field.key]?.value ?? null,
				source: sources[field.key]?.source ?? "absent",
			}));
			const values = Object.fromEntries(provenance.map((p) => [p.key, p.value]));
			const checked = c.churchBody.safeParse(resolveBody(template.body, values));
			if (!checked.success) rejectInput("mergeFields", "The merge values make the document too large.");
			const body = JSON.stringify(checked.data);
			const hash = hashOf(body);
			const requestHash = hashOf(JSON.stringify([template.id, cleaned.values]));
			const docId = stableId(scope.tenantId, "church-document", input.requestKey);
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
							${template.id}, ${template.version}, ${template.documentClass}, true, ${JSON.stringify(provenance)}::jsonb
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
			return c.churchDocument.parse({
				id: row.id,
				tenantId: scope.tenantId,
				templateId: template.id,
				templateVersion: template.version,
				documentClass: template.documentClass,
				useChurchBranding: true,
				title: template.title,
				revision: "1",
				revisionId: revId,
				body: checked.data,
				contentHash: hash,
				archived: false,
				provenance,
			});
		});
	},

	/**
	 * `documents.saveNative` on a Church Document: one attributed revision, or a refusal that writes nothing. One
	 * statement checks the seat, the expected revision and the slots, and writes the revision and its audit row.
	 */
	async saveChurch(db: Database, authority: RequestActor, input: c.ChurchSave) {
		const scope = adminScope(authority);
		const body = JSON.stringify(input.body);
		const hash = hashOf(body);
		const revId = randomUUID();
		const slotMap = Object.fromEntries(CHURCH_TEMPLATES.map((t) => [t.id, t.slots.map((s) => s.id)]));
		const provided = JSON.stringify(c.slotIdsOf(input.body));
		const found = await rowsOf<{
			ok: boolean;
			found: string | null;
			archived: boolean | null;
			prior_revision: string | null;
			missing: string[] | null;
			unknown: string[] | null;
			stored: string | null;
			next_revision: string | null;
			template_id: string | null;
			template_version: number | null;
			document_class: ChurchRow["document_class"] | null;
			use_church_branding: boolean | null;
			title: string | null;
			input_provenance: Provenance | null;
		}>(
			db,
			sql`WITH gate AS (SELECT ${gateSql(scope, true)} AS ok),
			existing AS (
				SELECT d.id, d.tenant_id, d.revision, d.archived_at, d.template_id, d.template_version, d.document_class,
					d.use_church_branding, d.title, d.input_provenance,
					coalesce(ARRAY(SELECT jsonb_array_elements_text(${JSON.stringify(slotMap)}::jsonb -> d.template_id)), '{}') AS need
				FROM document d JOIN gate ON gate.ok
				WHERE d.id = ${input.documentId}::uuid AND d.tenant_id = ${scope.tenantId}::uuid AND d.kind = 'church_document'
			),
			slots AS (
				SELECT existing.id,
					ARRAY(SELECT n FROM unnest(existing.need) n WHERE NOT n = ANY (ARRAY(SELECT jsonb_array_elements_text(${provided}::jsonb)))) AS missing,
					ARRAY(SELECT p FROM unnest(ARRAY(SELECT jsonb_array_elements_text(${provided}::jsonb))) p WHERE NOT p = ANY (existing.need)) AS unknown
				FROM existing
			),
			added AS (
				INSERT INTO document_revision (
					id, tenant_id, document_id, version_number, body, content_hash, published_at, recorded_at, author_account_id
				)
				SELECT ${revId}::uuid, existing.tenant_id, existing.id, (existing.revision + 1)::int, ${body}, ${hash},
					clock_timestamp(), clock_timestamp(), ${scope.accountId}::uuid
				FROM existing JOIN slots ON slots.id = existing.id
				WHERE existing.archived_at IS NULL AND existing.revision = ${input.expectedRevision}::bigint
					AND cardinality(slots.missing) = 0 AND cardinality(slots.unknown) = 0
				RETURNING id, document_id
			),
			updated AS (
				UPDATE document SET current_revision_id = added.id, revision = document.revision + 1
				FROM added WHERE document.id = added.document_id
				RETURNING document.id, document.revision::text AS revision
			),
			aud AS (
				INSERT INTO audit_event (
					tenant_id, actor_id, action, kind, subject_id, occurred_at, recorded_at, event_key, after_revision, metadata
				)
				SELECT ${scope.tenantId}::uuid, ${scope.accountId}::uuid, 'documents.saved', 'edit', updated.id,
					clock_timestamp(), clock_timestamp(), 'church-document:' || updated.id::text || ':' || updated.revision,
					updated.revision::bigint, '{}'::jsonb
				FROM updated
				RETURNING id
			)
			SELECT (SELECT ok FROM gate) AS ok, (SELECT id FROM existing) AS found, (SELECT archived_at IS NOT NULL FROM existing) AS archived,
				(SELECT revision::text FROM existing) AS prior_revision, (SELECT missing FROM slots) AS missing,
				(SELECT unknown FROM slots) AS unknown, (SELECT id FROM updated) AS stored, (SELECT revision FROM updated) AS next_revision,
				(SELECT template_id FROM existing) AS template_id, (SELECT template_version FROM existing) AS template_version,
				(SELECT document_class FROM existing) AS document_class, (SELECT use_church_branding FROM existing) AS use_church_branding,
				(SELECT title FROM existing) AS title, (SELECT input_provenance FROM existing) AS input_provenance,
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
		if (row.missing?.length) deny("slot_not_deletable", { slotIds: row.missing });
		if (row.unknown?.length) rejectInput("body", `Slot ${row.unknown[0]} is not on this template.`);
		if (!row.stored || !row.next_revision || !row.template_id || !row.document_class || !row.input_provenance)
			deny("conflict");
		return c.churchDocument.parse({
			id: row.stored,
			tenantId: scope.tenantId,
			templateId: row.template_id,
			templateVersion: Number(row.template_version),
			documentClass: row.document_class,
			useChurchBranding: row.use_church_branding,
			title: row.title,
			revision: row.next_revision,
			revisionId: revId,
			body: input.body,
			contentHash: hash,
			archived: false,
			provenance: row.input_provenance,
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
				archived: boolean | null;
				revision_id: string | null;
				body: string | null;
				recorded_at: Date | string | null;
				kit: Record<string, unknown> | null;
				prior_id: string | null;
				prior_same: boolean | null;
			}>(
				db,
				sql`SELECT g.ok, d.id, d.template_id, d.template_version, d.document_class, d.use_church_branding,
					d.input_provenance, d.archived_at IS NOT NULL AS archived, r.id AS revision_id, r.body, r.recorded_at,
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
			const template = templateFor(row.template_id);
			// A stored body that no longer meets the limits (1,000 blocks, safe text) is a failed render, not a crash.
			const parsed = c.churchBody.safeParse(safeJson(row.body));
			if (!parsed.success) deny("render_failed");
			const body = parsed.data;
			const frozen = (key: string) => row.input_provenance?.find((p) => p.key === key)?.value ?? null;
			const church = frozen("church_name");
			if (!church) deny("unavailable");
			const theme = await exportTheme(
				db,
				storage,
				authority,
				{ name: church, kit: row.kit ? dataFromRow(row.kit) : null },
				template.documentClass,
				row.use_church_branding === true,
			);
			const render = {
				template,
				body,
				church,
				pastorName: frozen("pastor_name"),
				theme,
				savedAt: new Date(row.recorded_at ?? 0),
			};
			let bytes: Buffer;
			try {
				bytes = input.format === "pdf" ? (await renderChurchPdf(render)).bytes : renderChurchDocx(render);
			} catch (error) {
				if (error instanceof RenderFailed) deny("render_failed");
				throw error;
			}
			if (bytes.length > ARTIFACT_MAX) deny("render_failed");
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
			const name = `${template.id}-revision-${input.revision}.${input.format}`;
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
						SELECT ${id}::uuid, ${scope.tenantId}::uuid, ${scope.accountId}::uuid, ${template.id}, ${String(row.template_version)},
							${template.name}, ${renderEngineVersion()}, ${input.format}, ${file.id}::uuid, '[]'::jsonb, ${name},
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
						templateId: template.id,
						templateVersion: String(row.template_version),
						savedTemplateName: template.name,
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
				body: JSON.parse(row.body),
			});
		});
	},
};

/** One saved export, as the history lists it. */
async function exportRecord(db: Database, scope: Scope, id: string) {
	const found = await rowsOf<{
		id: string;
		template_id: string;
		template_version: string;
		saved_template_name: string;
		format: "pdf" | "docx";
		download_name: string;
		generated_at: Date | string;
		creator_account_id: string | null;
		revision: string;
		sha256: string;
		byte_count: string | number;
		source_document_id: string;
		source_revision_id: string;
		source_number: number;
		theme_kind: "church" | "everyfield-neutral";
		theme_primary: string | null;
	}>(
		db,
		sql`SELECT gd.id, gd.template_id, gd.template_version, gd.saved_template_name, gd.format, gd.download_name, gd.generated_at,
			gd.creator_account_id, gd.revision::text AS revision, f.sha256, f.byte_count, gd.source_document_id, gd.source_revision_id,
			sr.version_number AS source_number, gd.theme_kind, gd.theme_primary
		FROM generated_document gd
		JOIN file_object f ON f.id = gd.object_id AND f.tenant_id = gd.tenant_id AND f.state = 'ready'
		JOIN document_revision sr ON sr.id = gd.source_revision_id AND sr.tenant_id = gd.tenant_id
		WHERE gd.id = ${id}::uuid AND gd.tenant_id = ${scope.tenantId}::uuid AND ${gateSql(scope, false)}`,
	);
	const row = found[0];
	if (!row) deny("unavailable");
	return c.generatedDocument.parse({
		id: row.id,
		plantId: scope.tenantId,
		templateId: row.template_id,
		templateVersion: row.template_version,
		savedTemplateName: row.saved_template_name,
		format: row.format,
		digest: row.sha256,
		byteCount: Number(row.byte_count),
		downloadName: row.download_name,
		generatedAt: iso(row.generated_at),
		creatorAccountId: row.creator_account_id,
		revision: row.revision,
		source: {
			documentId: row.source_document_id,
			revisionId: row.source_revision_id,
			revision: Number(row.source_number),
		},
		theme: { kind: row.theme_kind, primary: row.theme_primary },
	});
}
