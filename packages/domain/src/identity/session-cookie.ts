import "server-only";
import { createHmac, timingSafeEqual } from "node:crypto";

const SIGNATURE = /^[A-Za-z0-9+/]{43}=$/;

export function signedSessionToken(value: string | undefined, secret: string): string | null {
	if (!value) return null;
	const dot = value.lastIndexOf(".");
	if (dot < 1) return null;
	const token = value.slice(0, dot);
	const signature = value.slice(dot + 1);
	if (!SIGNATURE.test(signature)) return null;
	const given = Buffer.from(signature, "base64");
	const expected = createHmac("sha256", secret).update(token).digest();
	return given.length === expected.length && timingSafeEqual(given, expected) ? token : null;
}
