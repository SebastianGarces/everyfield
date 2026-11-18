import "server-only";

import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { jobDatabase } from "../database.ts";
import { mailCallbackHandler } from "../jobs/webhook.ts";

const secret = (() => {
	const key = randomBytes(32);
	return { key, text: `whsec_${key.toString("base64")}` };
})();

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

export function settleCaptured(ids: readonly string[]): void {
	for (const id of ids) {
		const body = JSON.stringify({ type: "email.sent", created_at: new Date().toISOString(), data: { email_id: id } });
		const svixId = randomUUID();
		for (const delay of DELAYS) {
			setTimeout(() => void post(body, svixId).catch(() => undefined), delay).unref();
		}
	}
}
