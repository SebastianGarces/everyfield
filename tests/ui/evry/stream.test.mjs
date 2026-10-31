// Evry's answer streams and renders safe markdown on a seeded preview (WP-051). It needs the People seed
// (tests/ui/people/seed.mts) and a preview started with EVRY_SCRIPTED_MODEL=1 in its apps/web/.env.local.
//   INV-stream-paint: one reply's text is observed at 3 or more distinct lengths across paints, and the final DOM holds
//     a <strong>, a list, a link and a <code>, with no literal markers.
//   INV-stream-stop: Stop shows "Stopping…", ends the answer promptly and keeps the text written so far.
import assert from "node:assert/strict";
import { test } from "node:test";
import { BASE, ENGINES, fixture, hydrated, signIn, withPage } from "../setup.mjs";

async function openPanel(page, context) {
	await signIn(context, fixture("people").owner.cookie);
	await page.goto(`${BASE}/people`);
	await hydrated(page);
	await page.getByRole("button", { name: "Ask Evry" }).click();
	const panel = page.getByRole("dialog", { name: "Evry" });
	await panel.getByRole("button", { name: "History" }).click();
	await panel.getByRole("button", { name: "New chat" }).click();
	return panel;
}

for (const [engine, launcher] of ENGINES) {
	test(`INV-stream-paint: the answer grows across paints and ends as formatted markdown (${engine})`, () =>
		withPage(
			launcher,
			async (page, context) => {
				const panel = await openPanel(page, context);
				// Watch the dialog's text length at every paint from before the question is sent.
				await page.evaluate(() => {
					window.__lengths = [];
					const dialog = document.querySelector('[role="dialog"]');
					const tick = () => {
						const answer = dialog.querySelector("li:last-child .text-ink-2");
						const n = answer ? answer.textContent.length : 0;
						if (n && window.__lengths.at(-1) !== n) window.__lengths.push(n);
						requestAnimationFrame(tick);
					};
					requestAnimationFrame(tick);
				});
				const box = panel.getByLabel("Message Evry");
				await box.fill(`Show a formatting demo (${engine} ${Date.now().toString(36)})`);
				await box.press("Enter");
				const answer = panel.locator("li").last();
				await answer.locator("strong").first().waitFor({ timeout: 30_000 });
				await answer.getByText("Then look at the longest waiting").waitFor({ timeout: 30_000 });

				const lengths = await page.evaluate(() => window.__lengths);
				assert.ok(new Set(lengths).size >= 3, `distinct text lengths across paints: ${lengths.join(",")}`);
				assert.deepEqual(
					lengths,
					[...lengths].sort((a, b) => a - b),
					"the text only grows",
				);
				assert.equal(await answer.locator("strong").first().textContent(), "19 prospects");
				assert.equal(await answer.locator("ul > li").count(), 2);
				assert.equal(await answer.locator("ol > li").count(), 2);
				const link = answer.getByRole("link", { name: "People page" });
				assert.equal(await link.getAttribute("href"), "/people");
				assert.equal(await answer.locator("code").first().textContent(), "next step");
				const text = await answer.textContent();
				assert.ok(!/\*\*|`|\]\(/.test(text), `no literal markers in: ${text}`);
			},
			{ width: 390, height: 844 },
		));

	test(`INV-stream-stop: Stop keeps the partial text and says Stopping… (${engine})`, () =>
		withPage(
			launcher,
			async (page, context) => {
				const panel = await openPanel(page, context);
				const box = panel.getByLabel("Message Evry");
				await box.fill(`Show a formatting demo to stop (${engine} ${Date.now().toString(36)})`);
				await box.press("Enter");
				const answer = panel.locator("li").last();
				await answer.getByText("There are").waitFor({ timeout: 30_000 });
				await panel.getByRole("button", { name: "Stop" }).click();
				await panel.getByText("You stopped this answer").waitFor({ timeout: 10_000 });
				assert.ok((await answer.textContent()).includes("There are"), "the partial text stays");
				assert.equal(await panel.getByRole("button", { name: "Stop" }).count(), 0);
				assert.equal(await panel.getByText("Stopping…").count(), 0, "no spinner is left");
			},
			{ width: 390, height: 844 },
		));
}
