import type { Backfill } from "@everyfield/db/migrate";
import { sql } from "@everyfield/db/query";

export function residentDiscoveryBackfill(): Backfill {
	return {
		name: "resident_discovery_d1891",
		async run(tx) {
			const result = await tx.execute(sql`INSERT INTO discovery(id,account_id,revision)
 SELECT gen_random_uuid(),l.account_id,1 FROM (SELECT DISTINCT account_id FROM residency_link) l
 WHERE NOT EXISTS(SELECT FROM seat WHERE account_id=l.account_id AND ended_at IS NULL)
 AND NOT EXISTS(SELECT FROM discovery WHERE account_id=l.account_id) ON CONFLICT (account_id) DO NOTHING`);
			return result.rowCount ?? 0;
		},
	};
}
