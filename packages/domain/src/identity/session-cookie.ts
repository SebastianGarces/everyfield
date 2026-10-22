import "server-only";
import { createHmac, timingSafeEqual } from "node:crypto";

// Better Auth signs its session cookie as `<token>.<signature>`: HMAC-SHA256 of the token with the auth secret, in
// standard base64 with padding, so always 43 characters and "=". Anything else is refused, as better-call refuses it.
const SIGNATURE = /^[A-Za-z0-9+/]{43}=$/;

/** The token of a session cookie value that Better Auth signed with `secret`, else null. */
export function signedSessionToken(value: string | undefined, secret: string): string | null {
	if (!value) return null;
	const cookie = value.includes("%") ? decodeURIComponent(value) : value;
	const dot = cookie.lastIndexOf(".");
	if (dot < 1) return null;
	const token = cookie.slice(0, dot);
	const signature = cookie.slice(dot + 1);
	if (!SIGNATURE.test(signature)) return null;
	const given = Buffer.from(signature, "base64");
	const expected = createHmac("sha256", secret).update(token).digest();
	return given.length === expected.length && timingSafeEqual(given, expected) ? token : null;
}
