import type { Transaction } from "@everyfield/db/client";
import { sql } from "@everyfield/db/query";
import { z } from "zod";
import { registry, type Registry } from "./registry.ts";
import { GLOBAL_TENANT } from "./values.ts";

type Db = Pick<Transaction, "execute">;

const globalRow = z.object({ name: z.string(), value: z.boolean().nullable() });

export async function readGlobalValues<R extends Registry = typeof registry>(
	db: Db,
	declared: R = registry as unknown as R,
): Promise<ReadonlyMap<keyof R & string, boolean | null>> {
	const { rows } = await db.execute(sql`SELECT f.name, f.value FROM feature_flag f
 WHERE f.tenant_id=${GLOBAL_TENANT}::uuid AND f.name=ANY(${sql.param(Object.keys(declared))}::text[])`);
	return new Map(z.array(globalRow).parse(rows).map((row) => [row.name as keyof R & string, row.value]));
}

const overrideRow = z.object({ tenant: z.string(), kind: z.enum(["plant", "organization", "account"]), value: z.boolean() });
export type FlagOverride = z.infer<typeof overrideRow>;

export async function readOverrides(db: Db, name: string): Promise<readonly FlagOverride[]> {
	const { rows } = await db.execute(sql`SELECT f.tenant_id::text AS tenant, t.kind, f.value
 FROM feature_flag f JOIN tenant t ON t.id=f.tenant_id
 WHERE f.name=${name} AND f.tenant_id<>${GLOBAL_TENANT}::uuid AND f.value IS NOT NULL
 ORDER BY t.kind, f.tenant_id`);
	return z.array(overrideRow).parse(rows);
}

const staleRow = z.object({ name: z.string(), since: z.coerce.date(), days: z.coerce.number().int() });
export type StaleFlag = z.infer<typeof staleRow>;

export async function readStaleReleaseFlags<R extends Registry = typeof registry>(
	db: Db,
	minimumDays: number,
	declared: R = registry as unknown as R,
): Promise<readonly StaleFlag[]> {
	const release = Object.entries(declared)
		.filter(([, flag]) => flag.kind === "release")
		.map(([name]) => name);
	const { rows } = await db.execute(sql`SELECT f.name, c.occurred_at AS since,
 floor(extract(epoch FROM clock_timestamp()-c.occurred_at)/86400)::int AS days
 FROM feature_flag f
 CROSS JOIN LATERAL (SELECT a.occurred_at FROM audit_event a
  WHERE a.tenant_id=${GLOBAL_TENANT}::uuid AND a.subject_id=f.id AND a.action='flags.changed'
  ORDER BY a.occurred_at DESC, a.id DESC LIMIT 1) c
 WHERE f.tenant_id=${GLOBAL_TENANT}::uuid AND f.value AND f.name=ANY(${sql.param(release)}::text[])
  AND c.occurred_at<=clock_timestamp()-make_interval(days=>${minimumDays}::int)
 ORDER BY c.occurred_at, f.name`);
	return z.array(staleRow).parse(rows);
}

export async function readAccountIdByEmail(db: Db, email: string): Promise<string | null> {
	const { rows } = await db.execute(sql`SELECT a.id::text AS id FROM account a JOIN auth_user u ON u.id=a.auth_user_id
 WHERE lower(u.email)=lower(${email})`);
	const found = z.array(z.object({ id: z.string() })).parse(rows);
	return found.length === 1 ? found[0]!.id : null;
}
