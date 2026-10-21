// The Evry panel's core loop on a seeded preview (WP-051/ui), in both engines at phone width. It needs the People seed
// (tests/ui/people/seed.mts) and a preview started with EVRY_SCRIPTED_MODEL=1 in its apps/web/.env.local.
//   AC:UI45-005 AC:EVRY-RETRY-CANCEL INV-request-key: a message whose reply is lost after the server saved it is sent
//     again with the same key and saved once; the streamed result card follows; Esc returns focus to Ask Evry and
//     Ctrl+J reopens the same conversation.
import assert from "node:assert/strict";
import { test } from "node:test";
import { BASE, ENGINES, fixture, hydrated, signIn, withPage } from "../setup.mjs";

for (const [engine, launcher] of ENGINES)
	test(`AC:UI45-005 AC:EVRY-RETRY-CANCEL INV-request-key: a lost reply is saved once and the card streams (${engine})`, () =>
		withPage(
			launcher,
			async (page, context) => {
				await signIn(context, fixture("people").owner.cookie);
				const keys = [];
				await context.route("**/api/evry/conversations/*/turns", async (route) => {
					keys.push(JSON.parse(route.request().postData()).requestKey);
					if (keys.length > 1) return route.continue();
					// The server saves the message; the browser never hears back.
					await route.fetch();
					await route.abort("connectionreset");
				});
				await page.goto(`${BASE}/people`);
				await hydrated(page);

				// Keyboard use: Safari does not focus a button on a mouse click, so only a keyboard opener is returned to.
				const opener = page.getByRole("button", { name: "Ask Evry" });
				await opener.focus();
				await page.keyboard.press("Enter");
				const panel = page.getByRole("dialog", { name: "Evry" });
				await panel.getByRole("button", { name: "History" }).click();
				await panel.getByRole("button", { name: "New chat" }).click();
				const text = `Find Maria (${engine} ${Date.now().toString(36)})`;
				const box = panel.getByLabel("Message Evry");
				await box.fill(text);
				await box.press("Enter");

				await panel.getByText("Not confirmed.").waitFor();
				await panel.getByRole("button", { name: "Send again" }).click();
				const card = panel.getByRole("region", { name: "People, 1 person" });
				await card.getByRole("link", { name: /Maria Santos/ }).waitFor({ timeout: 30_000 });

				assert.equal(keys.length, 2);
				assert.equal(keys[0], keys[1]);
				const saved = await page.evaluate(
					(t) =>
						fetch("/api/evry/open")
							.then((r) => r.json())
							.then((d) => d.events.filter((e) => e.kind === "user_message" && e.body.text === t).length),
					text,
				);
				assert.equal(saved, 1);

				await page.keyboard.press("Escape");
				await panel.waitFor({ state: "hidden" });
				assert.equal(await opener.evaluate((el) => el === document.activeElement), true);
				await page.keyboard.press("Control+j");
				await card.waitFor();
			},
			{ width: 390, height: 844 },
		));
