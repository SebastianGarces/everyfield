import { sql } from "../../../packages/db/node_modules/drizzle-orm/index.js";
import { closeDatabase, createDatabase } from "../../../packages/db/src/client.ts";
import { catalogVersion, REFERENCE_TEAM_KEY } from "../../../packages/domain/src/teams/responsibilities/playbook.ts";

const admin = createDatabase({ connectionString: process.env.DATABASE_URL!, max: 1 });
try {
	const out: Record<string, string | null> = {};
	for (const key of Object.keys(REFERENCE_TEAM_KEY)) {
		const found = await admin.execute(
			sql`SELECT ${catalogVersion()} AS "versionId" FROM (SELECT ${key}::text AS template_key) t`,
		);
		out[key] = (found.rows[0] as { versionId: string | null }).versionId;
	}
	console.log(JSON.stringify(out));
} finally {
	await closeDatabase(admin);
}
