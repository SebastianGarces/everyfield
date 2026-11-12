// T-163: the web app's Next config sends baseline security headers on every response and keeps the invitation page's
// no-referrer override after them; `next dev` logs no request whose URL carries a link token; the product dark
// viewport is the dark page-frame token.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { test } from "node:test";

const { default: config } = await import("../../../apps/web/next.config.ts");
const { THEME_VIEWPORT } = await import("../../../apps/web/src/app/viewport.ts");
const require = createRequire(new URL("../../../apps/web/package.json", import.meta.url));
const { ignoreLoggingIncomingRequests } = require("next/dist/server/dev/log-requests.js");

type Header = { key: string; value: string };
type Rule = { source: string; headers: Header[] };

const rules: Rule[] = await config.headers();
const value = (rule: Rule | undefined, key: string) => rule?.headers.find((h) => h.key === key)?.value;

test("T-163: every response refuses framing and sniffing and has a default Referrer-Policy", () => {
	const global = rules.findIndex((r) => r.source === "/:path*");
	assert.notEqual(global, -1, "no global /:path* headers rule");
	assert.equal(value(rules[global], "X-Frame-Options"), "DENY");
	assert.equal(value(rules[global], "X-Content-Type-Options"), "nosniff");
	assert.equal(value(rules[global], "Referrer-Policy"), "strict-origin-when-cross-origin");
});

test("T-163: /invitation sends no Referer, its rule after the global one so its value wins", () => {
	const global = rules.findIndex((r) => r.source === "/:path*");
	const invitation = rules.findIndex((r) => r.source === "/invitation");
	assert.notEqual(invitation, -1, "no /invitation headers rule");
	assert.ok(invitation > global, "the /invitation rule must come after the global rule");
	assert.equal(value(rules[invitation], "Referrer-Policy"), "no-referrer");
	assert.equal(value(rules[invitation], "X-Robots-Tag"), "noindex, nofollow");
});

test("T-163: the dev request log skips every URL that carries a link token", () => {
	const token = "Sentinel_tok-123";
	const skipped = (url: string) => ignoreLoggingIncomingRequests({ url }, config.logging);
	for (const url of [
		`/rsvp/${token}`,
		`/rsvp/${token}?_rsc=abc`,
		`/unsubscribe/${token}`,
		`/email-preferences/${token}/one-click`,
		`/confirm-email?token=${token}`,
		`/verify-email?token=${token}`,
		`/reset-password?token=${token}&_rsc=abc`,
		`/signin?returnTo=${encodeURIComponent(`/confirm-email?token=${token}`)}`,
	])
		assert.equal(skipped(url), true, `${url} is logged`);
	for (const url of ["/people", "/settings/account", "/", "/signin?returnTo=%2Fpeople", "/invitation"])
		assert.equal(skipped(url), false, `${url} is not logged`);
});

test("T-163: the dark product viewport is the dark page frame token; light matches the marketing canvas", () => {
	const tokens = readFileSync(new URL("../../../design/handoff/tokens.css", import.meta.url), "utf8");
	const dark = tokens.slice(tokens.search(/^\[data-theme="dark"\] \{/m)).match(/--ef-frame:\s*(#[0-9a-f]{6})/i)?.[1];
	assert.equal(THEME_VIEWPORT.dark.themeColor.toLowerCase(), dark?.toLowerCase());
	assert.equal(THEME_VIEWPORT.dark.colorScheme, "dark");
	assert.deepEqual(THEME_VIEWPORT.light, { themeColor: "#FCFBF8", colorScheme: "light" });
});
