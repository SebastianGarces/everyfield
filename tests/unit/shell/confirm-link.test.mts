import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { test } from "node:test";

const web = createRequire(new URL("../../../apps/web/package.json", import.meta.url));
const { NextRequest } = web("next/server");
const { getPathMatch } = web("next/dist/shared/lib/router/utils/path-match.js");
const { proxy, config, EMAIL_CHANGE_PROOF_COOKIE } = await import("../../../apps/web/src/proxy.ts");

const token = "Sentinel_tok-123";
const proxied = (url: string) => config.matcher.some((source: string) => getPathMatch(source)(new URL(url).pathname));

test("INV-link: an email-change link leaves the address and the sign-in return path, and its value is kept only for the confirm page", () => {
	const arrival = `https://everyfield.test/confirm-email?token=${token}`;
	assert.equal(proxied(arrival), true);
	const kept = proxy(new NextRequest(arrival));
	assert.equal(kept.status, 307);
	assert.equal(kept.headers.get("location"), "https://everyfield.test/confirm-email");
	const cookie = kept.cookies.get(EMAIL_CHANGE_PROOF_COOKIE);
	assert.deepEqual(
		{
			value: cookie?.value,
			path: cookie?.path,
			httpOnly: cookie?.httpOnly,
			secure: cookie?.secure,
			sameSite: cookie?.sameSite,
		},
		{ value: token, path: "/confirm-email", httpOnly: true, secure: true, sameSite: "lax" },
	);
	const signedOut = proxy(new NextRequest("https://everyfield.test/confirm-email"));
	assert.equal(signedOut.headers.get("location"), "https://everyfield.test/signin?returnTo=%2Fconfirm-email");
	assert.equal(signedOut.headers.get("set-cookie"), null);
});

test("INV-link: a reset or verify link leaves the address before the page, and its value is kept only for that page and its answer", () => {
	for (const [page, name] of [
		["/reset-password", "ef-reset-proof"],
		["/verify-email", "ef-verify-proof"],
	]) {
		const arrival = `https://everyfield.test${page}?step=2&token=${token}`;
		assert.equal(proxied(arrival), true);
		const kept = proxy(new NextRequest(arrival));
		assert.equal(kept.status, 307);
		assert.equal(kept.headers.get("location"), `https://everyfield.test${page}?step=2`);
		assert.deepEqual(kept.headers.getSetCookie(), [
			`${name}=${token}; Path=${page}; Max-Age=3600; HttpOnly; SameSite=Lax; Secure`,
			`${name}=${token}; Path=/api/auth${page}; Max-Age=3600; HttpOnly; SameSite=Lax; Secure`,
		]);
		const bare = proxy(new NextRequest(`https://everyfield.test${page}`));
		assert.deepEqual([bare.status, bare.headers.get("location"), bare.headers.getSetCookie()], [200, null, []]);
	}
});
