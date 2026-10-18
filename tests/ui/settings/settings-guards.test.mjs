// Settings guards that a silent break would turn into lost drafts, leaked data or a wrong deletion (WP-010/ui).
// Each row fails when its guard is removed:
//   INV-draft-close: closing with unsaved changes asks; Keep editing keeps the draft; Discard closes (SettingsDialog).
//   INV-draft-back: drafts survive section switches and Back; Back out of settings asks and Keep editing returns.
//   INV-focus-back: Back between sections leaves focus inside the dialog, never on the page body.
//   INV-save-refused: a refused explicit save keeps the draft, says why and offers Load latest (ChurchSection).
//   INV-save-clean: a successful save (also one the server trims) leaves no draft, so closing does not ask; an edit
//     typed while the save is pending stays unsaved, also one that types the old value back (useDraft begin/settle).
//   INV-autosave-rollback: a refused switch returns to the saved value and says why (NotificationsSection).
//   INV-section-scope: a Member is not offered the church profile and its deep link shows no access, not data.
//   INV-account-switch: switching account drops drafts (SettingsProvider key).
//   INV-email-once: a second Enter while the email link is sending sends nothing (EmailChange).
//   INV-avatar-check: wrong type and size never upload; a failed save keeps the old photo (AvatarControl).
//   INV-owner-delete: only the Owner sees workspace deletion; it needs the typed church name (WorkspaceDeletionDialog).
//   INV-tz-preview: the church time zone saves only from a fresh preview; a stale one asks again (PlantTimezoneDialog).
//   INV-personal-tz: an unconfirmed personal zone is never preselected (PersonalTimezone).
//   INV-deletion-deadline: cancel shows only before the deadline and a server refusal removes it (DeletionStatusScreen).
// It runs against a running app: set UI_BASE_URL to the task preview.
//   UI_BASE_URL=http://wp-010-ui-....localhost:1355 corepack pnpm test:ui
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { chromium, webkit } from "../../../apps/web/node_modules/playwright/index.mjs";

const BASE = process.env.UI_BASE_URL;
const SETTINGS = "/design/settings";
const FAST = "delay=150";

const PNG = Buffer.from(
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
	"base64",
);

// UI_ENGINE=chromium or webkit runs one engine; both run by default.
const ENGINES = [
	["chromium", chromium],
	["webkit", webkit],
].filter(([name]) => !process.env.UI_ENGINE || process.env.UI_ENGINE === name);

for (const [name, engine] of ENGINES) {
	describe(`settings guards (${name})`, () => {
		let browser;
		before(async () => {
			assert.ok(BASE, "Set UI_BASE_URL to a running preview of this worktree.");
			browser = await engine.launch();
		});
		after(async () => {
			await browser?.close();
		});

		async function open(path, run) {
			const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: "reduce" });
			try {
				const page = await context.newPage();
				await page.goto(BASE + path);
				await run(page);
			} finally {
				await context.close();
			}
		}
		const dialog = (page) => page.getByRole("dialog");
		const discard = (page) => page.getByRole("alertdialog", { name: "Discard unsaved changes?" });
		const churchName = (page) => page.getByRole("textbox", { name: "Church name" });

		test("INV-draft-close: closing with a draft asks first", { timeout: 60_000 }, () =>
			open(`${SETTINGS}/church?as=owner&${FAST}`, async (page) => {
				await churchName(page).fill("Harvest Point Community Church");
				await page.keyboard.press("Escape");
				await discard(page).waitFor();
				await discard(page).getByRole("button", { name: "Keep editing" }).click();
				assert.equal(
					await churchName(page).inputValue(),
					"Harvest Point Community Church",
					"Keep editing keeps the draft",
				);

				await dialog(page).getByRole("button", { name: "Close" }).click();
				await discard(page).getByRole("button", { name: "Discard changes" }).click();
				await page.waitForURL((url) => url.pathname === SETTINGS);
				assert.equal(await dialog(page).count(), 0, "Discard closes settings");
			}),
		);

		test("INV-draft-back: drafts survive section switches and Back", { timeout: 60_000 }, () =>
			open(`${SETTINGS}?as=owner&${FAST}`, async (page) => {
				await page.getByRole("link", { name: "Church profile" }).click();
				await churchName(page).fill("Harvest Point East");
				await dialog(page)
					.getByRole("link", { name: /^Your account/ })
					.click();
				await page.getByRole("textbox", { name: "Your name" }).waitFor();
				assert.ok(
					await dialog(page)
						.getByRole("link", { name: /^Church profile\s*, unsaved changes$/ })
						.isVisible(),
					"the nav marks the section with a draft",
				);

				await page.goBack();
				await page.waitForURL(/\/church/);
				assert.equal(await churchName(page).inputValue(), "Harvest Point East", "Back shows the kept draft");

				await page.goBack();
				await discard(page).waitFor();
				assert.equal(await dialog(page).count(), 1, "settings stays open while it asks");
				await discard(page).getByRole("button", { name: "Keep editing" }).click();
				await page.waitForURL(/\/design\/settings\/church/);
				assert.equal(await churchName(page).inputValue(), "Harvest Point East");
			}),
		);

		test("INV-focus-back: Back between sections keeps focus in the dialog", { timeout: 60_000 }, () =>
			open(`${SETTINGS}/notifications?as=owner&${FAST}`, async (page) => {
				await page.getByRole("table").waitFor();
				await dialog(page).getByRole("link", { name: "Your account" }).click();
				const name = page.getByRole("textbox", { name: "Your name" });
				await name.focus();
				await page.goBack();
				await page.getByRole("table").waitFor();
				await page.waitForFunction(() => document.activeElement?.closest("[role=dialog]") !== null);
				assert.equal(
					await page.evaluate(() => document.activeElement?.getAttribute("data-settings-nav")),
					"notifications",
				);
			}),
		);

		test("INV-save-clean: a saved draft no longer guards closing", { timeout: 60_000 }, async () => {
			await open(`${SETTINGS}/church?as=owner&${FAST}`, async (page) => {
				await churchName(page).fill("Harvest Point East ");
				await dialog(page).getByRole("button", { name: "Save" }).click();
				await dialog(page).getByText("No unsaved changes.").waitFor();
				assert.equal(
					await dialog(page)
						.getByRole("link", { name: /unsaved changes/ })
						.count(),
					0,
					"no nav mark",
				);
				await page.keyboard.press("Escape");
				await page.waitForURL((url) => url.pathname === SETTINGS);
				assert.equal(await discard(page).count(), 0, "closing after a save does not ask");
				assert.equal(await dialog(page).count(), 0);
			});
			await open(`${SETTINGS}/church?as=owner&delay=900`, async (page) => {
				await churchName(page).fill("Harvest Point East");
				await dialog(page).getByRole("button", { name: "Save" }).click();
				await churchName(page).fill("Harvest Point West");
				await page.waitForFunction(() => !document.querySelector("[aria-busy=true]"));
				await dialog(page).getByText("Unsaved changes", { exact: true }).waitFor();
				assert.equal(await churchName(page).inputValue(), "Harvest Point West", "the later edit is kept");
				await page.keyboard.press("Escape");
				await discard(page).waitFor();
			});
			// Typing the old value back while the save runs is also an edit: the save changes the saved value, so the
			// old value must stay as an unsaved draft and never be overwritten by the reply.
			await open(`${SETTINGS}/church?as=owner&delay=900`, async (page) => {
				await churchName(page).fill("Harvest Point Church changed");
				await dialog(page).getByRole("button", { name: "Save" }).click();
				await churchName(page).fill("Harvest Point Church");
				await page.waitForFunction(() => !document.querySelector("[aria-busy=true]"));
				await page.waitForTimeout(300);
				assert.equal(await churchName(page).inputValue(), "Harvest Point Church", "the typed-back value is kept");
				assert.ok(await dialog(page).getByText("Unsaved changes", { exact: true }).isVisible());
				await page.keyboard.press("Escape");
				await discard(page).waitFor();
			});
		});

		test("INV-save-refused: a refused save keeps the draft", { timeout: 60_000 }, () =>
			open(`${SETTINGS}/church?as=owner&${FAST}&fail=saveSection:conflict`, async (page) => {
				await churchName(page).fill("Harvest Point North");
				await dialog(page).getByRole("button", { name: "Save" }).click();
				const alert = dialog(page).getByRole("alert").filter({ hasText: "Someone changed this" });
				await alert.waitFor();
				assert.equal(await alert.getByRole("button", { name: "Load latest" }).count(), 1);
				assert.equal(await churchName(page).inputValue(), "Harvest Point North");
				assert.ok(await dialog(page).getByText("Unsaved changes", { exact: true }).isVisible());

				await dialog(page).getByRole("button", { name: "Save" }).click();
				await dialog(page).getByText("No unsaved changes.").waitFor();
				assert.equal(await churchName(page).inputValue(), "Harvest Point North", "the retry saves the same draft");
			}),
		);

		test("INV-autosave-rollback: a refused switch returns to the saved value", { timeout: 60_000 }, () =>
			open(`${SETTINGS}/notifications?as=owner&${FAST}&fail=saveSection:temporary`, async (page) => {
				const email = page.getByRole("switch", { name: "Tasks due, email" });
				assert.equal(await email.getAttribute("aria-checked"), "true");
				await email.click();
				await dialog(page).getByRole("alert").filter({ hasText: "could not save" }).waitFor();
				assert.equal(await email.getAttribute("aria-checked"), "true", "the switch shows the saved value again");

				await email.click();
				await page.waitForFunction(
					() => document.querySelector('[aria-label="Tasks due, email"]')?.getAttribute("aria-checked") === "false",
				);
				assert.equal(await dialog(page).getByRole("alert").count(), 0, "a successful save clears the error");
			}),
		);

		test("INV-section-scope: a Member gets no church profile", { timeout: 60_000 }, () =>
			open(`${SETTINGS}/church?as=member&${FAST}`, async (page) => {
				await dialog(page).getByRole("heading", { name: "Church profile is not available to you" }).waitFor();
				assert.equal(
					await dialog(page)
						.getByRole("link", { name: /^Church profile/ })
						.count(),
					0,
				);
				assert.equal(await churchName(page).count(), 0);
				const calls = await page.evaluate(() => window.__settingsFixture.calls);
				assert.equal(calls.getSection ?? 0, 0, "the church profile is never requested");
			}),
		);

		test("INV-account-switch: switching account drops drafts", { timeout: 60_000 }, () =>
			open(`${SETTINGS}/church?as=owner&${FAST}`, async (page) => {
				await churchName(page).fill("Owner draft");
				// A client-side switch, as a context switch in the app would be: the layout and dialog stay mounted.
				await page.evaluate(() => window.__settingsNavigate("/design/settings/church?as=admin&delay=150"));
				await page.waitForURL(/as=admin/);
				await page.waitForFunction(() =>
					[...document.querySelectorAll("[role=dialog] input")].some((i) => i.value === "Harvest Point Church"),
				);
				assert.equal(
					await churchName(page).inputValue(),
					"Harvest Point Church",
					"the admin never sees the owner's draft",
				);
				assert.equal(await discard(page).count(), 0);
			}),
		);

		test("INV-email-once: Enter twice sends one link", { timeout: 60_000 }, () =>
			open(`${SETTINGS}/account?as=owner&delay=800`, async (page) => {
				await dialog(page)
					.getByRole("group", { name: "Email" })
					.getByRole("button", { name: "Change", exact: true })
					.click();
				const field = page.getByRole("textbox", { name: "New email" });
				await field.fill("daniel.reyes@harvestpoint.org");
				await field.press("Enter");
				await field.press("Enter");
				await page.getByRole("status").filter({ hasText: "We sent a link to daniel.reyes@harvestpoint.org" }).waitFor();
				const calls = await page.evaluate(() => window.__settingsFixture.calls);
				assert.equal(calls.requestEmailChange, 1);
			}),
		);

		test("INV-email-kept: a sending or sent link survives a section switch", { timeout: 60_000 }, () =>
			open(`${SETTINGS}/account?as=admin&delay=800`, async (page) => {
				await dialog(page)
					.getByRole("group", { name: "Email" })
					.getByRole("button", { name: "Change", exact: true })
					.click();
				await page.getByRole("textbox", { name: "New email" }).fill("qa-settings@example.test");
				await page.getByRole("button", { name: "Send link" }).click();
				await dialog(page).getByRole("link", { name: "Notifications" }).click();
				await page.getByRole("table").waitFor();
				await page.waitForTimeout(1000);
				await dialog(page).getByRole("link", { name: "Your account" }).click();
				await page.getByRole("status").filter({ hasText: "We sent a link to qa-settings@example.test" }).waitFor();
				assert.equal(await page.evaluate(() => window.__settingsFixture.calls.requestEmailChange), 1);
			}),
		);

		test("INV-avatar-check: bad files never upload; a failed save keeps the old photo", { timeout: 60_000 }, () =>
			open(`${SETTINGS}/account?as=owner&${FAST}&fail=finalizeAvatar:temporary`, async (page) => {
				const input = dialog(page).locator('input[type="file"]');
				const message = dialog(page).locator("[data-avatar-message]");
				await page.getByRole("img", { name: "Daniel Reyes, no photo" }).waitFor();

				await input.setInputFiles({ name: "notes.txt", mimeType: "text/plain", buffer: Buffer.from("hello") });
				assert.equal(await message.textContent(), "Use a JPG, PNG or WebP photo.");
				await input.setInputFiles({
					name: "big.png",
					mimeType: "image/png",
					buffer: Buffer.alloc(3 * 1024 * 1024 + 1),
				});
				assert.equal(await message.textContent(), "Choose a photo smaller than 3 MB.");
				assert.equal(await page.evaluate(() => window.__settingsFixture.calls.finalizeAvatar ?? 0), 0);

				await input.setInputFiles({ name: "me.png", mimeType: "image/png", buffer: PNG });
				await dialog(page)
					.getByText(/^Your photo was not saved/)
					.waitFor();
				assert.equal(await page.getByRole("img", { name: "Daniel Reyes, no photo" }).count(), 1, "the old state stays");

				await input.setInputFiles({ name: "me.png", mimeType: "image/png", buffer: PNG });
				await page.getByRole("img", { name: "Your photo" }).waitFor();
				const src = await page.getByRole("img", { name: "Your photo" }).locator("img").getAttribute("src");
				assert.match(src, /^blob:/, "the preview's port supplies the delivery source");
			}),
		);

		test("INV-owner-delete: only the Owner can delete the workspace", { timeout: 60_000 }, async () => {
			await open(`${SETTINGS}/church?as=admin&${FAST}`, async (page) => {
				await churchName(page).waitFor();
				assert.equal(await page.getByRole("button", { name: "Delete church workspace" }).count(), 0);
			});
			await open(`${SETTINGS}/church?as=owner&${FAST}`, async (page) => {
				await page.getByRole("button", { name: "Delete church workspace" }).click();
				const confirm = page.getByRole("alertdialog", { name: "Delete Harvest Point Church?" });
				const go = confirm.getByRole("button", { name: "Delete workspace" });
				assert.equal(await go.isDisabled(), true);
				await confirm.getByRole("textbox").fill("Harvest Point");
				assert.equal(await go.isDisabled(), true, "a partial name does not unlock it");
				await confirm.getByRole("textbox").fill("harvest point church");
				await go.click();
				await page.waitForURL(/\/design\/restricted\/workspace-deletion/);
			});
		});

		test("INV-tz-preview: a stale preview asks for a new one", { timeout: 60_000 }, () =>
			open(`${SETTINGS}/church?as=owner&${FAST}&fail=setPlantTimezone:stale_preview`, async (page) => {
				await page.getByRole("button", { name: "Change time zone" }).click();
				const zone = page.getByRole("dialog", { name: "Change time zone" });
				assert.equal(await zone.getByRole("button", { name: "Preview changes" }).isDisabled(), true);
				await zone.getByRole("combobox").click();
				await page.getByPlaceholder("Search time zones").fill("New York");
				await page
					.getByRole("option", { name: /New York/ })
					.first()
					.click();
				await zone.getByRole("button", { name: "Preview changes" }).click();
				await zone.getByRole("region", { name: "What changes" }).waitFor();
				await zone.getByRole("button", { name: /^Change to New York time$/ }).click();
				await zone.getByRole("alert").filter({ hasText: "preview is out of date" }).waitFor();
				assert.equal(await zone.getByRole("button", { name: /^Change to/ }).count(), 0, "no save from a stale preview");
				await zone.getByRole("button", { name: "Preview again" }).click();
				await zone.getByRole("button", { name: /^Change to New York time$/ }).click();
				await zone.waitFor({ state: "detached" });
				await dialog(page).getByText("New York · Eastern Time").waitFor();
			}),
		);

		test("INV-personal-tz: an unconfirmed zone is never preselected", { timeout: 60_000 }, () =>
			open(`${SETTINGS}/account?as=admin&${FAST}`, async (page) => {
				await dialog(page).getByText("Not chosen yet").waitFor();
				await page.getByRole("button", { name: "Choose your time zone" }).click();
				const zone = page.getByRole("dialog", { name: "Choose your time zone" });
				assert.equal((await zone.getByRole("combobox").textContent()).trim(), "Choose a time zone");
				assert.equal(await zone.getByRole("button", { name: "Use this time zone" }).isDisabled(), true);
			}),
		);

		test("INV-deletion-deadline: cancel only before the deadline", { timeout: 60_000 }, async () => {
			await open("/design/restricted/account-deletion?state=pending", async (page) => {
				assert.equal(await page.getByRole("navigation").count(), 0, "the restricted page has no navigation");
				await page.getByText(/You can cancel until \w+ \d+, \d{4} at \d+:\d\d [AP]M [A-Z]{2,5}\./).waitFor();
				await page.getByRole("button", { name: "Keep my account" }).click();
				await page.getByRole("heading", { name: "Deletion cancelled" }).waitFor();
			});
			await open("/design/restricted/account-deletion?state=late", async (page) => {
				await page.getByText(/The time to cancel ended on/).waitFor();
				assert.equal(await page.getByRole("button", { name: "Keep my account" }).count(), 0);
			});
			await open("/design/restricted/workspace-deletion?state=skew", async (page) => {
				await page.getByRole("button", { name: "Keep the workspace" }).click();
				await page.getByRole("alert").filter({ hasText: "30 days to cancel have ended" }).waitFor();
				await page.waitForFunction(
					() => ![...document.querySelectorAll("button")].some((b) => b.textContent === "Keep the workspace"),
				);
			});
		});
	});
}
