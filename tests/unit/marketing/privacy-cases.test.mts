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
const { action, expected } = cases.find((c: { id: string }) => c.id === "CASE-ADM-007");
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
		.replace(/&quot;/g, '"')
		.replace(/&amp;/g, "&")
		.replace(/\s+/g, " ");

const VENDOR =
	/\b(?:vercel|neon|tigris|amazon|aws|postgres\w*|cloudflare|openai|anthropic|langfuse|azure|us-east-1)\b/i;
const PHYSICAL_ERASURE = /day 37|37 days|physical(?:ly)?|permanently erase|recall/i;

test("AC:CASE-ADM-007 INV-marketing: the served privacy page states the private hold, live removal, the backup limit, no exact erasure day, the outside-copy limits and no set recovery time, names no vendor, and robots grants and refuses no access", () => {
	const text = textOf(Privacy);
	for (const line of lines(shared.privacy_page)) assert.ok(text.includes(line), line);
	const { cancel_days, copy_days_after_purge } = action.arguments;
	const states = (line: string) => text.includes(line);
	const { result, event } = expected;
	assert.deepEqual(
		{
			policy_states_access_stops_at_once: states("Normal access stops at once."),
			policy_states_cancellation_period: states(
				`We keep the data privately for ${cancel_days} days so the request can be cancelled.`,
			),
			policy_states_live_removal: states("After that, we remove the data from the live systems."),
			policy_states_deletion_reaches_backups: states(
				`Backup copies last at most ${copy_days_after_purge} more days after that removal.`,
			),
			policy_states_no_exact_erasure_day: states("We do not promise that every copy is gone on an exact day."),
			policy_states_shared_attribution: states(
				"We may keep a short note that an account was deleted, not a full profile.",
			),
			policy_states_external_copy_limits:
				states(
					"Email already sent, a public feedback issue already published, and a file someone already downloaded cannot be taken back at once.",
				) && states("Our providers may keep service logs and backup copies under their own retention policies."),
			policy_states_no_recovery_time: states("We do not promise a set recovery time if that provider has an outage."),
			policy_names_vendor: VENDOR.test(text),
			physical_day37_claim: PHYSICAL_ERASURE.test(text),
		},
		{
			policy_states_access_stops_at_once: result.policy_states_access_stops_at_once,
			policy_states_cancellation_period: result.policy_states_cancellation_period,
			policy_states_live_removal: result.policy_states_live_removal,
			policy_states_deletion_reaches_backups: result.policy_states_deletion_reaches_backups,
			policy_states_no_exact_erasure_day: result.policy_states_no_exact_erasure_day,
			policy_states_shared_attribution: result.policy_states_shared_attribution,
			policy_states_external_copy_limits: result.policy_states_external_copy_limits,
			policy_states_no_recovery_time: result.policy_states_no_recovery_time,
			policy_names_vendor: result.policy_names_vendor,
			physical_day37_claim: result.physical_day37_claim,
		},
	);
	assert.equal(VENDOR.test(textOf(Terms)), result.policy_names_vendor);

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
