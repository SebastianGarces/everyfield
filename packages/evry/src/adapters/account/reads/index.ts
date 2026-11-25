import { sql } from "@everyfield/db/query";
import { owner } from "@everyfield/contracts/common";
import { z } from "zod";
import { EvryRefusal } from "../../../context/errors.ts";
import type { ReadAdapter, SourceResult } from "../../../catalog/types.ts";
import { anySeat } from "../../native.ts";

export const getAvatar: ReadAdapter<Record<string, never>> = {
	operation: "account.getAvatar",
	description:
		"Show the user's own account photo, or say there is none. The app shows the photo itself under this result.",
	input: z.strictObject({}),
	allowed: anySeat,
	async invoke(tx, actor, _input, native): Promise<SourceResult> {
		if (!native) throw new EvryRefusal("source_unavailable");
		const found = await tx.execute(sql`SELECT a.avatar_object_id AS version, n.display_name AS name
			FROM account a CROSS JOIN LATERAL seat_identity(a.id) n WHERE a.id=${actor.accountId}::uuid`);
		const row = z.strictObject({ version: z.uuid().nullable(), name: z.string() }).safeParse(found.rows[0]);
		if (!row.success) throw new EvryRefusal("source_unavailable");
		const shown =
			row.data.version !== null &&
			(
				await native.account.getAvatar(
					tx,
					{ session: actor.session, selected: owner.parse({ kind: "account", id: actor.accountId }) },
					{ versionId: row.data.version },
				)
			).status === "ok";
		return {
			operation: "account.getAvatar",
			status: "available",
			rows: [
				{
					kind: "account",
					id: actor.accountId,
					label: row.data.name,
					fields: { photo: shown ? "available" : "none" },
				},
			],
			total: 1,
			page: 1,
			next: null,
			completeness: "complete",
			exclusions: [],
		};
	},
};

export const ACCOUNT_READS = [getAvatar] as const;
