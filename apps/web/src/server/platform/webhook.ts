import { createHmac, timingSafeEqual } from "node:crypto";
import "server-only";
import { Refusal } from "./boundary.ts";

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
