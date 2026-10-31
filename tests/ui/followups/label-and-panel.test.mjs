// S2 batch 3 (F12, F13). F12: the label row of a Field never opens or reopens the button-style control it names.
// F13: a follow-up's "What happened" arrives with the task panel. Real producer state on a seeded preview: set
// UI_BASE_URL, then seed People and follow-ups (tests/ui/followups/seed.mts).
import assert from "node:assert/strict";
import { test } from "node:test";
import { BASE, ENGINES, fixture, hydrated, signIn, withPage } from "../setup.mjs";

const people = () => fixture("people");
const seeded = () => fixture("followups");

for (const [name, engine] of ENGINES) {
	test(`AC:TARGET-TSK-012 (${name}): a click on the Owners label row never opens or reopens the dropdown`, async () => {
		await withPage(engine, async (page, context) => {
			await signIn(context, people().owner.cookie);
			await page.goto(`${BASE}/people/${people().people["Ana Lee"]}`);
			await hydrated(page);
			await page.getByRole("button", { name: "Add follow-up" }).click();
			const dialog = page.getByRole("dialog", { name: "Add a follow-up" });
			const owners = dialog.getByRole("combobox", { name: "Owners" });
			await owners.waitFor();
			// The label row is the full width of the field: click the text, the "Optional" part and the empty end.
			const row = dialog.locator("label", { hasText: "Owners" });
			const box = await row.boundingBox();
			assert.ok(box && box.width > 200, "the label row spans the field");
			const closed = async (why) => {
				await page.waitForTimeout(500);
				assert.equal(await owners.getAttribute("aria-expanded"), "false", why);
				assert.equal(await page.getByRole("listbox").count(), 0, why);
			};
			await row.click({ position: { x: 12, y: 8 } });
			await closed("label text, closed");
			await row.getByText("Optional").click();
			await closed("Optional, closed");
			await page.mouse.click(box.x + box.width - 8, box.y + box.height / 2);
			await closed("empty end of the row, closed");

			// Open with the trigger: it opens on click, then a label click closes it and it stays closed.
			await owners.click();
			await page.getByRole("listbox").waitFor();
			assert.equal(await owners.getAttribute("aria-expanded"), "true");
			await page.mouse.click(box.x + box.width - 8, box.y + box.height / 2);
			await closed("label row, open then click");
			// The trigger still toggles on click and on the keyboard.
			await owners.click();
			await page.getByRole("listbox").waitFor();
			await owners.click();
			await closed("trigger click closes");
			await owners.focus();
			for (const key of ["Enter", "Space"]) {
				await page.keyboard.press(key === "Space" ? " " : key);
				await page.getByRole("listbox").waitFor();
				await page.keyboard.press("Escape");
				await closed(`${key} opened and Escape closed`);
				await owners.focus();
			}
			// getByLabel still finds the trigger.
			assert.equal((await dialog.getByLabel("Owners").count()) > 0, true);
		});
	});

	test(`AC:TARGET-TSK-012 (${name}): a click on the How label row never opens the Select; the trigger still opens by click and keys`, async () => {
		await withPage(engine, async (page, context) => {
			await signIn(context, people().owner.cookie);
			await page.goto(`${BASE}/follow-ups/${seeded().tasks.maria}`);
			await hydrated(page);
			await page.getByRole("radio", { name: /Contacted/ }).click();
			const how = page.getByRole("combobox", { name: "How" });
			await how.waitFor();
			const row = page.locator("label", { hasText: /^How/ });
			const box = await row.boundingBox();
			assert.ok(box);
			const closed = async (why) => {
				await page.waitForTimeout(500);
				assert.equal(await how.getAttribute("aria-expanded"), "false", why);
				assert.equal(await page.getByRole("listbox").count(), 0, why);
			};
			await page.mouse.click(box.x + box.width - 8, box.y + box.height / 2);
			await closed("label row, closed");
			await how.click();
			await page.getByRole("listbox").waitFor();
			await page.keyboard.press("Escape");
			await closed("click opened, Escape closed");
			await how.focus();
			for (const key of ["Enter", " ", "ArrowDown"]) {
				await page.keyboard.press(key);
				await page.getByRole("listbox").waitFor();
				await page.keyboard.press("Escape");
				await closed(`key ${JSON.stringify(key)}`);
				await how.focus();
			}
			assert.ok((await page.getByLabel("How").count()) > 0);
		});
	});

	test(`AC:TARGET-MTG-022 (${name}): a text input's label still focuses it`, async () => {
		await withPage(engine, async (page, context) => {
			await signIn(context, people().owner.cookie);
			await page.goto(`${BASE}/people/${people().people["Ana Lee"]}`);
			await hydrated(page);
			await page.getByRole("button", { name: "Add follow-up" }).click();
			const dialog = page.getByRole("dialog", { name: "Add a follow-up" });
			const labels = dialog.locator("label");
			const n = await labels.count();
			let focused = 0;
			for (let i = 0; i < n; i++) {
				const forId = await labels.nth(i).getAttribute("for");
				const target = forId ? await dialog.locator(`[id="${forId}"]`).count() : 0;
				if (!target) continue;
				const tag = await dialog.locator(`[id="${forId}"]`).evaluate((e) => e.tagName);
				if (tag !== "INPUT" && tag !== "TEXTAREA") continue;
				await labels.nth(i).click();
				assert.equal(await dialog.locator(`[id="${forId}"]`).evaluate((e) => e === document.activeElement), true);
				focused++;
			}
			assert.ok(focused > 0, "at least one text label was checked");
		});
	});
}

for (const [name, engine] of ENGINES.slice(0, 1)) {
	test(`AC:TARGET-MTG-022 (${name}): "What happened" arrives with the task panel and stays through a status change`, async () => {
		await withPage(engine, async (page, context) => {
			await signIn(context, people().owner.cookie);
			const requests = [];
			page.on("request", (r) => requests.push(r.url()));
			const title = "Follow up with Maria Santos";
			// A mutation observer records any frame that shows the loading text, from the first panel paint.
			await page.addInitScript(() => {
				window.__loading = false;
				const look = () => {
					if (document.body?.innerText.includes("Loading what was recorded")) window.__loading = true;
				};
				new MutationObserver(look).observe(document, { childList: true, subtree: true, characterData: true });
			});
			await page.goto(`${BASE}/tasks?view=all&status=any&q=Maria`);
			await hydrated(page);
			await page.getByRole("button", { name: title, exact: true }).click();
			const panel = page.getByRole("dialog");
			const log = panel.locator("section").filter({ has: page.getByRole("heading", { name: "What happened" }) });
			await log.getByText("Left a voicemail about Sunday.").waitFor();
			assert.equal(await page.evaluate(() => window.__loading), false, "the loading text never showed");
			assert.equal(requests.filter((u) => u.includes("what=history")).length, 0, "no contact history request");

			// A status change leaves the entries on screen.
			await panel
				.getByRole("button", { name: /Mark done/ })
				.first()
				.click();
			await page.getByText("Done", { exact: true }).first().waitFor();
			await page.waitForTimeout(500);
			assert.equal(await log.getByText("Left a voicemail about Sunday.").count(), 1);
			assert.equal(await page.evaluate(() => window.__loading), false);
			assert.equal(requests.filter((u) => u.includes("what=history")).length, 0);

			// A deep link opens the panel with the entries in its first paint.
			await page.goto(`${BASE}/tasks?view=all&status=any&task=${seeded().tasks.maria}`);
			await hydrated(page);
			await page.getByRole("dialog").getByText("Left a voicemail about Sunday.").waitFor();
			assert.equal(await page.evaluate(() => window.__loading), false);
		});
	});

	test(`AC:TARGET-MTG-022 (${name}): an outcome saved on the call screen shows in "What happened" after browser back`, async () => {
		await withPage(engine, async (page, context) => {
			await signIn(context, people().owner.cookie);
			const url = `${BASE}/tasks?view=all&status=any&task=${seeded().tasks.sara}`;
			await page.goto(url);
			await hydrated(page);
			const panel = page.getByRole("dialog");
			const entries = panel
				.locator("section")
				.filter({ has: page.getByRole("heading", { name: "What happened" }) })
				.locator("li");
			await entries
				.first()
				.waitFor({ state: "attached" })
				.catch(() => {});
			const before = await entries.count();
			await panel.getByRole("link", { name: "Record what happened" }).click();
			await page.getByRole("radio", { name: /Tried, no contact/ }).waitFor();
			await hydrated(page);
			await page.getByRole("radio", { name: /Tried, no contact/ }).click();
			await page.getByRole("button", { name: "Save", exact: true }).click();
			await page.getByRole("heading", { name: /Saved/ }).waitFor();
			await page.goBack();
			await page.getByRole("dialog").waitFor();
			await page.waitForTimeout(1500);
			assert.equal(await entries.count(), before + 1, "the new outcome shows after browser back");
		});
	});
}
