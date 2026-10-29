// Dev preview only: marks every captured send as "sent", the way the provider's `email.sent` callback does, so the
// Messages history can show a Sent message. It signs the callback with a throwaway secret and posts it to the one
// mail callback handler the app uses. Nothing is delivered. Run after a Send now on a preview seeded by tests/ui.
//
//   node --env-file=<home apps/web/.env.local> --conditions=react-server --import tsx tests/ui/communication/settle.mts
import { sql } from "../../../packages/db/node_modules/drizzle-orm/index.js";
import { mailCallbackHandler } from "../../../apps/web/src/server/jobs/webhook.ts";
import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { fixturePath } from "../setup.mjs";
import { openSeedEnvironment } from "../seed-env.mts";

const people = JSON.parse(readFileSync(fixturePath("people"), "utf8"));
const env = await openSeedEnvironment(people.origin);
const key = randomBytes(32);
const secret = `whsec_${key.toString("base64")}`;
const handler = mailCallbackHandler(env.runtime, secret);
const rows = await env.admin.execute(
	sql`SELECT provider_message_id AS id FROM mail WHERE provider_message_id LIKE 'capture-%' AND sent_at IS NULL`,
);
let settled = 0;
for (const { id } of rows.rows as { id: string }[]) {
	const body = JSON.stringify({ type: "email.sent", created_at: new Date().toISOString(), data: { email_id: id } });
	const svixId = randomUUID();
	const stamp = String(Math.floor(Date.now() / 1000));
	const signature = createHmac("sha256", key).update(`${svixId}.${stamp}.${body}`).digest("base64");
	const response = await handler(
		new Request("https://callback.test/", {
			method: "POST",
			headers: { "svix-id": svixId, "svix-timestamp": stamp, "svix-signature": `v1,${signature}` },
			body,
		}),
	);
	if (response.status >= 300) throw Error(`callback refused: ${response.status}`);
	settled += 1;
}
await env.close();
console.log(JSON.stringify({ settled }));
