import assert from "node:assert/strict";
import { test } from "node:test";

const ORIGIN = "https://everyfield.test";
const assigned: string[] = [];
Object.defineProperty(globalThis, "window", {
	configurable: true,
	value: { location: { origin: ORIGIN, assign: (url: URL | string) => assigned.push(String(url)) } },
});
const { loadPage } = await import("../../../apps/web/src/features/identity/api.ts");

const opened = (path: string) => {
	assigned.length = 0;
	loadPage(path);
	return [...assigned];
};

test("AC: a page load after sign-in or sign-out goes to a path on this site", () => {
	assert.deepEqual(opened("/signin"), [`${ORIGIN}/signin`]);
	assert.deepEqual(opened("/people?tab=all#top"), [`${ORIGIN}/people?tab=all#top`]);
	assert.deepEqual(opened("settings/account"), [`${ORIGIN}/settings/account`]);
	assert.deepEqual(opened(`${ORIGIN}/meetings`), [`${ORIGIN}/meetings`]);
});

test("AC: a page load to another site, a protocol-relative host or a script address does nothing", () => {
	for (const path of [
		"https://evil.test/",
		"http://everyfield.test/",
		`${ORIGIN}.evil.test/`,
		"//evil.test/signin",
		"/\\evil.test/signin",
		"\\\\evil.test",
		"javascript:alert(1)",
		"data:text/html,<p>x</p>",
		"mailto:a@example.test",
		"http://[",
	])
		assert.deepEqual(opened(path), [], `${path} navigated`);
});
