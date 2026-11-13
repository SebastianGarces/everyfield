// One trusted-IP rule (peo-36): early access passes `{ headers: await headers() }` and identity passes the Request, and
// both read the IP through trustedIdentityIp. No database.
import test from "node:test";
import assert from "node:assert/strict";
import { trustedIdentityIp } from "../../../packages/domain/src/identity/ingress.ts";

const header = (value) => ({ "x-vercel-forwarded-for": value, "x-forwarded-for": "198.51.100.9" });
const earlyAccess = (value, vercel) => trustedIdentityIp({ headers: new Headers(header(value)) }, vercel);
const identity = (value, vercel) =>
	trustedIdentityIp(new Request("https://app.example.test/api/auth", { headers: header(value) }), vercel);

test("INV-identity: early access and identity read the same IP, or null, from the same header", () => {
	const cases = [
		["192.0.2.1, 192.0.2.2", true, null],
		["192.0.2.1", true, "192.0.2.1"],
		["2001:db8::1", true, "2001:db8::1"],
		["192.0.2.1", false, null],
		["192.0.2.1, 192.0.2.2", false, null],
		["not-an-ip", true, null],
	];
	for (const [value, vercel, expected] of cases) {
		assert.equal(earlyAccess(value, vercel), expected, `early access: ${value} vercel=${vercel}`);
		assert.equal(identity(value, vercel), expected, `identity: ${value} vercel=${vercel}`);
	}
});
