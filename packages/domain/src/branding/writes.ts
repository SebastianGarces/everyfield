import * as c from "@everyfield/contracts/branding";
import type { Database } from "@everyfield/db/client";
import { sql, type SQL } from "@everyfield/db/query";
import { randomUUID } from "node:crypto";
import "server-only";
import { z } from "zod";
import type { RequestActor } from "../access/session.ts";
import { deny, parse, scopeOf, settle, type Scope } from "./access.ts";
import {
	LETTERHEAD_COLUMNS,
	STORED_MAX_BYTES,
	altColumn,
	assetColumn,
	kitFromRow,
	slotValues,
	uploadKeyOf,
} from "./kit.ts";

/** The 15 minutes a staged upload stays open for its bytes and its finalize. */
const STAGING_MINUTES = 15;

const SCALARS = [
	["primary_color", "primaryColor"],
	["accent_color", "accentColor"],
	["heading_font", "headingFont"],
	["body_font", "bodyFont"],
	...c.LETTERHEAD_KEYS.map((key) => [LETTERHEAD_COLUMNS[key], key] as const),
] as const;
const col = (name: string) => sql.identifier(name);

/** The statement result `{ ok, current_revision, row }` every kit write reads. */
const resultRow = z.object({
	ok: z.boolean().nullable(),
	current_revision: z.union([z.string(), z.number()]).nullable(),
	row: z.record(z.string(), z.unknown()).nullable(),
});
async function run(db: Database, query: SQL) {
	const { rows } = await db.execute(query);
	return resultRow.parse(rows[0]);
}

/** The gate: the live Owner or Admin seat, checked inside the statement that writes. */
const gate = (scope: Scope) => sql`gate AS (SELECT ${scope.admin} AS ok)`;
/** The kit as it was when the statement started. Absent for a church plant with no kit. */
const current = (scope: Scope) =>
	sql`cur AS (SELECT k.* FROM church_brand_kit k, gate WHERE gate.ok AND k.tenant_id = ${scope.plantId}::uuid)`;
/** The cleanup job of a file the kit no longer holds. The worker deletes only unreferenced files. */
const releaseJobs = (scope: Scope, files: SQL, from: SQL) => sql`rel AS (
	INSERT INTO job(tenant_id, kind, subject_record_id, producer_key, state, eligible_at, attempt_count, max_attempts, claim_generation)
	SELECT ${scope.plantId}::uuid, 'object_cleanup', v.id, 'brand-asset-release/' || v.id::text, 'ready', clock_timestamp(), 0, 4, 0
	FROM ${from}, LATERAL (VALUES ${files}) v(id)
	WHERE v.id IS NOT NULL
	ON CONFLICT DO NOTHING)`;
/** One audit row in the statement, with the changed fields and their before and after values (D70). */
const audit = (scope: Scope, changed: SQL, kind: "edit" | "remove") => sql`aud AS (
	INSERT INTO audit_event(tenant_id, actor_id, action, kind, subject_id, occurred_at, recorded_at, before_value, after_value, before_revision, after_revision, metadata)
	SELECT ${scope.plantId}::uuid, ${scope.accountId}::uuid, 'branding.changed', ${kind}, ${scope.plantId}::uuid,
		clock_timestamp(), clock_timestamp(), d.before_value, d.after_value,
		(SELECT revision FROM cur), (SELECT revision FROM ${changed} LIMIT 1), jsonb_build_object('diff', d.fields)
	FROM (
		SELECT coalesce(jsonb_object_agg(n.key, coalesce(o.value, 'null'::jsonb)), '{}'::jsonb) AS before_value,
			coalesce(jsonb_object_agg(n.key, n.value), '{}'::jsonb) AS after_value,
			coalesce(jsonb_object_agg(n.key, true), '{}'::jsonb) AS fields
		FROM ${changed} ch
		CROSS JOIN LATERAL jsonb_each(to_jsonb(ch)) n
		LEFT JOIN jsonb_each(coalesce((SELECT to_jsonb(cur) FROM cur), '{}'::jsonb)) o ON o.key = n.key
		WHERE n.key NOT IN ('tenant_id', 'revision') AND n.value IS DISTINCT FROM coalesce(o.value, 'null'::jsonb)
	) d
	WHERE EXISTS (SELECT FROM ${changed})
	RETURNING id)`;
const tail = sql`SELECT (SELECT ok FROM gate) AS ok, (SELECT revision::text FROM cur) AS current_revision,
	(SELECT to_jsonb(c) FROM changed c) AS row`;

/** Lets a specific field refuse with its own code instead of the generic `invalid_input`. */
function parseSettings(raw: unknown) {
	const patch = (raw as { patch?: Record<string, unknown> } | null)?.patch;
	if (patch && typeof patch === "object" && patch.primaryColor === null) deny("primary_required");
	const found = c.saveSettingsRequest.safeParse(raw);
	if (found.success) return found.data;
	const first = found.error.issues.find((issue) => issue.path[0] === "patch");
	const field = first?.path[1];
	if (field === "headingFont" || field === "bodyFont") deny("unsupported_font");
	if (field === "ein") deny("invalid_ein");
	return parse(c.saveSettingsRequest, raw);
}

export const brandWriter = {
	/** One patch of closed fields, with the expected revision checked in the same statement. */
	async saveSettings(db: Database, authority: RequestActor, raw: unknown) {
		return settle(async () => {
			const scope = scopeOf(authority);
			const input = parseSettings(raw);
			const patch = input.patch;
			const has = (key: string) => (patch as Record<string, unknown>)[key] !== undefined;
			const value = (key: string) => (patch as Record<string, unknown>)[key] ?? null;
			const cleared = c.ASSET_SLOTS.filter((slot) => patch.assets?.[slot] === null);
			const sets = [
				...SCALARS.map(
					([column, key]) =>
						sql`${col(column)} = CASE WHEN ${has(key)}::boolean THEN ${value(key)}::text ELSE k.${col(column)} END`,
				),
				...c.ASSET_SLOTS.flatMap((slot) => {
					const clear = cleared.includes(slot);
					return [
						sql`${assetColumn(slot)} = CASE WHEN ${clear}::boolean THEN NULL ELSE k.${assetColumn(slot)} END`,
						sql`${altColumn(slot)} = CASE WHEN ${clear}::boolean THEN NULL ELSE k.${altColumn(slot)} END`,
					];
				}),
			];
			const fresh = SCALARS.map(([column, key]) =>
				column === "heading_font"
					? sql`coalesce(${value(key)}::text, ${c.DEFAULT_HEADING_FONT}::text)`
					: column === "body_font"
						? sql`coalesce(${value(key)}::text, ${c.DEFAULT_BODY_FONT}::text)`
						: sql`${value(key)}::text`,
			);
			const primaryAfter = sql`CASE WHEN ${has("primaryColor")}::boolean THEN ${value("primaryColor")}::text ELSE k.primary_color END`;
			const result = await run(
				db,
				sql`WITH ${gate(scope)}, ${current(scope)},
				upd AS (
					UPDATE church_brand_kit k SET revision = k.revision + 1, ${sql.join(sets, sql`, `)}
					FROM gate
					WHERE gate.ok AND k.tenant_id = ${scope.plantId}::uuid AND k.revision = ${input.expectedRevision}::bigint
						AND ${primaryAfter} IS NOT NULL
					RETURNING k.*),
				ins AS (
					INSERT INTO church_brand_kit(tenant_id, revision, ${sql.join(
						SCALARS.map(([column]) => col(column)),
						sql`, `,
					)})
					SELECT ${scope.plantId}::uuid, 1, ${sql.join(fresh, sql`, `)}
					FROM gate
					WHERE gate.ok AND ${input.expectedRevision}::bigint = 0 AND NOT EXISTS (SELECT FROM cur)
						AND ${value("primaryColor")}::text IS NOT NULL
					ON CONFLICT (tenant_id) DO NOTHING
					RETURNING *),
				changed AS (SELECT * FROM upd UNION ALL SELECT * FROM ins),
				${releaseJobs(
					scope,
					sql.join(
						c.ASSET_SLOTS.map(
							(slot) => sql`(CASE WHEN ${cleared.includes(slot)}::boolean THEN cur.${assetColumn(slot)} END)`,
						),
						sql`, `,
					),
					sql`cur, upd`,
				)},
				${audit(scope, sql`changed`, "edit")}
				${tail}`,
			);
			if (!result.row) {
				if (result.ok === true && String(result.current_revision ?? "0") === input.expectedRevision) {
					// The revision is right, so the only other reason is a missing or cleared primary color.
					deny("primary_required");
				}
				if (result.ok !== true) deny("access_denied");
				deny("conflict");
			}
			return kitFromRow(result.row);
		});
	},

	/** Stages a pending `brand_asset` file and its orphan cleanup job in one statement (CASE-BRD-002). */
	async requestUpload(db: Database, authority: RequestActor, raw: unknown) {
		return settle(async () => {
			const scope = scopeOf(authority);
			const rawObject = (raw ?? {}) as Record<string, unknown>;
			// A missing or blank alt text refuses before anything is stored.
			if (typeof rawObject.altText !== "string" || !rawObject.altText.trim()) deny("alt_text_required");
			if (!(c.ASSET_MEDIA_TYPES as readonly unknown[]).includes(rawObject.mediaType)) deny("unsupported_media_type");
			const input = parse(c.uploadRequest, raw);
			const id = randomUUID();
			const { rows } = await db.execute(sql`WITH ${gate(scope)},
				up AS (
					INSERT INTO file_object(id, tenant_id, purpose, opaque_key, media_type, max_bytes, state, upload_key, claim_generation, expires_at)
					SELECT ${id}::uuid, ${scope.plantId}::uuid, 'brand_asset', ${`private/${scope.plantId}/${randomUUID()}`}::text,
						${c.isTrimmedSlot(input.slot) ? "image/png" : "image/jpeg"}::text, ${String(STORED_MAX_BYTES)}::bigint, 'pending',
						${uploadKeyOf(input.slot, input.mediaType, input.byteLength, id)}::text, 0, clock_timestamp() + ${`${STAGING_MINUTES} minutes`}::interval
					FROM gate WHERE gate.ok
					RETURNING id, expires_at),
				cl AS (
					INSERT INTO job(tenant_id, kind, subject_record_id, producer_key, state, eligible_at, attempt_count, max_attempts, claim_generation)
					SELECT ${scope.plantId}::uuid, 'object_cleanup', up.id, 'brand-asset-upload/' || up.id::text, 'ready', up.expires_at, 0, 4, 0
					FROM up ON CONFLICT DO NOTHING)
				SELECT (SELECT ok FROM gate) AS ok, (SELECT id FROM up) AS id, (SELECT expires_at FROM up) AS expires_at`);
			const row = z
				.object({
					ok: z.boolean().nullable(),
					id: z.string().nullable(),
					expires_at: z.union([z.date(), z.string()]).nullable(),
				})
				.parse(rows[0]);
			if (!row.ok || !row.id || !row.expires_at) deny("access_denied");
			return c.uploadTicket.parse({ uploadId: row.id, expiresAt: new Date(row.expires_at).toISOString() });
		});
	},

	/** Attaches the ready, unexpired, same-church-plant `brand_asset` file to its slot with its alt text. */
	async finalizeUpload(db: Database, authority: RequestActor, raw: unknown) {
		return settle(async () => {
			const scope = scopeOf(authority);
			const rawObject = (raw ?? {}) as Record<string, unknown>;
			if (typeof rawObject.altText !== "string" || !rawObject.altText.trim()) deny("alt_text_required");
			const input = parse(c.finalizeUploadRequest, raw);
			const slot = input.slot;
			const result = await run(
				db,
				sql`WITH ${gate(scope)}, ${current(scope)},
				f AS (
					SELECT f.id FROM file_object f, gate
					WHERE gate.ok AND f.id = ${input.uploadId}::uuid AND f.tenant_id = ${scope.plantId}::uuid
						AND f.purpose = 'brand_asset' AND f.state = 'ready' AND f.expires_at > clock_timestamp()
						AND starts_with(f.upload_key, ${`brand-asset/${slot}/`}::text)),
				upd AS (
					UPDATE church_brand_kit k SET revision = k.revision + 1,
						${assetColumn(slot)} = f.id, ${altColumn(slot)} = ${input.altText}::text
					FROM gate, f
					WHERE gate.ok AND k.tenant_id = ${scope.plantId}::uuid AND k.revision = ${input.expectedRevision}::bigint
					RETURNING k.*),
				ins AS (
					INSERT INTO church_brand_kit(tenant_id, revision, ${assetColumn(slot)}, ${altColumn(slot)})
					SELECT ${scope.plantId}::uuid, 1, f.id, ${input.altText}::text
					FROM gate, f
					WHERE gate.ok AND ${input.expectedRevision}::bigint = 0 AND NOT EXISTS (SELECT FROM cur)
					ON CONFLICT (tenant_id) DO NOTHING
					RETURNING *),
				changed AS (SELECT * FROM upd UNION ALL SELECT * FROM ins),
				${releaseJobs(scope, sql`(cur.${assetColumn(slot)})`, sql`cur, upd`)},
				${audit(scope, sql`changed`, "edit")}
				SELECT (SELECT ok FROM gate) AS ok, (SELECT revision::text FROM cur) AS current_revision,
					(SELECT to_jsonb(c) FROM changed c) AS row`,
			);
			if (!result.row) {
				if (result.ok !== true) deny("access_denied");
				if (String(result.current_revision ?? "0") !== input.expectedRevision) deny("conflict");
				deny("unavailable");
			}
			return kitFromRow(result.row);
		});
	},

	/** Deletes the kit row, queues cleanup of every asset file and writes one audit row. */
	async reset(db: Database, authority: RequestActor, raw: unknown) {
		return settle(async () => {
			const scope = scopeOf(authority);
			const input = parse(c.resetRequest, raw);
			const { rows } = await db.execute(sql`WITH ${gate(scope)}, ${current(scope)},
				del AS (
					DELETE FROM church_brand_kit k USING gate
					WHERE gate.ok AND k.tenant_id = ${scope.plantId}::uuid AND k.revision = ${input.expectedRevision}::bigint
					RETURNING k.*),
				${releaseJobs(scope, slotValues("del"), sql`del`)},
				aud AS (
					INSERT INTO audit_event(tenant_id, actor_id, action, kind, subject_id, occurred_at, recorded_at, before_value, after_value, before_revision, metadata)
					SELECT ${scope.plantId}::uuid, ${scope.accountId}::uuid, 'branding.changed', 'remove', ${scope.plantId}::uuid,
						clock_timestamp(), clock_timestamp(),
						(SELECT jsonb_object_agg(n.key, n.value) FROM jsonb_each(to_jsonb(del)) n
							WHERE n.key NOT IN ('tenant_id', 'revision') AND n.value <> 'null'::jsonb),
						'{}'::jsonb, del.revision, jsonb_build_object('diff', jsonb_build_object('reset', true))
					FROM del
					RETURNING id)
				SELECT (SELECT ok FROM gate) AS ok, (SELECT revision::text FROM cur) AS current_revision,
					(SELECT count(*) FROM del) AS deleted`);
			const row = z
				.object({
					ok: z.boolean().nullable(),
					current_revision: z.union([z.string(), z.number()]).nullable(),
					deleted: z.coerce.number(),
				})
				.parse(rows[0]);
			if (row.ok !== true) deny("access_denied");
			// Reset of a church plant with no kit is already the answer.
			if (row.deleted === 0 && !(row.current_revision === null && input.expectedRevision === "0")) deny("conflict");
			return kitFromRow(null);
		});
	},
} satisfies Record<string, (db: Database, authority: RequestActor, raw: unknown) => Promise<unknown>>;
