import "server-only";
import { createHmac, timingSafeEqual } from "node:crypto";
import type { Pool } from "pg";
import { z } from "zod";
import { boundedBytes, Refusal } from "./boundary.ts";
import { transaction } from "./database.ts";

export function verifyCallback(raw: Uint8Array, headers: Headers, secret: string, now = Date.now()) {
	const id = headers.get("svix-id");
	const stamp = headers.get("svix-timestamp");
	if (
		!id ||
		id.length > 128 ||
		!stamp ||
		!/^\d{10}$/.test(stamp) ||
		Math.abs(now / 1000 - Number(stamp)) > 300 ||
		!/^whsec_[A-Za-z0-9+/]+=*$/.test(secret)
	)
		throw new Refusal("unavailable", 404);
	const key = Buffer.from(secret.slice(6), "base64");
	if (key.length < 32) throw new Refusal("unavailable", 404);
	const digest = createHmac("sha256", key).update(`${id}.${stamp}.`).update(raw).digest();
	const matches = (headers.get("svix-signature") ?? "").split(" ").some((part) => {
		if (!part.startsWith("v1,")) return false;
		const candidate = Buffer.from(part.slice(3), "base64");
		return candidate.length === digest.length && timingSafeEqual(candidate, digest);
	});
	if (!matches) throw new Refusal("unavailable", 404);
	return id;
}
const payload = z.object({
	type: z.enum(["email.sent", "email.delivered", "email.bounced"]),
	data: z.object({ email_id: z.string().min(1).max(128) }),
});
export async function receiveCallback(db: Pool, request: Request, secret: string) {
	const raw = await boundedBytes(request, 16_384);
	const event = verifyCallback(raw, request.headers, secret);
	let value: unknown;
	try {
		value = JSON.parse(new TextDecoder().decode(raw));
	} catch {
		throw new Refusal("invalid_input", 422);
	}
	const parsed = payload.safeParse(value);
	if (!parsed.success) throw new Refusal("invalid_input", 422);
	const rank = { "email.sent": 1, "email.delivered": 2, "email.bounced": 3 }[parsed.data.type];
	await transaction(db, async (tx) => {
		const message = (
			await tx.query("SELECT id FROM proof_mail WHERE provider_id=$1 FOR UPDATE", [parsed.data.data.email_id])
		).rows[0];
		if (!message) return;
		const inserted = await tx.query(
			"INSERT INTO proof_provider_event(id) VALUES($1) ON CONFLICT DO NOTHING RETURNING id",
			[event],
		);
		if (inserted.rowCount === 1)
			await tx.query("UPDATE proof_mail SET rank=greatest(rank,$2) WHERE id=$1", [message.id, rank]);
	});
	return { accepted: true };
}
