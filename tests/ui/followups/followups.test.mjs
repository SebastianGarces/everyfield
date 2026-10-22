// Follow-up saves when the reply is lost (WP-023/ui, C58/C68). A silent break would save an outcome twice, say "not
// saved" when the server never answered, or let a second form submit while the first result is unknown. Real producer
// state on a seeded preview: set UI_BASE_URL, then seed People and follow-ups (tests/ui/followups/seed.mts).
import assert from "node:assert/strict";
import { test } from "node:test";
import { BASE, ENGINES, fixture, hydrated, withPage } from "../setup.mjs";

/** Signs in with a seeded session. The cookie is always Secure: a preview reached on http://localhost is a secure context. */
const signIn = (context, cookie) => {
	const [name, value] = cookie.split(/=(.*)/s);
	const { hostname } = new URL(BASE);
	return context.addCookies([{ name, value, domain: hostname, path: "/", httpOnly: true, secure: true, sameSite: "Lax" }]);
};

const people = () => fixture("people");
/** Server actions are POSTs with a Next-Action header. The first `lose` of them reach the server, but their answers are lost. */
async function loseReplies(context, lose) {
	let n = 0;
	await context.route("**/*", async (route) => {
		const r = route.request();
		if (r.method() !== "POST" || !r.headers()["next-action"] || ++n > lose) return route.fallback();
		await route.fetch();
		return route.abort("failed");
	});
	return () => n;
}
const PERSON = { chromium: "James Okafor", webkit: "David Kim" };

for (const [name, engine] of ENGINES) {
	test(`AC:TARGET-MTG-022 AC:TARGET-PPL-022 (${name}): a follow-up outcome whose replies are lost saves once after Check again`, async () => {
		await withPage(
			engine,
			async (page, context) => {
				await signIn(context, people().owner.cookie);
				const personUrl = `${BASE}/people/${people().people[PERSON[name]]}`;
				await page.goto(personUrl);
				await hydrated(page);
				// An explicit follow-up, undated, Needs owner.
				await page.getByRole("button", { name: "Add follow-up" }).click();
				const add = page.getByRole("dialog", { name: "Add a follow-up" });
				await add.getByRole("button", { name: "Add follow-up" }).click();
				await add.waitFor({ state: "detached" });
				const row = page.getByRole("link", { name: `Follow up with ${PERSON[name]}` }).first();
				await row.click();
				await page.getByRole("heading", { level: 1, name: PERSON[name] }).waitFor();
				await hydrated(page);

				const posts = await loseReplies(context, 2);
				await page.getByRole("radio", { name: /Contacted/ }).click();
				// Contacted needs the person to say when.
				await page.getByRole("button", { name: "Save", exact: true }).click();
				await page.getByText("Choose when you talked.").waitFor();
				await page.getByRole("radio", { name: "Just now" }).click();
				await page.getByRole("button", { name: "Save", exact: true }).click();
				const unknown = page.getByText("The outcome may already be saved.", { exact: false });
				await unknown.waitFor();
				assert.equal(posts(), 2, "one send and one replay with the same request");
				assert.equal(await page.getByText("was not saved").count(), 0, "a lost answer is never a refusal");
				assert.equal(
					await page.getByRole("button", { name: "Dismiss" }).count(),
					0,
					"an unknown result has no Dismiss",
				);
				assert.equal(await page.getByRole("button", { name: "Save", exact: true }).isDisabled(), true);
				await page.getByText("Check the last save first.").waitFor();

				await page.getByRole("button", { name: "Check again" }).click();
				await page.getByRole("heading", { name: "Saved: Contacted" }).waitFor();
				assert.equal(posts(), 3);

				// The contact log holds exactly one entry for the three sends.
				await page.goto(personUrl);
				const log = page.locator("#contact-log");
				await log.getByText("Contacted", { exact: true }).first().waitFor();
				assert.equal(await log.locator("li").count(), 1);
			},
			{ width: 390, height: 844 },
		);
	});

	test(`AC:TARGET-COM-011 (${name}): an unknown contact save is announced inside the open dialog and blocks the card`, async () => {
		await withPage(engine, async (page, context) => {
			await signIn(context, people().owner.cookie);
			await page.goto(`${BASE}/people/${people().people["Maria Santos"]}`);
			await hydrated(page);
			const posts = await loseReplies(context, 2);
			await page.getByRole("button", { name: "Record contact" }).click();
			const dialog = page.getByRole("dialog", { name: "Record a contact" });
			await dialog.getByRole("radio", { name: /Tried, no contact/ }).click();
			await dialog.getByRole("button", { name: "Save contact" }).click();
			await dialog.getByText("The contact may already be saved.", { exact: false }).waitFor();
			assert.equal(posts(), 2);
			// The announcement is a live region inside the modal, which hides the rest of the page.
			assert.equal(await dialog.locator('[aria-live="assertive"]').getByText("may already be saved").count(), 1);
			await dialog.getByRole("button", { name: "Cancel" }).click();
			// The card keeps the unknown result: its other actions wait, and nothing can dismiss it.
			const card = page.locator("#contact-log");
			assert.equal(await card.getByRole("button", { name: "Record contact" }).isDisabled(), true);
			await card.getByRole("button", { name: "Check again" }).click();
			await card.getByText("Tried, no contact", { exact: true }).first().waitFor();
			assert.equal(await card.getByRole("button", { name: "Check again" }).count(), 0);
		});
	});
}
