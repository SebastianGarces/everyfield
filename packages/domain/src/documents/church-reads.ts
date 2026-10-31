import * as c from "@everyfield/contracts/documents";
import { sql } from "@everyfield/db/query";
import "server-only";
import type { RequestActor } from "../access/session.ts";
import { deny, parse, plantViewer, settle, type Reader } from "./access.ts";
import { gateSql, iso, plantScope, rowsOf } from "./scope.ts";
import { churchTemplate } from "./templates/church.ts";

/** An Owner, Admin or Member of the church plant. An account with no seat gets `access_denied`. */
function readerScope(authority: RequestActor) {
	const viewer = plantViewer(authority);
	if (!viewer) deny("access_denied");
	return plantScope(viewer);
}

/** The name of an account in this church plant: the linked person's name, else the account's own name. Null when it is gone. */
export const authorNameSql = (tenantId: string, account: ReturnType<typeof sql>) =>
	sql`coalesce(
		(SELECT p.display_name FROM person p
			WHERE p.tenant_id = ${tenantId}::uuid AND p.linked_account_id = ${account} AND p.state = 'live' LIMIT 1),
		(SELECT i.display_name FROM seat_identity(${account}) i LIMIT 1)
	)`;

type PageRow = {
	ok: boolean;
	id: string | null;
	template_id: string | null;
	template_version: number | null;
	document_class: c.ChurchDocument["documentClass"] | null;
	use_church_branding: boolean | null;
	title: string | null;
	revision: string | null;
	revision_id: string | null;
	body: string | null;
	content_hash: string | null;
	archived: boolean | null;
	input_provenance: c.ChurchDocument["provenance"] | null;
	time_zone: string | null;
	has_kit: boolean | null;
	revisions:
		| {
				id: string;
				number: number;
				authorAccountId: string | null;
				authorName: string | null;
				recordedAt: string;
				contentHash: string;
		  }[]
		| null;
	exports:
		| {
				id: string;
				format: string;
				revision: number;
				theme: string;
				creatorName: string | null;
				generatedAt: string;
				downloadName: string;
		  }[]
		| null;
};

export const churchReader = {
	/** The Church Documents of the church plant that are not archived, most recently edited first. One statement. */
	async listChurch(db: Reader, authority: RequestActor, raw: unknown) {
		return settle(async () => {
			parse(c.listChurchRequest, raw);
			const scope = readerScope(authority);
			const found = await rowsOf<{
				ok: boolean;
				id: string | null;
				title: string | null;
				template_id: string | null;
				document_class: c.ChurchDocument["documentClass"] | null;
				revision: string | null;
				recorded_at: Date | string | null;
				time_zone: string | null;
			}>(
				db,
				sql`SELECT g.ok, d.id, d.title, d.template_id, d.document_class, d.revision::text AS revision, r.recorded_at,
					CASE WHEN g.ok THEN (SELECT p.timezone FROM plant p WHERE p.id = ${scope.tenantId}::uuid) END AS time_zone
				FROM (SELECT ${gateSql(scope, false)} AS ok) g
				LEFT JOIN document d ON g.ok AND d.tenant_id = ${scope.tenantId}::uuid AND d.kind = 'church_document'
					AND d.archived_at IS NULL AND d.current_revision_id IS NOT NULL
				LEFT JOIN document_revision r ON r.id = d.current_revision_id AND r.tenant_id = d.tenant_id
				ORDER BY r.recorded_at DESC NULLS LAST, d.id
				LIMIT 200`,
			);
			if (found[0]?.ok !== true) deny("access_denied");
			return c.churchList.parse({
				timeZone: found[0].time_zone,
				documents: found
					.filter((row) => row.id)
					.map((row) => ({
						id: row.id,
						title: row.title,
						templateId: row.template_id,
						templateName: churchTemplate(row.template_id ?? "")?.name ?? row.template_id,
						documentClass: row.document_class,
						revision: Number(row.revision),
						editedAt: iso(row.recorded_at),
					})),
			});
		});
	},

	/**
	 * The page of one Church Document: its current state, template facts, revision history with author names and saved
	 * exports. One statement. Another church plant, an unknown id and a document that is not a Church Document read the same.
	 */
	async readChurch(db: Reader, authority: RequestActor, raw: unknown) {
		return settle(async () => {
			const input = parse(c.readChurchRequest, raw);
			const scope = readerScope(authority);
			const found = await rowsOf<PageRow>(
				db,
				sql`SELECT g.ok, d.id, d.template_id, d.template_version, d.document_class, d.use_church_branding, d.title,
					d.revision::text AS revision, r.id AS revision_id, r.body, r.content_hash, d.archived_at IS NOT NULL AS archived,
					d.input_provenance,
					CASE WHEN d.id IS NOT NULL THEN (SELECT p.timezone FROM plant p WHERE p.id = ${scope.tenantId}::uuid) END AS time_zone,
					CASE WHEN d.id IS NOT NULL THEN EXISTS (SELECT FROM church_brand_kit k WHERE k.tenant_id = ${scope.tenantId}::uuid) END AS has_kit,
					(SELECT jsonb_agg(jsonb_build_object(
							'id', x.id, 'number', x.version_number, 'authorAccountId', x.author_account_id,
							'authorName', x.author_name, 'recordedAt', x.recorded_at, 'contentHash', x.content_hash
						) ORDER BY x.version_number DESC)
						FROM (
							SELECT v.id, v.version_number, v.author_account_id, v.recorded_at, v.content_hash,
								${authorNameSql(scope.tenantId, sql`v.author_account_id`)} AS author_name
							FROM document_revision v WHERE v.document_id = d.id AND v.tenant_id = d.tenant_id
							ORDER BY v.version_number DESC LIMIT 1000
						) x) AS revisions,
					(SELECT jsonb_agg(jsonb_build_object(
							'id', e.id, 'format', e.format, 'revision', e.version_number, 'theme', e.theme_kind,
							'creatorName', e.creator_name, 'generatedAt', e.generated_at, 'downloadName', e.download_name
						) ORDER BY e.generated_at DESC)
						FROM (
							SELECT gd.id, gd.format, sr.version_number, gd.theme_kind, gd.generated_at, gd.download_name,
								${authorNameSql(scope.tenantId, sql`gd.creator_account_id`)} AS creator_name
							FROM generated_document gd
							JOIN file_object f ON f.id = gd.object_id AND f.tenant_id = gd.tenant_id AND f.state = 'ready'
							JOIN document_revision sr ON sr.id = gd.source_revision_id AND sr.tenant_id = gd.tenant_id
							WHERE gd.tenant_id = d.tenant_id AND gd.source_document_id = d.id
							ORDER BY gd.generated_at DESC LIMIT 100
						) e) AS exports
				FROM (SELECT ${gateSql(scope, false)} AS ok) g
				LEFT JOIN document d ON g.ok AND d.id = ${input.documentId}::uuid AND d.tenant_id = ${scope.tenantId}::uuid
					AND d.kind = 'church_document' AND d.current_revision_id IS NOT NULL
				LEFT JOIN document_revision r ON r.id = d.current_revision_id AND r.tenant_id = d.tenant_id`,
			);
			const row = found[0];
			if (row?.ok !== true) deny("access_denied");
			const template = churchTemplate(row.template_id ?? "");
			if (!row.id || !template || row.body === null || !row.revisions) deny("unavailable");
			return c.churchPage.parse({
				document: {
					id: row.id,
					tenantId: scope.tenantId,
					templateId: row.template_id,
					templateVersion: Number(row.template_version),
					documentClass: row.document_class,
					useChurchBranding: row.use_church_branding,
					title: row.title,
					revision: row.revision,
					revisionId: row.revision_id,
					body: JSON.parse(row.body),
					contentHash: row.content_hash,
					archived: row.archived,
					provenance: row.input_provenance,
				},
				templateName: template.name,
				slots: template.slots,
				timeZone: row.time_zone,
				hasBrandKit: row.has_kit === true,
				revisions: row.revisions.map((revision) => ({ ...revision, recordedAt: iso(revision.recordedAt) })),
				exports: (row.exports ?? []).map((item) => ({ ...item, generatedAt: iso(item.generatedAt) })),
			});
		});
	},
};
