import { createRequire } from "node:module";
import { sql } from "../../packages/db/src/query.ts";
import type { Database } from "../../packages/db/src/client.ts";
import { CLOSED_MARK } from "./restore.mts";
import { sourceClass, type Neon } from "./source.mts";
const require = createRequire(new URL("../../packages/domain/package.json", import.meta.url));
const { z }: typeof import("../../packages/domain/node_modules/zod/index.js") = require("zod");

export const OPEN_OPERATION = "maintenance.openDrillTarget";
export const OPENED_MARK = "everyfield isolated restore: opened for a drill";
const TARGET = /^[a-z][a-z0-9_]{0,62}$/;
const ROLES = ["everyfield_runtime", "everyfield_auth", "everyfield_cleanup"];
const capability = z.strictObject({
	authority: z.literal("authorized_restricted_recovery_operator"),
	verified: z.literal(true),
	operation_ids: z.array(z.string()).refine((ids: string[]) => ids.includes(OPEN_OPERATION)),
	environment: z.literal("isolated-drill"),
});

export type OpenResult =
	| { opened: true; refusal: null; target: string; sessions_removed: number; customer_data_gate: "blocked" }
	| { opened: false; refusal: "operator_unavailable" | "target_not_isolated_drill" };

export async function openDrillTarget(
	deps: { admin: Database; connection: URL; neon: () => Neon },
	input: { capability: unknown; target: string },
): Promise<OpenResult> {
	if (!capability.safeParse(input.capability).success) return { opened: false, refusal: "operator_unavailable" };
	const refused = { opened: false, refusal: "target_not_isolated_drill" } as const;
	const { target } = input;
	if (!TARGET.test(target) || target === "public") return refused;
	if (!["disposable", "drill"].includes(sourceClass(deps.connection, deps.neon))) return refused;
	return deps.admin.transaction(async (tx) => {
		const [found] = (
			await tx.execute<{ mark: string | null }>(
				sql`SELECT obj_description(oid, 'pg_namespace') AS mark FROM pg_namespace WHERE nspname=${target}`,
			)
		).rows;
		if (found?.mark !== CLOSED_MARK) return refused;
		await tx.execute(sql.raw(`SET LOCAL search_path TO ${target}, pg_catalog, pg_temp`));
		const sessions = await tx.execute(sql`DELETE FROM auth_session`);
		await tx.execute(sql`DELETE FROM auth_verification`);
		await tx.execute(sql`UPDATE identity_proof SET superseded_at=clock_timestamp()
			WHERE superseded_at IS NULL AND consumed_at IS NULL`);
		await tx.execute(sql.raw(`GRANT USAGE ON SCHEMA ${target} TO ${ROLES.join(", ")}`));
		await tx.execute(sql.raw(`COMMENT ON SCHEMA ${target} IS '${OPENED_MARK}'`));
		return {
			opened: true,
			refusal: null,
			target,
			sessions_removed: sessions.rowCount ?? 0,
			customer_data_gate: "blocked",
		};
	});
}
