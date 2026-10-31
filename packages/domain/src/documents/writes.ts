import * as c from "@everyfield/contracts/documents";
import type { Database } from "@everyfield/db/client";
import { sql } from "@everyfield/db/query";
import {
	createAuthorizedDownload,
	deleteUnreferencedObject,
	type PrivateStorage,
	type ResourceAuthorizer,
} from "@everyfield/db/schema";
import { createHash, randomUUID } from "node:crypto";
import "server-only";
import type { z } from "zod";
import { type RequestActor } from "../access/session.ts";
import { deny, parse, plantViewer, readPlant, rejectInput, settle } from "./access.ts";
import { churchWriter } from "./church-writes.ts";
import { editableState, library } from "./catalog.ts";
import { cleanOverrides, resolveMerge } from "./merge.ts";
import { RenderFailed, digestOf, renderEngineVersion, renderPreview } from "./render.ts";
import {
	ARTIFACT_MAX,
	MEDIA,
	PAGE,
	gateSql,
	generatedFrom,
	historyRows,
	iso,
	plantScope,
	postgresCode,
	refuseStorage,
	rowsOf,
	sameRevision,
	storeBytes,
	type Scope,
} from "./scope.ts";
import { ImportRejected, readImport } from "./unpack.ts";

type OwnedRow = {
	id: string;
	tenant_id?: string;
	kind: "native" | "core_values" | "launch_summary";
	title: string;
	body: string;
	revision: string;
	content_hash: string;
	archived: boolean;
	copied_from_revision_id: string | null;
	copied_from_hash: string | null;
};

function hashOf(body: string) {
	return createHash("sha256").update(body, "utf8").digest("hex");
}

function accountScope(authority: RequestActor): Scope | null {
	if (authority.actor.context.kind !== "account") return null;
	const accountId = authority.actor.accountId;
	return {
		kind: "account",
		tenantId: accountId,
		accountId,
		access: { session: authority.session, owner: { kind: "account", id: accountId } },
	};
}

function viewScope(authority: RequestActor) {
	const viewer = plantViewer(authority);
	return accountScope(authority) ?? (viewer ? plantScope(viewer) : null);
}

function editScope(authority: RequestActor) {
	const account = accountScope(authority);
	if (account) return account;
	const viewer = plantViewer(authority);
	if (!viewer || viewer.access.role === "member") return null;
	return plantScope(viewer);
}

function generateScope(authority: RequestActor) {
	const viewer = plantViewer(authority);
	return viewer ? plantScope(viewer) : null;
}

function copyScope(authority: RequestActor) {
	const viewer = plantViewer(authority);
	if (!viewer || viewer.access.role === "member") return null;
	return plantScope(viewer);
}

function ownedFrom(row: OwnedRow, tenantId: string) {
	return c.ownedDocument.parse({
		id: row.id,
		tenantId: row.tenant_id ?? tenantId,
		kind: row.kind,
		title: row.title,
		body: row.body,
		revision: row.revision,
		contentHash: row.content_hash,
		archived: row.archived,
		copiedFromRevisionId: row.copied_from_revision_id,
		copiedFromHash: row.copied_from_hash,
	});
}

const generatedWriter = {
	async generate(db: Database, authority: RequestActor, raw: unknown, storage: PrivateStorage | null) {
		return settle(async () => {
			const input = parse(c.generateRequest, raw);
			const cleaned = cleanOverrides(input.overrides);
			if (!cleaned.ok) rejectInput(cleaned.path, cleaned.problem);
			const scope = generateScope(authority);
			if (!scope) deny();
			// An editable template makes a Church Document with createFromTemplate. It never saves a file here.
			if (editableState(input.templateId)) deny("template_is_editable");
			const loaded = await library();
			const template = loaded.templates.find((item) => item.id === input.templateId);
			if (!template) deny();
			if (!template.formats.includes(input.format)) rejectInput("format", "Format is not on this template.");
			if (template.name.length > 200) deny();
			const plant = await readPlant(
				db,
				{ ...scope, plantId: scope.tenantId },
				{
					personId: input.personId ?? null,
					meetingId: input.meetingId ?? null,
					teamId: input.teamId ?? null,
				},
			);
			if (!plant.open) deny();
			if (!plant.subjectOk) deny("invalid_subject");
			const resolved = resolveMerge(
				template,
				{ churchName: plant.churchName, pastorName: plant.pastorName, launchDate: plant.launchDate },
				cleaned.values,
			);
			if (!resolved.ok) rejectInput(resolved.path, resolved.problem);
			const inputs = resolved.fields.map((field) => ({ key: field.key, value: field.value, source: field.source }));
			const stored = await rowsOf<{
				id: string;
				template_version: string;
				saved_template_name: string;
				format: "pdf" | "docx" | "xlsx";
				download_name: string;
				generated_at: Date | string;
				creator_account_id: string | null;
				revision: string;
				sha256: string;
				byte_count: string | number;
				same: boolean;
			}>(
				db,
				sql`SELECT gd.id, gd.template_version, gd.saved_template_name, gd.format, gd.download_name, gd.generated_at,
					gd.creator_account_id, gd.revision::text AS revision, f.sha256, f.byte_count,
					(gd.template_id = ${template.id} AND gd.template_version = ${loaded.version} AND gd.format = ${input.format}
						AND gd.inputs = ${JSON.stringify(inputs)}::jsonb) AS same
				FROM generated_document gd
				JOIN file_object f ON f.id = gd.object_id AND f.tenant_id = gd.tenant_id AND f.state = 'ready'
				WHERE gd.tenant_id = ${scope.tenantId}::uuid AND gd.request_key = ${input.requestKey}
					AND ${gateSql(scope, false)}`,
			);
			const prior = stored[0];
			if (prior?.same) return generatedFrom(prior, scope.tenantId, template.id);
			if (prior) deny("conflict");
			if (!resolved.complete) rejectInput("overrides", "A required merge field is empty.");
			let bytes: Buffer | null;
			try {
				bytes = await renderPreview(template, input.format, resolved);
			} catch (error) {
				if (error instanceof RenderFailed) deny("render_failed");
				throw error;
			}
			if (!bytes) rejectInput("overrides", "A required merge field is empty.");
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
							id, tenant_id, creator_account_id, template_id, template_version, saved_template_name,
							renderer_version, format, object_id, inputs, download_name, generated_at, request_key
						)
						SELECT ${id}::uuid, ${scope.tenantId}::uuid, ${scope.accountId}::uuid, ${template.id}, ${loaded.version},
							${template.name}, ${renderEngineVersion()}, ${input.format}, ${file.id}::uuid,
							${JSON.stringify(inputs)}::jsonb, ${`${template.id}.${input.format}`}, clock_timestamp(), ${input.requestKey}
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
						SELECT ${scope.tenantId}::uuid, ${scope.accountId}::uuid, 'documents.generated', 'create', ins.id,
							clock_timestamp(), clock_timestamp(), 'generated:' || ins.id::text, ${input.requestKey}, '{}'::jsonb
						FROM ins
						RETURNING id
					)
					SELECT (SELECT ok FROM gate) AS ok, (SELECT id FROM ins) AS id,
						(SELECT generated_at FROM ins) AS generated_at, (SELECT revision FROM ins) AS revision,
						(SELECT count(*) FROM aud) AS audited`,
				);
				const row = inserted[0];
				if (!row?.ok) deny();
				if (row.id && row.generated_at && row.revision)
					return c.generatedDocument.parse({
						id: row.id,
						plantId: scope.tenantId,
						templateId: template.id,
						templateVersion: loaded.version,
						savedTemplateName: template.name,
						format: input.format,
						digest: digestOf(bytes),
						byteCount: bytes.length,
						downloadName: `${template.id}.${input.format}`,
						generatedAt: iso(row.generated_at),
						creatorAccountId: scope.accountId,
						revision: row.revision,
						source: null,
						theme: null,
					});
			} catch (error) {
				if (postgresCode(error) !== "23505") {
					if (postgresCode(error) === "42501" || postgresCode(error) === "23514") deny();
					throw error;
				}
			}
			const raced = await rowsOf<{ same: boolean } & Parameters<typeof generatedFrom>[0]>(
				db,
				sql`SELECT gd.id, gd.template_id, gd.template_version, gd.saved_template_name, gd.format, gd.download_name,
					gd.generated_at, gd.creator_account_id, gd.revision::text AS revision, f.sha256, f.byte_count,
					(gd.template_id = ${template.id} AND gd.template_version = ${loaded.version} AND gd.format = ${input.format}
						AND gd.inputs = ${JSON.stringify(inputs)}::jsonb) AS same
				FROM generated_document gd
				JOIN file_object f ON f.id = gd.object_id AND f.state = 'ready'
				WHERE gd.tenant_id = ${scope.tenantId}::uuid AND gd.request_key = ${input.requestKey}`,
			);
			if (raced[0]?.same) return generatedFrom(raced[0], scope.tenantId, template.id);
			deny("conflict");
		});
	},

	async download(db: Database, authority: RequestActor, raw: unknown, storage: PrivateStorage | null) {
		return settle(async () => {
			const input = parse(c.generatedDocumentRequest, raw);
			if (!storage) deny();
			const scope = generateScope(authority);
			if (!scope) deny();
			const found = await rowsOf<{ object_id: string }>(
				db,
				sql`SELECT f.id AS object_id
				FROM generated_document gd
				JOIN file_object f ON f.id = gd.object_id AND f.tenant_id = gd.tenant_id AND f.state = 'ready'
				WHERE gd.id = ${input.documentId}::uuid AND gd.tenant_id = ${scope.tenantId}::uuid
					AND ${gateSql(scope, false)}`,
			);
			if (!found[0]) deny();
			const authorize: ResourceAuthorizer = async (tx, file, intent) => {
				if (intent !== "read") return null;
				const allowed = await rowsOf<{ ok: boolean }>(
					tx,
					sql`SELECT ${gateSql(scope, false)} AS ok
					FROM generated_document gd
					JOIN file_object f ON f.id = gd.object_id AND f.tenant_id = gd.tenant_id AND f.state = 'ready'
					WHERE gd.id = ${input.documentId}::uuid AND gd.tenant_id = ${scope.tenantId}::uuid AND f.id = ${file.id}::uuid`,
				);
				if (allowed[0]?.ok !== true) return null;
				return { kind: "account", actorId: scope.accountId };
			};
			try {
				return c.downloadResult.parse(await createAuthorizedDownload(db, storage, authorize, found[0].object_id));
			} catch (error) {
				return refuseStorage(error);
			}
		});
	},

	async "history.list"(db: Database, authority: RequestActor, raw: unknown) {
		return settle(async () => {
			parse(c.listHistoryRequest, raw);
			const scope = generateScope(authority);
			if (!scope) deny();
			const found = await historyRows(db, scope, null);
			return c.generatedHistory.parse({
				entries: found.map((row) => generatedFrom(row, scope.tenantId, row.template_id)),
			});
		});
	},

	async "history.get"(db: Database, authority: RequestActor, raw: unknown) {
		return settle(async () => {
			const input = parse(c.generatedDocumentRequest, raw);
			const scope = generateScope(authority);
			if (!scope) deny();
			const found = await historyRows(db, scope, input.documentId);
			if (!found[0]) deny();
			return generatedFrom(found[0], scope.tenantId, found[0].template_id);
		});
	},

	async listOwned(db: Database, authority: RequestActor, raw: unknown) {
		return settle(async () => {
			parse(c.listOwnedRequest, raw);
			const scope = viewScope(authority);
			if (!scope) deny();
			const found = await rowsOf<OwnedRow & { ok: boolean }>(
				db,
				sql`SELECT g.ok, d.id, d.tenant_id, d.kind, d.title, d.revision::text AS revision,
					d.archived_at IS NOT NULL AS archived, d.copied_from_revision_id, d.copied_from_hash, r.body, r.content_hash
				FROM (SELECT ${gateSql(scope, false)} AS ok) g
				LEFT JOIN document d ON g.ok AND d.tenant_id = ${scope.tenantId}::uuid AND d.current_revision_id IS NOT NULL
					AND d.kind <> 'church_document'
				LEFT JOIN document_revision r ON r.id = d.current_revision_id AND r.tenant_id = d.tenant_id
				ORDER BY r.recorded_at DESC NULLS LAST
				LIMIT ${PAGE}`,
			);
			if (found[0]?.ok !== true && found.length > 0) deny();
			if (found.length === 0) deny();
			return c.ownedDocumentPage.parse({
				documents: found.filter((row) => row.id).map((row) => ownedFrom(row, scope.tenantId)),
			});
		});
	},

	async read(db: Database, authority: RequestActor, raw: unknown) {
		return settle(() => readOwned(db, authority, raw));
	},

	async getAuthorized(db: Database, authority: RequestActor, raw: unknown) {
		return settle(() => readOwned(db, authority, raw));
	},

	createFromTemplate: churchWriter.createFromTemplate,
	setBranding: churchWriter.setBranding,
	exportNative: churchWriter.exportNative,

	async readCoreValuesEvidence(db: Database, authority: RequestActor, raw: unknown) {
		return settle(async () => {
			parse(c.readEvidenceRequest, raw);
			const scope = viewScope(authority);
			if (!scope) deny();
			const found = await rowsOf<{ ok: boolean; id: string | null; body: string | null }>(
				db,
				sql`SELECT g.ok, d.id, r.body
				FROM (SELECT ${gateSql(scope, false)} AS ok) g
				LEFT JOIN document d ON g.ok AND d.tenant_id = ${scope.tenantId}::uuid AND d.kind = 'core_values'
					AND d.archived_at IS NULL AND d.current_revision_id IS NOT NULL
				LEFT JOIN document_revision r ON r.id = d.current_revision_id AND r.tenant_id = d.tenant_id
					AND (r.import_state IS NULL OR r.import_state = 'ready') AND length(btrim(r.body)) > 0
				ORDER BY r.recorded_at DESC NULLS LAST
				LIMIT 1`,
			);
			if (!found[0] || found[0].ok !== true) deny();
			if (!found[0].id || !found[0].body) return c.coreValuesEvidence.parse({ documentId: null, text: null });
			return c.coreValuesEvidence.parse({ documentId: found[0].id, text: found[0].body });
		});
	},

	async saveNative(db: Database, authority: RequestActor, raw: unknown) {
		return settle(async () => {
			const input = parse(c.saveNativeRequest, raw);
			if (!input.body.trim()) rejectInput("body", "Body is empty.");
			const scope = editScope(authority);
			if (!scope) deny();
			const hash = hashOf(input.body);
			if (input.expectedRevision === "0") {
				if (input.documentId) rejectInput("documentId", "A new document has no id.");
				return createNative(db, scope, input.title, input.body, hash);
			}
			if (!input.documentId) rejectInput("documentId", "Name the document to replace.");
			return appendNative(db, scope, input.documentId, input.expectedRevision, input.title, input.body, hash, null);
		});
	},

	async archive(db: Database, authority: RequestActor, raw: unknown) {
		return settle(async () => {
			const input = parse(c.archiveDocumentRequest, raw);
			const scope = editScope(authority);
			if (!scope) deny();
			const row = await mutateOwned(db, scope, input.documentId, input.expectedRevision, "archive");
			if (row === "conflict") deny("conflict");
			if (row === "deny" || !row) deny();
			return row;
		});
	},

	async designateCoreValues(db: Database, authority: RequestActor, raw: unknown) {
		return settle(async () => {
			const input = parse(c.designateCoreValuesRequest, raw);
			const scope = editScope(authority);
			if (!scope) deny();
			const row = await mutateOwned(db, scope, input.documentId, input.expectedRevision, "designate");
			if (row === "conflict") deny("conflict");
			if (row === "deny" || !row) deny();
			return row;
		});
	},

	async importTextOrWord(db: Database, authority: RequestActor, raw: unknown, storage: PrivateStorage | null) {
		return settle(async () => {
			const input = parse(c.importDocumentRequest, raw);
			const scope = editScope(authority);
			if (!scope) deny();
			const bytes = decodeImport(input.bytes);
			let text: string;
			try {
				text = readImport(bytes, input.format);
			} catch (error) {
				if (error instanceof ImportRejected) rejectInput("bytes", error.message);
				throw error;
			}
			const hash = hashOf(text);
			const replay = await rowsOf<OwnedRow & { ok: boolean; stored_hash: string | null }>(
				db,
				sql`SELECT g.ok, d.id, d.tenant_id, d.kind, d.title, d.revision::text AS revision,
					d.archived_at IS NOT NULL AS archived, d.copied_from_revision_id, d.copied_from_hash,
					r.body, r.content_hash, a.after_value->>'hash' AS stored_hash
				FROM (SELECT ${gateSql(scope, true)} AS ok) g
				LEFT JOIN audit_event a ON g.ok AND a.tenant_id = ${scope.tenantId}::uuid AND a.request_key = ${input.requestKey}
					AND a.action = 'documents.imported'
				LEFT JOIN document d ON d.id = a.subject_id AND d.tenant_id = a.tenant_id
				LEFT JOIN document_revision r ON r.id = d.current_revision_id AND r.tenant_id = d.tenant_id`,
			);
			if (replay[0]?.ok !== true) deny();
			if (replay[0]?.stored_hash) {
				if (replay[0].content_hash === hash && replay[0].id) return ownedFrom(replay[0], scope.tenantId);
				deny("conflict");
			}
			const file = await storeBytes(
				db,
				storage,
				scope,
				"native_import",
				input.format === "text" ? "text/plain" : MEDIA.docx,
				bytes,
				`import:${scope.tenantId}:${input.requestKey}`,
			);
			const imported = { objectId: file.id, format: input.format, hash, requestKey: input.requestKey };
			if (input.expectedRevision === "0") {
				if (input.documentId) rejectInput("documentId", "A new document has no id.");
				return createNative(db, scope, input.title, text, hash, imported);
			}
			if (!input.documentId) rejectInput("documentId", "Name the document to replace.");
			return appendNative(db, scope, input.documentId, input.expectedRevision, input.title, text, hash, imported);
		});
	},

	async useForChurch(db: Database, authority: RequestActor, raw: unknown) {
		return settle(async () => {
			const input = parse(c.useForChurchRequest, raw);
			const scope = copyScope(authority);
			if (!scope) deny();
			const docId = randomUUID();
			const revId = randomUUID();
			const found = await rowsOf<OwnedRow & { ok: boolean }>(
				db,
				sql`WITH gate AS (SELECT ${gateSql(scope, true)} AS ok),
				source AS (
					SELECT d.kind, d.title, r.id AS revision_id, r.body, r.content_hash
					FROM document d
					JOIN document_revision r ON r.id = ${input.revisionId}::uuid AND r.document_id = d.id AND r.tenant_id = d.tenant_id
					JOIN gate ON gate.ok
					WHERE d.id = ${input.documentId}::uuid AND d.tenant_id = ${scope.accountId}::uuid
						AND d.kind IN ('native', 'core_values') AND length(btrim(r.body)) > 0
				),
				inserted AS (
					INSERT INTO document (id, tenant_id, kind, title, current_revision_id, copied_from_revision_id, copied_from_hash, revision)
					SELECT ${docId}::uuid, ${scope.tenantId}::uuid, source.kind, source.title, ${revId}::uuid, source.revision_id, source.content_hash, 1
					FROM source
					RETURNING id, tenant_id, kind, title, revision::text AS revision, copied_from_revision_id, copied_from_hash
				),
				added AS (
					INSERT INTO document_revision (id, tenant_id, document_id, version_number, body, content_hash, published_at, recorded_at)
					SELECT ${revId}::uuid, inserted.tenant_id, inserted.id, 1, source.body, source.content_hash, clock_timestamp(), clock_timestamp()
					FROM inserted JOIN source ON true
					RETURNING id
				),
				aud AS (
					INSERT INTO audit_event (tenant_id, actor_id, action, kind, subject_id, occurred_at, recorded_at, event_key, metadata)
					SELECT ${scope.tenantId}::uuid, ${scope.accountId}::uuid, 'documents.copied', 'create', inserted.id,
						clock_timestamp(), clock_timestamp(), 'copied:' || inserted.id::text, '{}'::jsonb
					FROM inserted
					RETURNING id
				)
				SELECT (SELECT ok FROM gate) AS ok, i.id, i.tenant_id, i.kind, i.title, i.revision,
					false AS archived, i.copied_from_revision_id, i.copied_from_hash, s.body, s.content_hash,
					(SELECT count(*) FROM added) AS written, (SELECT count(*) FROM aud) AS audited
				FROM (SELECT 1) seed
				LEFT JOIN inserted i ON true
				LEFT JOIN source s ON true`,
			);
			const row = found[0];
			if (!row?.ok || !row.id) deny();
			return ownedFrom(row, scope.tenantId);
		});
	},

	async purgeOwnedForDeletion(db: Database, raw: unknown) {
		return settle(async () => {
			const input = parse(c.purgeOwnedRequest, raw);
			try {
				const found = await rowsOf<{ removed: string | number }>(
					db,
					sql`SELECT documents_purge_owned(${input.witnessId}::uuid) AS removed`,
				);
				return { removed: Number(found[0]?.removed ?? 0) };
			} catch (error) {
				if (postgresCode(error) === "42501") deny();
				throw error;
			}
		});
	},

	async reconcileOrphans(db: Database, storage: PrivateStorage | null) {
		return settle(async () => {
			if (!storage) deny();
			const candidates = await rowsOf<{ id: string }>(
				db,
				sql`SELECT id FROM file_object
				WHERE state IN ('pending', 'failed', 'ready')
					AND NOT file_is_referenced(id)
					AND (state <> 'pending' OR expires_at < clock_timestamp())
				ORDER BY id
				LIMIT 20`,
			);
			const authorize: ResourceAuthorizer = async (_tx, _file, intent) =>
				intent === "cleanup" ? { kind: "system", cause: "object_cleanup" } : null;
			let purged = 0;
			let unknown = 0;
			for (const candidate of candidates) {
				try {
					const result = await deleteUnreferencedObject(db, storage, authorize, candidate.id);
					if (result.status === "inaccessible") purged += 1;
					else unknown += 1;
				} catch (error) {
					if (error instanceof Error && error.message === "unavailable") continue;
					throw error;
				}
			}
			return { purged, unknown };
		});
	},
};

async function readOwned(db: Database, authority: RequestActor, raw: unknown) {
	const input = parse(c.ownedDocumentRequest, raw);
	const scope = viewScope(authority);
	if (!scope) deny();
	const found = await rowsOf<OwnedRow & { ok: boolean }>(
		db,
		sql`SELECT g.ok, d.id, d.tenant_id, d.kind, d.title, d.revision::text AS revision,
			d.archived_at IS NOT NULL AS archived, d.copied_from_revision_id, d.copied_from_hash, r.body, r.content_hash
		FROM (SELECT ${gateSql(scope, false)} AS ok) g
		LEFT JOIN document d ON g.ok AND d.id = ${input.documentId}::uuid AND d.tenant_id = ${scope.tenantId}::uuid
			AND d.current_revision_id IS NOT NULL
			AND d.kind <> 'church_document'
		LEFT JOIN document_revision r ON r.id = d.current_revision_id AND r.tenant_id = d.tenant_id`,
	);
	if (!found[0]?.ok || !found[0].id) deny();
	return ownedFrom(found[0], scope.tenantId);
}

type ImportLink = { objectId: string; format: "text" | "docx"; hash: string; requestKey: string };

async function createNative(
	db: Database,
	scope: Scope,
	title: string,
	body: string,
	hash: string,
	imported: ImportLink | null = null,
) {
	const docId = randomUUID();
	const revId = randomUUID();
	const action = imported ? "documents.imported" : "documents.saved";
	const found = await rowsOf<{ ok: boolean; id: string | null; revision: string | null }>(
		db,
		sql`WITH gate AS (SELECT ${gateSql(scope, true)} AS ok),
		inserted AS (
			INSERT INTO document (id, tenant_id, kind, title, current_revision_id, revision)
			SELECT ${docId}::uuid, ${scope.tenantId}::uuid, 'native', ${title}, ${revId}::uuid, 1
			FROM gate WHERE ok
			RETURNING id, tenant_id, revision::text AS revision
		),
		added AS (
			INSERT INTO document_revision (
				id, tenant_id, document_id, version_number, body, content_hash, import_object_id, import_format, import_state,
				published_at, recorded_at
			)
			SELECT ${revId}::uuid, inserted.tenant_id, inserted.id, 1, ${body}, ${hash},
				${imported?.objectId ?? null}::uuid, ${imported?.format ?? null},
				CASE WHEN ${imported ? "ready" : null}::text IS NULL THEN NULL ELSE 'ready' END,
				clock_timestamp(), clock_timestamp()
			FROM inserted
			RETURNING id
		),
		aud AS (
			INSERT INTO audit_event (
				tenant_id, actor_id, action, kind, subject_id, occurred_at, recorded_at, event_key, request_key, after_value, metadata
			)
			SELECT ${scope.tenantId}::uuid, ${scope.accountId}::uuid, ${action}, 'create', inserted.id,
				clock_timestamp(), clock_timestamp(), 'document:' || inserted.id::text || ':' || inserted.revision,
				${imported?.requestKey ?? null}, CASE WHEN ${imported?.requestKey ?? null}::text IS NULL THEN NULL ELSE jsonb_build_object('hash', ${hash}::text) END,
				'{}'::jsonb
			FROM inserted
			RETURNING id
		)
		SELECT (SELECT ok FROM gate) AS ok, (SELECT id FROM inserted) AS id, (SELECT revision FROM inserted) AS revision,
			(SELECT count(*) FROM added) AS written, (SELECT count(*) FROM aud) AS audited`,
	);
	const row = found[0];
	if (!row?.ok || !row.id || !row.revision) deny();
	return ownedFrom(
		{
			id: row.id,
			kind: "native",
			title,
			body,
			revision: row.revision,
			content_hash: hash,
			archived: false,
			copied_from_revision_id: null,
			copied_from_hash: null,
		},
		scope.tenantId,
	);
}

async function appendNative(
	db: Database,
	scope: Scope,
	documentId: string,
	expected: string,
	title: string,
	body: string,
	hash: string,
	imported: ImportLink | null,
) {
	const revId = randomUUID();
	const action = imported ? "documents.imported" : "documents.saved";
	let found: Array<
		OwnedRow & {
			ok: boolean;
			found: string | null;
			prior_revision: string | null;
			stored: string | null;
			next_revision: string | null;
		}
	>;
	try {
		found = await rowsOf<
			OwnedRow & {
				ok: boolean;
				found: string | null;
				prior_revision: string | null;
				stored: string | null;
				next_revision: string | null;
			}
		>(
			db,
			sql`WITH gate AS (SELECT ${gateSql(scope, true)} AS ok),
		existing AS (
			SELECT d.id, d.tenant_id, d.kind, d.title, d.revision::text AS revision, d.archived_at,
				d.copied_from_revision_id, d.copied_from_hash, r.body, r.content_hash
			FROM document d
			JOIN document_revision r ON r.id = d.current_revision_id AND r.tenant_id = d.tenant_id
			JOIN gate ON gate.ok
			WHERE d.id = ${documentId}::uuid AND d.tenant_id = ${scope.tenantId}::uuid AND d.kind <> 'church_document'
		),
		added AS (
			INSERT INTO document_revision (
				id, tenant_id, document_id, version_number, body, content_hash, import_object_id, import_format, import_state,
				published_at, recorded_at
			)
			SELECT ${revId}::uuid, existing.tenant_id, existing.id,
				(SELECT coalesce(max(version_number), 0) + 1 FROM document_revision prior WHERE prior.document_id = existing.id),
				${body}, ${hash}, ${imported?.objectId ?? null}::uuid, ${imported?.format ?? null},
				CASE WHEN ${imported ? "ready" : null}::text IS NULL THEN NULL ELSE 'ready' END,
				clock_timestamp(), clock_timestamp()
			FROM existing
			WHERE existing.archived_at IS NULL AND existing.revision = ${expected}
			RETURNING id, document_id
		),
		updated AS (
			UPDATE document SET current_revision_id = added.id, title = ${title}, revision = document.revision + 1
			FROM added
			WHERE document.id = added.document_id
			RETURNING document.id, document.tenant_id, document.kind, document.title, document.revision::text AS revision,
				document.copied_from_revision_id, document.copied_from_hash
		),
		aud AS (
			INSERT INTO audit_event (
				tenant_id, actor_id, action, kind, subject_id, occurred_at, recorded_at, event_key, request_key, after_value,
				after_revision, metadata
			)
			SELECT ${scope.tenantId}::uuid, ${scope.accountId}::uuid, ${action}, 'edit', updated.id,
				clock_timestamp(), clock_timestamp(), 'document:' || updated.id::text || ':' || updated.revision,
				${imported?.requestKey ?? null}, CASE WHEN ${imported?.requestKey ?? null}::text IS NULL THEN NULL ELSE jsonb_build_object('hash', ${hash}::text) END,
				updated.revision::bigint, '{}'::jsonb
			FROM updated
			RETURNING id
		)
		SELECT (SELECT ok FROM gate) AS ok, (SELECT id FROM existing) AS found, (SELECT revision FROM existing) AS prior_revision,
			(SELECT id FROM updated) AS stored, (SELECT revision FROM updated) AS next_revision,
			(SELECT kind FROM existing) AS kind, (SELECT title FROM existing) AS title, (SELECT body FROM existing) AS body,
			(SELECT content_hash FROM existing) AS content_hash, (SELECT archived_at IS NOT NULL FROM existing) AS archived,
			(SELECT copied_from_revision_id FROM existing) AS copied_from_revision_id,
			(SELECT copied_from_hash FROM existing) AS copied_from_hash,
			(SELECT count(*) FROM aud) AS audited`,
		);
	} catch (error) {
		if (postgresCode(error) === "23505") deny("conflict");
		throw error;
	}
	const row = found[0];
	if (!row?.ok) deny();
	if (!row.found || !row.prior_revision) deny();
	if (!sameRevision(row.prior_revision, expected)) deny("conflict");
	if (row.archived) deny();
	if (!row.stored || !row.next_revision) deny("conflict");
	return ownedFrom(
		{
			id: row.stored,
			kind: row.kind,
			title,
			body,
			revision: row.next_revision,
			content_hash: hash,
			archived: false,
			copied_from_revision_id: row.copied_from_revision_id,
			copied_from_hash: row.copied_from_hash,
		},
		scope.tenantId,
	);
}

async function mutateOwned(
	db: Database,
	scope: Scope,
	documentId: string,
	expected: string,
	action: "archive" | "designate",
) {
	const found = await rowsOf<
		OwnedRow & {
			ok: boolean;
			found: string | null;
			prior_revision: string | null;
			stored: string | null;
			next_revision: string | null;
			eligible: boolean | null;
			prior_kind: OwnedRow["kind"] | null;
		}
	>(
		db,
		sql`WITH gate AS (SELECT ${gateSql(scope, true)} AS ok),
		existing AS (
			SELECT d.id, d.tenant_id, d.kind, d.title, d.revision::text AS revision, d.archived_at,
				d.copied_from_revision_id, d.copied_from_hash, r.body, r.content_hash, r.import_state
			FROM document d
			JOIN document_revision r ON r.id = d.current_revision_id AND r.tenant_id = d.tenant_id
			JOIN gate ON gate.ok
			WHERE d.id = ${documentId}::uuid AND d.tenant_id = ${scope.tenantId}::uuid AND d.kind <> 'church_document'
		),
		updated AS (
			UPDATE document SET
				archived_at = CASE WHEN ${action} = 'archive' THEN clock_timestamp() ELSE document.archived_at END,
				kind = CASE WHEN ${action} = 'designate' THEN 'core_values' ELSE document.kind END,
				revision = document.revision + 1
			FROM existing
			WHERE document.id = existing.id AND existing.archived_at IS NULL AND existing.revision = ${expected}
				AND (${action} <> 'designate' OR (
					existing.kind = 'native' AND length(btrim(existing.body)) > 0
					AND (existing.import_state IS NULL OR existing.import_state = 'ready')
				))
			RETURNING document.id, document.revision::text AS revision, document.kind, document.archived_at
		),
		aud AS (
			INSERT INTO audit_event (
				tenant_id, actor_id, action, kind, subject_id, occurred_at, recorded_at, event_key, after_revision, metadata
			)
			SELECT ${scope.tenantId}::uuid, ${scope.accountId}::uuid,
				CASE WHEN ${action} = 'archive' THEN 'documents.archived' ELSE 'documents.designated' END,
				CASE WHEN ${action} = 'archive' THEN 'archive' ELSE 'edit' END,
				updated.id, clock_timestamp(), clock_timestamp(), ${action} || ':' || updated.id::text || ':' || updated.revision,
				updated.revision::bigint, '{}'::jsonb
			FROM updated
			RETURNING id
		)
		SELECT (SELECT ok FROM gate) AS ok, (SELECT id FROM existing) AS found, (SELECT revision FROM existing) AS prior_revision,
			(SELECT kind FROM existing) AS prior_kind, (SELECT title FROM existing) AS title, (SELECT body FROM existing) AS body,
			(SELECT content_hash FROM existing) AS content_hash,
			(SELECT archived_at IS NOT NULL FROM existing) AS archived,
			(SELECT length(btrim(body)) > 0 AND (import_state IS NULL OR import_state = 'ready') FROM existing) AS eligible,
			(SELECT copied_from_revision_id FROM existing) AS copied_from_revision_id,
			(SELECT copied_from_hash FROM existing) AS copied_from_hash,
			(SELECT id FROM updated) AS stored, (SELECT revision FROM updated) AS next_revision,
			(SELECT kind FROM updated) AS kind, (SELECT archived_at IS NOT NULL FROM updated) AS next_archived,
			(SELECT count(*) FROM aud) AS audited`,
	);
	const row = found[0];
	if (!row?.ok || !row.found || !row.prior_revision) return "deny" as const;
	if (!sameRevision(row.prior_revision, expected)) return "conflict" as const;
	if (action === "archive" && row.archived)
		return ownedFrom(
			{ ...row, id: row.found, kind: row.prior_kind ?? row.kind, revision: row.prior_revision },
			scope.tenantId,
		);
	if (action === "designate" && row.prior_kind === "core_values" && row.eligible && !row.archived)
		return ownedFrom({ ...row, id: row.found, kind: "core_values", revision: row.prior_revision }, scope.tenantId);
	if (!row.stored || !row.next_revision) return "deny" as const;
	return ownedFrom(
		{
			...row,
			id: row.stored,
			kind: action === "designate" ? "core_values" : (row.prior_kind ?? row.kind),
			revision: row.next_revision,
			archived: action === "archive",
		},
		scope.tenantId,
	);
}

function decodeImport(value: string) {
	if (value.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) rejectInput("bytes", "Bytes are not base64.");
	const bytes = Buffer.from(value, "base64");
	if (!bytes.length || bytes.length > 10 * 1024 * 1024) rejectInput("bytes", "The file must be 10 MiB or smaller.");
	return bytes;
}

type Reply<T> = Promise<c.DocumentsReply<T>>;
type GeneratedDocument = z.infer<typeof c.generatedDocument>;
type GeneratedHistory = z.infer<typeof c.generatedHistory>;
type OwnedDocument = z.infer<typeof c.ownedDocument>;

/**
 * `documents.history.list` and `documents.history.get`: the revisions of a Church Document when the request names a
 * document (and a revision), the saved files of the church plant otherwise.
 */
function historyList(db: Database, authority: RequestActor, raw: { documentId: string }): Reply<c.ChurchRevisionList>;
function historyList(db: Database, authority: RequestActor, raw: unknown): Reply<GeneratedHistory>;
function historyList(db: Database, authority: RequestActor, raw: unknown) {
	if (typeof raw === "object" && raw !== null && "documentId" in raw)
		return churchWriter["history.list.church"](db, authority, raw);
	return generatedWriter["history.list"](db, authority, raw);
}
function historyGet(
	db: Database,
	authority: RequestActor,
	raw: { documentId: string; revision: number },
): Reply<c.ChurchRevision>;
function historyGet(db: Database, authority: RequestActor, raw: unknown): Reply<GeneratedDocument>;
function historyGet(db: Database, authority: RequestActor, raw: unknown) {
	if (typeof raw === "object" && raw !== null && "revision" in raw)
		return churchWriter["history.get.church"](db, authority, raw);
	return generatedWriter["history.get"](db, authority, raw);
}

/**
 * `documents.saveNative`: a structured body saves a Church Document, a text body saves a plain native document.
 */
function saveNative(
	db: Database,
	authority: RequestActor,
	raw: z.input<typeof c.saveChurchRequest>,
): Reply<c.ChurchDocument>;
function saveNative(db: Database, authority: RequestActor, raw: unknown): Reply<OwnedDocument>;
function saveNative(db: Database, authority: RequestActor, raw: unknown) {
	if (typeof raw === "object" && raw !== null && Array.isArray((raw as { body?: unknown }).body))
		return settle(() => churchWriter.saveChurch(db, authority, parse(c.saveChurchRequest, raw)));
	return generatedWriter.saveNative(db, authority, raw);
}

export const documentsWriter = {
	...generatedWriter,
	saveNative,
	"history.list": historyList,
	"history.get": historyGet,
};
