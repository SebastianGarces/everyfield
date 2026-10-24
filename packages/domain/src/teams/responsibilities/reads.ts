import * as c from "@everyfield/contracts/teams/responsibilities";
import { sql } from "@everyfield/db/query";
import "server-only";
import { z } from "zod";
import type { RequestActor } from "../../access/session.ts";
import { deny, one, parse, read, type Reader, type Viewer } from "../core.ts";
import { catalogVersion } from "./store.ts";

const pageOf = (page: number | undefined) => page ?? 1;

async function teamRow(db: Reader, viewer: Viewer, query: ReturnType<typeof sql>) {
	const found = await one(db, viewer, query);
	if (!found) deny("access_denied");
	return found;
}

export const responsibilityReader = {
	async listResponsibilities(db: Reader, authority: RequestActor, raw: unknown) {
		return read(authority, async (viewer) => {
			const input = parse(c.listRequest, raw);
			const page = pageOf(input.page);
			const offset = (page - 1) * c.RESPONSIBILITY_PAGE;
			const found = await teamRow(
				db,
				viewer,
				sql`SELECT t.responsibility_offer AS offer,
					coalesce((SELECT json_agg(json_build_object(
						'id', r.id, 'revision', r.revision::text, 'sourceLine', r.source_line, 'text', r.text,
						'sortOrder', r.sort_order, 'completedOn', r.completed_on::text
					) ORDER BY r.sort_order, r.id)
					FROM (
						SELECT * FROM responsibility r
						WHERE r.team_id = t.id AND r.plant_id = t.plant_id AND r.removed_at IS NULL
						ORDER BY r.sort_order, r.id
						LIMIT ${c.RESPONSIBILITY_PAGE} OFFSET ${offset}
					) r), '[]'::json) AS items
					FROM team t
					WHERE t.id = ${input.teamId}::uuid AND t.plant_id = ${viewer.plantId}::uuid`,
			);
			return c.responsibilityPage.parse({
				teamId: input.teamId,
				offer: found.offer,
				page,
				items: found.items,
			});
		});
	},
	async previewResponsibilities(db: Reader, authority: RequestActor, raw: unknown) {
		return read(authority, async (viewer) => {
			const input = parse(c.previewRequest, raw);
			const found = await teamRow(
				db,
				viewer,
				sql`SELECT t.responsibility_offer AS offer,
					coalesce((SELECT json_agg(r.source_line) FROM responsibility r
						WHERE r.team_id = t.id AND r.plant_id = t.plant_id), '[]'::json) AS stored,
					${catalogVersion()} AS version
					FROM team t
					WHERE t.id = ${input.teamId}::uuid AND t.plant_id = ${viewer.plantId}::uuid`,
			);
			const stored = z.array(z.string()).parse(found.stored);
			const hidden = found.offer === "declined" || found.version == null;
			const lines = hidden
				? []
				: c.RESPONSIBILITY_LINES.filter((line) => !stored.includes(line.key)).map((line) => ({
						key: line.key,
						text: line.text,
						sortOrder: line.sortOrder,
					}));
			return c.previewPage.parse({ teamId: input.teamId, offer: found.offer, lines });
		});
	},
};
