// WP-005: the post-sign-in landing rule through the real sign-in form and the real server (no stubbed API). Seed the
// preview with invitation-seed.mts first; it writes the three landing accounts. Each row signs in and asserts the
// final URL, so a removed rule (a hardcoded landing) fails here.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { BASE, ENGINES, fixture, withPage } from "../setup.mjs";

const seed = () => fixture("invitation");

async function signInAs(page, email, path = "/signin") {
	await page.goto(BASE + path);
	await page.getByRole("heading", { name: "Welcome back" }).waitFor();
	await page.getByLabel("Email").fill(email);
	await page.getByLabel("Password", { exact: true }).fill(seed().password);
	await page.getByRole("button", { name: "Sign in", exact: true }).click();
}
const at =
	(path, search = "") =>
	(url) =>
		url.pathname === path && url.search === search;

for (const [name, engine] of ENGINES) {
	describe(`sign-in landing (${name})`, () => {
		test("an owner whose setup is finished lands on /people", { timeout: 90_000 }, () =>
			withPage(engine, async (page) => {
				await signInAs(page, seed().landing.finished);
				await page.waitForURL(at("/people"), { timeout: 60_000 });
			}),
		);

		test("an owner whose setup is not finished lands on /onboarding", { timeout: 90_000 }, () =>
			withPage(engine, async (page) => {
				await signInAs(page, seed().landing.unfinished);
				await page.waitForURL(at("/onboarding"), { timeout: 60_000 });
			}),
		);

		test("a new account lands on /onboarding", { timeout: 90_000 }, () =>
			withPage(engine, async (page) => {
				await signInAs(page, seed().landing.pending);
				await page.waitForURL(at("/onboarding"), { timeout: 60_000 });
			}),
		);

		test("a safe returnTo wins over the rule", { timeout: 90_000 }, () =>
			withPage(engine, async (page) => {
				await signInAs(page, seed().landing.finished, "/signin?returnTo=%2Fsettings%2Fsharing");
				await page.waitForURL(at("/settings/sharing"), { timeout: 60_000 });
			}),
		);

		test("a safe returnTo to /documents lands on /documents", { timeout: 90_000 }, () =>
			withPage(engine, async (page) => {
				await signInAs(page, seed().landing.finished, "/signin?returnTo=%2Fdocuments");
				await page.waitForURL(at("/documents"), { timeout: 60_000 });
			}),
		);

		test("an unsafe returnTo is ignored and never leaves the origin", { timeout: 180_000 }, async () => {
			for (const value of ["https://evil.example", "//evil.example", "/\\evil.example", "javascript:alert(1)"]) {
				await withPage(engine, async (page) => {
					await signInAs(page, seed().landing.finished, "/signin?returnTo=" + encodeURIComponent(value));
					await page.waitForURL(at("/people"), { timeout: 60_000 });
					assert.equal(new URL(page.url()).origin, new URL(BASE).origin, value);
				});
			}
		});

		test("the signed-in screen's Continue follows the rule", { timeout: 90_000 }, () =>
			withPage(engine, async (page) => {
				await signInAs(page, seed().landing.finished);
				await page.waitForURL(at("/people"), { timeout: 60_000 });
				await page.goto(BASE + "/signin");
				const next = page.getByRole("link", { name: "Continue" });
				await next.waitFor();
				assert.equal(await next.getAttribute("href"), "/home");
				await next.click();
				await page.waitForURL(at("/people"), { timeout: 60_000 });
			}),
		);

		test("a new account's signed-in screen still links to /onboarding", { timeout: 90_000 }, () =>
			withPage(engine, async (page) => {
				await signInAs(page, seed().landing.pending);
				await page.waitForURL(at("/onboarding"), { timeout: 60_000 });
				await page.goto(BASE + "/signin");
				const setup = page.getByRole("link", { name: "Set up your church" });
				await setup.waitFor();
				assert.equal(await setup.getAttribute("href"), "/onboarding");
			}),
		);

		test("a signed-out visitor to /home goes to /signin without a loop", { timeout: 60_000 }, () =>
			withPage(engine, async (page) => {
				await page.goto(BASE + "/home");
				await page.waitForURL(at("/signin"), { timeout: 60_000 });
				await page.getByRole("heading", { name: "Welcome back" }).waitFor();
			}),
		);
	});
}
