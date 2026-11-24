import "../runs-in/render-module-mocks.mjs";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { createRequire, registerHooks } from "node:module";
import { mock, test } from "node:test";
import { pathToFileURL } from "node:url";
import { setServerEnv } from "../../support/server-env.mts";

const at = (path: string) => new URL(`../../../apps/web/src/${path}`, import.meta.url).href;
const web = createRequire(new URL("../../../apps/web/package.json", import.meta.url));
const key = randomBytes(32);
setServerEnv();
process.env.NOTIFICATION_OPT_OUT_KEYS = key.toString("base64");

const read: string[] = [];
const session = (name: string) => async () => {
	read.push(name);
	return null;
};
registerHooks({
	resolve: (specifier, context, next) =>
		specifier === "server-only" ? { url: "data:text/javascript,", shortCircuit: true } : next(specifier, context),
});
mock.module(pathToFileURL(web.resolve("next/headers")).href, {
	namedExports: { cookies: session("cookies"), headers: session("headers") },
});
mock.module(at("server/request-context.ts"), {
	namedExports: Object.fromEntries(
		["getViewer", "viewerActor", "organizationSeat", "seated", "organizationSeatOf"].map((name) => [
			name,
			session(name),
		]),
	),
});
mock.module(at("server/sign-in.ts"), {
	namedExports: { signIn: session("signIn"), requireActor: session("requireActor") },
});
mock.module(at("server/identity/index.ts"), { namedExports: { requestAuth: session("requestAuth") } });
const row = {
	account_id: "11111111-1111-4111-8111-111111111111",
	rev: "3",
	email_enabled: true,
	in_app_enabled: true,
	changed: false,
};
mock.module(at("server/database.ts"), {
	namedExports: { requestDatabase: () => ({ execute: async () => ({ rows: [row] }) }) },
});
mock.module(at("features/notifications/NotificationsScreen.tsx"), {
	namedExports: { NotificationsScreen: () => null },
});
mock.module(at("features/notifications/OptOutScreen.tsx"), { namedExports: { OptOutScreen: () => null } });
const { issueEmailOptOutToken } = await import("../../../packages/domain/src/notifications/opt-out.ts");
const { OptOutPage } = await import("../../../apps/web/src/features/notifications/routes.tsx");

const view = async (token: string) =>
	(await OptOutPage({ params: Promise.resolve({ token }) })).props.view as { state: string };
const DAY = 86_400_000;
const daysAgo = (days: number) => new Date(Date.now() - days * DAY).toISOString();
const token = (times: { iat: string; exp?: string }) =>
	issueEmailOptOutToken(key, {
		purpose: "disable",
		accountId: row.account_id,
		category: "task_due",
		unsubscribeRevision: "3",
		...times,
	});

test("INV-privacy: the notifications opt-out page takes the link's token as its only authority and never reads a session, cookie or header", async () => {
	assert.equal((await view(token({ iat: daysAgo(1) }))).state, "open");
	assert.equal((await view(token({ iat: daysAgo(5), exp: daysAgo(3) }))).state, "expired");
	assert.equal((await view("not-a-token")).state, "invalid");
	assert.deepEqual(read, []);
});
