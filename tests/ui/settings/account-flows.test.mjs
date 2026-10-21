// Your account's credential and deletion flows on the real settings server (WP-010/ui round 4). Each row fails when its
// guard is removed:
//   BUG-wp010-ui-password-session: a password change replaces this browser's session. The page the server action
//     renders read the revoked cookie from the request and sent the browser to sign-in; it now reads the new one
//     (server/request-context.ts getSession), so the browser stays on Settings and says the password changed.
//   AC:DEL58-002 AC:DEL58-001: a deletion request ends the session and opens the restricted page with its deadline. A
//     wrong password is refused; the original email and password show the pending request; Keep my account cancels
//     it, and the login signs in again.
// Both accounts sign in through the form and end as they started, so the rows can run again on the same seed. They run
// against a running app seeded with the People fixture (tests/ui/people/seed.mts) through tests/ui/setup.mjs.
import assert from "node:assert/strict";
import { test } from "node:test";
import { BASE, ENGINES, fixture, hydrated, withPage } from "../setup.mjs";

const { password, emails } = fixture("people").settings;
const [PASSWORD_ACCOUNT, DELETION_ACCOUNT] = emails;

async function signIn(page, email, secret) {
	await page.goto(`${BASE}/signin?returnTo=${encodeURIComponent("/settings/account")}`, { waitUntil: "networkidle" });
	await hydrated(page);
	await page.getByLabel("Email").fill(email);
	await page.getByLabel("Password", { exact: true }).fill(secret);
	await page.getByRole("button", { name: "Sign in" }).click();
	await page.getByRole("heading", { level: 2, name: "Your account" }).waitFor({ timeout: 60_000 });
	await hydrated(page);
}

async function changePassword(page, from, to) {
	await page.getByRole("button", { name: "Change password" }).click();
	const dialog = page.getByRole("dialog", { name: "Change password" });
	await dialog.getByLabel("Current password").fill(from);
	await dialog.getByLabel("New password", { exact: true }).fill(to);
	await dialog.getByLabel("Repeat new password").fill(to);
	await dialog.getByRole("button", { name: "Change password" }).click();
	await dialog.waitFor({ state: "detached", timeout: 30_000 });
	await page.getByRole("status").filter({ hasText: "Password changed. Your other devices are signed out." }).waitFor();
	assert.equal(new URL(page.url()).pathname, "/settings/account");
}

for (const [name, engine] of ENGINES) {
	test(`BUG-wp010-ui-password-session (${name}): a password change keeps this browser on Settings`, async () => {
		await withPage(engine, async (page) => {
			await signIn(page, PASSWORD_ACCOUNT, password);
			const next = `${password}-changed`;
			await changePassword(page, password, next);
			// The new session survives a fresh load; changing back leaves the seed as it was.
			await page.reload({ waitUntil: "networkidle" });
			await page.getByRole("heading", { level: 2, name: "Your account" }).waitFor({ timeout: 60_000 });
			await hydrated(page);
			await changePassword(page, next, password);
		});
	});

	test(`AC:DEL58-002 AC:DEL58-001 (${name}): request deletion, prove the login, then keep the account`, async () => {
		await withPage(engine, async (page) => {
			await signIn(page, DELETION_ACCOUNT, password);
			await page.getByRole("button", { name: "Delete your account" }).click();
			await page.getByRole("alertdialog").getByRole("button", { name: "Delete my account" }).click();

			await page.waitForURL(/\/account-deletion\?until=/, { timeout: 60_000 });
			const until = new URL(page.url()).searchParams.get("until");
			await page.getByRole("heading", { level: 1, name: "Your account is scheduled for deletion" }).waitFor();
			await hydrated(page);
			// The old session no longer opens Settings.
			const session = await page.evaluate(async () => (await (await fetch("/api/auth/get-session")).json())?.status);
			assert.notEqual(session, "active");

			await page.getByLabel("Email").fill(DELETION_ACCOUNT);
			await page.getByLabel("Password", { exact: true }).fill(`${password}-wrong`);
			await page.getByRole("button", { name: "Continue" }).click();
			await page.getByRole("alert").filter({ hasText: "do not match an account that is scheduled" }).waitFor();
			assert.equal(await page.evaluate(() => document.activeElement?.getAttribute("name")), "password");

			await page.getByLabel("Password", { exact: true }).fill(password);
			await page.getByRole("button", { name: "Continue" }).click();
			const keep = page.getByRole("button", { name: "Keep my account" });
			await keep.waitFor({ timeout: 30_000 });
			// The deadline shown is the one the request returned: 30 days after it.
			const deadline = new Date(until).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" });
			assert.match(await page.getByRole("main").innerText(), new RegExp(`You can cancel until ${deadline}`));

			await keep.click();
			await page.getByRole("heading", { level: 1, name: "Deletion cancelled" }).waitFor({ timeout: 30_000 });
			await signIn(page, DELETION_ACCOUNT, password);
		});
	});
}
