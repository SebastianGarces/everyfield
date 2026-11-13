import * as c from "@everyfield/contracts/people";
import type { Database } from "@everyfield/db/client";
import { sql, type SQLWrapper } from "@everyfield/db/query";
import { z } from "zod";
import { workspaceAvatar } from "../settings/photo-visibility.ts";
import { authorizeCachedRead, deny, parse, readReply, type PeopleReadContext } from "./core.ts";

/**
 * The photo a person row shows, as `listPhoto` JSON or NULL, in one expression (REQ-PPL-005, REQ-IDN-006): a live
 * person's own People photo wins; otherwise the photo of the account the person links to, while that account holds a
 * live seat in the person's church (workspaceAvatar, the rule the photo route applies); a retired or merged person
 * has none. The People list, the meeting guest list and Evry's result cards share it.
 */
export function listPhotoSql(p: {
	id: SQLWrapper;
	state: SQLWrapper;
	photo: SQLWrapper;
	account: SQLWrapper;
	plant: SQLWrapper;
}) {
	return sql<unknown>`(CASE WHEN ${p.state}<>'live' THEN NULL
		WHEN ${p.photo} IS NOT NULL THEN json_build_object('kind','person','personId',${p.id},'versionId',${p.photo})
		ELSE (SELECT json_build_object('kind','account','accountId',${p.account},'versionId',lp.v)
			FROM (SELECT ${workspaceAvatar(p.account, p.plant)} AS v) lp WHERE lp.v IS NOT NULL) END)`;
}
/** listPhotoSql on the `person` alias `p`. */
export const personAliasPhoto = listPhotoSql({
	id: sql`p.id`,
	state: sql`p.state`,
	photo: sql`p.photo_object_id`,
	account: sql`p.linked_account_id`,
	plant: sql`p.plant_id`,
});

const photoRow = z.object({ allowed: z.boolean(), id: z.uuid().nullable(), photo: c.listPhoto.nullable() });

/**
 * The current photos of the given people of this church, for a screen that already shows them (Evry's result cards).
 * One statement on the pool with the live access check (C13) inside it: a reader who lost access gets a refusal.
 * Nothing is saved: each call reads the photos as they are now.
 */
export async function readPersonPhotos(db: Database, ctx: PeopleReadContext, raw: unknown) {
	return readReply(async () => {
		if (ctx.selected.kind !== "plant") deny();
		const { personIds } = parse(c.personPhotosRequest, raw);
		const { gate } = authorizeCachedRead(ctx);
		const result = await db.execute(sql`SELECT g.allowed, x.id, x.photo FROM (SELECT ${gate} AS allowed) g
			LEFT JOIN LATERAL (SELECT p.id, ${personAliasPhoto} AS photo FROM person p
				WHERE g.allowed AND p.plant_id=${ctx.selected.id}::uuid AND p.id = ANY(${sql.param(personIds)}::uuid[])) x ON true`);
		const rows = result.rows.map((r) => photoRow.parse(r));
		if (!rows[0]?.allowed) deny();
		return c.personPhotos.parse({
			photos: rows.flatMap((r) => (r.id && r.photo ? [{ personId: r.id, photo: r.photo }] : [])),
		});
	});
}
