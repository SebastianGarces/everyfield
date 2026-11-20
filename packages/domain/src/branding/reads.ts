import * as c from "@everyfield/contracts/branding";
import type { Database } from "@everyfield/db/client";
import { sql } from "@everyfield/db/query";
import { dominantColors, readAuthorizedObject, type PrivateStorage } from "@everyfield/db/schema";
import "server-only";
import { z } from "zod";
import type { RequestActor } from "../access/session.ts";
import { deny, parse, scopeOf, settle } from "./access.ts";
import { assetColumn, dataFromRow, kitFromRow } from "./kit.ts";
import { brandAssetReader } from "./files.ts";
import { resolveDocumentTheme } from "./theme.ts";

const row = z.object({ ok: z.boolean().nullable(), row: z.record(z.string(), z.unknown()).nullable() });

export const brandReader = {
	async get(db: Database, authority: RequestActor, raw: unknown) {
		return settle(async () => {
			const scope = scopeOf(authority);
			parse(c.getRequest, raw);
			const { rows } = await db.execute(sql`SELECT g.ok, to_jsonb(k) AS row
				FROM (SELECT ${scope.admin} AS ok) g
				LEFT JOIN church_brand_kit k ON g.ok AND k.tenant_id = ${scope.plantId}::uuid`);
			const found = row.parse(rows[0]);
			if (found.ok !== true) deny("access_denied");
			return kitFromRow(found.row);
		});
	},

	async suggestColors(db: Database, authority: RequestActor, raw: unknown, storage: PrivateStorage | null) {
		return settle(async () => {
			const scope = scopeOf(authority);
			const input = parse(c.suggestColorsRequest, raw);
			const { rows } = await db.execute(sql`SELECT g.ok, f.id AS file_id
				FROM (SELECT ${scope.admin} AS ok) g
				LEFT JOIN church_brand_kit k ON g.ok AND k.tenant_id = ${scope.plantId}::uuid
				LEFT JOIN file_object f ON f.id = k.${assetColumn(input.assetKind)} AND f.tenant_id = k.tenant_id
					AND f.purpose = 'brand_asset' AND f.state = 'ready'`);
			const found = z.object({ ok: z.boolean().nullable(), file_id: z.string().nullable() }).parse(rows[0]);
			if (found.ok !== true) deny("access_denied");
			if (!found.file_id || !storage) deny("unavailable");
			const bytes = await readAuthorizedObject(db, storage, brandAssetReader(scope, "settings"), found.file_id).catch(
				() => deny("unavailable"),
			);
			const palette = await dominantColors(bytes).catch(() => deny("unavailable"));
			const [suggestedPrimary] = palette;
			if (!suggestedPrimary) deny("unavailable");
			return c.suggestedColors.parse({ suggestedPrimary, palette, suggestedFrom: input.assetKind });
		});
	},

	async resolveTheme(db: Database, authority: RequestActor, raw: unknown) {
		return settle(async () => {
			const scope = scopeOf(authority);
			const input = parse(c.resolveThemeRequest, raw);
			const { rows } = await db.execute(sql`SELECT g.ok, p.name, to_jsonb(k) AS row
				FROM (SELECT ${scope.seat} AS ok) g
				LEFT JOIN plant p ON g.ok AND p.id = ${scope.plantId}::uuid
				LEFT JOIN church_brand_kit k ON g.ok AND k.tenant_id = ${scope.plantId}::uuid`);
			const found = z
				.object({
					ok: z.boolean().nullable(),
					name: z.string().nullable(),
					row: z.record(z.string(), z.unknown()).nullable(),
				})
				.parse(rows[0]);
			if (found.ok !== true || !found.name) deny("access_denied");
			return resolveDocumentTheme(
				{ name: found.name, kit: found.row ? dataFromRow(found.row) : null },
				input.documentClass,
				{ useChurchBranding: input.useChurchBranding },
			);
		});
	},
};
