import "../runs-in/render.mjs";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire, registerHooks } from "node:module";
import { test } from "node:test";

const WEB = new URL("../../../apps/web/", import.meta.url);
const web = createRequire(new URL("package.json", WEB));
registerHooks({
	resolve: (specifier, context, next) =>
		specifier === "server-only" ? { url: "data:text/javascript,", shortCircuit: true } : next(specifier, context),
});
const { createElement } = web("react");
const { renderToStaticMarkup } = web("react-dom/server");
const load = (file: string) => import(new URL(`src/${file}`, WEB).href);
const { default: Privacy } = await load("app/privacy/page.tsx");
const { default: Terms } = await load("app/terms/page.tsx");
const { default: robots } = await load("app/robots.ts");
const { default: sitemap } = await load("app/sitemap.ts");
const { proxy, config } = await load("proxy.ts");
const { NextRequest } = web("next/server");

const { cases } = JSON.parse(
	readFileSync(new URL("../../../docs/acceptance/operations.json", import.meta.url), "utf8"),
);
const { expected } = cases.find((c: { id: string }) => c.id === "CASE-ADM-007");
const { shared } = JSON.parse(readFileSync(new URL("../../../design/marketing-copy.json", import.meta.url), "utf8"));
const lines = (value: unknown): string[] =>
	typeof value === "string"
		? [value]
		: Object.entries(value as object).flatMap(([key, child]) => (key === "note" ? [] : lines(child)));
const textOf = (page: unknown) =>
	renderToStaticMarkup(createElement(page))
		.replace(/<(style|script)[\s\S]*?<\/\1>/g, " ")
		.replace(/<\/?a\b[^>]*>/g, "")
		.replace(/<[^>]+>/g, "\n")
		.replace(/&#x27;/g, "'")
		.replace(/&amp;/g, "&")
		.replace(/\s+/g, " ");

const VENDOR_OR_OUTAGE =
	/\b(?:vercel|neon|tigris|amazon|aws|postgres\w*|cloudflare|openai|anthropic|langfuse|azure|outages?|us-east-1)\b/i;
const EXACT_TIMEFRAME =
	/\b(?:\d+|seven|thirty|twelve|thirty-seven|one|an?)[\s-]+(?:calendar )?(?:hour|day|week|month|year)s?\b/i;
const PHYSICAL_ERASURE = /day 37|37 days|physical(?:ly)?|permanently erase|recall/i;

test("INV-marketing: the served privacy page states backup deletion and outside-copy limits in general terms, and robots grants and refuses no access", () => {
	const text = textOf(Privacy);
	for (const line of lines(shared.privacy_page)) assert.ok(text.includes(line), line);
	const { result, event } = expected;
	assert.deepEqual(
		{
			policy_states_deletion_reaches_backups: text.includes(
				"When data is deleted, it's also removed from our backups as they roll over on a regular schedule.",
			),
			policy_states_external_copy_limits: text.includes(
				"Our providers may keep service logs and backup copies under their own retention policies.",
			),
			policy_names_vendor_or_outage: VENDOR_OR_OUTAGE.test(text),
			policy_exact_timeframe: EXACT_TIMEFRAME.test(text),
			physical_day37_claim: PHYSICAL_ERASURE.test(text),
		},
		{
			policy_states_deletion_reaches_backups: result.policy_states_deletion_reaches_backups,
			policy_states_external_copy_limits: result.policy_states_external_copy_limits,
			policy_names_vendor_or_outage: result.policy_names_vendor_or_outage,
			policy_exact_timeframe: result.policy_exact_timeframe,
			physical_day37_claim: result.physical_day37_claim,
		},
	);

	const { rules } = robots();
	assert.equal(rules.disallow, "/");
	for (const [page, path] of [
		[Privacy, "/privacy"],
		[Terms, "/terms"],
	]) {
		assert.ok(textOf(page).length > 1000, "served with no session");
		assert.ok(rules.allow.includes(path));
		assert.ok(sitemap().some((entry: { url: string }) => entry.url.endsWith(path)));
		assert.equal(
			config.matcher.some((m: string) => m.startsWith(path)),
			false,
		);
	}
	const visits = ["/overview", "/people"].map((path) => {
		assert.equal(rules.allow.includes(path), false);
		const answer = proxy(
			new NextRequest(`https://everyfield.app${path}`, {
				headers: { "user-agent": "ignores-robots/1.0" },
			}),
		);
		return [answer.status, new URL(answer.headers.get("location")).pathname];
	});
	assert.deepEqual(visits, [
		[307, "/signin"],
		[307, "/signin"],
	]);
	assert.equal(result.robots_is_auth, false);
	assert.equal(event, null);
});
