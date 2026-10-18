import { createDatabase, closeDatabase } from "../../../packages/db/src/client.ts";
import { sql as querySql } from "../../../packages/db/node_modules/drizzle-orm/index.js";
import { createRequire } from "node:module";
import { randomBytes } from "node:crypto";
import { createMailService } from "../../../apps/web/src/server/jobs/mail.ts";
import { createResendTransport } from "../../../apps/web/src/server/jobs/resend.ts";
import { claimDue } from "../../../apps/web/src/server/jobs/queue.ts";
const require = createRequire(new URL("../../../apps/web/package.json", import.meta.url));
const url = new URL(process.env.JOBS_TEST_CONNECTION ?? "about:blank");
if (url.hostname !== "ep-autumn-dew-b8ltidky.c-14.us-east-1.aws.neon.tech" || process.env.NODE_ENV === "production")
	throw Error("test_database_required");
const endpoint = new URL(process.env.JOBS_TEST_ENDPOINT ?? "about:blank");
if (endpoint.hostname !== "127.0.0.1") throw Error("local_provider_required");
const db = createDatabase({ connectionString: url.href, options: process.env.JOBS_TEST_OPTIONS, max: 2 });
const service = createMailService({
	db,
	encryptionKey: Buffer.from(process.env.JOBS_TEST_KEY ?? "", "base64"),
	addressKey: randomBytes(32),
	from: "no-reply@example.test",
	authorize: async (tx, m) =>
		(
			await tx.execute(
				querySql`SELECT id FROM seat WHERE account_id=${querySql.param(m.recipient)} AND plant_id=${querySql.param(m.tenant)} AND ended_at IS NULL FOR SHARE`,
			)
		).rowCount === 1,
	transport: createResendTransport("synthetic", async (url, init) =>
		fetch(endpoint.origin + new URL(url).pathname, init),
	),
});
try {
	const [claim] = await claimDue(db, ["mail"]);
	if (!claim) throw Error("claim_required");
	await service.dispatch(claim);
} finally {
	await closeDatabase(db);
}
