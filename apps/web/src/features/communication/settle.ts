import "server-only";

import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { jobDatabase } from "../../server/database.ts";
import { mailCallbackHandler } from "../../server/jobs/webhook.ts";

// Dev-only companion of the mail capture (criterion 35). A real provider posts `email.sent` after it accepts a
// message. Capture delivers nothing, so without this a captured send would stay Scheduled with 0 delivered.
// Each captured message gets the same signed callback the provider would post, applied by the one mail
// callback handler the app uses. The secret is made here for this process and is never an app setting.

const secret = (() => {
	const key = randomBytes(32);
	return { key, text: `whsec_${key.toString("base64")}` };
})();

/** Delays in milliseconds. The mail row takes its provider id after the send returns, so the first post may wait. */
const DELAYS = [500, 3_000];

async function post(body: string, svixId: string): Promise<void> {
	const db = jobDatabase();
	if (!db) return;
	const stamp = String(Math.floor(Date.now() / 1000));
	const signature = createHmac("sha256", secret.key).update(`${svixId}.${stamp}.${body}`).digest("base64");
	await mailCallbackHandler(
		db,
		secret.text,
	)(
		new Request("https://callback.invalid/", {
			method: "POST",
			headers: { "svix-id": svixId, "svix-timestamp": stamp, "svix-signature": `v1,${signature}` },
			body,
		}),
	);
}

/** Posts `email.sent` for each captured provider id. A failure leaves the message Scheduled, as before. */
export function settleCaptured(ids: readonly string[]): void {
	for (const id of ids) {
		const body = JSON.stringify({ type: "email.sent", created_at: new Date().toISOString(), data: { email_id: id } });
		const svixId = randomUUID();
		for (const delay of DELAYS) {
			setTimeout(() => void post(body, svixId).catch(() => undefined), delay).unref();
		}
	}
}
