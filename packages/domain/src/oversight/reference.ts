import { RUBRIC_VERSION } from "@everyfield/contracts/oversight";
import type { Database } from "@everyfield/db/client";
import { sql } from "@everyfield/db/query";
import { createHash } from "node:crypto";
import "server-only";
import { z } from "zod";
import rubric from "../../../../docs/reference/network-rubric-v1.json" with { type: "json" };

export const NETWORK_RUBRIC_HASH = createHash("sha256").update(JSON.stringify(rubric)).digest("hex");

export const activeReference = sql`(SELECT n.activation_number FROM network_reference n
	WHERE n.activation_number IS NOT NULL ORDER BY n.activation_number DESC LIMIT 1)`;

type Db = Pick<Database, "execute">;
const idRow = z.object({ id: z.uuid() });

export async function writeNetworkReference(db: Db, input: { rubricVersion: string; contentHash: string }) {
	const { rows } = await db.execute(sql`INSERT INTO network_reference(rubric_version,content_hash,state)
	VALUES(${input.rubricVersion},${input.contentHash},'building') RETURNING id`);
	return idRow.parse(rows[0]).id;
}

export async function validateNetworkReference(db: Db, id: string) {
	const { rows } = await db.execute(sql`UPDATE network_reference SET state=CASE
	WHEN rubric_version=${RUBRIC_VERSION} AND content_hash=${NETWORK_RUBRIC_HASH} THEN 'validated' ELSE 'failed' END
	WHERE id=${id}::uuid AND state='building' RETURNING state`);
	return z.object({ state: z.enum(["validated", "failed"]) }).parse(rows[0]).state;
}

export async function activateNetworkReference(db: Db, id: string) {
	const { rows } = await db.execute(sql`UPDATE network_reference SET
	activation_number=coalesce((SELECT max(n.activation_number) FROM network_reference n),0)+1,activated_at=clock_timestamp()
	WHERE id=${id}::uuid AND state='validated' AND activation_number IS NULL RETURNING activation_number`);
	const row = z.object({ activation_number: z.int() }).safeParse(rows[0]);
	return row.success ? row.data.activation_number : null;
}
