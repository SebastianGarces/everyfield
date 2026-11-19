import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { test } from "node:test";

const { default: config } = await import("../../../apps/web/next.config.ts");
const require = createRequire(new URL("../../../apps/web/package.json", import.meta.url));
const { ignoreLoggingIncomingRequests } = require("next/dist/server/dev/log-requests.js");
const { getPathMatch } = require("next/dist/shared/lib/router/utils/path-match.js");

type Header = { key: string; value: string };
type Rule = { source: string; headers: Header[] };

assert.ok(config.headers, "next.config sets response headers");
const rules: Rule[] = await config.headers();
const value = (rule: Rule | undefined, key: string) => rule?.headers.find((h) => h.key === key)?.value;
const served = (url: string, key: string) => {
	const pathname = new URL(url, "http://127.0.0.1").pathname;
	let found: string | undefined;
	for (const rule of rules) if (getPathMatch(rule.source)(pathname)) found = value(rule, key) ?? found;
	return found;
};

const token = "Sentinel_tok-123";
const linkUrls = [
	`/rsvp/${token}`,
	`/rsvp/${token}?_rsc=abc`,
	`/unsubscribe/${token}`,
	`/unsubscribe/${token}/one-click`,
	`/email-preferences/${token}`,
	`/email-preferences/${token}/one-click`,
	`/confirm-email?token=${token}`,
	`/verify-email?token=${token}`,
	`/reset-password?token=${token}&_rsc=abc`,
	`/signin?returnTo=${encodeURIComponent(`/confirm-email?token=${token}`)}`,
];

test("every response refuses framing and sniffing and has a default Referrer-Policy", () => {
	const global = rules.findIndex((r) => r.source === "/:path*");
	assert.notEqual(global, -1, "no global /:path* headers rule");
	assert.equal(value(rules[global], "X-Frame-Options"), "DENY");
	assert.equal(value(rules[global], "X-Content-Type-Options"), "nosniff");
	assert.equal(value(rules[global], "Referrer-Policy"), "strict-origin-when-cross-origin");
});

test("AC: every page a mailed link opens sends no Referer", () => {
	for (const url of [...linkUrls, `/invitation#proof=${token}`, `/connections/respond?invitation=1#${token}`])
		assert.equal(served(url, "Referrer-Policy"), "no-referrer", `${url} sends a Referer`);
	for (const url of ["/people", "/settings/account", "/", "/signin-help", "/meetings"])
		assert.equal(served(url, "Referrer-Policy"), "strict-origin-when-cross-origin", `${url} lost the default`);
	assert.equal(served("/invitation", "X-Robots-Tag"), "noindex, nofollow");
});

test("the dev request log skips every URL that carries a link token", () => {
	const skipped = (url: string) => ignoreLoggingIncomingRequests({ url }, config.logging);
	for (const url of linkUrls) assert.equal(skipped(url), true, `${url} is logged`);
	for (const url of ["/people", "/settings/account", "/", "/signin?returnTo=%2Fpeople", "/invitation"])
		assert.equal(skipped(url), false, `${url} is not logged`);
});
