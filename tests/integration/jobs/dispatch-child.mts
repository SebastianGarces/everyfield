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
	authorize: async (tx,mail) => {
 const input=mail.map(m=>({id:m.id,recipient:m.recipient,tenant:m.tenant}));
 const r=await tx.execute(querySql`SELECT i.id FROM jsonb_to_recordset(${JSON.stringify(input)}::jsonb) i(id uuid,recipient uuid,tenant uuid) JOIN seat s ON s.account_id=i.recipient AND s.plant_id=i.tenant AND s.ended_at IS NULL FOR SHARE OF s`);
 return new Set(r.rows.map(r=>r.id));
 },
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
